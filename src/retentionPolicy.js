'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function positiveDays(value, fallback) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : fallback; }
function loadRetentionPolicy(env = process.env) {
  return {
    logsDays: positiveDays(env.RETENTION_LOGS_DAYS, 30),
    auditDays: positiveDays(env.RETENTION_AUDIT_DAYS, 365),
    exportsDays: positiveDays(env.RETENTION_EXPORTS_DAYS, 7),
    backupsDays: positiveDays(env.RETENTION_BACKUPS_DAYS, 30),
    webhookEventsDays: positiveDays(env.RETENTION_WEBHOOK_EVENTS_DAYS, 30),
    messageStatusesDays: positiveDays(env.RETENTION_MESSAGE_STATUSES_DAYS, 180),
    cloudEventsDays: positiveDays(env.RETENTION_CLOUD_EVENTS_DAYS, 180),
    mediaDays: positiveDays(env.RETENTION_MEDIA_DAYS, 365),
    jobsDays: positiveDays(env.RETENTION_JOBS_DAYS, 30),
  };
}
function cutoff(days, now = Date.now()) { return now - Math.max(0, Number(days || 0)) * 86400000; }
function fileHash(file) { const h = crypto.createHash('sha256'); h.update(fs.readFileSync(file)); return h.digest('hex'); }
function collectOldFiles(dir, beforeMs, { extensions = null } = {}) {
  const rows = [];
  if (!dir || !fs.existsSync(dir)) return rows;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { rows.push(...collectOldFiles(full, beforeMs, { extensions })); continue; }
    if (!entry.isFile()) continue;
    if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
    const stat = fs.statSync(full);
    if (stat.mtimeMs < beforeMs) rows.push({ file: full, bytes: stat.size, mtime: stat.mtime.toISOString(), sha256: fileHash(full) });
  }
  return rows;
}
function parseDate(row, keys = []) { for (const key of keys) { const raw = row?.[key]; if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw; const value = Date.parse(raw || ''); if (Number.isFinite(value)) return value; } return 0; }
function pruneJsonl(file, beforeMs, { dateKeys = ['timestamp','createdAt','updatedAt'], apply = false } = {}) {
  if (!fs.existsSync(file)) return { file, total: 0, retained: 0, removed: 0 };
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); const kept = []; let removed = 0;
  for (const line of lines) { try { const row = JSON.parse(line); const date = parseDate(row, dateKeys); if (date && date < beforeMs) { removed += 1; continue; } } catch {} kept.push(line); }
  if (apply && removed) { const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 }); fs.renameSync(temp, file); }
  return { file, total: lines.length, retained: kept.length, removed };
}
function pruneJsonArrayFile(file, beforeMs, { paths = [], dateKeys = ['updatedAt','createdAt','timestamp','expiresAt'], apply = false } = {}) {
  if (!fs.existsSync(file)) return { file, changes: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); const changes = [];
  for (const key of paths) { const rows = Array.isArray(parsed?.[key]) ? parsed[key] : null; if (!rows) continue; const kept = rows.filter((row) => { const date = parseDate(row, dateKeys); return !date || date >= beforeMs; }); changes.push({ path: key, total: rows.length, retained: kept.length, removed: rows.length - kept.length }); if (apply) parsed[key] = kept; }
  if (apply && changes.some((row) => row.removed)) { const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temp, file); }
  return { file, changes };
}
function applyFileRetention({ files, quarantineDir, apply = false }) {
  const moved = []; if (!apply) return { moved, candidates: files };
  fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  for (const item of files) { const target = path.join(quarantineDir, `${crypto.randomBytes(8).toString('hex')}-${path.basename(item.file)}`); fs.renameSync(item.file, target); moved.push({ ...item, target }); }
  return { moved, candidates: files };
}
function tenantRetentionPlan(root, policy, now) {
  const rows = [];
  if (!fs.existsSync(root)) return rows;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z0-9_-]{1,64}$/i.test(entry.name) || entry.name === 'quarantine') continue;
    const dir = path.join(root, entry.name); const conversationsFile = path.join(dir, 'conversations.json'); const statusFile = path.join(dir, 'message_status.json'); const mediaDir = path.join(dir, 'conversation_media');
    const conversations = fs.existsSync(conversationsFile) ? JSON.parse(fs.readFileSync(conversationsFile, 'utf8')) : {};
    const conversationCutoff = cutoff(policy.messageStatusesDays, now); const retainedConversations = {}; const mediaReferenced = new Set(); let messagesTotal = 0; let messagesRemoved = 0;
    for (const [phone, messages] of Object.entries(conversations || {})) {
      const source = Array.isArray(messages) ? messages : []; messagesTotal += source.length;
      const retained = source.filter((message) => { const at = parseDate(message, ['createdAt','timestamp','updatedAt']); const keep = !at || at >= conversationCutoff; if (!keep) messagesRemoved += 1; return keep; });
      if (retained.length) retainedConversations[phone] = retained;
      for (const message of retained) if (message?.mediaFile) mediaReferenced.add(path.basename(String(message.mediaFile)));
    }
    const statuses = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {}; const retainedStatuses = {}; let statusesRemoved = 0;
    for (const [id, status] of Object.entries(statuses || {})) { const at = parseDate(status, ['updatedAt','createdAt','sentAt','deliveredAt','readAt','lastOutboundAt','lastInboundAt','timestamp']); if (at && at < cutoff(policy.messageStatusesDays, now)) statusesRemoved += 1; else retainedStatuses[id] = status; }
    const mediaCandidates = [];
    if (fs.existsSync(mediaDir)) for (const item of fs.readdirSync(mediaDir, { withFileTypes: true })) { if (!item.isFile() || mediaReferenced.has(item.name)) continue; const file = path.join(mediaDir, item.name); const stat = fs.statSync(file); if (stat.mtimeMs < cutoff(policy.mediaDays, now)) mediaCandidates.push({ file, bytes: stat.size, mtime: stat.mtime.toISOString(), sha256: fileHash(file), tenantId: entry.name }); }
    rows.push({ tenantId: entry.name, conversationsFile, statusFile, retainedConversations, retainedStatuses, messagesTotal, messagesRemoved, statusesTotal: Object.keys(statuses || {}).length, statusesRemoved, mediaCandidates });
  }
  return rows;
}

