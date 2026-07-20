'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_VERSION = 1;

function storeFile() {
  if (String(process.env.SESSION_STORE_FILE || '').trim()) {
    return path.resolve(process.env.SESSION_STORE_FILE);
  }
  const dataDir = String(process.env.ZAPE_DATA_DIR || '').trim()
    ? path.resolve(process.env.ZAPE_DATA_DIR)
    : path.join(__dirname, '..', 'data');
  return path.join(dataDir, 'auth_sessions.json');
}

function emptyStore() {
  return { version: STORE_VERSION, sessions: [] };
}

function hashSessionId(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId || '')).digest('hex');
}

function readStore() {
  const file = storeFile();
  if (!fs.existsSync(file)) return emptyStore();

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (cause) {
    const error = new Error('O armazenamento de sessões está corrompido ou ilegível.');
    error.code = 'SESSION_STORE_CORRUPT';
    error.cause = cause;
    throw error;
  }

  if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.sessions)) {
    const error = new Error('O armazenamento de sessões possui formato inválido.');
    error.code = 'SESSION_STORE_INVALID';
    throw error;
  }
  return parsed;
}

function writeStore(store) {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  fs.writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function prune(store, now = Date.now()) {
  const revokedRetentionMs = 7 * 24 * 60 * 60 * 1000;
  store.sessions = store.sessions.filter((session) => {
    const expiresAt = Number(session.expiresAt || 0);
    const revokedAt = Number(session.revokedAt || 0);
    if (revokedAt && revokedAt < now - revokedRetentionMs) return false;
    if (!revokedAt && expiresAt && expiresAt < now - revokedRetentionMs) return false;
    return true;
  });
  return store;
}

function createSession({ tenantId, username, expiresAt, now = Date.now() }) {
  const sessionId = crypto.randomBytes(32).toString('base64url');
  const idHash = hashSessionId(sessionId);
  const store = prune(readStore(), now);
  store.sessions.push({
    idHash,
    tenantId: String(tenantId || ''),
    username: String(username || ''),
    createdAt: now,
    expiresAt: Number(expiresAt),
    revokedAt: null,
  });
  writeStore(store);
  return { sessionId, idHash };
}

function getSession(sessionId, now = Date.now()) {
  const idHash = hashSessionId(sessionId);
  const store = readStore();
  const session = store.sessions.find((item) => item.idHash === idHash);
  if (!session || session.revokedAt) return null;
  if (!session.expiresAt || Number(session.expiresAt) <= now) return null;
  return { ...session };
}

function revokeSession(sessionId, now = Date.now()) {
  if (!sessionId) return false;
  const idHash = hashSessionId(sessionId);
  const store = prune(readStore(), now);
  const session = store.sessions.find((item) => item.idHash === idHash);
  if (!session || session.revokedAt) return false;
  session.revokedAt = now;
  writeStore(store);
  return true;
}

function revokeAllForTenant(tenantId, username, now = Date.now()) {
  const store = prune(readStore(), now);
  let changed = false;
  for (const session of store.sessions) {
    if (session.revokedAt) continue;
    if (session.tenantId !== String(tenantId || '')) continue;
    if (username && session.username !== String(username)) continue;
    session.revokedAt = now;
    changed = true;
  }
  if (changed) writeStore(store);
  return changed;
}

module.exports = {
  STORE_VERSION,
  storeFile,
  hashSessionId,
  readStore,
  createSession,
  getSession,
  revokeSession,
  revokeAllForTenant,
};
