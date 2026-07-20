'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizePhoneToE164Digits } = require('./phone');

const DATA_MANIFEST_FILE = '.zape-data-manifest.json';
const SCHEMA_VERSIONS = Object.freeze({
  'leads.jsonl': 1,
  'conversations.json': 1,
  'message_status.json': 1,
  'crm.json': 1,
  'tags.json': 1,
  'lead_tags.json': 1,
  'funnel_stages.json': 1,
  'funnel_lead_stage.json': 1,
  'wa_cloud_saved_sheets.json': 1,
  'wa_cloud_dispatches.json': 2,
  'wa_cloud_jobs.json': 1,
});

const LEAD_FIELDS_TO_MERGE = [
  'nome', 'empresa', 'jaAnuncia', 'website', 'email', 'whatsapp_raw',
  'active_contact_id', 'active_seriesid', 'sourceDetail',
];

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hashIdentifier(input) {
  const value = String(input ?? '').trim();
  return value ? sha256(value).slice(0, 16) : '';
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function fileSha256(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try { fs.chmodSync(dir, mode); } catch {}
  return dir;
}

function atomicWriteFile(filePath, content, mode = 0o600) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, mode); } catch {}
}

function atomicWriteJson(filePath, value, mode = 0o600) {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function listTenantIds(dataDir) {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z0-9_-]{1,64}$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function safeReadJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return { exists: false, value: fallback, error: null };
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return { exists: true, value: fallback, error: null };
    return { exists: true, value: JSON.parse(raw), error: null };
  } catch (error) {
    return { exists: true, value: fallback, error };
  }
}

function readJsonlDetailed(filePath) {
  const result = { exists: fs.existsSync(filePath), records: [], invalidLines: [], blankLines: 0, totalLines: 0 };
  if (!result.exists) return result;
  const raw = fs.readFileSync(filePath, 'utf8');
  raw.split(/\r?\n/).forEach((line, index) => {
    result.totalLines += 1;
    if (!line.trim()) {
      result.blankLines += 1;
      return;
    }
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('record_not_object');
      result.records.push({ value, lineNumber: index + 1, raw: line });
    } catch (error) {
      result.invalidLines.push({
        lineNumber: index + 1,
        raw: line,
        rawHash: sha256(line),
        errorCode: String(error?.message || 'invalid_json').slice(0, 120),
      });
    }
  });
  return result;
}

function extractLeadPhone(lead) {
  return lead?.whatsapp_digits || lead?.whatsapp || lead?.whatsapp_raw || lead?.phone || lead?.telefone || '';
}

function normalizeDataPhone(input) {
  const normalized = normalizePhoneToE164Digits(input);
  if (normalized) return { normalized, valid: true, rawDigits: String(input || '').replace(/\D/g, '').replace(/^0+/, '') };
  const rawDigits = String(input || '').replace(/\D/g, '').replace(/^0+/, '');
  return { normalized: '', valid: false, rawDigits };
}

function leadReferenceSet(tenantDir) {
  const refs = new Set();
  const crm = safeReadJson(path.join(tenantDir, 'crm.json'), {});
  if (crm.value && Array.isArray(crm.value.pipelines)) {
    for (const pipeline of crm.value.pipelines) {
      const stages = pipeline?.stages && typeof pipeline.stages === 'object' ? pipeline.stages : {};
      for (const stage of Object.values(stages)) {
        for (const leadId of Array.isArray(stage?.leadIds) ? stage.leadIds : []) refs.add(String(leadId));
      }
    }
  }
  const leadTags = safeReadJson(path.join(tenantDir, 'lead_tags.json'), {});
  if (leadTags.value && typeof leadTags.value === 'object') {
    Object.keys(leadTags.value).forEach((id) => refs.add(String(id)));
  }
  const stageMap = safeReadJson(path.join(tenantDir, 'funnel_lead_stage.json'), {});
  if (stageMap.value && typeof stageMap.value === 'object') {
    Object.keys(stageMap.value).forEach((id) => refs.add(String(id)));
  }
  return refs;
}

function fieldRichness(lead) {
  let score = 0;
  for (const [key, value] of Object.entries(lead || {})) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) score += Math.min(value.length, 5);
    else if (typeof value === 'object') score += Math.min(Object.keys(value).length, 5);
    else score += key === 'id' ? 0 : 1;
  }
  return score;
}

function dateRank(value, fallback = Number.MAX_SAFE_INTEGER) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : fallback;
}

function choosePrimaryLead(records, referencedIds = new Set()) {
  return [...records].sort((a, b) => {
    const aId = String(a.value?.id || '');
    const bId = String(b.value?.id || '');
    const refDiff = Number(referencedIds.has(bId)) - Number(referencedIds.has(aId));
    if (refDiff) return refDiff;
    const richness = fieldRichness(b.value) - fieldRichness(a.value);
    if (richness) return richness;
    const dateDiff = dateRank(a.value?.createdAt) - dateRank(b.value?.createdAt);
    if (dateDiff) return dateDiff;
    return aId.localeCompare(bId) || a.lineNumber - b.lineNumber;
  })[0];
}

function valueKey(value) {
  return stableStringify(value);
}

