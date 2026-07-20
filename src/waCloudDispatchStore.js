'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.ZAPE_DATA_DIR
  ? path.resolve(process.env.ZAPE_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'wa_cloud_dispatches.json');
const VERSION = 2;
const STATES = Object.freeze(['queued', 'submitted', 'sent', 'delivered', 'read', 'failed', 'replied', 'expired', 'canceled']);
const PROGRESSION = Object.freeze({ queued: 0, submitted: 1, sent: 2, delivered: 3, read: 4, replied: 5 });

function now() { return new Date().toISOString(); }
function normalizeText(value) { return String(value || '').trim(); }
function normalizeDigits(value) { return String(value || '').replace(/\D+/g, '').replace(/^0+/, ''); }
function genId(prefix) { return `${prefix}_${crypto.randomBytes(12).toString('hex')}`; }
function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); }
function indexKey(connectionId, messageId) { return `${normalizeText(connectionId)}:${normalizeText(messageId)}`; }

function emptyStore() {
  return { version: VERSION, campaigns: [], events: [], inboundEvents: [], messageIndex: {} };
}

function normalizeHistory(history, fallbackState, timestamp) {
  const rows = Array.isArray(history) ? history.filter((x) => x && typeof x === 'object') : [];
  if (rows.length) return rows;
  return fallbackState ? [{ state: fallbackState, at: timestamp || now(), source: 'legacy_import' }] : [];
}

function normalizeEvent(input = {}) {
  const createdAt = input.createdAt || now();
  const status = STATES.includes(normalizeText(input.status)) ? normalizeText(input.status) : 'queued';
  return {
    id: normalizeText(input.id) || genId('evt'),
    dispatchId: normalizeText(input.dispatchId || input.id) || genId('dispatch'),
    tenantId: normalizeText(input.tenantId || 'admin').toLowerCase(),
    connectionId: normalizeText(input.connectionId),
    phoneNumberId: normalizeText(input.phoneNumberId),
    wabaId: normalizeText(input.wabaId),
    campaignId: normalizeText(input.campaignId),
    campaignName: normalizeText(input.campaignName),
    templateName: normalizeText(input.templateName),
    languageCode: normalizeText(input.languageCode || 'pt_BR'),
    recipientId: normalizeDigits(input.recipientId || input.toDigits || input.to || input.phone),
    toDigits: normalizeDigits(input.recipientId || input.toDigits || input.to || input.phone),
    leadId: input.leadId ? String(input.leadId) : '',
    leadSnapshot: input.leadSnapshot && typeof input.leadSnapshot === 'object' ? input.leadSnapshot : null,
    origin: input.origin && typeof input.origin === 'object' ? input.origin : null,
    dispatchSource: input.dispatchSource && typeof input.dispatchSource === 'object' ? input.dispatchSource : null,
    vars: Array.isArray(input.vars) ? input.vars.map((x) => String(x ?? '')) : [],
    status,
    deliveryState: normalizeText(input.deliveryState),
    messageId: normalizeText(input.messageId) || null,
    conversationId: normalizeText(input.conversationId || input?.conversation?.id) || null,
    parentMessageId: normalizeText(input.parentMessageId) || null,
    error: input.error || null,
    errorInfo: input.errorInfo || null,
    sentAt: input.sentAt || null,
    submittedAt: input.submittedAt || null,
    deliveredAt: input.deliveredAt || null,
    readAt: input.readAt || null,
    failedAt: input.failedAt || null,
    repliedAt: input.repliedAt || input.respondedAt || null,
    respondedAt: input.repliedAt || input.respondedAt || null,
    expiredAt: input.expiredAt || null,
    canceledAt: input.canceledAt || null,
    inbound: input.inbound || null,
    statusHistory: normalizeHistory(input.statusHistory, status, createdAt),
    createdAt,
    updatedAt: input.updatedAt || createdAt,
  };
}

