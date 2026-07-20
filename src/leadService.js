'use strict';

const fs = require('fs');
const path = require('path');
const { tenantDir } = require('./tenantPaths');
const { normalizePhoneToE164Digits } = require('./phone');
const {
  readLeads,
  leadVersion,
  findLeadById,
  updateLeadById,
  mergeLeadRecords,
} = require('./tenantLeadsStore');
const { getLeadTagsMap, setLeadTags, removeLeadTags } = require('./tenantLeadTagsStore');
const { readCrmState, writeCrmState } = require('./tenantCrmStore');
const { getLeadStageMap, setLeadStageMap } = require('./tenantFunnelStore');
const { appendLeadChange } = require('./leadChangeStore');

const EDITABLE_FIELDS = Object.freeze(['nome', 'empresa', 'jaAnuncia', 'website', 'email', 'whatsapp']);
const MAX_LENGTHS = Object.freeze({
  nome: 200,
  empresa: 200,
  jaAnuncia: 120,
  website: 500,
  email: 320,
  whatsapp: 80,
});

class LeadServiceError extends Error {
  constructor(code, message, statusCode = 400, details = undefined) {
    super(message);
    this.name = 'LeadServiceError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function validateEmail(email) {
  if (!email) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new LeadServiceError('LEAD_EMAIL_INVALID', 'Informe um e-mail válido.', 400);
  }
}

function validateWebsite(website) {
  if (!website) return;
  let parsed;
  try { parsed = new URL(website); } catch {
    throw new LeadServiceError('LEAD_WEBSITE_INVALID', 'Informe uma URL válida, incluindo http:// ou https://.', 400);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new LeadServiceError('LEAD_WEBSITE_INVALID', 'O website deve usar http ou https.', 400);
  }
}

function actorFromRequest(req) {
  return {
    userId: req?.auth?.userId || req?.auth?.username || '',
    role: req?.auth?.role || '',
  };
}

function publicLead(lead) {
  if (!lead) return null;
  return { ...lead, _version: leadVersion(lead) };
}

function editableSnapshot(lead) {
  return {
    nome: String(lead?.nome || ''),
    empresa: String(lead?.empresa || ''),
    jaAnuncia: String(lead?.jaAnuncia || ''),
    website: String(lead?.website || ''),
    email: String(lead?.email || ''),
    whatsapp: String(lead?.whatsapp_raw || lead?.whatsapp_digits || ''),
  };
}

function changedFields(previous, next) {
  const before = editableSnapshot(previous);
  const after = editableSnapshot(next);
  return EDITABLE_FIELDS
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field, previous: before[field], next: after[field] }));
}

function normalizeEditablePayload(current, payload = {}) {
  const out = { ...current };
  for (const field of ['nome', 'empresa', 'jaAnuncia', 'website', 'email']) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      out[field] = cleanText(payload[field], MAX_LENGTHS[field]);
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'whatsapp')) {
    const raw = cleanText(payload.whatsapp, MAX_LENGTHS.whatsapp);
    const digits = raw ? normalizePhoneToE164Digits(raw) : '';
    if (raw && !digits) throw new LeadServiceError('LEAD_PHONE_INVALID', 'Informe um WhatsApp válido.', 400);
    out.whatsapp_raw = raw;
    out.whatsapp_digits = digits;
  }

  if (!out.nome) throw new LeadServiceError('LEAD_NAME_REQUIRED', 'Nome é obrigatório.', 400);
  validateEmail(out.email);
  validateWebsite(out.website);
  if (!out.email && !out.whatsapp_digits) {
    throw new LeadServiceError('LEAD_CONTACT_REQUIRED', 'Informe e-mail ou WhatsApp.', 400);
  }
  return out;
}

function findPhoneConflict(tenantId, leadId, phoneDigits) {
  if (!phoneDigits) return null;
  return readLeads(tenantId).find((lead) => {
    if (String(lead?.id || '') === String(leadId || '')) return false;
    return normalizePhoneToE164Digits(lead?.whatsapp_digits || lead?.whatsapp_raw || '') === phoneDigits;
  }) || null;
}