function mergeLeadGroup(records, normalizedPhone, referencedIds = new Set()) {
  const primaryRecord = choosePrimaryLead(records, referencedIds);
  const primary = JSON.parse(JSON.stringify(primaryRecord.value));
  const primaryId = String(primary.id || `lead_${hashIdentifier(`${normalizedPhone}:${primaryRecord.lineNumber}`)}`);
  primary.id = primaryId;
  primary.schemaVersion = SCHEMA_VERSIONS['leads.jsonl'];
  primary.whatsapp_digits = normalizedPhone;

  const allIds = records.map((record) => String(record.value?.id || '')).filter(Boolean);
  const mergedIds = [...new Set(allIds.filter((id) => id !== primaryId))].sort();
  const alternates = {};

  for (const field of LEAD_FIELDS_TO_MERGE) {
    const values = [];
    const seen = new Set();
    for (const record of records) {
      const value = record.value?.[field];
      if (value === undefined || value === null || value === '') continue;
      const key = valueKey(value);
      if (!seen.has(key)) {
        seen.add(key);
        values.push(value);
      }
    }
    if ((primary[field] === undefined || primary[field] === null || primary[field] === '') && values.length) {
      primary[field] = values[0];
    }
    const chosenKey = primary[field] === undefined ? null : valueKey(primary[field]);
    const otherValues = values.filter((value) => valueKey(value) !== chosenKey);
    if (otherValues.length) alternates[field] = otherValues;
  }

  const tags = new Set();
  const origins = [];
  const originSeen = new Set();
  const sourceMeta = [];
  for (const record of records) {
    for (const tag of Array.isArray(record.value?.tags) ? record.value.tags : []) tags.add(String(tag));
    const origin = {
      leadId: String(record.value?.id || ''),
      source: record.value?.source ?? null,
      sourceDetail: record.value?.sourceDetail ?? null,
      createdAt: record.value?.createdAt ?? null,
    };
    const originKey = stableStringify(origin);
    if (!originSeen.has(originKey)) {
      originSeen.add(originKey);
      origins.push(origin);
    }
    if (record.value?.sourceMeta && typeof record.value.sourceMeta === 'object') {
      sourceMeta.push({ leadId: String(record.value?.id || ''), value: record.value.sourceMeta });
    }
  }
  if (tags.size) primary.tags = [...tags].sort();
  if (mergedIds.length) primary.mergedLeadIds = [...new Set([...(Array.isArray(primary.mergedLeadIds) ? primary.mergedLeadIds : []), ...mergedIds])].sort();
  if (origins.length > 1) primary.mergedOrigins = origins;
  if (sourceMeta.length > 1) primary.mergedSourceMeta = sourceMeta;
  if (Object.keys(alternates).length) primary.mergedFieldAlternates = alternates;
  primary.mergeHistory = [
    ...(Array.isArray(primary.mergeHistory) ? primary.mergeHistory : []),
    {
      mergedAt: new Date().toISOString(),
      strategy: 'phase7-phone-normalized-v1',
      primaryLeadId: primaryId,
      mergedLeadIds: mergedIds,
      normalizedPhone,
    },
  ];

  return { primary, primaryId, mergedIds, allIds: [...new Set(allIds)], normalizedPhone };
}

function auditLeadsTenant(tenantDir, tenantId) {
  const parsed = readJsonlDetailed(path.join(tenantDir, 'leads.jsonl'));
  const phoneGroups = new Map();
  const ids = new Map();
  let missingPhone = 0;
  let invalidPhone = 0;
  for (const record of parsed.records) {
    const id = String(record.value?.id || '').trim();
    if (id) ids.set(id, (ids.get(id) || 0) + 1);
    const phone = extractLeadPhone(record.value);
    if (!phone) {
      missingPhone += 1;
      continue;
    }
    const normalized = normalizeDataPhone(phone);
    if (!normalized.valid) {
      invalidPhone += 1;
      continue;
    }
    if (!phoneGroups.has(normalized.normalized)) phoneGroups.set(normalized.normalized, []);
    phoneGroups.get(normalized.normalized).push(record);
  }
  const duplicateGroups = [...phoneGroups.values()].filter((group) => group.length > 1);
  return {
    tenantId,
    fileExists: parsed.exists,
    validRecords: parsed.records.length,
    invalidLines: parsed.invalidLines.length,
    invalidLineRefs: parsed.invalidLines.map((line) => ({ lineNumber: line.lineNumber, rawHash: line.rawHash })),
    uniqueNormalizedPhones: phoneGroups.size,
    duplicatePhoneGroups: duplicateGroups.length,
    duplicateExtraRows: duplicateGroups.reduce((sum, group) => sum + group.length - 1, 0),
    missingPhone,
    invalidPhone,
    duplicateIds: [...ids.values()].filter((count) => count > 1).length,
    duplicateGroupRefs: duplicateGroups.map((group) => ({
      phoneHash: hashIdentifier(normalizeDataPhone(extractLeadPhone(group[0].value)).normalized),
      count: group.length,
      leadIdHashes: group.map((record) => hashIdentifier(record.value?.id)).filter(Boolean),
    })),
  };
}

function conversationEntries(tenantDir) {
  const filePath = path.join(tenantDir, 'conversations.json');
  const parsed = safeReadJson(filePath, {});
  const value = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value : {};
  return { filePath, parsed, value };
}

function auditConversationsTenant(tenantDir, tenantId) {
  const { parsed, value } = conversationEntries(tenantDir);
  const normalizedKeys = new Map();
  const invalidKeys = [];
  let messages = 0;
  let invalidMessageArrays = 0;
  let duplicateMessageIds = 0;
  let mediaReferences = 0;
  for (const [key, list] of Object.entries(value)) {
    const normalized = normalizeDataPhone(key);
    if (!normalized.valid) invalidKeys.push({ keyHash: hashIdentifier(key), reason: key === '0' ? 'zero_key' : 'invalid_phone' });
    else {
      if (!normalizedKeys.has(normalized.normalized)) normalizedKeys.set(normalized.normalized, []);
      normalizedKeys.get(normalized.normalized).push(key);
    }
    if (!Array.isArray(list)) {
      invalidMessageArrays += 1;
      continue;
    }
    messages += list.length;
    const ids = new Set();
    for (const message of list) {
      const id = String(message?.id || message?.messageId || '').trim();
      if (id && ids.has(id)) duplicateMessageIds += 1;
      if (id) ids.add(id);
      if (message?.mediaFile || message?.mediaId || message?.hasMedia) mediaReferences += 1;
    }
  }
  return {
    tenantId,
    fileExists: parsed.exists,
    parseError: Boolean(parsed.error),
    conversationKeys: Object.keys(value).length,
    messages,
    invalidKeys: invalidKeys.length,
    invalidKeyRefs: invalidKeys,
    normalizationCollisions: [...normalizedKeys.values()].filter((keys) => keys.length > 1).length,
    invalidMessageArrays,
    duplicateMessageIds,
    mediaReferences,
  };
}

function leadPhoneAndConversationSets(tenantDir) {
  const leads = readJsonlDetailed(path.join(tenantDir, 'leads.jsonl'));
  const leadPhones = new Set();
  for (const record of leads.records) {
    const normalized = normalizeDataPhone(extractLeadPhone(record.value));
    if (normalized.valid) leadPhones.add(normalized.normalized);
  }
  const conversations = conversationEntries(tenantDir).value;
  const conversationPhones = new Set();
  for (const key of Object.keys(conversations)) {
    const normalized = normalizeDataPhone(key);
    if (normalized.valid) conversationPhones.add(normalized.normalized);
  }
  return { leadPhones, conversationPhones };
}

