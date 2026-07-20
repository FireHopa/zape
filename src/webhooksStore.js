const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { encryptSecret, decryptSecret, isEncryptedSecret } = require('./secretVault');

const DATA_DIR = process.env.ZAPE_DATA_DIR
  ? path.resolve(process.env.ZAPE_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'webhooks.json');
const SCHEMA_VERSION = 2;

function envBool(value) {
  const text = String(value || '').trim();
  return text === '1' || /^(true|yes|on)$/i.test(text);
}

function _loadRaw() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function _runtimeRow(raw) {
  const row = { ...raw };
  delete row.tokenEncrypted;
  delete row.tokenHash;
  const legacyToken = String(raw.token || '').trim();
  let token = '';
  let decryptError = '';

  if (isEncryptedSecret(raw.tokenEncrypted)) {
    try {
      token = decryptSecret(raw.tokenEncrypted);
    } catch (error) {
      decryptError = error.code || 'SECRET_DECRYPT_FAILED';
    }
  } else if (legacyToken && envBool(process.env.ALLOW_LEGACY_PLAINTEXT_SECRETS)) {
    token = legacyToken;
  }

  row.token = token;
  Object.defineProperty(row, '_security', {
    value: {
      encrypted: isEncryptedSecret(raw.tokenEncrypted),
      legacyPlaintext: Boolean(legacyToken),
      decryptError,
    },
    enumerable: false,
  });
  return row;
}

function _loadAll() {
  return _loadRaw().map(_runtimeRow);
}

function _serializeRow(row) {
  const next = { ...row, schemaVersion: SCHEMA_VERSION };
  const token = String(row.token || '').trim();
  delete next.token;
  delete next._security;
  if (token) {
    next.tokenEncrypted = encryptSecret(token);
    next.tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  } else if (!isEncryptedSecret(next.tokenEncrypted)) {
    delete next.tokenEncrypted;
    delete next.tokenHash;
  }
  return next;
}

function _saveAll(rows) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true, mode: 0o700 });
  const serialized = rows.map(_serializeRow);
  const tempFile = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(serialized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempFile, DATA_FILE);
  try { fs.chmodSync(DATA_FILE, 0o600); } catch { /* best effort */ }
}

function _genId() {
  return crypto.randomBytes(12).toString('hex');
}

function _genToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function listWebhooks(tenantId) {
  const tenant = String(tenantId || '').trim() || 'admin';
  return _loadAll().filter((webhook) => webhook.tenantId === tenant && !webhook.deletedAt);
}

function _sanitizeCrmTarget(value) {
  if (value === null || value === false || value === '') return null;
  if (!value || typeof value !== 'object') return undefined;
  const pipelineId = String(value.pipelineId || '').trim();
  const stageId = String(value.stageId || '').trim();
  if (!pipelineId || !stageId) return null;
  const now = new Date().toISOString();
  return {
    enabled: value.enabled !== false,
    pipelineId,
    stageId,
    linkedAt: value.linkedAt || now,
    updatedAt: now,
  };
}

function _sanitizeExternalCrmTarget(value) {
  if (value === null || value === false || value === '') return null;
  if (!value || typeof value !== 'object') return undefined;
  if (value.enabled === false) return null;
  const allowedSources = new Set(['WhatsApp', 'Landing Page', 'Evento', 'Instagram', 'Google', 'Indicação', 'Tráfego Pago', 'Outro']);
  const source = String(value.source || 'WhatsApp').trim();
  const now = new Date().toISOString();
  return {
    enabled: true,
    pipelineId: String(value.pipelineId || '').trim(),
    stageId: String(value.stageId || '').trim(),
    source: allowedSources.has(source) ? source : 'WhatsApp',
    linkedAt: value.linkedAt || now,
    updatedAt: now,
  };
}