function updateLead(tenantId, leadId, payload, req) {
  const current = findLeadById(tenantId, leadId);
  if (!current) throw new LeadServiceError('LEAD_NOT_FOUND', 'Lead não encontrado.', 404);

  const expectedVersion = String(payload?._version || payload?.version || '').trim();
  const currentVersion = leadVersion(current);
  if (!expectedVersion || expectedVersion !== currentVersion) {
    throw new LeadServiceError('LEAD_VERSION_CONFLICT', 'Este lead foi alterado em outra sessão. Recarregue os dados antes de salvar.', 409, {
      current: publicLead(current),
    });
  }

  const next = normalizeEditablePayload(current, payload || {});
  const conflict = findPhoneConflict(tenantId, leadId, next.whatsapp_digits);
  if (conflict) {
    throw new LeadServiceError('LEAD_PHONE_CONFLICT', 'Já existe outro lead com este WhatsApp. Nenhum dado foi sobrescrito.', 409, {
      conflictLeadId: String(conflict.id || ''),
      sourceLeadId: String(leadId || ''),
      mergeAvailable: true,
      mergeEndpoint: `/leads/${encodeURIComponent(conflict.id)}/merge`,
      conflictVersion: leadVersion(conflict),
    });
  }

  const changes = changedFields(current, next);
  if (!changes.length) return { lead: publicLead(current), changes: [] };

  next.updatedAt = new Date().toISOString();
  const out = updateLeadById(tenantId, leadId, () => next);
  if (!out.ok) throw new LeadServiceError('LEAD_NOT_FOUND', 'Lead não encontrado.', 404);

  appendLeadChange(tenantId, {
    leadId,
    type: 'update',
    actor: actorFromRequest(req),
    changes,
    metadata: { versionBefore: currentVersion, versionAfter: leadVersion(next) },
  });

  return { lead: publicLead(next), changes };
}

function snapshotMergeFiles(tenantId) {
  const base = tenantDir(tenantId);
  const names = ['leads.jsonl', 'lead_tags.json', 'crm.json', 'funnel_lead_stage.json', 'lead_changes.jsonl'];
  return names.map((name) => {
    const filePath = path.join(base, name);
    if (!fs.existsSync(filePath)) return { filePath, existed: false, content: null, mode: 0o600 };
    const stat = fs.statSync(filePath);
    return { filePath, existed: true, content: fs.readFileSync(filePath), mode: stat.mode & 0o777 };
  });
}