function auditStatusesTenant(tenantDir, tenantId) {
  const filePath = path.join(tenantDir, 'message_status.json');
  const parsed = safeReadJson(filePath, {});
  const statuses = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value : {};
  const { leadPhones, conversationPhones } = leadPhoneAndConversationSets(tenantDir);
  const rawLeadPhones = new Set();
  for (const record of readJsonlDetailed(path.join(tenantDir, 'leads.jsonl')).records) {
    const digits = String(extractLeadPhone(record.value) || '').replace(/\D/g, '').replace(/^0+/, '');
    if (digits) rawLeadPhones.add(digits);
  }
  const rawConversationKeys = new Set();
  for (const key of Object.keys(conversationEntries(tenantDir).value)) {
    rawConversationKeys.add(String(key));
    const digits = String(key).replace(/\D/g, '').replace(/^0+/, '');
    if (digits) rawConversationKeys.add(digits);
  }
  let invalidKeys = 0;
  let orphanStatuses = 0;
  let unmatchedRawReferences = 0;
  const orphanRefs = [];
  const normalizedGroups = new Map();
  for (const key of Object.keys(statuses)) {
    const rawDigits = String(key).replace(/\D/g, '').replace(/^0+/, '');
    if (!rawLeadPhones.has(rawDigits) && !rawConversationKeys.has(String(key)) && !rawConversationKeys.has(rawDigits)) unmatchedRawReferences += 1;
    const normalized = normalizeDataPhone(key);
    if (!normalized.valid) {
      invalidKeys += 1;
      orphanStatuses += 1;
      orphanRefs.push({ statusKeyHash: hashIdentifier(key), reason: 'invalid_phone' });
      continue;
    }
    if (!normalizedGroups.has(normalized.normalized)) normalizedGroups.set(normalized.normalized, []);
    normalizedGroups.get(normalized.normalized).push(key);
    if (!leadPhones.has(normalized.normalized) && !conversationPhones.has(normalized.normalized)) {
      orphanStatuses += 1;
      orphanRefs.push({ statusKeyHash: hashIdentifier(key), reason: 'no_lead_or_conversation' });
    }
  }
  return {
    tenantId,
    fileExists: parsed.exists,
    parseError: Boolean(parsed.error),
    statuses: Object.keys(statuses).length,
    invalidKeys,
    orphanStatuses,
    unmatchedRawReferences,
    normalizationCollisions: [...normalizedGroups.values()].filter((keys) => keys.length > 1).length,
    orphanRefs,
  };
}

function collectMediaReferences(conversations) {
  const refs = [];
  for (const [conversationKey, list] of Object.entries(conversations || {})) {
    if (!Array.isArray(list)) continue;
    for (let index = 0; index < list.length; index += 1) {
      const message = list[index] || {};
      const mediaFile = path.basename(String(message.mediaFile || '').trim());
      if (!mediaFile) continue;
      refs.push({ conversationKey, messageIndex: index, messageId: String(message.id || ''), mediaFile });
    }
  }
  return refs;
}

