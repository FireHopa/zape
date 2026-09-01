'use strict';

const crypto = require('crypto');
const { normalizePhoneToE164Digits } = require('./phone');
const { readLeads: readJsonLeads, appendLead } = require('./tenantLeadsStore');
const { withTenantLeadWrite } = require('./leadWriteCoordinator');
const databaseRuntime = require('./database/runtime');
const { LeadServiceError } = require('./leadService');

function nowIso() {
  return new Date().toISOString();
}

function readLeadCollection(tenantId) {
  return databaseRuntime.isDatabasePrimary()
    ? databaseRuntime.readLeadsFromCache(tenantId)
    : readJsonLeads(tenantId);
}

function findLeadByWhatsapp(tenantId, whatsapp) {
  const phoneDigits = normalizePhoneToE164Digits(whatsapp || '');
  if (!phoneDigits) return null;
  return readLeadCollection(tenantId).find((item) =>
    normalizePhoneToE164Digits(item?.whatsapp_digits || item?.whatsapp_raw || '') === phoneDigits
  ) || null;
}

function buildLeadRecord(source, payload = {}) {
  const whatsappDigits = normalizePhoneToE164Digits(payload.whatsapp || payload.whatsapp_digits || payload.whatsapp_raw || '');
  return {
    id: String(payload.id || crypto.randomUUID()),
    source: String(source || payload.source || 'manual').trim(),
    sourceDetail: String(payload.sourceDetail || payload.originDetail || '').trim(),
    sourceMeta: payload.sourceMeta && typeof payload.sourceMeta === 'object' ? payload.sourceMeta : null,
    createdAt: String(payload.createdAt || nowIso()),

    nome: String(payload.nome || payload.name || '').trim(),
    empresa: String(payload.empresa || payload.company || '').trim(),
    jaAnuncia: String(payload.jaAnuncia || payload.advertisesOnGoogleRaw || '').trim(),
    website: String(payload.website || '').trim(),
    email: String(payload.email || '').trim(),

    whatsapp_raw: String(payload.whatsapp || payload.whatsapp_raw || payload.whatsapp_digits || '').trim(),
    whatsapp_digits: whatsappDigits,

    tags: payload.tags || '',
    active_contact_id: String(payload.active_contact_id || '').trim(),
    active_seriesid: String(payload.active_seriesid || '').trim(),
  };
}

async function saveLeadRecord(tenantId, lead) {
  return withTenantLeadWrite(tenantId, async () => {
    const phoneDigits = normalizePhoneToE164Digits(lead?.whatsapp_digits || lead?.whatsapp_raw || '');
    if (phoneDigits) {
      const duplicate = findLeadByWhatsapp(tenantId, phoneDigits);
      if (duplicate) {
        throw new LeadServiceError(
          'LEAD_PHONE_CONFLICT',
          'Já existe um lead com este WhatsApp. Nenhum registro foi duplicado.',
          409,
          { conflictLeadId: String(duplicate.id || '') }
        );
      }
    }

    if (databaseRuntime.isDatabasePrimary()) {
      try {
        return await databaseRuntime.createLead(tenantId, lead);
      } catch (error) {
        if (['LEAD_UNIQUE_CONFLICT', 'LEAD_PHONE_CONFLICT'].includes(String(error?.code || ''))) {
          const existing = findLeadByWhatsapp(tenantId, phoneDigits);
          throw new LeadServiceError(
            'LEAD_PHONE_CONFLICT',
            'Já existe um lead com este WhatsApp. Nenhum registro foi duplicado.',
            409,
            { conflictLeadId: String(existing?.id || error?.details?.conflictLeadId || '') }
          );
        }
        throw error;
      }
    }

    await appendLead(tenantId, lead);
    if (databaseRuntime.isShadow()) {
      try {
        await databaseRuntime.createLead(tenantId, lead);
      } catch (error) {
        console.error(`[PERSISTENCE_SHADOW] Divergência ao gravar lead [${tenantId}]:`, error?.message || error);
        throw error;
      }
    }
    return lead;
  });
}

async function createLeadFromPayload(tenantId, source, payload = {}, validation = {}) {
  const lead = buildLeadRecord(source, payload);
  const allowPhoneOnly = validation.allowPhoneOnly === true || payload.allowPhoneOnly === true;
  const allowEmailOnly = validation.allowEmailOnly === true;

  if (!lead.whatsapp_digits && !allowEmailOnly) {
    throw new Error('Lead inválido (WhatsApp obrigatório e válido).');
  }
  if (!allowPhoneOnly && !allowEmailOnly && (!lead.nome || !lead.email)) {
    throw new Error('Lead inválido (nome/email/whatsapp válido).');
  }
  if (allowEmailOnly && !lead.email && !lead.whatsapp_digits) {
    throw new Error('Lead inválido (informe e-mail ou WhatsApp).');
  }

  return saveLeadRecord(tenantId, lead);
}

async function ensureLeadFromPayload(tenantId, source, payload = {}, validation = {}) {
  const existing = findLeadByWhatsapp(tenantId, payload.whatsapp || payload.whatsapp_digits || payload.whatsapp_raw || '');
  if (existing) return { lead: existing, created: false, reused: true };

  try {
    const lead = await createLeadFromPayload(tenantId, source, payload, validation);
    return { lead, created: true, reused: false };
  } catch (error) {
    if (String(error?.code || '') !== 'LEAD_PHONE_CONFLICT') throw error;
    const conflicted = findLeadByWhatsapp(tenantId, payload.whatsapp || payload.whatsapp_digits || payload.whatsapp_raw || '');
    if (!conflicted) throw error;
    return { lead: conflicted, created: false, reused: true };
  }
}

module.exports = {
  buildLeadRecord,
  createLeadFromPayload,
  ensureLeadFromPayload,
  findLeadByWhatsapp,
  readLeadCollection,
  saveLeadRecord,
};
