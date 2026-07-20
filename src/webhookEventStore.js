'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

function hashKey(integration, tenantId, eventId) {
  return crypto.createHash('sha256')
    .update(`${String(integration || '').trim()}\0${String(tenantId || '').trim()}\0${String(eventId || '').trim()}`)
    .digest('hex');
}

function createWebhookEventStore({
  file = process.env.WEBHOOK_IDEMPOTENCY_FILE || path.join(process.env.ZAPE_DATA_DIR ? path.resolve(process.env.ZAPE_DATA_DIR) : path.join(__dirname, '..', 'data'), 'webhook_idempotency.json'),
  retentionMs = Number(process.env.WEBHOOK_IDEMPOTENCY_RETENTION_MS || 7 * 24 * 60 * 60 * 1000),
  pendingTimeoutMs = Number(process.env.WEBHOOK_IDEMPOTENCY_PENDING_TIMEOUT_MS || 15 * 60 * 1000),
  now = () => Date.now(),
} = {}) {
  function readState() {
    if (!fs.existsSync(file)) return { schemaVersion: SCHEMA_VERSION, events: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        schemaVersion: SCHEMA_VERSION,
        events: Array.isArray(parsed?.events) ? parsed.events : [],
      };
    } catch (cause) {
      const error = new Error('Arquivo de idempotência de webhooks inválido.');
      error.code = 'WEBHOOK_IDEMPOTENCY_CORRUPT';
      error.statusCode = 503;
      error.cause = cause;
      throw error;
    }
  }

  function writeState(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, events: state.events }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }

  function prune(state, currentTime = now()) {
    const before = state.events.length;
    state.events = state.events.filter((event) => {
      const expiresAt = Date.parse(event.expiresAt || '') || 0;
      const createdAt = Date.parse(event.createdAt || '') || 0;
      if (event.state === 'pending' && currentTime - createdAt > pendingTimeoutMs) return false;
      return expiresAt > currentTime;
    });
    return state.events.length !== before;
  }

  function claim({ integration, tenantId, eventId, requestHash = '' }) {
    const currentTime = now();
    const state = readState();
    const changedByPrune = prune(state, currentTime);
    const keyHash = hashKey(integration, tenantId, eventId);
    const existing = state.events.find((event) => event.keyHash === keyHash);
    if (existing) {
      if (changedByPrune) writeState(state);
      const normalizedRequestHash = String(requestHash || '').trim();
      const conflict = Boolean(normalizedRequestHash && existing.requestHash && normalizedRequestHash !== existing.requestHash);
      return {
        claimed: false,
        duplicate: !conflict,
        conflict,
        pending: existing.state === 'pending',
        statusCode: Number(existing.statusCode || 200),
        responseBody: existing.responseBody || null,
        keyHash,
      };
    }

    const createdAt = new Date(currentTime).toISOString();
    state.events.push({
      keyHash,
      integration: String(integration || '').slice(0, 80),
      tenantIdHash: crypto.createHash('sha256').update(String(tenantId || '')).digest('hex'),
      state: 'pending',
      requestHash: String(requestHash || '').trim().slice(0, 128),
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(currentTime + retentionMs).toISOString(),
      statusCode: null,
      responseBody: null,
    });
    writeState(state);
    return { claimed: true, duplicate: false, pending: true, keyHash };
  }

  function complete({ integration, tenantId, eventId, statusCode = 200, responseBody = null }) {
    const currentTime = now();
    const state = readState();
    prune(state, currentTime);
    const keyHash = hashKey(integration, tenantId, eventId);
    const event = state.events.find((item) => item.keyHash === keyHash);
    if (!event) return false;
    event.state = 'completed';
    event.statusCode = Number(statusCode) || 200;
    event.responseBody = responseBody && typeof responseBody === 'object' ? responseBody : null;
    event.updatedAt = new Date(currentTime).toISOString();
    event.expiresAt = new Date(currentTime + retentionMs).toISOString();
    writeState(state);
    return true;
  }

  function release({ integration, tenantId, eventId }) {
    const state = readState();
    const keyHash = hashKey(integration, tenantId, eventId);
    const before = state.events.length;
    state.events = state.events.filter((event) => event.keyHash !== keyHash);
    if (state.events.length !== before) writeState(state);
    return state.events.length !== before;
  }

  function inspect() {
    const state = readState();
    prune(state, now());
    return state.events.map((event) => ({ ...event }));
  }

  return { file, claim, complete, release, inspect };
}

const defaultStore = createWebhookEventStore();

module.exports = {
  SCHEMA_VERSION,
  hashKey,
  createWebhookEventStore,
  claimWebhookEvent: defaultStore.claim,
  completeWebhookEvent: defaultStore.complete,
  releaseWebhookEvent: defaultStore.release,
};