function auditMediaTenant(tenantDir, tenantId) {
  const conversations = conversationEntries(tenantDir).value;
  const refs = collectMediaReferences(conversations);
  const refNames = new Set(refs.map((ref) => ref.mediaFile));
  const mediaDir = path.join(tenantDir, 'conversation_media');
  const files = fs.existsSync(mediaDir)
    ? fs.readdirSync(mediaDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
    : [];
  const missing = refs.filter((ref) => !fs.existsSync(path.join(mediaDir, ref.mediaFile)));
  const orphans = files.filter((file) => !refNames.has(file));
  const hashGroups = new Map();
  let totalBytes = 0;
  for (const file of files) {
    const filePath = path.join(mediaDir, file);
    const stat = fs.statSync(filePath);
    totalBytes += stat.size;
    const hash = fileSha256(filePath);
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash).push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  const duplicateGroups = [...hashGroups.entries()].filter(([, group]) => group.length > 1);
  return {
    tenantId,
    mediaDirectoryExists: fs.existsSync(mediaDir),
    physicalFiles: files.length,
    physicalBytes: totalBytes,
    references: refs.length,
    missingReferences: missing.length,
    missingRefs: missing.map((ref) => ({
      conversationHash: hashIdentifier(ref.conversationKey),
      messageHash: hashIdentifier(ref.messageId),
      fileHash: hashIdentifier(ref.mediaFile),
    })),
    orphanFiles: orphans.length,
    orphanBytes: orphans.reduce((sum, file) => sum + fs.statSync(path.join(mediaDir, file)).size, 0),
    duplicateHashGroups: duplicateGroups.length,
    duplicateExtraFiles: duplicateGroups.reduce((sum, [, group]) => sum + group.length - 1, 0),
    duplicateBytesRecoverable: duplicateGroups.reduce((sum, [, group]) => {
      const sorted = [...group].sort((a, b) => a.file.localeCompare(b.file));
      return sum + sorted.slice(1).reduce((subtotal, item) => subtotal + item.size, 0);
    }, 0),
    duplicateRefs: duplicateGroups.map(([hash, group]) => ({ hash: hash.slice(0, 16), count: group.length, size: group[0].size })),
  };
}

function auditCrmTenant(tenantDir, tenantId) {
  const filePath = path.join(tenantDir, 'crm.json');
  const parsed = safeReadJson(filePath, {});
  const crm = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
  const leadIds = new Set(readJsonlDetailed(path.join(tenantDir, 'leads.jsonl')).records.map((record) => String(record.value?.id || '')).filter(Boolean));
  const seen = new Map();
  let pipelines = 0;
  let stages = 0;
  let references = 0;
  let missingLeadReferences = 0;
  let duplicateReferences = 0;
  const missingRefs = [];
  if (Array.isArray(crm.pipelines)) {
    pipelines = crm.pipelines.length;
    for (const pipeline of crm.pipelines) {
      const stageMap = pipeline?.stages && typeof pipeline.stages === 'object' ? pipeline.stages : {};
      for (const [stageId, stage] of Object.entries(stageMap)) {
        stages += 1;
        for (const leadId of Array.isArray(stage?.leadIds) ? stage.leadIds : []) {
          const id = String(leadId);
          references += 1;
          if (!leadIds.has(id)) {
            missingLeadReferences += 1;
            missingRefs.push({ leadIdHash: hashIdentifier(id), pipelineHash: hashIdentifier(pipeline?.id), stageHash: hashIdentifier(stageId) });
          }
          if (seen.has(id)) duplicateReferences += 1;
          else seen.set(id, { pipelineId: pipeline?.id, stageId });
        }
      }
    }
  }
  return {
    tenantId,
    fileExists: parsed.exists,
    parseError: Boolean(parsed.error),
    pipelines,
    stages,
    references,
    missingLeadReferences,
    duplicateReferences,
    missingRefs,
  };
}

function auditTagsTenant(tenantDir, tenantId) {
  const leadIds = new Set(readJsonlDetailed(path.join(tenantDir, 'leads.jsonl')).records.map((record) => String(record.value?.id || '')).filter(Boolean));
  const tagsParsed = safeReadJson(path.join(tenantDir, 'tags.json'), []);
  const tags = Array.isArray(tagsParsed.value) ? tagsParsed.value : [];
  const tagIds = new Set(tags.map((tag) => String(tag?.id || '')).filter(Boolean));
  const leadTagsParsed = safeReadJson(path.join(tenantDir, 'lead_tags.json'), {});
  const leadTags = leadTagsParsed.value && typeof leadTagsParsed.value === 'object' && !Array.isArray(leadTagsParsed.value) ? leadTagsParsed.value : {};
  let leadMappings = 0;
  let missingLeads = 0;
  let missingTags = 0;
  const refs = [];
  for (const [leadId, assigned] of Object.entries(leadTags)) {
    leadMappings += 1;
    if (!leadIds.has(String(leadId))) {
      missingLeads += 1;
      refs.push({ leadIdHash: hashIdentifier(leadId), reason: 'missing_lead' });
    }
    for (const tagId of Array.isArray(assigned) ? assigned : []) {
      if (!tagIds.has(String(tagId))) {
        missingTags += 1;
        refs.push({ leadIdHash: hashIdentifier(leadId), tagIdHash: hashIdentifier(tagId), reason: 'missing_tag' });
      }
    }
  }
  return {
    tenantId,
    tags: tags.length,
    leadMappings,
    missingLeads,
    missingTags,
    refs,
  };
}

function auditTenant(tenantDir, tenantId) {
  return {
    tenantId,
    leads: auditLeadsTenant(tenantDir, tenantId),
    conversations: auditConversationsTenant(tenantDir, tenantId),
    statuses: auditStatusesTenant(tenantDir, tenantId),
    media: auditMediaTenant(tenantDir, tenantId),
    crm: auditCrmTenant(tenantDir, tenantId),
    tags: auditTagsTenant(tenantDir, tenantId),
  };
}

function aggregateAudit(tenants) {
  const summary = {
    tenants: tenants.length,
    leads: 0,
    invalidLeadLines: 0,
    duplicatePhoneGroups: 0,
    duplicateLeadRows: 0,
    conversations: 0,
    invalidConversationKeys: 0,
    statuses: 0,
    orphanStatuses: 0,
    unmatchedRawStatuses: 0,
    mediaFiles: 0,
    missingMediaReferences: 0,
    orphanMediaFiles: 0,
    duplicateMediaFiles: 0,
    duplicateMediaBytesRecoverable: 0,
    crmMissingLeadReferences: 0,
    tagMissingLeadReferences: 0,
  };
  for (const tenant of tenants) {
    summary.leads += tenant.leads.validRecords;
    summary.invalidLeadLines += tenant.leads.invalidLines;
    summary.duplicatePhoneGroups += tenant.leads.duplicatePhoneGroups;
    summary.duplicateLeadRows += tenant.leads.duplicateExtraRows;
    summary.conversations += tenant.conversations.conversationKeys;
    summary.invalidConversationKeys += tenant.conversations.invalidKeys;
    summary.statuses += tenant.statuses.statuses;
    summary.orphanStatuses += tenant.statuses.orphanStatuses;
    summary.unmatchedRawStatuses += tenant.statuses.unmatchedRawReferences;
    summary.mediaFiles += tenant.media.physicalFiles;
    summary.missingMediaReferences += tenant.media.missingReferences;
    summary.orphanMediaFiles += tenant.media.orphanFiles;
    summary.duplicateMediaFiles += tenant.media.duplicateExtraFiles;
    summary.duplicateMediaBytesRecoverable += tenant.media.duplicateBytesRecoverable;
    summary.crmMissingLeadReferences += tenant.crm.missingLeadReferences;
    summary.tagMissingLeadReferences += tenant.tags.missingLeads;
  }
  return summary;
}

function auditDataDirectory(dataDir) {
  const startedAt = new Date().toISOString();
  const tenants = listTenantIds(dataDir).map((tenantId) => auditTenant(path.join(dataDir, tenantId), tenantId));
  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    startedAt,
    dataDirectoryHash: hashIdentifier(path.resolve(dataDir)),
    summary: aggregateAudit(tenants),
    tenants,
  };
}

function remapLeadIdsInCrm(crm, idMap, conflictLog) {
  const next = JSON.parse(JSON.stringify(crm || {}));
  const assigned = new Map();
  if (!Array.isArray(next.pipelines)) return next;
  for (const pipeline of next.pipelines) {
    const stageOrder = Array.isArray(pipeline?.stageOrder) ? pipeline.stageOrder : Object.keys(pipeline?.stages || {});
    const stages = pipeline?.stages && typeof pipeline.stages === 'object' ? pipeline.stages : {};
    for (const stageId of stageOrder) {
      const stage = stages[stageId];
      if (!stage) continue;
      const output = [];
      for (const originalId of Array.isArray(stage.leadIds) ? stage.leadIds : []) {
        const mapped = idMap.get(String(originalId)) || String(originalId);
        if (!mapped) continue;
        if (assigned.has(mapped)) {
          conflictLog.push({ type: 'crm_multiple_stages', leadIdHash: hashIdentifier(mapped), keptStageHash: hashIdentifier(assigned.get(mapped)), removedStageHash: hashIdentifier(stageId) });
          continue;
        }
        assigned.set(mapped, stageId);
        if (!output.includes(mapped)) output.push(mapped);
      }
      stage.leadIds = output;
    }
  }
  return next;
}

function remapLeadTags(leadTags, idMap) {
  const next = {};
  for (const [leadId, tagIds] of Object.entries(leadTags || {})) {
    const mapped = idMap.get(String(leadId)) || String(leadId);
    if (!mapped) continue;
    const set = new Set([...(next[mapped] || []), ...(Array.isArray(tagIds) ? tagIds.map(String) : [])]);
    next[mapped] = [...set].sort();
  }
  return next;
}

