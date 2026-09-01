'use strict';

const { ensureLeadFromPayload } = require('./leadIntakeService');
const { enqueueExternalCrmLead, enqueueExternalCrmConversationEvent } = require('./externalCrmIntegration');
const { commitInboundActivity, evaluateInboundActivity } = require('./inboundActivityStore');

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return !['0', 'false', 'no', 'off', 'nao', 'não'].includes(String(value).trim().toLowerCase());
}

function positiveInteger(value, fallback, minimum = 1, maximum = 3650) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function parseTenantSet(value) {
  return new Set(String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean));
}

function inboundAutomationConfig(tenantId) {
  const tenant = String(tenantId || 'admin').trim().toLowerCase() || 'admin';
  const included = parseTenantSet(process.env.WHATSAPP_INBOUND_AUTO_LEAD_TENANTS);
  const excluded = parseTenantSet(process.env.WHATSAPP_INBOUND_AUTO_LEAD_EXCLUDED_TENANTS);
  const globallyEnabled = normalizeBoolean(process.env.WHATSAPP_INBOUND_AUTO_LEAD_ENABLED, true);
  const enabled = globallyEnabled
    && !excluded.has(tenant)
    && (!included.size || included.has(tenant));

  return {
    enabled,
    profile: String(process.env.WHATSAPP_INBOUND_CRM_PROFILE || 'whatsapp_immersion_like').trim(),
    source: String(process.env.WHATSAPP_INBOUND_CRM_SOURCE || 'WhatsApp').trim() || 'WhatsApp',
    pipelineId: String(process.env.WHATSAPP_INBOUND_CRM_PIPELINE_ID || '').trim(),
    stageId: String(process.env.WHATSAPP_INBOUND_CRM_STAGE_ID || '').trim(),
    temperature: String(process.env.WHATSAPP_INBOUND_CRM_TEMPERATURE || 'Quente').trim(),
    priority: String(process.env.WHATSAPP_INBOUND_CRM_PRIORITY || 'alta').trim(),
    tags: String(process.env.WHATSAPP_INBOUND_AUTO_LEAD_TAGS || 'WhatsApp Inbound, Tratamento Imersão').trim(),
    reactivationEnabled: normalizeBoolean(process.env.WHATSAPP_INBOUND_REACTIVATION_ENABLED, true),
    reactivationDays: positiveInteger(process.env.WHATSAPP_INBOUND_REACTIVATION_DAYS, 30),
  };
}

function firstFilled(values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function contactNameFromMessage(message) {
  return firstFilled([
    message?._data?.notifyName,
    message?.rawData?.notifyName,
    message?._data?.sender?.pushname,
    message?.rawData?.sender?.pushname,
    message?._data?.contact?.pushname,
    message?.rawData?.contact?.pushname,
  ]).slice(0, 200);
}

function messageIdFromMessage(message) {
  return firstFilled([
    message?.id?._serialized,
    message?.id?.$1,
    message?.rawData?.id?._serialized,
    message?.rawData?.id?.$1,
    message?.id?.id,
    message?.rawData?.id?.id,
  ]).slice(0, 255);
}

function safeEventToken(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '_')
    .slice(0, 180);
}