function normalizeCampaign(input = {}) {
  const createdAt = input.createdAt || now();
  return {
    id: normalizeText(input.id) || genId('camp'),
    tenantId: normalizeText(input.tenantId || 'admin').toLowerCase(),
    connectionId: normalizeText(input.connectionId),
    phoneNumberId: normalizeText(input.phoneNumberId),
    wabaId: normalizeText(input.wabaId),
    name: normalizeText(input.name || input.templateName || 'Campanha oficial'),
    templateName: normalizeText(input.templateName),
    languageCode: normalizeText(input.languageCode || 'pt_BR'),
    total: Number(input.total || 0),
    sourceSummary: input.sourceSummary && typeof input.sourceSummary === 'object' ? input.sourceSummary : {},
    jobId: normalizeText(input.jobId),
    state: normalizeText(input.state || 'draft') || 'draft',
    progress: input.progress && typeof input.progress === 'object' ? input.progress : null,
    createdAt,
    updatedAt: input.updatedAt || createdAt,
  };
}

function rebuildIndex(store) {
  const index = {};
  for (const event of store.events) {
    if (!event.connectionId || !event.messageId) continue;
    const key = indexKey(event.connectionId, event.messageId);
    if (!index[key]) index[key] = event.id;
  }
  store.messageIndex = index;
  return store;
}

function readStore() {
  ensureDir();
  if (!fs.existsSync(FILE)) return emptyStore();
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
    const store = {
      version: VERSION,
      campaigns: (Array.isArray(raw.campaigns) ? raw.campaigns : []).map(normalizeCampaign),
      events: (Array.isArray(raw.events) ? raw.events : []).map(normalizeEvent),
      inboundEvents: Array.isArray(raw.inboundEvents) ? raw.inboundEvents : [],
      messageIndex: raw.messageIndex && typeof raw.messageIndex === 'object' ? raw.messageIndex : {},
    };
    return rebuildIndex(store);
  } catch (error) {
    const e = new Error('Histórico Cloud API indisponível ou corrompido.');
    e.code = 'CLOUD_DISPATCH_STORE_CORRUPTED';
    e.cause = error;
    throw e;
  }
}

function writeStore(input) {
  ensureDir();
  const store = rebuildIndex({
    version: VERSION,
    campaigns: Array.isArray(input?.campaigns) ? input.campaigns.map(normalizeCampaign) : [],
    events: Array.isArray(input?.events) ? input.events.map(normalizeEvent) : [],
    inboundEvents: Array.isArray(input?.inboundEvents) ? input.inboundEvents : [],
    messageIndex: {},
  });
  const temp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
  return store;
}

function createCampaign(input = {}) {
  const store = readStore();
  const campaign = normalizeCampaign(input);
  store.campaigns.push(campaign);
  writeStore(store);
  return campaign;
}

function updateCampaign(campaignId, patch = {}) {
  const store = readStore();
  const index = store.campaigns.findIndex((row) => row.id === String(campaignId));
  if (index < 0) return null;
  store.campaigns[index] = normalizeCampaign({ ...store.campaigns[index], ...patch, id: store.campaigns[index].id, updatedAt: now() });
  writeStore(store);
  return store.campaigns[index];
}

function recordEvent(input = {}) {
  const store = readStore();
  const event = normalizeEvent(input);
  store.events.push(event);
  writeStore(store);
  return event;
}

function transitionDecision(current, next) {
  if (!STATES.includes(next)) return { allowed: false, reason: 'unknown_state' };
  if (current === next) return { allowed: false, reason: 'duplicate' };
  if (current === 'replied') return { allowed: false, reason: 'terminal_replied' };
  if (current === 'canceled' || current === 'expired') return { allowed: false, reason: 'terminal_state' };
  if (current === 'failed') return { allowed: false, reason: 'terminal_failed' };
  if (next === 'replied') return { allowed: true };
  if (next === 'failed' || next === 'expired' || next === 'canceled') {
    return { allowed: (PROGRESSION[current] ?? -1) <= PROGRESSION.sent, reason: 'terminal_after_delivery' };
  }
  const currentRank = PROGRESSION[current];
  const nextRank = PROGRESSION[next];
  if (currentRank === undefined || nextRank === undefined) return { allowed: false, reason: 'invalid_progression' };
  return nextRank > currentRank ? { allowed: true } : { allowed: false, reason: 'regression' };
}