function remapFunnelLeadStage(stageMap, idMap, conflicts) {
  const next = {};
  for (const [leadId, stageId] of Object.entries(stageMap || {})) {
    const mapped = idMap.get(String(leadId)) || String(leadId);
    if (!mapped) continue;
    if (next[mapped] && next[mapped] !== stageId) {
      conflicts.push({ type: 'funnel_stage_conflict', leadIdHash: hashIdentifier(mapped), keptStageHash: hashIdentifier(next[mapped]), ignoredStageHash: hashIdentifier(stageId) });
      continue;
    }
    next[mapped] = stageId;
  }
  return next;
}

function recursivelyRemapLeadIds(value, idMap) {
  if (Array.isArray(value)) return value.map((item) => recursivelyRemapLeadIds(item, idMap));
  if (!value || typeof value !== 'object') return value;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^leadId$/i.test(key) && typeof child === 'string') next[key] = idMap.get(child) || child;
    else if (/^leadIds$/i.test(key) && Array.isArray(child)) next[key] = [...new Set(child.map((id) => idMap.get(String(id)) || String(id)))];
    else next[key] = recursivelyRemapLeadIds(child, idMap);
  }
  return next;
}

function mergeConversationMessages(groups) {
  const output = [];
  const seen = new Set();
  for (const list of groups) {
    if (!Array.isArray(list)) continue;
    for (const message of list) {
      const fingerprint = String(message?.id || message?.messageId || '') || sha256(stableStringify(message));
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      output.push(message);
    }
  }
  output.sort((a, b) => {
    const aTime = Number(a?.timestamp || 0) || dateRank(a?.createdAt, 0) / 1000;
    const bTime = Number(b?.timestamp || 0) || dateRank(b?.createdAt, 0) / 1000;
    return aTime - bTime || String(a?.id || '').localeCompare(String(b?.id || ''));
  });
  return output;
}

function normalizeConversations(conversations, quarantine) {
  const grouped = new Map();
  for (const [key, list] of Object.entries(conversations || {})) {
    const normalized = normalizeDataPhone(key);
    if (!normalized.valid || !Array.isArray(list)) {
      quarantine.push({ type: 'conversation', key, value: list, reason: !normalized.valid ? 'invalid_phone_key' : 'messages_not_array' });
      continue;
    }
    if (!grouped.has(normalized.normalized)) grouped.set(normalized.normalized, []);
    grouped.get(normalized.normalized).push(list);
  }
  const next = {};
  for (const [phone, groups] of grouped.entries()) next[phone] = mergeConversationMessages(groups);
  return next;
}

function statusRank(status) {
  const ack = Number(status?.ack ?? -1);
  const replied = status?.repliedAt ? 100 : 0;
  const updated = dateRank(status?.updatedAt || status?.repliedAt || status?.lastSendAt, 0) / 1e12;
  return replied + Math.max(ack, -1) * 10 + updated;
}

function normalizeStatuses(statuses, validPhones, quarantine) {
  const grouped = new Map();
  for (const [key, value] of Object.entries(statuses || {})) {
    const normalized = normalizeDataPhone(key);
    if (!normalized.valid || !validPhones.has(normalized.normalized)) {
      quarantine.push({ type: 'status', key, value, reason: !normalized.valid ? 'invalid_phone_key' : 'no_lead_or_conversation' });
      continue;
    }
    if (!grouped.has(normalized.normalized)) grouped.set(normalized.normalized, []);
    grouped.get(normalized.normalized).push(value);
  }
  const next = {};
  for (const [phone, values] of grouped.entries()) {
    const sorted = [...values].sort((a, b) => statusRank(b) - statusRank(a));
    const merged = Object.assign({}, ...sorted.reverse());
    merged.toDigits = phone;
    next[phone] = merged;
  }
  return next;
}

function resolveMedia(conversations, tenantDir, options, quarantine, operations) {
  const mediaDir = path.join(tenantDir, 'conversation_media');
  if (!fs.existsSync(mediaDir)) return conversations;
  const next = JSON.parse(JSON.stringify(conversations || {}));
  const files = fs.readdirSync(mediaDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  const hashGroups = new Map();
  for (const file of files) {
    const filePath = path.join(mediaDir, file);
    const hash = fileSha256(filePath);
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash).push(file);
  }
  const canonicalByFile = new Map();
  for (const [hash, group] of hashGroups.entries()) {
    const sorted = [...group].sort();
    const canonical = sorted[0];
    for (const duplicate of sorted.slice(1)) {
      canonicalByFile.set(duplicate, canonical);
      operations.push({ type: 'media_duplicate', hash: hash.slice(0, 16), from: duplicate, to: canonical });
    }
  }

  const referenced = new Set();
  for (const [phone, messages] of Object.entries(next)) {
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      const current = path.basename(String(message?.mediaFile || '').trim());
      if (!current) continue;
      const canonical = canonicalByFile.get(current) || current;
      if (canonical !== current) {
        message.mediaFile = canonical;
        if (message.mediaId === current) message.mediaId = canonical;
      }
      referenced.add(canonical);
      if (!fs.existsSync(path.join(mediaDir, canonical))) {
        message.mediaUnavailable = true;
        message.mediaErrorCode = 'MEDIA_FILE_MISSING';
        operations.push({ type: 'media_missing', conversationHash: hashIdentifier(phone), messageHash: hashIdentifier(message.id), fileHash: hashIdentifier(canonical) });
      }
    }
  }

  const cutoff = Date.now() - Number(options.retentionDays || 30) * 86400000;
  for (const file of files) {
    const canonical = canonicalByFile.get(file) || file;
    const stat = fs.statSync(path.join(mediaDir, file));
    if (canonicalByFile.has(file)) {
      quarantine.push({ type: 'media_file', file, reason: 'duplicate_hash', canonical, sha256: fileSha256(path.join(mediaDir, file)) });
    } else if (!referenced.has(canonical) && stat.mtimeMs < cutoff) {
      quarantine.push({ type: 'media_file', file, reason: 'orphan_retention_expired', sha256: fileSha256(path.join(mediaDir, file)) });
    }
  }
  return next;
}