function createWebhook(tenantId, { name, messageText, messages, crmTarget, externalCrmTarget } = {}) {
  const tenant = String(tenantId || '').trim() || 'admin';
  const all = _loadAll();
  let token = _genToken();
  const tokenHashes = new Set(all.map((item) => String(item.token || '')).filter(Boolean).map((item) => crypto.createHash('sha256').update(item).digest('hex')));
  while (tokenHashes.has(crypto.createHash('sha256').update(token).digest('hex'))) token = _genToken();

  const now = new Date().toISOString();
  const messagesArray = Array.isArray(messages) ? messages : (messageText ? [String(messageText).trim()] : []);
  const row = {
    id: _genId(),
    tenantId: tenant,
    token,
    name: String(name || 'Webhook').trim() || 'Webhook',
    messageText: messagesArray[0] || '',
    messages: messagesArray,
    crmTarget: _sanitizeCrmTarget(crmTarget) || null,
    externalCrmTarget: _sanitizeExternalCrmTarget(externalCrmTarget) || null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  all.unshift(row);
  _saveAll(all);
  return row;
}

function updateWebhook(tenantId, webhookId, patch = {}) {
  const tenant = String(tenantId || '').trim() || 'admin';
  const all = _loadAll();
  const index = all.findIndex((webhook) => webhook.id === webhookId && webhook.tenantId === tenant && !webhook.deletedAt);
  if (index < 0) return { ok: false, error: 'Webhook não encontrado.' };

  const current = all[index];
  const next = { ...current };
  if (patch.name !== undefined) next.name = String(patch.name || '').trim() || current.name || 'Webhook';
  if (patch.messages !== undefined && Array.isArray(patch.messages)) {
    next.messages = patch.messages.map((message) => String(message).trim()).filter(Boolean);
    next.messageText = next.messages[0] || '';
  } else if (patch.messageText !== undefined) {
    next.messageText = String(patch.messageText || '').trim();
    if (!next.messages) next.messages = [];
    next.messages[0] = next.messageText;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'crmTarget')) {
    const cleanedTarget = _sanitizeCrmTarget(patch.crmTarget);
    next.crmTarget = cleanedTarget === undefined ? (next.crmTarget || null) : cleanedTarget;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'externalCrmTarget')) {
    const cleanedTarget = _sanitizeExternalCrmTarget(patch.externalCrmTarget);
    next.externalCrmTarget = cleanedTarget === undefined ? (next.externalCrmTarget || null) : cleanedTarget;
  }
  next.updatedAt = new Date().toISOString();
  all[index] = next;
  _saveAll(all);
  return { ok: true, webhook: next };
}

function deleteWebhook(tenantId, webhookId) {
  const tenant = String(tenantId || '').trim() || 'admin';
  const all = _loadAll();
  const index = all.findIndex((webhook) => webhook.id === webhookId && webhook.tenantId === tenant && !webhook.deletedAt);
  if (index < 0) return { ok: false, error: 'Webhook não encontrado.' };
  all[index].deletedAt = new Date().toISOString();
  all[index].updatedAt = new Date().toISOString();
  _saveAll(all);
  return { ok: true };
}

function resolveWebhookToken(token) {
  const candidate = String(token || '').trim();
  if (!candidate) return null;
  const candidateHash = crypto.createHash('sha256').update(candidate).digest('hex');
  const rawMatch = _loadRaw().find((row) => row.tokenHash === candidateHash && !row.deletedAt);
  if (rawMatch) {
    const runtime = _runtimeRow(rawMatch);
    return runtime.token && crypto.timingSafeEqual(Buffer.from(runtime.token), Buffer.from(candidate)) ? runtime : null;
  }

  // Compatibilidade temporária somente quando explicitamente habilitada.
  if (envBool(process.env.ALLOW_LEGACY_PLAINTEXT_SECRETS)) {
    const legacy = _loadRaw().find((row) => String(row.token || '') === candidate && !row.deletedAt);
    return legacy ? _runtimeRow(legacy) : null;
  }
  return null;
}

module.exports = {
  DATA_FILE,
  SCHEMA_VERSION,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  resolveWebhookToken,
};