function transitionEvent(event, nextState, patch = {}, context = {}) {
  const state = normalizeText(nextState).toLowerCase();
  const decision = transitionDecision(event.status, state);
  if (!decision.allowed) return { event, changed: false, ignoredReason: decision.reason };
  const at = context.at || now();
  const historyRow = {
    state,
    at,
    source: normalizeText(context.source || 'system'),
    eventId: normalizeText(context.eventId) || undefined,
    providerStatus: normalizeText(context.providerStatus) || undefined,
  };
  Object.keys(historyRow).forEach((key) => historyRow[key] === undefined && delete historyRow[key]);
  const next = {
    ...event,
    ...patch,
    id: event.id,
    dispatchId: event.dispatchId,
    status: state,
    updatedAt: at,
    statusHistory: [...(event.statusHistory || []), historyRow],
  };
  if (state === 'submitted') next.submittedAt = next.submittedAt || at;
  if (state === 'sent') next.sentAt = next.sentAt || at;
  if (state === 'delivered') next.deliveredAt = next.deliveredAt || at;
  if (state === 'read') next.readAt = next.readAt || at;
  if (state === 'failed') next.failedAt = next.failedAt || at;
  if (state === 'replied') {
    next.repliedAt = next.repliedAt || at;
    next.respondedAt = next.respondedAt || at;
  }
  if (state === 'expired') next.expiredAt = next.expiredAt || at;
  if (state === 'canceled') next.canceledAt = next.canceledAt || at;
  return { event: normalizeEvent(next), changed: true, ignoredReason: null };
}

function attachMessageId(store, eventIndex, messageId) {
  const id = normalizeText(messageId);
  if (!id) return;
  const event = store.events[eventIndex];
  const key = indexKey(event.connectionId, id);
  const existingId = store.messageIndex[key];
  if (existingId && existingId !== event.id) {
    const error = new Error('Meta message ID já associado a outro disparo desta conexão.');
    error.code = 'META_MESSAGE_ID_CONFLICT';
    throw error;
  }
  event.messageId = id;
  store.messageIndex[key] = event.id;
}

function updateEvent(eventId, patch = {}, context = {}) {
  const store = readStore();
  const idx = store.events.findIndex((event) => event.id === String(eventId));
  if (idx < 0) return null;
  let event = store.events[idx];
  if (patch.messageId) attachMessageId(store, idx, patch.messageId);
  const requestedState = normalizeText(patch.status);
  if (requestedState) {
    const withoutStatus = { ...patch };
    delete withoutStatus.status;
    const transitioned = transitionEvent(event, requestedState, withoutStatus, context);
    event = transitioned.event;
    store.events[idx] = event;
  } else {
    store.events[idx] = normalizeEvent({ ...event, ...patch, id: event.id, updatedAt: context.at || now() });
  }
  const campaign = store.campaigns.find((row) => row.id === store.events[idx].campaignId);
  if (campaign) campaign.updatedAt = store.events[idx].updatedAt;
  writeStore(store);
  return store.events[idx];
}

function findByMessageId({ connectionId, messageId, tenantId } = {}) {
  const store = readStore();
  const key = indexKey(connectionId, messageId);
  const eventId = store.messageIndex[key];
  if (!eventId) return null;
  const event = store.events.find((row) => row.id === eventId) || null;
  if (!event) return null;
  if (tenantId && event.tenantId !== String(tenantId).toLowerCase()) return null;
  return event;
}