function createTenantPlan(tenantDir, tenantId, options = {}) {
  const conflicts = [];
  const quarantine = [];
  const operations = [];
  const referencedIds = leadReferenceSet(tenantDir);
  const parsedLeads = readJsonlDetailed(path.join(tenantDir, 'leads.jsonl'));
  for (const invalid of parsedLeads.invalidLines) quarantine.push({ type: 'invalid_lead_line', ...invalid });

  const groups = new Map();
  const independent = [];
  for (const record of parsedLeads.records) {
    const normalized = normalizeDataPhone(extractLeadPhone(record.value));
    if (!normalized.valid) {
      independent.push(record.value);
      continue;
    }
    if (!groups.has(normalized.normalized)) groups.set(normalized.normalized, []);
    groups.get(normalized.normalized).push(record);
  }

  const idMap = new Map();
  const leads = [];
  for (const [phone, records] of groups.entries()) {
    if (records.length === 1) {
      const lead = JSON.parse(JSON.stringify(records[0].value));
      lead.schemaVersion = SCHEMA_VERSIONS['leads.jsonl'];
      lead.whatsapp_digits = phone;
      leads.push(lead);
      if (lead.id) idMap.set(String(lead.id), String(lead.id));
      continue;
    }
    const merged = mergeLeadGroup(records, phone, referencedIds);
    leads.push(merged.primary);
    for (const id of merged.allIds) idMap.set(id, merged.primaryId);
    operations.push({ type: 'lead_merge', phoneHash: hashIdentifier(phone), primaryIdHash: hashIdentifier(merged.primaryId), mergedIdHashes: merged.mergedIds.map(hashIdentifier) });
  }
  for (const lead of independent) {
    const next = JSON.parse(JSON.stringify(lead));
    next.schemaVersion = SCHEMA_VERSIONS['leads.jsonl'];
    leads.push(next);
    if (next.id) idMap.set(String(next.id), String(next.id));
  }
  leads.sort((a, b) => dateRank(a.createdAt) - dateRank(b.createdAt) || String(a.id || '').localeCompare(String(b.id || '')));

  const conversationsParsed = safeReadJson(path.join(tenantDir, 'conversations.json'), {});
  const conversations = normalizeConversations(conversationsParsed.value || {}, quarantine);
  const validPhones = new Set([
    ...leads.map((lead) => normalizeDataPhone(extractLeadPhone(lead)).normalized).filter(Boolean),
    ...Object.keys(conversations),
  ]);
  const statusesParsed = safeReadJson(path.join(tenantDir, 'message_status.json'), {});
  const statuses = normalizeStatuses(statusesParsed.value || {}, validPhones, quarantine);
  const conversationsWithMedia = resolveMedia(conversations, tenantDir, options, quarantine, operations);

  const crmParsed = safeReadJson(path.join(tenantDir, 'crm.json'), null);
  const crm = crmParsed.exists && crmParsed.value ? remapLeadIdsInCrm(crmParsed.value, idMap, conflicts) : null;
  const leadTagsParsed = safeReadJson(path.join(tenantDir, 'lead_tags.json'), null);
  const leadTags = leadTagsParsed.exists && leadTagsParsed.value ? remapLeadTags(leadTagsParsed.value, idMap) : null;
  const funnelMapParsed = safeReadJson(path.join(tenantDir, 'funnel_lead_stage.json'), null);
  const funnelLeadStage = funnelMapParsed.exists && funnelMapParsed.value ? remapFunnelLeadStage(funnelMapParsed.value, idMap, conflicts) : null;

  const optionalJson = {};
  for (const filename of ['wa_cloud_saved_sheets.json', 'wa_cloud_dispatches.json']) {
    const parsed = safeReadJson(path.join(tenantDir, filename), null);
    if (parsed.exists && parsed.value !== null) optionalJson[filename] = recursivelyRemapLeadIds(parsed.value, idMap);
  }

  const outputFiles = {};
  if (parsedLeads.exists) outputFiles['leads.jsonl'] = leads.map((lead) => JSON.stringify(lead)).join('\n') + (leads.length ? '\n' : '');
  if (conversationsParsed.exists) outputFiles['conversations.json'] = `${JSON.stringify(conversationsWithMedia, null, 2)}\n`;
  if (statusesParsed.exists) outputFiles['message_status.json'] = `${JSON.stringify(statuses, null, 2)}\n`;
  if (crm !== null) outputFiles['crm.json'] = `${JSON.stringify(crm, null, 2)}\n`;
  if (leadTags !== null) outputFiles['lead_tags.json'] = `${JSON.stringify(leadTags, null, 2)}\n`;
  if (funnelLeadStage !== null) outputFiles['funnel_lead_stage.json'] = `${JSON.stringify(funnelLeadStage, null, 2)}\n`;
  for (const [filename, value] of Object.entries(optionalJson)) outputFiles[filename] = `${JSON.stringify(value, null, 2)}\n`;

  const changedFiles = [];
  for (const [filename, content] of Object.entries(outputFiles)) {
    const filePath = path.join(tenantDir, filename);
    const before = fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.alloc(0);
    const after = Buffer.from(content);
    if (!before.equals(after)) changedFiles.push({ filename, beforeSha256: sha256(before), afterSha256: sha256(after), beforeBytes: before.length, afterBytes: after.length });
  }

  return {
    tenantId,
    summary: {
      leadsBefore: parsedLeads.records.length,
      leadsAfter: leads.length,
      invalidLeadLines: parsedLeads.invalidLines.length,
      leadMerges: operations.filter((op) => op.type === 'lead_merge').length,
      changedFiles: changedFiles.length,
      quarantinedRecords: quarantine.filter((item) => item.type !== 'media_file').length,
      mediaQuarantineCandidates: quarantine.filter((item) => item.type === 'media_file').length,
      conflicts: conflicts.length,
    },
    changedFiles,
    conflicts,
    quarantine,
    operations,
    outputFiles,
  };
}

function createDataManifest(tenantDir, tenantId) {
  const files = {};
  for (const [filename, version] of Object.entries(SCHEMA_VERSIONS)) {
    const filePath = path.join(tenantDir, filename);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    files[filename] = { schemaVersion: version, sha256: fileSha256(filePath), bytes: fs.statSync(filePath).size };
  }
  return { manifestVersion: 1, tenantId, generatedAt: new Date().toISOString(), files };
}