async function handleInboundLead({
  tenantId,
  digits,
  contactName = '',
  messageId = '',
  remoteId = '',
  receivedAt,
  channel = 'whatsapp_web',
  sourceDetail = 'Primeiro contato recebido automaticamente pelo WhatsApp',
  metadata = {},
} = {}) {
  const config = inboundAutomationConfig(tenantId);
  if (!config.enabled) return { ok: true, skipped: true, reason: 'disabled' };

  const at = String(receivedAt || new Date().toISOString());
  const normalizedMessageId = String(messageId || '').trim().slice(0, 255);
  const normalizedChannel = String(channel || 'whatsapp').trim().slice(0, 80);
  const intake = await ensureLeadFromPayload(
    tenantId,
    normalizedChannel === 'whatsapp_cloud' ? 'whatsapp_cloud_inbound' : 'whatsapp_inbound',
    {
      nome: String(contactName || '').trim().slice(0, 200),
      whatsapp: digits,
      tags: config.tags,
      allowPhoneOnly: true,
      sourceDetail,
      sourceMeta: {
        type: 'whatsapp_inbound',
        channel: normalizedChannel,
        tenantId: String(tenantId || 'admin'),
        remoteId: String(remoteId || ''),
        firstMessageId: normalizedMessageId,
        firstMessageAt: at,
        integrationProfile: config.profile,
        commercialTreatment: 'immersion_like',
        ...(metadata && typeof metadata === 'object' ? metadata : {}),
      },
    },
    { allowPhoneOnly: true }
  );

  const activity = evaluateInboundActivity({
    tenantId,
    phone: digits,
    leadId: intake.lead.id,
    messageId: normalizedMessageId,
    channel: normalizedChannel,
    receivedAt: at,
    reactivationDays: config.reactivationDays,
  });

  if (activity.duplicateMessage) {
    return {
      ok: true,
      skipped: true,
      reason: 'duplicate_message',
      created: intake.created,
      reused: intake.reused,
      lead: intake.lead,
      activity,
    };
  }

  const isFirstContact = Boolean(intake.created || activity.firstSeen);
  const isReactivation = Boolean(!isFirstContact && config.reactivationEnabled && activity.reactivated);
  if (!isFirstContact && !isReactivation) {
    const conversationSync = await enqueueExternalCrmConversationEvent({
      tenantId, lead: intake.lead, direction: 'inbound', messageId: normalizedMessageId,
      conversationId: String(remoteId || digits), occurredAt: at, channel: normalizedChannel,
      preview: String(metadata?.messagePreview || ''), metadata: { remoteId: String(remoteId || ''), ...metadata },
    });
    commitInboundActivity(activity);
    return {
      ok: true,
      skipped: true,
      reason: 'existing_active_lead',
      created: intake.created,
      reused: intake.reused,
      lead: intake.lead,
      activity,
      conversationSync,
    };
  }

  const eventType = isReactivation ? 'whatsapp.inbound.reactivated' : 'whatsapp.inbound.first_contact';
  const eventSuffix = isReactivation
    ? `whatsapp-reactivated:${safeEventToken(normalizedMessageId || at)}`
    : 'whatsapp-inbound';
  const commercialTreatment = isReactivation ? 'reactivation' : 'immersion_like';
  const webhookName = normalizedChannel === 'whatsapp_cloud' ? 'WhatsApp Cloud Inbound' : 'WhatsApp Inbound';
  const queued = await enqueueExternalCrmLead({
    tenantId,
    webhook: {
      id: normalizedChannel === 'whatsapp_cloud' ? 'whatsapp-cloud-inbound' : 'whatsapp-inbound',
      name: webhookName,
      displayName: isReactivation ? 'Lead reativado pelo WhatsApp' : 'Primeiro contato recebido no WhatsApp',
    },
    lead: intake.lead,
    target: {
      enabled: true,
      pipelineId: config.pipelineId,
      stageId: config.stageId,
      source: config.source,
      profile: config.profile,
      temperature: config.temperature,
      priority: config.priority,
      commercialTreatment,
    },
    payloadType: normalizedChannel,
    eventType,
    eventKey: `zape:${String(tenantId || 'admin')}:${String(intake.lead.id)}:${eventSuffix}`,
    metadata: {
      channel: normalizedChannel,
      firstMessageId: activity.current?.firstMessageId || normalizedMessageId,
      messageId: normalizedMessageId,
      firstMessageAt: activity.current?.firstInboundAt || at,
      lastMessageAt: at,
      remoteId: String(remoteId || ''),
      localLeadCreated: intake.created,
      reactivated: isReactivation,
      inactivityDays: isReactivation ? activity.gapDays : 0,
      tenantRoutingMethod: String(metadata?.tenantRoutingMethod || ''),
      phoneNumberId: String(metadata?.phoneNumberId || ''),
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
    },
  });
  const conversationSync = await enqueueExternalCrmConversationEvent({
    tenantId, lead: intake.lead, direction: 'inbound', messageId: normalizedMessageId,
    conversationId: String(remoteId || digits), occurredAt: at, channel: normalizedChannel,
    preview: String(metadata?.messagePreview || ''), metadata: { remoteId: String(remoteId || ''), ...metadata },
  });
  commitInboundActivity(activity);

  return {
    ok: true,
    created: intake.created,
    reused: intake.reused,
    reactivated: isReactivation,
    lead: intake.lead,
    activity,
    externalCrm: queued,
    conversationSync,
  };
}

async function handleInboundWhatsappLead({ tenantId, digits, message, remoteId, receivedAt }) {
  return handleInboundLead({
    tenantId,
    digits,
    contactName: contactNameFromMessage(message),
    messageId: messageIdFromMessage(message),
    remoteId,
    receivedAt,
    channel: 'whatsapp_web',
    metadata: { messagePreview: String(message?.body || '').slice(0, 500) },
  });
}

async function handleInboundCloudLead({ tenantId, digits, contactName, messageId, phoneNumberId, receivedAt, routingMethod, messageType, messageText = "" }) {
  return handleInboundLead({
    tenantId,
    digits,
    contactName,
    messageId,
    remoteId: digits,
    receivedAt,
    channel: 'whatsapp_cloud',
    sourceDetail: 'Contato recebido automaticamente pela API oficial do WhatsApp',
    metadata: {
      phoneNumberId: String(phoneNumberId || ''),
      tenantRoutingMethod: String(routingMethod || ''),
      messageType: String(messageType || ''),
      messagePreview: String(messageText || '').slice(0, 500),
    },
  });
}

module.exports = {
  contactNameFromMessage,
  handleInboundCloudLead,
  handleInboundLead,
  handleInboundWhatsappLead,
  inboundAutomationConfig,
  messageIdFromMessage,
};
