// src/waCloudConfigStore.js
/**
 * Configuração local da integração oficial WhatsApp Cloud API / Embedded Signup.
 *
 * Correção importante:
 * - App ID, App Secret, Configuration ID e Graph Version podem vir do .env ou do painel.
 * - Token, WABA ID e Phone Number ID são um conjunto único e NÃO devem ser misturados.
 * - Se existir qualquer rastro de conexão feita pelo painel, o runtime usa o painel.
 *   Isso evita o bug: display/número do painel + WABA antigo do .env.
 * - O .env só assume as credenciais da Cloud API quando não existe conexão do painel
 *   ou quando WA_CLOUD_FORCE_ENV=1 está definido explicitamente.
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_FILE = path.join(DATA_DIR, "wa_cloud_config.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function normalizeStoredConfig(raw = {}) {
  if (!raw || typeof raw !== "object") return {};
  const out = { ...raw };

  // Compatibilidade com versões antigas ou payloads vindos direto da Meta.
  if (!out.accessToken && raw.token) out.accessToken = raw.token;
  if (!out.accessToken && raw.access_token) out.accessToken = raw.access_token;
  if (!out.phoneNumberId && raw.phone_number_id) out.phoneNumberId = raw.phone_number_id;
  if (!out.wabaId && raw.waba_id) out.wabaId = raw.waba_id;
  if (!out.businessId && raw.business_id) out.businessId = raw.business_id;
  if (!out.displayPhoneNumber && raw.display_phone_number) out.displayPhoneNumber = raw.display_phone_number;
  if (!out.verifiedName && raw.verified_name) out.verifiedName = raw.verified_name;

  // Se a sessão do Embedded Signup estiver salva, também usamos como fallback.
  const sess = raw.lastEmbeddedSession && raw.lastEmbeddedSession.data ? raw.lastEmbeddedSession.data : null;
  if (sess) {
    if (!out.phoneNumberId && sess.phone_number_id) out.phoneNumberId = sess.phone_number_id;
    if (!out.wabaId && sess.waba_id) out.wabaId = sess.waba_id;
    if (!out.businessId && sess.business_id) out.businessId = sess.business_id;
  }

  return out;
}

function readStoredConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) || {};
    return normalizeStoredConfig(raw && typeof raw === "object" ? raw : {});
  } catch {
    return {};
  }
}

function writeStoredConfig(patch = {}) {
  ensureDir();
  const prev = readStoredConfig();
  const next = {
    ...prev,
    ...sanitizeConfigPatch(patch),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

function sanitizeConfigPatch(patch = {}) {
  const out = {};
  const copyString = (from, to = from) => {
    if (Object.prototype.hasOwnProperty.call(patch, from)) {
      out[to] = String(patch[from] ?? "").trim();
    }
  };

  copyString("appId");
  copyString("appSecret");
  copyString("configurationId");
  copyString("graphVersion");
  copyString("redirectUri");
  copyString("accessToken");
  copyString("access_token", "accessToken");
  copyString("tokenType");
  copyString("tokenExpiresIn");
  copyString("phoneNumberId");
  copyString("phone_number_id", "phoneNumberId");
  copyString("wabaId");
  copyString("waba_id", "wabaId");
  copyString("businessId");
  copyString("business_id", "businessId");
  copyString("displayPhoneNumber");
  copyString("display_phone_number", "displayPhoneNumber");
  copyString("verifiedName");
  copyString("verified_name", "verifiedName");

  if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
    out.enabled = Boolean(patch.enabled);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "preferPanelCredentials")) {
    out.preferPanelCredentials = Boolean(patch.preferPanelCredentials);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastEmbeddedSession")) {
    out.lastEmbeddedSession = patch.lastEmbeddedSession || null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "linkedAt")) {
    out.linkedAt = String(patch.linkedAt || "");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "subscribedAt")) {
    out.subscribedAt = String(patch.subscribedAt || "");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastSubscribeError")) {
    out.lastSubscribeError = patch.lastSubscribeError || null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastTokenDebug")) {
    out.lastTokenDebug = patch.lastTokenDebug || null;
  }

  return out;
}

function envFirst(...keys) {
  for (const key of keys) {
    const v = process.env[key];
    if (v !== undefined && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function envBool(value) {
  const s = String(value || "").trim();
  return s === "1" || /^(true|yes|on)$/i.test(s);
}

function hasPanelConnectionTrace(stored = {}) {
  return Boolean(
    stored.preferPanelCredentials ||
    stored.appId ||
    stored.configurationId ||
    stored.accessToken ||
    stored.phoneNumberId ||
    stored.wabaId ||
    stored.businessId ||
    stored.displayPhoneNumber ||
    stored.verifiedName ||
    stored.linkedAt ||
    stored.lastEmbeddedSession
  );
}

function getCloudCredentialSource(stored) {
  const envToken = envFirst("WA_CLOUD_TOKEN", "META_WA_ACCESS_TOKEN");
  const envPhoneNumberId = envFirst("WA_CLOUD_PHONE_NUMBER_ID", "META_WA_PHONE_NUMBER_ID");
  const envWabaId = envFirst("WA_CLOUD_WABA_ID", "META_WA_WABA_ID");
  const forceEnv = envBool(envFirst("WA_CLOUD_FORCE_ENV", "META_WA_FORCE_ENV"));

  const storedToken = String(stored.accessToken || "").trim();
  const storedPhoneNumberId = String(stored.phoneNumberId || "").trim();
  const storedWabaId = String(stored.wabaId || "").trim();
  const panelTrace = hasPanelConnectionTrace(stored);
  const storedComplete = Boolean(storedToken && storedPhoneNumberId && storedWabaId);
  const envComplete = Boolean(envToken && envPhoneNumberId && envWabaId);
  const envHasAny = Boolean(envToken || envPhoneNumberId || envWabaId);

  if (forceEnv) {
    return {
      source: "env",
      forceEnv: true,
      token: envToken,
      phoneNumberId: envPhoneNumberId,
      wabaId: envWabaId,
      complete: envComplete,
      needsRelink: false,
      mixedWarning: panelTrace ? "WA_CLOUD_FORCE_ENV=1 está ativo. As credenciais salvas pelo painel foram ignoradas." : "",
      env: { hasToken: !!envToken, phoneNumberId: envPhoneNumberId, wabaId: envWabaId },
      stored: { hasToken: !!storedToken, phoneNumberId: storedPhoneNumberId, wabaId: storedWabaId, hasPanelTrace: panelTrace },
    };
  }

  // Regra principal da correção: se o painel já registrou qualquer conexão,
  // não fazemos fallback silencioso para o .env. Fallback silencioso foi o que
  // misturou token/número/WABA de origens diferentes.
  if (panelTrace) {
    const envDifferent = Boolean(
      envHasAny && (
        (envToken && storedToken && envToken !== storedToken) ||
        (envPhoneNumberId && storedPhoneNumberId && envPhoneNumberId !== storedPhoneNumberId) ||
        (envWabaId && storedWabaId && envWabaId !== storedWabaId) ||
        !storedComplete
      )
    );
    return {
      source: "stored",
      forceEnv: false,
      token: storedToken,
      phoneNumberId: storedPhoneNumberId,
      wabaId: storedWabaId,
      complete: storedComplete,
      needsRelink: !storedComplete,
      mixedWarning: envDifferent
        ? "Existem credenciais no .env, mas o painel está usando apenas a conexão salva pelo Embedded Signup. Isso evita misturar Token/WABA/Phone de origens diferentes. Para usar o .env de propósito, defina WA_CLOUD_FORCE_ENV=1."
        : "",
      env: { hasToken: !!envToken, phoneNumberId: envPhoneNumberId, wabaId: envWabaId },
      stored: { hasToken: !!storedToken, phoneNumberId: storedPhoneNumberId, wabaId: storedWabaId, hasPanelTrace: true },
    };
  }

  return {
    source: "env",
    forceEnv: false,
    token: envToken,
    phoneNumberId: envPhoneNumberId,
    wabaId: envWabaId,
    complete: envComplete,
    needsRelink: false,
    mixedWarning: "",
    env: { hasToken: !!envToken, phoneNumberId: envPhoneNumberId, wabaId: envWabaId },
    stored: { hasToken: false, phoneNumberId: "", wabaId: "", hasPanelTrace: false },
  };
}

function getRuntimeConfig() {
  const stored = readStoredConfig();

  const envEnabled = envFirst("WA_CLOUD_ENABLED");
  const graphVersion = envFirst("WA_CLOUD_GRAPH_VERSION", "META_GRAPH_VERSION") || stored.graphVersion || "v25.0";
  const credentialSource = getCloudCredentialSource(stored);
  const usingStoredConnection = credentialSource.source === "stored";

  return {
    stored,
    enabled: envEnabled ? envBool(envEnabled) : stored.enabled !== false,
    graphVersion,

    token: credentialSource.token || "",
    phoneNumberId: credentialSource.phoneNumberId || "",
    wabaId: credentialSource.wabaId || "",
    credentialSource,

    appId: envFirst("WA_EMBEDDED_APP_ID", "META_APP_ID", "FACEBOOK_APP_ID") || stored.appId || "",
    appSecret: envFirst("WA_EMBEDDED_APP_SECRET", "META_APP_SECRET", "FACEBOOK_APP_SECRET") || stored.appSecret || "",
    configurationId: envFirst("WA_EMBEDDED_CONFIG_ID", "META_LOGIN_CONFIG_ID", "FACEBOOK_LOGIN_CONFIG_ID") || stored.configurationId || "",
    redirectUri: envFirst("WA_EMBEDDED_REDIRECT_URI", "META_REDIRECT_URI", "FACEBOOK_REDIRECT_URI") || stored.redirectUri || "",

    // Só exibimos metadados do painel quando a origem efetiva é o painel.
    // Isso impede mostrar número/nome antigo junto com WABA vindo do .env.
    businessId: usingStoredConnection ? (stored.businessId || "") : "",
    displayPhoneNumber: usingStoredConnection ? (stored.displayPhoneNumber || "") : "",
    verifiedName: usingStoredConnection ? (stored.verifiedName || "") : "",
    linkedAt: usingStoredConnection ? (stored.linkedAt || "") : "",
    subscribedAt: usingStoredConnection ? (stored.subscribedAt || "") : "",
    lastSubscribeError: usingStoredConnection ? (stored.lastSubscribeError || null) : null,
    lastTokenDebug: usingStoredConnection ? (stored.lastTokenDebug || null) : null,
  };
}

function maskValue(v, keep = 4) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (s.length <= keep * 2) return "•".repeat(Math.max(4, s.length));
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

function clearLinkedCloudConfig() {
  const prev = readStoredConfig();
  const next = {
    ...prev,
    enabled: false,
    accessToken: "",
    tokenType: "",
    tokenExpiresIn: "",
    phoneNumberId: "",
    wabaId: "",
    businessId: "",
    displayPhoneNumber: "",
    verifiedName: "",
    linkedAt: "",
    subscribedAt: "",
    lastSubscribeError: null,
    lastTokenDebug: null,
    lastEmbeddedSession: null,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

module.exports = {
  CONFIG_FILE,
  readStoredConfig,
  writeStoredConfig,
  getRuntimeConfig,
  maskValue,
  clearLinkedCloudConfig,
};