function buildMigrationPlan(dataDir, options = {}) {
  const tenants = listTenantIds(dataDir).map((tenantId) => createTenantPlan(path.join(dataDir, tenantId), tenantId, options));
  return {
    planVersion: 1,
    generatedAt: new Date().toISOString(),
    dataDirectoryHash: hashIdentifier(path.resolve(dataDir)),
    options: { retentionDays: Number(options.retentionDays || 30) },
    summary: {
      tenants: tenants.length,
      leadsBefore: tenants.reduce((sum, tenant) => sum + tenant.summary.leadsBefore, 0),
      leadsAfter: tenants.reduce((sum, tenant) => sum + tenant.summary.leadsAfter, 0),
      leadMerges: tenants.reduce((sum, tenant) => sum + tenant.summary.leadMerges, 0),
      changedFiles: tenants.reduce((sum, tenant) => sum + tenant.summary.changedFiles, 0),
      quarantineRecords: tenants.reduce((sum, tenant) => sum + tenant.summary.quarantinedRecords, 0),
      mediaQuarantineCandidates: tenants.reduce((sum, tenant) => sum + tenant.summary.mediaQuarantineCandidates, 0),
      conflicts: tenants.reduce((sum, tenant) => sum + tenant.summary.conflicts, 0),
    },
    tenants,
  };
}

function copyFileWithParents(source, target) {
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
  try { fs.chmodSync(target, 0o600); } catch {}
}

function safeRelative(base, target) {
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe_relative_path');
  return relative;
}