function restoreMergeFiles(snapshot) {
  for (const item of snapshot) {
    if (!item.existed) {
      try { fs.rmSync(item.filePath, { force: true }); } catch {}
      continue;
    }
    fs.mkdirSync(path.dirname(item.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${item.filePath}.rollback-${process.pid}`;
    fs.writeFileSync(tmp, item.content, { mode: item.mode || 0o600 });
    fs.renameSync(tmp, item.filePath);
    try { fs.chmodSync(item.filePath, item.mode || 0o600); } catch {}
  }
}

function mergeValues(target, source) {
  const merged = { ...target };
  const alternates = merged.mergedFieldAlternates && typeof merged.mergedFieldAlternates === 'object'
    ? { ...merged.mergedFieldAlternates }
    : {};
  for (const field of ['nome', 'empresa', 'jaAnuncia', 'website', 'email', 'whatsapp_raw', 'whatsapp_digits']) {
    const targetValue = String(merged[field] || '').trim();
    const sourceValue = String(source[field] || '').trim();
    if (!targetValue && sourceValue) merged[field] = source[field];
    else if (targetValue && sourceValue && targetValue !== sourceValue) {
      const values = new Set(Array.isArray(alternates[field]) ? alternates[field].map(String) : []);
      values.add(sourceValue);
      alternates[field] = Array.from(values);
    }
  }
  if (Object.keys(alternates).length) merged.mergedFieldAlternates = alternates;

  const ids = new Set([...(Array.isArray(merged.mergedLeadIds) ? merged.mergedLeadIds : []), String(source.id || '')].filter(Boolean));
  for (const id of Array.isArray(source.mergedLeadIds) ? source.mergedLeadIds : []) ids.add(String(id));
  merged.mergedLeadIds = Array.from(ids);

  const origins = Array.isArray(merged.mergedOrigins) ? [...merged.mergedOrigins] : [];
  for (const item of [
    { source: target.source || '', sourceDetail: target.sourceDetail || '' },
    { source: source.source || '', sourceDetail: source.sourceDetail || '' },
  ]) {
    if (!item.source && !item.sourceDetail) continue;
    if (!origins.some((origin) => origin?.source === item.source && origin?.sourceDetail === item.sourceDetail)) origins.push(item);
  }
  if (origins.length) merged.mergedOrigins = origins;
  merged.mergeHistory = [
    ...(Array.isArray(merged.mergeHistory) ? merged.mergeHistory : []),
    { sourceLeadId: String(source.id || ''), mergedAt: new Date().toISOString() },
  ];
  merged.updatedAt = new Date().toISOString();
  return merged;
}

function replaceLeadReferencesInCrm(state, sourceId, targetId) {
  let changed = false;
  for (const pipeline of Array.isArray(state?.pipelines) ? state.pipelines : []) {
    for (const stage of Object.values(pipeline?.stages || {})) {
      if (!Array.isArray(stage?.leadIds)) continue;
      const before = stage.leadIds.map(String);
      const after = [];
      const seen = new Set();
      for (const id of before) {
        const nextId = id === sourceId ? targetId : id;
        if (!seen.has(nextId)) { seen.add(nextId); after.push(nextId); }
      }
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        stage.leadIds = after;
        changed = true;
      }
    }
  }
  return changed;
}

function mergeLeads(tenantId, targetId, payload, req) {
  const sourceId = String(payload?.sourceLeadId || '').trim();
  if (String(payload?.confirm || '') !== 'MERGE_LEADS') {
    throw new LeadServiceError('LEAD_MERGE_CONFIRMATION_REQUIRED', 'Confirmação explícita do merge é obrigatória.', 400);
  }
  if (!sourceId || sourceId === String(targetId)) {
    throw new LeadServiceError('LEAD_MERGE_INVALID', 'Selecione dois leads diferentes para o merge.', 400);
  }

  const target = findLeadById(tenantId, targetId);
  const source = findLeadById(tenantId, sourceId);
  if (!target || !source) throw new LeadServiceError('LEAD_NOT_FOUND', 'Um dos leads não foi encontrado.', 404);
  if (String(payload?.targetVersion || '') !== leadVersion(target) || String(payload?.sourceVersion || '') !== leadVersion(source)) {
    throw new LeadServiceError('LEAD_VERSION_CONFLICT', 'Um dos leads foi alterado. Recarregue os dados antes de fazer o merge.', 409);
  }

  const desiredPhone = normalizePhoneToE164Digits(payload?.desiredPhone || target.whatsapp_digits || target.whatsapp_raw || '');
  const targetPhone = normalizePhoneToE164Digits(target.whatsapp_digits || target.whatsapp_raw || '');
  const sourcePhone = normalizePhoneToE164Digits(source.whatsapp_digits || source.whatsapp_raw || '');
  if (!desiredPhone || (desiredPhone !== targetPhone && desiredPhone !== sourcePhone)) {
    throw new LeadServiceError('LEAD_MERGE_PHONE_MISMATCH', 'O merge só pode ser confirmado para o telefone em conflito.', 409);
  }

  const targetTags = getLeadTagsMap(tenantId);
  const mergedTagIds = Array.from(new Set([
    ...(Array.isArray(targetTags[targetId]) ? targetTags[targetId] : []),
    ...(Array.isArray(targetTags[sourceId]) ? targetTags[sourceId] : []),
  ].map(String).filter(Boolean)));
  const crmState = readCrmState(tenantId);
  const funnelMap = getLeadStageMap(tenantId);
  const snapshot = snapshotMergeFiles(tenantId);

  try {
    const result = mergeLeadRecords(tenantId, targetId, sourceId, (targetLead, sourceLead) => {
      const merged = mergeValues(targetLead, sourceLead);
      merged.whatsapp_digits = desiredPhone;
      if (!merged.whatsapp_raw) merged.whatsapp_raw = desiredPhone;
      return merged;
    });
    if (!result.ok) throw new LeadServiceError('LEAD_NOT_FOUND', 'Um dos leads não foi encontrado.', 404);

    setLeadTags(tenantId, targetId, mergedTagIds);
    removeLeadTags(tenantId, sourceId);
    if (replaceLeadReferencesInCrm(crmState, sourceId, targetId)) writeCrmState(tenantId, crmState);
    if (Object.prototype.hasOwnProperty.call(funnelMap, sourceId)) {
      if (!Object.prototype.hasOwnProperty.call(funnelMap, targetId)) funnelMap[targetId] = funnelMap[sourceId];
      delete funnelMap[sourceId];
      setLeadStageMap(tenantId, funnelMap);
    }

    appendLeadChange(tenantId, {
      leadId: targetId,
      type: 'merge',
      actor: actorFromRequest(req),
      changes: changedFields(target, result.target),
      metadata: {
        sourceLeadId: sourceId,
        targetVersionBefore: leadVersion(target),
        sourceVersionBefore: leadVersion(source),
        targetVersionAfter: leadVersion(result.target),
      },
    });

    return { lead: publicLead(result.target), mergedLeadId: sourceId, tagIds: mergedTagIds };
  } catch (error) {
    restoreMergeFiles(snapshot);
    if (error instanceof LeadServiceError) throw error;
    throw new LeadServiceError('LEAD_MERGE_REFERENCE_FAILED', 'O merge foi revertido porque não foi possível atualizar todas as referências.', 500);
  }
}

module.exports = {
  EDITABLE_FIELDS,
  LeadServiceError,
  publicLead,
  updateLead,
  mergeLeads,
};
