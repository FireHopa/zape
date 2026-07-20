'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sanitizeForLog } = require('./safeLog');

function auditFile() {
  const configured = String(process.env.SECURITY_AUDIT_FILE || '').trim();
  if (configured) return path.resolve(configured);
  const dataDir = String(process.env.ZAPE_DATA_DIR || '').trim();
  return dataDir ? path.join(path.resolve(dataDir), 'security_audit.jsonl') : path.join(__dirname, '..', 'data', 'security_audit.jsonl');
}
function actorHash(auth) { return crypto.createHash('sha256').update(`${auth?.tenantId || ''}:${auth?.userId || auth?.username || ''}`).digest('hex'); }
function safeText(value, max = 120) { return String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max); }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function lastEntryHash(file) {
  try {
    const content = fs.readFileSync(file, 'utf8').trim();
    if (!content) return '';
    const lines = content.split(/\r?\n/);
    const last = JSON.parse(lines[lines.length - 1]);
    return String(last.entryHash || '');
  } catch { return ''; }
}
function canonical(entry) { const copy = { ...entry }; delete copy.entryHash; return JSON.stringify(copy); }

function recordSecurityAudit({ req, action, resource, targetTenantId, outcome = 'success', details } = {}) {
  const auth = req?.auth || {};
  const file = auditFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const previousHash = lastEntryHash(file);
  const entry = {
    version: 2,
    timestamp: new Date().toISOString(),
    action: safeText(action),
    resource: safeText(resource),
    outcome: safeText(outcome, 40),
    actorTenantId: safeText(auth.tenantId, 40),
    actorRole: safeText(auth.role, 40),
    actorHash: actorHash(auth),
    targetTenantId: safeText(targetTenantId || auth.tenantId, 40),
    correlationId: safeText(req?.correlationId, 128),
    operationId: safeText(req?.operationId, 128),
    requestMethod: safeText(req?.method, 12),
    requestPath: safeText(req?.path || req?.originalUrl, 180).replace(/^\/webhooks\/[^/]+$/, '/webhooks/[redacted]'),
    details: details && typeof details === 'object' ? sanitizeForLog(details) : undefined,
    previousHash,
  };
  entry.entryHash = sha256(`${previousHash}\n${canonical(entry)}`);
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return entry;
}

function verifySecurityAudit(file = auditFile()) {
  if (!fs.existsSync(file)) return { ok: true, entries: 0, errors: [] };
  const errors = []; let previousHash = ''; let entries = 0;
  for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    entries += 1;
    try {
      const entry = JSON.parse(line);
      if (String(entry.previousHash || '') !== previousHash) errors.push({ line: index + 1, code: 'AUDIT_CHAIN_PREVIOUS_MISMATCH' });
      const expected = sha256(`${previousHash}\n${canonical(entry)}`);
      if (String(entry.entryHash || '') !== expected) errors.push({ line: index + 1, code: 'AUDIT_CHAIN_HASH_MISMATCH' });
      previousHash = String(entry.entryHash || '');
    } catch { errors.push({ line: index + 1, code: 'AUDIT_INVALID_JSON' }); }
  }
  return { ok: errors.length === 0, entries, lastHash: previousHash, errors };
}

module.exports = { recordSecurityAudit, auditFile, verifySecurityAudit };