function rollbackAppliedChangesBestEffort(manifest) {
  const dataDir = path.resolve(manifest.dataDir);
  const backupRoot = path.resolve(manifest.backupRoot);
  const errors = [];
  for (const entry of [...(manifest.quarantineFiles || [])].reverse()) {
    try {
      const target = path.join(dataDir, entry.relative);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch (error) { errors.push(String(error?.message || error)); }
  }
  for (const entry of [...(manifest.movedFiles || [])].reverse()) {
    try {
      const from = path.join(dataDir, entry.to);
      const to = path.join(dataDir, entry.from);
      if (!fs.existsSync(from)) continue;
      ensureDir(path.dirname(to));
      fs.renameSync(from, to);
    } catch (error) { errors.push(String(error?.message || error)); }
  }
  for (const entry of [...(manifest.files || [])].reverse()) {
    try {
      const target = path.join(dataDir, entry.tenantId, entry.filename);
      if (entry.created && !entry.backupRelative) {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        continue;
      }
      if (!entry.backupRelative) continue;
      const backup = path.join(backupRoot, entry.backupRelative);
      if (fs.existsSync(backup)) copyFileWithParents(backup, target);
    } catch (error) { errors.push(String(error?.message || error)); }
  }
  return errors;
}

function applyMigrationPlan(dataDir, plan, options = {}) {
  if (String(options.confirm || '') !== 'APPLY_DATA_INTEGRITY') throw new Error('confirmation_required');
  if (!plan || Number(plan.planVersion) !== 1 || !Array.isArray(plan.tenants)) throw new Error('invalid_migration_plan');
  const resolvedDataDir = path.resolve(dataDir);
  if (plan.dataDirectoryHash !== hashIdentifier(resolvedDataDir)) throw new Error('migration_plan_data_directory_mismatch');
  const migrationId = `phase7-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
  const backupRoot = path.resolve(options.backupDir || path.join(path.dirname(dataDir), 'data-integrity-backups', migrationId));
  if (fs.existsSync(backupRoot) && fs.readdirSync(backupRoot).length) throw new Error('backup_dir_not_empty');
  ensureDir(backupRoot);
  const manifest = {
    manifestVersion: 1,
    migrationId,
    createdAt: new Date().toISOString(),
    dataDir: path.resolve(dataDir),
    backupRoot,
    files: [],
    movedFiles: [],
    quarantineFiles: [],
  };

  try {
    for (const tenantPlan of plan.tenants) {
    const tenantDir = path.join(dataDir, tenantPlan.tenantId);
    for (const changed of tenantPlan.changedFiles) {
      const filePath = path.join(tenantDir, changed.filename);
      const backupPath = path.join(backupRoot, tenantPlan.tenantId, changed.filename);
      const currentSha256 = fs.existsSync(filePath) ? fileSha256(filePath) : sha256(Buffer.alloc(0));
      if (currentSha256 !== changed.beforeSha256) throw new Error(`source_changed_since_plan:${tenantPlan.tenantId}:${changed.filename}`);
      if (fs.existsSync(filePath)) copyFileWithParents(filePath, backupPath);
      manifest.files.push({ tenantId: tenantPlan.tenantId, filename: changed.filename, beforeSha256: changed.beforeSha256, afterSha256: changed.afterSha256, backupRelative: safeRelative(backupRoot, backupPath) });
      atomicWriteFile(filePath, tenantPlan.outputFiles[changed.filename], 0o600);
      if (fileSha256(filePath) !== changed.afterSha256) throw new Error(`checksum_mismatch_after_write:${tenantPlan.tenantId}:${changed.filename}`);
    }

    const quarantineDir = path.join(tenantDir, 'quarantine', migrationId);
    const recordQuarantine = tenantPlan.quarantine.filter((item) => item.type !== 'media_file');
    if (recordQuarantine.length) {
      ensureDir(quarantineDir);
      const quarantinePath = path.join(quarantineDir, 'records.json');
      atomicWriteJson(quarantinePath, { migrationId, tenantId: tenantPlan.tenantId, records: recordQuarantine });
      manifest.quarantineFiles.push({ tenantId: tenantPlan.tenantId, relative: safeRelative(dataDir, quarantinePath), sha256: fileSha256(quarantinePath) });
    }

    const mediaCandidates = tenantPlan.quarantine.filter((item) => item.type === 'media_file');
    if (mediaCandidates.length && options.confirmMedia === 'QUARANTINE_ORPHAN_MEDIA') {
      const sourceDir = path.join(tenantDir, 'conversation_media');
      const targetDir = path.join(quarantineDir, 'conversation_media');
      ensureDir(targetDir);
      for (const candidate of mediaCandidates) {
        const source = path.join(sourceDir, path.basename(candidate.file));
        if (!fs.existsSync(source)) continue;
        if (candidate.sha256 && fileSha256(source) !== candidate.sha256) throw new Error(`media_changed_since_plan:${tenantPlan.tenantId}:${hashIdentifier(candidate.file)}`);
        const target = path.join(targetDir, path.basename(candidate.file));
        fs.renameSync(source, target);
        manifest.movedFiles.push({ tenantId: tenantPlan.tenantId, from: safeRelative(dataDir, source), to: safeRelative(dataDir, target), sha256: fileSha256(target), reason: candidate.reason });
      }
    }

    const dataManifestPath = path.join(tenantDir, DATA_MANIFEST_FILE);
    const existed = fs.existsSync(dataManifestPath);
    const dataManifestBackup = path.join(backupRoot, tenantPlan.tenantId, DATA_MANIFEST_FILE);
    if (existed) copyFileWithParents(dataManifestPath, dataManifestBackup);
    atomicWriteJson(dataManifestPath, createDataManifest(tenantDir, tenantPlan.tenantId));
    manifest.files.push({
      tenantId: tenantPlan.tenantId,
      filename: DATA_MANIFEST_FILE,
      beforeSha256: existed ? fileSha256(dataManifestBackup) : null,
      afterSha256: fileSha256(dataManifestPath),
      backupRelative: existed ? safeRelative(backupRoot, dataManifestBackup) : null,
      created: !existed,
    });
  }

    manifest.completedAt = new Date().toISOString();
    const manifestPath = path.join(backupRoot, 'rollback-manifest.json');
    atomicWriteJson(manifestPath, manifest);
    return { manifest, manifestPath };
  } catch (error) {
    const rollbackErrors = rollbackAppliedChangesBestEffort(manifest);
    if (rollbackErrors.length) error.rollbackErrors = rollbackErrors;
    throw error;
  }
}

function rollbackMigration(manifestPath, options = {}) {
  if (String(options.confirm || '') !== 'ROLLBACK_DATA_INTEGRITY') throw new Error('rollback_confirmation_required');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const dataDir = path.resolve(manifest.dataDir);
  const backupRoot = path.resolve(manifest.backupRoot);
  for (const entry of [...manifest.movedFiles].reverse()) {
    const from = path.join(dataDir, entry.to);
    const to = path.join(dataDir, entry.from);
    if (!fs.existsSync(from)) continue;
    if (fileSha256(from) !== entry.sha256) throw new Error(`moved_file_changed:${entry.to}`);
    ensureDir(path.dirname(to));
    fs.renameSync(from, to);
  }
  for (const entry of [...(manifest.quarantineFiles || [])].reverse()) {
    const target = path.join(dataDir, entry.relative);
    if (!fs.existsSync(target)) continue;
    if (fileSha256(target) !== entry.sha256) throw new Error(`quarantine_file_changed:${entry.relative}`);
    fs.unlinkSync(target);
  }
  for (const entry of [...manifest.files].reverse()) {
    const target = path.join(dataDir, entry.tenantId, entry.filename);
    if (fs.existsSync(target) && entry.afterSha256 && fileSha256(target) !== entry.afterSha256) throw new Error(`target_changed_after_migration:${entry.tenantId}:${entry.filename}`);
    if (entry.created && !entry.backupRelative) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      continue;
    }
    const backup = path.join(backupRoot, entry.backupRelative);
    if (!fs.existsSync(backup)) throw new Error(`backup_missing:${entry.backupRelative}`);
    copyFileWithParents(backup, target);
    if (entry.beforeSha256 && fileSha256(target) !== entry.beforeSha256) throw new Error(`rollback_checksum_mismatch:${entry.tenantId}:${entry.filename}`);
  }
  return { ok: true, migrationId: manifest.migrationId, rolledBackAt: new Date().toISOString() };
}

function validateTenantDataManifest(tenantDir, tenantId) {
  const manifestPath = path.join(tenantDir, DATA_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return { tenantId, manifestExists: false, valid: true, issues: ['manifest_missing'] };
  const parsed = safeReadJson(manifestPath, null);
  if (parsed.error || !parsed.value || typeof parsed.value !== 'object') return { tenantId, manifestExists: true, valid: false, issues: ['manifest_invalid'] };
  const issues = [];
  for (const [filename, metadata] of Object.entries(parsed.value.files || {})) {
    const filePath = path.join(tenantDir, filename);
    if (!fs.existsSync(filePath)) {
      issues.push(`missing:${filename}`);
      continue;
    }
    if (SCHEMA_VERSIONS[filename] !== Number(metadata.schemaVersion)) issues.push(`schema_version:${filename}`);
    if (fileSha256(filePath) !== metadata.sha256) issues.push(`checksum:${filename}`);
  }
  return { tenantId, manifestExists: true, valid: issues.length === 0, issues };
}

function validateDataIntegrityOnBoot(dataDir, options = {}) {
  const strict = Boolean(options.strict);
  const tenants = listTenantIds(dataDir);
  const results = [];
  for (const tenantId of tenants) {
    const tenantDir = path.join(dataDir, tenantId);
    const leads = readJsonlDetailed(path.join(tenantDir, 'leads.jsonl'));
    const manifest = validateTenantDataManifest(tenantDir, tenantId);
    const issues = [];
    if (leads.invalidLines.length) issues.push(`invalid_lead_lines:${leads.invalidLines.length}`);
    for (const filename of ['conversations.json', 'message_status.json', 'crm.json', 'tags.json', 'lead_tags.json']) {
      const parsed = safeReadJson(path.join(tenantDir, filename), null);
      if (parsed.exists && parsed.error) issues.push(`invalid_json:${filename}`);
    }
    issues.push(...manifest.issues.filter((issue) => issue !== 'manifest_missing'));
    results.push({ tenantId, valid: issues.length === 0, issues, manifestExists: manifest.manifestExists });
  }
  const invalid = results.filter((result) => !result.valid);
  if (strict && invalid.length) {
    const error = new Error(`Data integrity validation failed for ${invalid.length} tenant(s).`);
    error.code = 'DATA_INTEGRITY_BOOT_FAILED';
    error.details = invalid.map((item) => ({ tenantId: item.tenantId, issueCount: item.issues.length }));
    throw error;
  }
  return { valid: invalid.length === 0, tenants: results };
}

module.exports = {
  DATA_MANIFEST_FILE,
  SCHEMA_VERSIONS,
  sha256,
  hashIdentifier,
  stableStringify,
  fileSha256,
  atomicWriteFile,
  atomicWriteJson,
  listTenantIds,
  safeReadJson,
  readJsonlDetailed,
  extractLeadPhone,
  normalizeDataPhone,
  auditLeadsTenant,
  auditConversationsTenant,
  auditStatusesTenant,
  auditMediaTenant,
  auditCrmTenant,
  auditTagsTenant,
  auditTenant,
  auditDataDirectory,
  buildMigrationPlan,
  applyMigrationPlan,
  rollbackMigration,
  createDataManifest,
  validateTenantDataManifest,
  validateDataIntegrityOnBoot,
};
