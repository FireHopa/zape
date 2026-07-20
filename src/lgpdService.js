'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizePhoneToE164Digits } = require('./phone');
const { tenantDir } = require('./tenantPaths');
const { readJsonlDetailed, atomicWriteFile } = require('./dataIntegrity');

function hash(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function normalizePhone(value) { return normalizePhoneToE164Digits(value) || String(value || '').replace(/\D+/g, '').replace(/^0+/, ''); }
function safeJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function atomicJson(file, value) { atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, 0o600); }
function leadPhone(row) { return normalizePhone(row?.whatsapp_digits || row?.whatsapp_raw || row?.whatsapp || row?.phone || row?.telefone || ''); }
function messagePhone(row) { return normalizePhone(row?.toDigits || row?.fromDigits || row?.phone || row?.telefone || row?.recipientId || row?.to || row?.from || ''); }
function contactRef(tenantId, phone) { return hash(`${tenantId}\0${normalizePhone(phone)}`).slice(0, 24); }
function filesForTenant(tenantId) { const dir = tenantDir(tenantId); return { dir, leads: path.join(dir, 'leads.jsonl'), conversations: path.join(dir, 'conversations.json'), statuses: path.join(dir, 'message_status.json'), tags: path.join(dir, 'lead_tags.json'), crm: path.join(dir, 'crm.json'), media: path.join(dir, 'conversation_media') }; }
function findConversationKeys(conversations, phone) { const normalized = normalizePhone(phone); return Object.keys(conversations || {}).filter((key) => normalizePhone(key) === normalized); }
function collectMediaRefs(messages) { const refs = new Set(); for (const row of messages || []) { if (row?.mediaFile) refs.add(path.basename(String(row.mediaFile))); } return Array.from(refs); }

