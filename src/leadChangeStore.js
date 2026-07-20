'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureTenantDir } = require('./tenantPaths');

function historyFile(tenantId) {
  return path.join(ensureTenantDir(tenantId), 'lead_changes.jsonl');
}

function hashActor(value) {
  const text = String(value || '').trim();
  return text ? crypto.createHash('sha256').update(text).digest('hex') : '';
}

function appendLeadChange(tenantId, entry = {}) {
  const filePath = historyFile(tenantId);
  const row = {
    schemaVersion: 1,
    id: crypto.randomBytes(12).toString('hex'),
    changedAt: new Date().toISOString(),
    tenantId: String(tenantId || ''),
    leadId: String(entry.leadId || ''),
    type: String(entry.type || 'update'),
    actor: {
      userIdHash: hashActor(entry.actor?.userId || entry.actor?.username || ''),
      role: String(entry.actor?.role || ''),
    },
    changes: Array.isArray(entry.changes) ? entry.changes : [],
    metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : undefined,
  };
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
  return row;
}

module.exports = { appendLeadChange, historyFile };