function applyTenantRetention(rows, { apply, quarantineDir }) {
  const results = [];
  for (const row of rows) {
    if (apply && row.messagesRemoved && fs.existsSync(row.conversationsFile)) atomicJson(row.conversationsFile, row.retainedConversations);
    if (apply && row.statusesRemoved && fs.existsSync(row.statusFile)) atomicJson(row.statusFile, row.retainedStatuses);
    const media = applyFileRetention({ files: row.mediaCandidates, quarantineDir: path.join(quarantineDir, 'media', row.tenantId), apply });
    results.push({ tenantId: row.tenantId, messagesTotal: row.messagesTotal, messagesRemoved: row.messagesRemoved, statusesTotal: row.statusesTotal, statusesRemoved: row.statusesRemoved, media });
  }
  return results;
}
function atomicJson(file, value) { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, file); }

function buildRetentionPlan({ env = process.env, now = Date.now() } = {}) {
  const policy = loadRetentionPolicy(env); const root = path.resolve(env.ZAPE_DATA_DIR || path.join(__dirname, '..', 'data')); const appRoot = path.resolve(__dirname, '..');
  const logDir = path.resolve(env.ZAPE_LOG_DIR || path.join(appRoot, 'logs')); const exportDir = path.resolve(env.EXPORT_DIRECTORY || path.join(appRoot, 'exports')); const backupDir = path.resolve(env.BACKUP_DIRECTORY || path.join(appRoot, 'backups'));
  return {
    schemaVersion: 1, generatedAt: new Date(now).toISOString(), policy, root,
    files: {
      logs: collectOldFiles(logDir, cutoff(policy.logsDays, now)),
      exports: collectOldFiles(exportDir, cutoff(policy.exportsDays, now)),
      backups: collectOldFiles(backupDir, cutoff(policy.backupsDays, now)),
    },
    stores: {
      audit: { file: path.resolve(env.SECURITY_AUDIT_FILE || path.join(root, 'security_audit.jsonl')), beforeMs: cutoff(policy.auditDays, now) },
      webhookEvents: { file: path.resolve(env.WEBHOOK_IDEMPOTENCY_FILE || path.join(root, 'webhook_idempotency.json')), beforeMs: cutoff(policy.webhookEventsDays, now), paths: ['events'] },
      cloud: { file: path.join(root, 'wa_cloud_dispatches.json'), beforeMs: cutoff(policy.cloudEventsDays, now), paths: ['events','inboundEvents'] },
      jobs: { file: path.resolve(env.WA_CLOUD_QUEUE_FILE || path.join(root, 'wa_cloud_jobs.json')), beforeMs: cutoff(policy.jobsDays, now), paths: ['jobs','deadLetters'] },
    },
    tenants: tenantRetentionPlan(root, policy, now),
  };
}
function executeRetentionPlan(plan, { apply = false, quarantineDir = path.join(plan.root, 'quarantine', `retention-${Date.now()}`) } = {}) {
  const fileCandidates = [...plan.files.logs, ...plan.files.exports, ...plan.files.backups];
  const result = { schemaVersion: 1, executedAt: new Date().toISOString(), apply, quarantineDir, files: applyFileRetention({ files: fileCandidates, quarantineDir, apply }), stores: {} };
  result.stores.audit = { file: plan.stores.audit.file, removed: 0, action: 'preserved_tamper_evident_chain', note: 'O arquivo ativo de auditoria não é truncado por linha; arquivos rotacionados são tratados como unidade.' };
  for (const key of ['webhookEvents','cloud','jobs']) { const item = plan.stores[key]; result.stores[key] = pruneJsonArrayFile(item.file, item.beforeMs, { paths: item.paths, apply }); }
  result.tenants = applyTenantRetention(plan.tenants || [], { apply, quarantineDir });
  const manifest = path.join(quarantineDir, 'retention-manifest.json');
  if (apply) { fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(manifest, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 }); }
  return result;
}
module.exports = { loadRetentionPolicy, buildRetentionPlan, executeRetentionPlan, pruneJsonl, pruneJsonArrayFile, collectOldFiles, tenantRetentionPlan };