function updateByMessageId(messageId, patch = {}, scope = {}) {
  const connectionId = normalizeText(scope.connectionId || patch.connectionId);
  if (!connectionId || !normalizeText(messageId)) return null;
  const event = findByMessageId({ connectionId, messageId, tenantId: scope.tenantId });
  if (!event) return null;
  if (scope.recipientId && normalizeDigits(event.recipientId) !== normalizeDigits(scope.recipientId)) return null;
  if (scope.phoneNumberId && event.phoneNumberId && normalizeText(event.phoneNumberId) !== normalizeText(scope.phoneNumberId)) return null;
  return updateEvent(event.id, patch, {
    source: scope.source || 'meta_webhook',
    eventId: scope.eventId,
    providerStatus: scope.providerStatus,
    at: scope.at,
  });
}

function recordInbound(input = {}) {
  const store = readStore();
  const incoming = {
    id: normalizeText(input.id) || genId('provider'),
    kind: normalizeText(input.kind || 'message'),
    connectionId: normalizeText(input.connectionId),
    phoneNumberId: normalizeText(input.phoneNumberId),
    wabaId: normalizeText(input.wabaId),
    recipientId: normalizeDigits(input.recipientId || input.from),
    messageId: normalizeText(input.messageId),
    contextMessageId: normalizeText(input.contextMessageId),
    type: normalizeText(input.type),
    timestamp: input.timestamp || null,
    matchedEventId: normalizeText(input.matchedEventId) || null,
    matchedTenantId: normalizeText(input.matchedTenantId).toLowerCase() || null,
    matchMethod: normalizeText(input.matchMethod || 'none'),
    createdAt: input.createdAt || now(),
  };
  store.inboundEvents.push(incoming);
  writeStore(store);
  return incoming;
}

function correlateInbound(input = {}) {
  const connectionId = normalizeText(input.connectionId);
  const contextMessageId = normalizeText(input.contextMessageId);
  let matched = null;
  let method = 'none';
  if (connectionId && contextMessageId) {
    matched = findByMessageId({ connectionId, messageId: contextMessageId });
    if (matched && input.recipientId && normalizeDigits(matched.recipientId) !== normalizeDigits(input.recipientId)) matched = null;
    if (matched) method = 'context.id';
  }
  if (matched) {
    const at = input.at || now();
    const updated = updateEvent(matched.id, {
      status: 'replied',
      parentMessageId: contextMessageId,
      inbound: input.inbound || null,
    }, { source: 'meta_webhook', eventId: input.eventId, at });
    recordInbound({ ...input, matchedEventId: updated.id, matchedTenantId: updated.tenantId, matchMethod: method });
    return { matched: true, event: updated, method };
  }
  const inbound = recordInbound({ ...input, matchMethod: 'unmatched' });
  return { matched: false, event: null, method: 'unmatched', inbound };
}

function recordProviderEvent(input = {}) {
  return recordInbound(input);
}

function listCampaigns(tenantId) {
  const tid = normalizeText(tenantId).toLowerCase();
  return readStore().campaigns.filter((row) => !tid || row.tenantId === tid);
}
function listEvents(tenantId) {
  const tid = normalizeText(tenantId).toLowerCase();
  return readStore().events.filter((row) => !tid || row.tenantId === tid);
}
function listInboundEvents({ tenantId, connectionId } = {}) {
  const tid = normalizeText(tenantId).toLowerCase();
  const cid = normalizeText(connectionId);
  return readStore().inboundEvents.filter((row) => (!cid || row.connectionId === cid) && (!tid || row.matchedTenantId === tid));
}

module.exports = {
  FILE,
  VERSION,
  STATES,
  createCampaign,
  updateCampaign,
  recordEvent,
  updateEvent,
  updateByMessageId,
  findByMessageId,
  correlateInbound,
  recordProviderEvent,
  listCampaigns,
  listEvents,
  listInboundEvents,
  readStore,
  writeStore,
  transitionDecision,
};
