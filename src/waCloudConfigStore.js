// src/waCloudConfigStore.js
/**
 * Configuração local da integração oficial WhatsApp Cloud API / Embedded Signup.
 *
 * Objetivo: permitir configurar pelo painel, sem editar código ou .env.
 * Por segurança, os valores de ambiente continuam tendo prioridade sobre o arquivo.
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_FILE = path.join(DATA_DIR, "wa_cloud_config.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStoredConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) || {};
    return raw && typeof raw === "object" ? raw : {};
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
  copyString("tokenType");
  copyString("tokenExpiresIn");
  copyString("phoneNumberId");
  copyString("wabaId");
  copyString("businessId");
  copyString("displayPhoneNumber");
  copyString("verifiedName");

  if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
    out.enabled = Boolean(patch.enabled);
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

  return out;
}

function envFirst(...keys) {
  for (const key of keys) {
    const v = process.env[key];
    if (v !== undefined && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function getRuntimeConfig() {
  const stored = readStoredConfig();

  const envEnabled = envFirst("WA_CLOUD_ENABLED");
  const graphVersion = envFirst("WA_CLOUD_GRAPH_VERSION", "META_GRAPH_VERSION") || stored.graphVersion || "v25.0";

  return {
    stored,
    enabled: envEnabled ? envEnabled === "1" || /^true|yes|on$/i.test(envEnabled) : stored.enabled !== false,
    graphVersion,

    token: envFirst("WA_CLOUD_TOKEN", "META_WA_ACCESS_TOKEN") || stored.accessToken || "",
    phoneNumberId: envFirst("WA_CLOUD_PHONE_NUMBER_ID", "META_WA_PHONE_NUMBER_ID") || stored.phoneNumberId || "",
    wabaId: envFirst("WA_CLOUD_WABA_ID", "META_WA_WABA_ID") || stored.wabaId || "",

    appId: envFirst("WA_EMBEDDED_APP_ID", "META_APP_ID", "FACEBOOK_APP_ID") || stored.appId || "",
    appSecret: envFirst("WA_EMBEDDED_APP_SECRET", "META_APP_SECRET", "FACEBOOK_APP_SECRET") || stored.appSecret || "",
    configurationId: envFirst("WA_EMBEDDED_CONFIG_ID", "META_LOGIN_CONFIG_ID", "FACEBOOK_LOGIN_CONFIG_ID") || stored.configurationId || "",
    redirectUri: envFirst("WA_EMBEDDED_REDIRECT_URI", "META_REDIRECT_URI", "FACEBOOK_REDIRECT_URI") || stored.redirectUri || "",

    businessId: stored.businessId || "",
    displayPhoneNumber: stored.displayPhoneNumber || "",
    verifiedName: stored.verifiedName || "",
    linkedAt: stored.linkedAt || "",
    subscribedAt: stored.subscribedAt || "",
    lastSubscribeError: stored.lastSubscribeError || null,
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
