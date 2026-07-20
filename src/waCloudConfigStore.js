/**
 * Configuração local da integração oficial WhatsApp Cloud API / Embedded Signup.
 *
 * Fase 1 de segurança:
 * - segredos persistentes usam AES-256-GCM com CONFIG_ENCRYPTION_KEY;
 * - App Secret e access token nunca são gravados em texto puro;
 * - formatos legados em texto puro são detectados, mas não usados por padrão;
 * - a migração é explícita, com dry-run e backup, por scripts/migrate-secrets.js.
 */
const fs = require('fs');
const path = require('path');
const {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  encryptionKeyConfigured,
} = require('./secretVault');
const { redactText } = require('./safeLog');

const DATA_DIR = process.env.ZAPE_DATA_DIR
  ? path.resolve(process.env.ZAPE_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'wa_cloud_config.json');
const SCHEMA_VERSION = 2;
const LEGACY_SECRET_FIELDS = ['appSecret', 'accessToken', 'access_token', 'token'];

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function envBool(value) {
  const s = String(value || '').trim();
  return s === '1' || /^(true|yes|on)$/i.test(s);
}

function envFirst(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function readRawStoredConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function normalizeString(value) {
  return String(value ?? '').trim();
}

function sanitizeEmbeddedSession(value) {
  if (!value || typeof value !== 'object') return null;
  const rawData = value.data && typeof value.data === 'object' ? value.data : {};
  const data = {
    waba_id: normalizeString(rawData.waba_id || rawData.wabaId),
    phone_number_id: normalizeString(rawData.phone_number_id || rawData.phoneNumberId),
    business_id: normalizeString(rawData.business_id || rawData.businessId),
  };
  Object.keys(data).forEach((key) => { if (!data[key]) delete data[key]; });
  return {
    event: normalizeString(value.event || value.type).slice(0, 100),
    data,
  };
}

function sanitizeTokenDebug(value) {
  const data = value && value.data && typeof value.data === 'object' ? value.data : null;
  if (!data) return value && value.error ? { error: redactText(value.error) } : null;
  const granularScopes = Array.isArray(data.granular_scopes)
    ? data.granular_scopes.slice(0, 20).map((item) => ({
      scope: normalizeString(item && item.scope).slice(0, 120),
      target_ids: Array.isArray(item && item.target_ids)
        ? item.target_ids.slice(0, 100).map(normalizeString).filter(Boolean)
        : [],
    }))
    : [];
  return {
    data: {
      app_id: normalizeString(data.app_id),
      is_valid: data.is_valid !== false,
      expires_at: Number(data.expires_at || 0) || 0,
      data_access_expires_at: Number(data.data_access_expires_at || 0) || 0,
      scopes: Array.isArray(data.scopes) ? data.scopes.slice(0, 100).map(normalizeString).filter(Boolean) : [],
      granular_scopes: granularScopes,
    },
  };
}

function sanitizeSubscribeError(value) {
  if (!value || typeof value !== 'object') return null;
  const payloadError = value.payload && value.payload.error && typeof value.payload.error === 'object'
    ? value.payload.error
    : null;
  return {
    message: redactText(value.message || payloadError?.message || 'Falha ao assinar webhook.'),
    status: Number(value.status || value.statusCode || 0) || null,
    code: normalizeString(value.code || payloadError?.code).slice(0, 80) || null,
    subcode: normalizeString(value.subcode || payloadError?.error_subcode).slice(0, 80) || null,
  };
}

function normalizeStoredConfig(raw = {}) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  const copyString = (from, to = from) => {
    if (hasOwn(raw, from)) out[to] = normalizeString(raw[from]);
  };

  copyString('appId');
  copyString('configurationId');
  copyString('graphVersion');
  copyString('redirectUri');
  copyString('tokenType');
  copyString('tokenExpiresIn');
  copyString('phoneNumberId');
  copyString('phone_number_id', 'phoneNumberId');
  copyString('wabaId');
  copyString('waba_id', 'wabaId');
  copyString('businessId');
  copyString('business_id', 'businessId');
  copyString('displayPhoneNumber');
  copyString('display_phone_number', 'displayPhoneNumber');
  copyString('verifiedName');
  copyString('verified_name', 'verifiedName');
  copyString('linkedAt');
  copyString('subscribedAt');
  copyString('updatedAt');

  if (hasOwn(raw, 'enabled')) out.enabled = Boolean(raw.enabled);
  if (hasOwn(raw, 'preferPanelCredentials')) out.preferPanelCredentials = Boolean(raw.preferPanelCredentials);
  out.lastEmbeddedSession = sanitizeEmbeddedSession(raw.lastEmbeddedSession);
  out.lastSubscribeError = sanitizeSubscribeError(raw.lastSubscribeError);
  out.lastTokenDebug = sanitizeTokenDebug(raw.lastTokenDebug);

  const encrypted = raw.encryptedSecrets && typeof raw.encryptedSecrets === 'object'
    ? raw.encryptedSecrets
    : {};
  const legacyPlaintextFields = LEGACY_SECRET_FIELDS.filter((field) => normalizeString(raw[field]));
  const security = {
    schemaVersion: Number(raw.schemaVersion || 1),
    encryptedAppSecret: isEncryptedSecret(encrypted.appSecret),
    encryptedAccessToken: isEncryptedSecret(encrypted.accessToken),
    legacyPlaintextFields,
    encryptionKeyConfigured: false,
    decryptError: '',
  };

  try {
    security.encryptionKeyConfigured = encryptionKeyConfigured();
    if (security.encryptedAppSecret) out.appSecret = decryptSecret(encrypted.appSecret);
    if (security.encryptedAccessToken) out.accessToken = decryptSecret(encrypted.accessToken);
  } catch (error) {
    security.decryptError = error.code || 'SECRET_DECRYPT_FAILED';
    out.appSecret = '';
    out.accessToken = '';
  }

  // Compatibilidade de emergência, desativada por padrão. O caminho normal é migrar.
  if (envBool(process.env.ALLOW_LEGACY_PLAINTEXT_SECRETS)) {
    if (!out.appSecret) out.appSecret = normalizeString(raw.appSecret);
    if (!out.accessToken) out.accessToken = normalizeString(raw.accessToken || raw.access_token || raw.token);
  }

  const sessionData = out.lastEmbeddedSession && out.lastEmbeddedSession.data;
  if (sessionData) {
    if (!out.phoneNumberId) out.phoneNumberId = normalizeString(sessionData.phone_number_id);
    if (!out.wabaId) out.wabaId = normalizeString(sessionData.waba_id);
    if (!out.businessId) out.businessId = normalizeString(sessionData.business_id);
  }

  Object.defineProperty(out, '_security', {
    value: security,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return out;
}

function readStoredConfig() {
  return normalizeStoredConfig(readRawStoredConfig());
}

function sanitizeConfigPatch(patch = {}) {
  const out = {};
  const copyString = (from, to = from) => {
    if (hasOwn(patch, from)) out[to] = normalizeString(patch[from]);
  };

  copyString('appId');
  copyString('appSecret');
  copyString('configurationId');
  copyString('graphVersion');
  copyString('redirectUri');
  copyString('accessToken');
  copyString('access_token', 'accessToken');
  copyString('tokenType');
  copyString('tokenExpiresIn');
  copyString('phoneNumberId');
  copyString('phone_number_id', 'phoneNumberId');
  copyString('wabaId');
  copyString('waba_id', 'wabaId');
  copyString('businessId');
  copyString('business_id', 'businessId');
  copyString('displayPhoneNumber');
  copyString('display_phone_number', 'displayPhoneNumber');
  copyString('verifiedName');
  copyString('verified_name', 'verifiedName');
  copyString('linkedAt');
  copyString('subscribedAt');

  if (hasOwn(patch, 'enabled')) out.enabled = Boolean(patch.enabled);
  if (hasOwn(patch, 'preferPanelCredentials')) out.preferPanelCredentials = Boolean(patch.preferPanelCredentials);
  if (hasOwn(patch, 'lastEmbeddedSession')) out.lastEmbeddedSession = sanitizeEmbeddedSession(patch.lastEmbeddedSession);
  if (hasOwn(patch, 'lastSubscribeError')) out.lastSubscribeError = sanitizeSubscribeError(patch.lastSubscribeError);
  if (hasOwn(patch, 'lastTokenDebug')) out.lastTokenDebug = sanitizeTokenDebug(patch.lastTokenDebug);
  return out;
}

function serializeStoredConfig(runtime = {}) {
  const out = {
    schemaVersion: SCHEMA_VERSION,
    enabled: runtime.enabled !== false,
    preferPanelCredentials: Boolean(runtime.preferPanelCredentials),
    appId: normalizeString(runtime.appId),
    configurationId: normalizeString(runtime.configurationId),
    graphVersion: normalizeString(runtime.graphVersion) || 'v25.0',
    redirectUri: normalizeString(runtime.redirectUri),
    tokenType: normalizeString(runtime.tokenType),
    tokenExpiresIn: normalizeString(runtime.tokenExpiresIn),
    phoneNumberId: normalizeString(runtime.phoneNumberId),
    wabaId: normalizeString(runtime.wabaId),
    businessId: normalizeString(runtime.businessId),
    displayPhoneNumber: normalizeString(runtime.displayPhoneNumber),
    verifiedName: normalizeString(runtime.verifiedName),
    linkedAt: normalizeString(runtime.linkedAt),
    subscribedAt: normalizeString(runtime.subscribedAt),
    lastSubscribeError: sanitizeSubscribeError(runtime.lastSubscribeError),
    lastEmbeddedSession: sanitizeEmbeddedSession(runtime.lastEmbeddedSession),
    lastTokenDebug: sanitizeTokenDebug(runtime.lastTokenDebug),
    encryptedSecrets: {},
    updatedAt: new Date().toISOString(),
  };

  if (normalizeString(runtime.appSecret)) {
    out.encryptedSecrets.appSecret = encryptSecret(runtime.appSecret);
  }
  if (normalizeString(runtime.accessToken)) {
    out.encryptedSecrets.accessToken = encryptSecret(runtime.accessToken);
  }
  if (!Object.keys(out.encryptedSecrets).length) delete out.encryptedSecrets;
  return out;
}

function atomicWriteJson(filePath, value) {
  ensureDir();
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempFile, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
}

function writeStoredConfig(patch = {}) {
  const prev = readStoredConfig();
  const cleaned = sanitizeConfigPatch(patch);
  const next = { ...prev, ...cleaned };
  const serialized = serializeStoredConfig(next);
  atomicWriteJson(CONFIG_FILE, serialized);
  return normalizeStoredConfig(serialized);
}

function hasPanelConnectionTrace(stored = {}) {
  const security = stored._security || {};
  return Boolean(
    stored.preferPanelCredentials || stored.appId || stored.configurationId ||
    stored.accessToken || stored.phoneNumberId || stored.wabaId || stored.businessId ||
    stored.displayPhoneNumber || stored.verifiedName || stored.linkedAt ||
    stored.lastEmbeddedSession || security.encryptedAccessToken || security.legacyPlaintextFields?.length
  );
}

function getCloudCredentialSource(stored) {
  const envToken = envFirst('WA_CLOUD_TOKEN', 'META_WA_ACCESS_TOKEN');
  const envPhoneNumberId = envFirst('WA_CLOUD_PHONE_NUMBER_ID', 'META_WA_PHONE_NUMBER_ID');
  const envWabaId = envFirst('WA_CLOUD_WABA_ID', 'META_WA_WABA_ID');
  const forceEnv = envBool(envFirst('WA_CLOUD_FORCE_ENV', 'META_WA_FORCE_ENV'));
  const storedToken = normalizeString(stored.accessToken);
  const storedPhoneNumberId = normalizeString(stored.phoneNumberId);
  const storedWabaId = normalizeString(stored.wabaId);
  const security = stored._security || {};
  const panelTrace = hasPanelConnectionTrace(stored);
  const storedComplete = Boolean(storedToken && storedPhoneNumberId && storedWabaId);
  const envComplete = Boolean(envToken && envPhoneNumberId && envWabaId);
  const envHasAny = Boolean(envToken || envPhoneNumberId || envWabaId);

  if (forceEnv) {
    return {
      source: 'env', forceEnv: true, token: envToken, phoneNumberId: envPhoneNumberId, wabaId: envWabaId,
      complete: envComplete, needsRelink: false,
      mixedWarning: panelTrace ? 'WA_CLOUD_FORCE_ENV=1 está ativo. A conexão persistida foi ignorada.' : '',
      env: { hasToken: !!envToken, phoneNumberId: envPhoneNumberId, wabaId: envWabaId },
      stored: { hasToken: !!storedToken || !!security.encryptedAccessToken, phoneNumberId: storedPhoneNumberId, wabaId: storedWabaId, hasPanelTrace: panelTrace },
      secretStorage: security,
    };
  }

  if (panelTrace) {
    const storageUnavailable = Boolean(security.decryptError || security.legacyPlaintextFields?.length);
    const envDifferent = Boolean(envHasAny && (
      (envToken && storedToken && envToken !== storedToken) ||
      (envPhoneNumberId && storedPhoneNumberId && envPhoneNumberId !== storedPhoneNumberId) ||
      (envWabaId && storedWabaId && envWabaId !== storedWabaId) || !storedComplete
    ));
    return {
      source: 'stored', forceEnv: false, token: storedToken, phoneNumberId: storedPhoneNumberId, wabaId: storedWabaId,
      complete: storedComplete, needsRelink: !storedComplete,
      mixedWarning: storageUnavailable
        ? 'A conexão persistida contém segredo legado ou não pôde ser descriptografada. Execute a migração segura e verifique CONFIG_ENCRYPTION_KEY.'
        : envDifferent
          ? 'Existem credenciais no ambiente, mas o painel está usando somente a conexão persistida para evitar mistura de contas.'
          : '',
      env: { hasToken: !!envToken, phoneNumberId: envPhoneNumberId, wabaId: envWabaId },
      stored: { hasToken: !!storedToken || !!security.encryptedAccessToken, phoneNumberId: storedPhoneNumberId, wabaId: storedWabaId, hasPanelTrace: true },
      secretStorage: security,
    };
  }

  return {
    source: 'env', forceEnv: false, token: envToken, phoneNumberId: envPhoneNumberId, wabaId: envWabaId,
    complete: envComplete, needsRelink: false, mixedWarning: '',
    env: { hasToken: !!envToken, phoneNumberId: envPhoneNumberId, wabaId: envWabaId },
    stored: { hasToken: false, phoneNumberId: '', wabaId: '', hasPanelTrace: false },
    secretStorage: security,
  };
}

function getRuntimeConfig() {
  const stored = readStoredConfig();
  const envEnabled = envFirst('WA_CLOUD_ENABLED');
  const graphVersion = envFirst('WA_CLOUD_GRAPH_VERSION', 'META_GRAPH_VERSION') || stored.graphVersion || 'v25.0';
  const credentialSource = getCloudCredentialSource(stored);
  const usingStoredConnection = credentialSource.source === 'stored';

  return {
    stored,
    enabled: envEnabled ? envBool(envEnabled) : stored.enabled !== false,
    graphVersion,
    token: credentialSource.token || '',
    phoneNumberId: credentialSource.phoneNumberId || '',
    wabaId: credentialSource.wabaId || '',
    credentialSource,
    appId: envFirst('WA_EMBEDDED_APP_ID', 'META_APP_ID', 'FACEBOOK_APP_ID') || stored.appId || '',
    appSecret: envFirst('WA_EMBEDDED_APP_SECRET', 'META_APP_SECRET', 'FACEBOOK_APP_SECRET') || stored.appSecret || '',
    configurationId: envFirst('WA_EMBEDDED_CONFIG_ID', 'META_LOGIN_CONFIG_ID', 'FACEBOOK_LOGIN_CONFIG_ID') || stored.configurationId || '',
    redirectUri: envFirst('WA_EMBEDDED_REDIRECT_URI', 'META_REDIRECT_URI', 'FACEBOOK_REDIRECT_URI') || stored.redirectUri || '',
    businessId: usingStoredConnection ? (stored.businessId || '') : '',
    displayPhoneNumber: usingStoredConnection ? (stored.displayPhoneNumber || '') : '',
    verifiedName: usingStoredConnection ? (stored.verifiedName || '') : '',
    linkedAt: usingStoredConnection ? (stored.linkedAt || '') : '',
    subscribedAt: usingStoredConnection ? (stored.subscribedAt || '') : '',
    lastSubscribeError: usingStoredConnection ? (stored.lastSubscribeError || null) : null,
    lastTokenDebug: usingStoredConnection ? (stored.lastTokenDebug || null) : null,
  };
}

function maskValue(value, keep = 4) {
  const text = normalizeString(value);
  if (!text) return '';
  if (text.length <= keep * 2) return '•'.repeat(Math.max(4, text.length));
  return `${text.slice(0, keep)}…${text.slice(-keep)}`;
}

function clearLinkedCloudConfig() {
  const raw = readRawStoredConfig();
  const encryptedSecrets = raw.encryptedSecrets && typeof raw.encryptedSecrets === 'object'
    ? { ...raw.encryptedSecrets }
    : {};
  delete encryptedSecrets.accessToken;

  const next = {
    ...raw,
    schemaVersion: SCHEMA_VERSION,
    enabled: false,
    tokenType: '',
    tokenExpiresIn: '',
    phoneNumberId: '',
    wabaId: '',
    businessId: '',
    displayPhoneNumber: '',
    verifiedName: '',
    linkedAt: '',
    subscribedAt: '',
    lastSubscribeError: null,
    lastTokenDebug: null,
    lastEmbeddedSession: null,
    encryptedSecrets,
    updatedAt: new Date().toISOString(),
  };
  LEGACY_SECRET_FIELDS.forEach((field) => { delete next[field]; });
  if (!Object.keys(encryptedSecrets).length) delete next.encryptedSecrets;
  atomicWriteJson(CONFIG_FILE, next);
  return normalizeStoredConfig(next);
}

module.exports = {
  CONFIG_FILE,
  SCHEMA_VERSION,
  LEGACY_SECRET_FIELDS,
  readRawStoredConfig,
  normalizeStoredConfig,
  readStoredConfig,
  writeStoredConfig,
  getRuntimeConfig,
  maskValue,
  clearLinkedCloudConfig,
  sanitizeEmbeddedSession,
  sanitizeTokenDebug,
};