function exportJsonContact({ tenantId, phone }) {
  const normalized = normalizePhone(phone); if (!normalized) throw Object.assign(new Error('Telefone inválido.'), { code: 'INVALID_PHONE' });
  const files = filesForTenant(tenantId); const leadsParsed = readJsonlDetailed(files.leads); const leads = leadsParsed.records.map((row) => row.value).filter((row) => leadPhone(row) === normalized);
  const conversations = safeJson(files.conversations, {}); const keys = findConversationKeys(conversations, normalized); const messages = keys.flatMap((key) => Array.isArray(conversations[key]) ? conversations[key] : []);
  const statuses = safeJson(files.statuses, {}); const statusRows = Object.entries(statuses || {}).filter(([,row]) => messagePhone(row) === normalized || normalizePhone(row?.phone || '') === normalized).map(([id,row]) => ({ id, ...row }));
  const leadIds = new Set(leads.map((row) => String(row.id || '')).filter(Boolean)); const leadTags = safeJson(files.tags, {}); const tags = Object.fromEntries(Object.entries(leadTags || {}).filter(([id]) => leadIds.has(String(id))));
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), tenantId, contactRef: contactRef(tenantId, normalized), normalizedPhone: normalized, leads, conversations: keys.map((key) => ({ key, messages: conversations[key] })), statuses: statusRows, tags, media: collectMediaRefs(messages).map((name) => ({ referenceHash: hash(name), available: fs.existsSync(path.join(files.media, name)) })) };
}
function removeLeadIdsFromObject(value, ids) { if (Array.isArray(value)) return value.filter((item) => !ids.has(String(item))).map((item) => removeLeadIdsFromObject(item, ids)); if (!value || typeof value !== 'object') return value; const out = {}; for (const [key,item] of Object.entries(value)) { if (ids.has(String(key))) continue; out[key] = removeLeadIdsFromObject(item, ids); } return out; }
function deleteJsonContact({ tenantId, phone, apply = false, backupDir }) {
  const exported = exportJsonContact({ tenantId, phone }); const normalized = exported.normalizedPhone; const files = filesForTenant(tenantId); const leadIds = new Set(exported.leads.map((row) => String(row.id || '')).filter(Boolean)); const conversations = safeJson(files.conversations, {}); const keys = findConversationKeys(conversations, normalized); const mediaRefs = collectMediaRefs(keys.flatMap((key) => conversations[key] || []));
  const plan = { schemaVersion: 1, tenantId, contactRef: exported.contactRef, apply, counts: { leads: exported.leads.length, conversations: keys.length, messages: exported.conversations.reduce((sum,row) => sum + row.messages.length, 0), statuses: exported.statuses.length, media: mediaRefs.length }, touchedFiles: [], backupDir: backupDir ? path.resolve(backupDir) : '' };
  if (!apply) return plan;
  if (!backupDir) throw new Error('backupDir é obrigatório para exclusão aplicada.'); fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const touched = [files.leads, files.conversations, files.statuses, files.tags, files.crm].filter((file) => fs.existsSync(file));
  for (const file of touched) { const target = path.join(backupDir, path.basename(file)); fs.copyFileSync(file, target); plan.touchedFiles.push({ file, backup: target, sha256: hash(fs.readFileSync(file)) }); }
  const parsed = readJsonlDetailed(files.leads); const keptLeads = parsed.records.map((row) => row.value).filter((row) => leadPhone(row) !== normalized); const leadLines = keptLeads.map(JSON.stringify).concat(parsed.invalidLines.map((row) => row.raw)); atomicWriteFile(files.leads, leadLines.length ? `${leadLines.join('\n')}\n` : '', 0o600);
  for (const key of keys) delete conversations[key]; atomicJson(files.conversations, conversations);
  const statuses = safeJson(files.statuses, {}); for (const [id,row] of Object.entries(statuses || {})) if (messagePhone(row) === normalized || normalizePhone(row?.phone || '') === normalized) delete statuses[id]; atomicJson(files.statuses, statuses);
  atomicJson(files.tags, removeLeadIdsFromObject(safeJson(files.tags, {}), leadIds)); atomicJson(files.crm, removeLeadIdsFromObject(safeJson(files.crm, {}), leadIds));
  const quarantine = path.join(backupDir, 'media'); fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 }); for (const name of mediaRefs) { const source = path.join(files.media, path.basename(name)); if (!fs.existsSync(source)) continue; const target = path.join(quarantine, `${crypto.randomBytes(8).toString('hex')}-${path.basename(name)}`); fs.renameSync(source, target); plan.touchedFiles.push({ file: source, backup: target, media: true }); }
  const manifest = path.join(backupDir, 'lgpd-delete-manifest.json'); fs.writeFileSync(manifest, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 }); plan.manifest = manifest; return plan;
}
async function exportDatabaseContact({ db, tenantId, phone }) {
  const normalized = normalizePhone(phone); const leads = (await db.query('SELECT * FROM leads WHERE tenant_id=$1 AND phone_normalized=$2', [tenantId, normalized])).rows;
  const conversations = (await db.query('SELECT * FROM conversations WHERE tenant_id=$1 AND phone_normalized=$2', [tenantId, normalized])).rows; const ids = conversations.map((row) => row.id);
  const messages = ids.length ? (await db.query(`SELECT * FROM messages WHERE tenant_id=$1 AND conversation_id IN (${ids.map((_,i)=>`$${i+2}`).join(',')})`, [tenantId, ...ids])).rows : [];
  const media = ids.length ? (await db.query(`SELECT m.* FROM media m JOIN messages msg ON msg.id=m.message_id WHERE m.tenant_id=$1 AND msg.conversation_id IN (${ids.map((_,i)=>`$${i+2}`).join(',')})`, [tenantId, ...ids])).rows : [];
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), tenantId, contactRef: contactRef(tenantId, normalized), normalizedPhone: normalized, leads, conversations, messages, media };
}
async function deleteDatabaseContact({ db, tenantId, phone, apply = false }) {
  const exported = await exportDatabaseContact({ db, tenantId, phone }); const plan = { schemaVersion: 1, tenantId, contactRef: exported.contactRef, apply, counts: { leads: exported.leads.length, conversations: exported.conversations.length, messages: exported.messages.length, media: exported.media.length } };
  if (!apply) return plan;
  await db.transaction(async (tx) => {
    await tx.query(`DELETE FROM media WHERE tenant_id=$1 AND message_id IN (
      SELECT msg.id FROM messages msg JOIN conversations conv ON conv.id=msg.conversation_id
      WHERE conv.tenant_id=$1 AND conv.phone_normalized=$2
    )`, [tenantId, exported.normalizedPhone]);
    await tx.query('DELETE FROM conversations WHERE tenant_id=$1 AND phone_normalized=$2', [tenantId, exported.normalizedPhone]);
    await tx.query('DELETE FROM leads WHERE tenant_id=$1 AND phone_normalized=$2', [tenantId, exported.normalizedPhone]);
  });
  return plan;
}
module.exports = { exportJsonContact, deleteJsonContact, exportDatabaseContact, deleteDatabaseContact, normalizePhone, contactRef };
