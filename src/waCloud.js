// src/waCloud.js
/**
 * WhatsApp Business Cloud API (oficial / Meta Graph).
 *
 * Requisitos (env):
 *  - WA_CLOUD_ENABLED=1
 *  - WA_CLOUD_TOKEN=EAAB...
 *  - WA_CLOUD_PHONE_NUMBER_ID=123...
 *  - (opcional) WA_CLOUD_WABA_ID=123...  (para listar templates)
 *  - (opcional) WA_CLOUD_GRAPH_VERSION=v25.0
 *  - (opcional) WA_CLOUD_WEBHOOK_VERIFY_TOKEN=seu_token (para verificação do webhook)
 *
 * Webhook recomendado:
 *  - POST /webhooks/wa-cloud  (status + mensagens recebidas)
 *  - GET  /webhooks/wa-cloud  (verificação)
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STATUS_FILE = path.join(DATA_DIR, "wa_cloud_message_status.json");

const {
  getRuntimeConfig,
  writeStoredConfig,
  maskValue,
  clearLinkedCloudConfig,
} = require("./waCloudConfigStore");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(STATUS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf-8")) || {};
  } catch {
    return {};
  }
}

function saveAll(obj) {
  ensureDir();
  fs.writeFileSync(STATUS_FILE, JSON.stringify(obj, null, 2), "utf-8");
}

function upsertStatus(toDigits, patch) {
  if (!toDigits) return null;
  const all = loadAll();
  const prev = all[toDigits] || { toDigits };
  const next = { ...prev, ...patch, toDigits, updatedAt: new Date().toISOString() };
  all[toDigits] = next;
  saveAll(all);
  return next;
}

function getStatus(toDigits) {
  const all = loadAll();
  return all[toDigits] || null;
}

function listStatus() {
  const all = loadAll();
  return Object.values(all);
}

function isCloudConfigured() {
  const cfg = getRuntimeConfig();
  return cfg.enabled && !!cfg.token && !!cfg.phoneNumberId;
}

function graphBase() {
  const cfg = getRuntimeConfig();
  const v = cfg.graphVersion || "v25.0";
  return `https://graph.facebook.com/${v}`;
}

function getCloudAccessToken() {
  return getRuntimeConfig().token;
}

async function graphFetch(url, { method = "GET", body, headers, token } = {}) {
  const accessToken = token || getCloudAccessToken();
  if (!accessToken) throw new Error("Token da WhatsApp Cloud API ausente.");

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }

  if (!res.ok) {
    const msg = (json && (json.error?.message || json.error?.error_user_msg)) || text || `HTTP ${res.status}`;
    const e = new Error(msg);
    e.status = res.status;
    e.payload = json || text;
    throw e;
  }
  return json;
}

async function graphFetchNoAuth(url, { method = "GET", body, headers } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }

  if (!res.ok) {
    const msg = (json && (json.error?.message || json.error?.error_user_msg)) || text || `HTTP ${res.status}`;
    const e = new Error(msg);
    e.status = res.status;
    e.payload = json || text;
    throw e;
  }
  return json;
}


function cleanTemplateName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

function extractNumericVars(text) {
  const out = [];
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

function assertSequentialVariables(text, label) {
  const nums = extractNumericVars(text);
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== i + 1) {
      throw new Error(`${label}: use variáveis sequenciais no formato {{1}}, {{2}}, {{3}} sem pular números.`);
    }
  }
  return nums;
}

function normalizeQuickReplyButtons(buttons) {
  const raw = Array.isArray(buttons)
    ? buttons
    : String(buttons || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

  return raw
    .map((b) => (typeof b === "string" ? { type: "QUICK_REPLY", text: b } : b))
    .map((b) => ({ type: "QUICK_REPLY", text: String(b?.text || "").trim() }))
    .filter((b) => b.text)
    .slice(0, 3);
}

function buildTemplateComponents(input = {}) {
  const components = [];

  const headerText = String(input.headerText || "").trim();
  const headerExample = String(input.headerExample || "").trim();
  if (headerText) {
    if (headerText.length > 60) throw new Error("Header deve ter no máximo 60 caracteres.");
    const headerVars = assertSequentialVariables(headerText, "Header");
    if (headerVars.length > 1) throw new Error("Header de texto aceita no máximo 1 variável.");
    const header = { type: "HEADER", format: "TEXT", text: headerText };
    if (headerVars.length) {
      if (!headerExample) throw new Error("Informe um exemplo para a variável do header.");
      header.example = { header_text: [headerExample] };
    }
    components.push(header);
  }

  const bodyText = String(input.bodyText || input.body || "").trim();
  if (!bodyText) throw new Error("Corpo da mensagem é obrigatório.");
  if (bodyText.length > 1024) throw new Error("Corpo da mensagem deve ter no máximo 1024 caracteres.");

  const bodyVars = assertSequentialVariables(bodyText, "Corpo");
  const body = { type: "BODY", text: bodyText };
  if (bodyVars.length) {
    const bodyExamples = Array.isArray(input.bodyExamples)
      ? input.bodyExamples.map((x) => String(x ?? "").trim())
      : [];

    if (bodyExamples.length < bodyVars.length || bodyExamples.slice(0, bodyVars.length).some((x) => !x)) {
      throw new Error(`Informe ${bodyVars.length} exemplo(s) para as variáveis do corpo.`);
    }
    body.example = { body_text: [bodyExamples.slice(0, bodyVars.length)] };
  }
  components.push(body);

  const footerText = String(input.footerText || "").trim();
  if (footerText) {
    if (footerText.length > 60) throw new Error("Footer deve ter no máximo 60 caracteres.");
    if (/\{\{\s*\d+\s*\}\}/.test(footerText)) throw new Error("Footer não deve usar variáveis.");
    components.push({ type: "FOOTER", text: footerText });
  }

  const buttons = normalizeQuickReplyButtons(input.quickReplyButtons || input.buttons || []);
  if (buttons.length) {
    for (const b of buttons) {
      if (b.text.length > 25) throw new Error(`Botão \"${b.text}\" deve ter no máximo 25 caracteres.`);
    }
    components.push({ type: "BUTTONS", buttons });
  }

  return components;
}

/**
 * Cria um modelo de mensagem na Meta para aprovação.
 * Endpoint oficial: POST /{whatsapp_business_account_id}/message_templates
 */
async function createTemplate(input = {}) {
  if (!isCloudConfigured()) throw new Error("WA_CLOUD não configurado.");
  const wabaId = getRuntimeConfig().wabaId;
  if (!wabaId) throw new Error("WABA ID ausente (necessário para criar templates).");

  const name = cleanTemplateName(input.name || input.templateName || "");
  if (!name) throw new Error("Nome do template obrigatório.");
  if (name.length > 512) throw new Error("Nome do template deve ter no máximo 512 caracteres.");
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("Nome inválido. Use apenas letras minúsculas, números e underline.");

  const category = String(input.category || "MARKETING").trim().toUpperCase();
  if (!["MARKETING", "UTILITY"].includes(category)) {
    throw new Error("Categoria suportada nesta tela: MARKETING ou UTILITY. AUTHENTICATION exige estrutura própria.");
  }

  const language = String(input.language || input.languageCode || "pt_BR").trim();
  if (!language) throw new Error("Idioma obrigatório. Ex: pt_BR.");

  const payload = {
    name,
    language,
    category,
    allow_category_change: input.allowCategoryChange !== false,
    components: buildTemplateComponents(input),
  };

  const url = `${graphBase()}/${encodeURIComponent(wabaId)}/message_templates`;
  const out = await graphFetch(url, { method: "POST", body: payload });
  return { ...out, submitted: payload };
}

/**
 * Envia TEMPLATE (obrigatório para disparo em massa).
 * components: [{type:"body", parameters:[{type:"text", text:"..."}]}, ...]
 */
async function sendTemplate({ toE164Digits, templateName, languageCode, components, meta }) {
  if (!isCloudConfigured()) throw new Error("WA_CLOUD não configurado.");
  const phoneId = getRuntimeConfig().phoneNumberId;

  const payload = {
    messaging_product: "whatsapp",
    to: String(toE164Digits),
    type: "template",
    template: {
      name: String(templateName),
      language: { code: String(languageCode || "pt_BR") },
      ...(components && components.length ? { components } : {}),
    },
  };

  const url = `${graphBase()}/${encodeURIComponent(phoneId)}/messages`;
  const out = await graphFetch(url, { method: "POST", body: payload });

  // registra status "sent" local (status final vem via webhook)
  upsertStatus(String(toE164Digits), {
    provider: "cloud",
    lastSendAt: new Date().toISOString(),
    templateName: String(templateName),
    languageCode: String(languageCode || "pt_BR"),
    messageId: out?.messages?.[0]?.id || null,
    state: "sent",
    meta: meta || null,
  });

  return out;
}

/**
 * Lista templates aprovados (opcional).
 * Requer WA_CLOUD_WABA_ID.
 */
async function listTemplates({ limit = 200 } = {}) {
  if (!isCloudConfigured()) throw new Error("WA_CLOUD não configurado.");
  const wabaId = getRuntimeConfig().wabaId;
  if (!wabaId) throw new Error("WABA ID ausente (necessário para listar templates).");

  const fields = "id,name,status,category,language,components,quality_score,rejected_reason";
  const url = `${graphBase()}/${encodeURIComponent(wabaId)}/message_templates?fields=${encodeURIComponent(fields)}&limit=${encodeURIComponent(String(limit))}`;
  return await graphFetch(url, { method: "GET" });
}

/**
 * Processa webhook do WhatsApp Cloud API:
 * - statuses: delivered/read/failed
 * - messages: inbound
 *
 * Observação: o formato do webhook pode variar por versão; aqui tratamos o essencial.
 */
function handleWebhook(body) {
  try {
    const entry = Array.isArray(body?.entry) ? body.entry : [];
    for (const e of entry) {
      const changes = Array.isArray(e?.changes) ? e.changes : [];
      for (const c of changes) {
        const value = c?.value || {};
        const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
        for (const st of statuses) {
          const to = String(st?.recipient_id || "").trim(); // geralmente é o número em E.164 sem +
          const state = String(st?.status || "").trim(); // sent|delivered|read|failed
          const messageId = st?.id || null;

          if (!to) continue;

          upsertStatus(to, {
            provider: "cloud",
            messageId,
            state: state || "unknown",
            error: st?.errors?.[0] || null,
            conversation: st?.conversation || null,
            pricing: st?.pricing || null,
            deliveredAt: state === "delivered" ? new Date().toISOString() : undefined,
            readAt: state === "read" ? new Date().toISOString() : undefined,
          });
        }

        const msgs = Array.isArray(value?.messages) ? value.messages : [];
        for (const m of msgs) {
          const from = String(m?.from || "").trim();
          if (!from) continue;

          // marca "replied"
          upsertStatus(from, {
            provider: "cloud",
            repliedAt: new Date().toISOString(),
            inbound: {
              id: m?.id || null,
              type: m?.type || null,
              text: m?.text?.body || null,
              timestamp: m?.timestamp || null,
            },
          });
        }
      }
    }
  } catch (err) {
    console.error("⚠️ WA_CLOUD webhook parse error:", err?.message || err);
  }
}

function getCloudStatus() {
  const cfg = getRuntimeConfig();
  const embeddedConfigured = !!(cfg.appId && cfg.configurationId && cfg.appSecret);
  return {
    enabled: Boolean(cfg.enabled),
    configured: isCloudConfigured(),
    hasToken: !!cfg.token,
    tokenMasked: maskValue(cfg.token),
    hasPhoneNumberId: !!cfg.phoneNumberId,
    phoneNumberId: cfg.phoneNumberId || "",
    hasWabaId: !!cfg.wabaId,
    wabaId: cfg.wabaId || "",
    businessId: cfg.businessId || "",
    displayPhoneNumber: cfg.displayPhoneNumber || "",
    verifiedName: cfg.verifiedName || "",
    graphVersion: cfg.graphVersion || "v25.0",
    linkedAt: cfg.linkedAt || "",
    subscribedAt: cfg.subscribedAt || "",
    lastSubscribeError: cfg.lastSubscribeError || null,
    embeddedSignup: {
      configured: embeddedConfigured,
      appId: cfg.appId || "",
      configurationId: cfg.configurationId || "",
      hasAppSecret: !!cfg.appSecret,
      appSecretMasked: maskValue(cfg.appSecret),
      redirectUri: cfg.redirectUri || "",
    },
  };
}

function saveEmbeddedSignupSettings(input = {}) {
  const appId = String(input.appId || "").trim();
  const configurationId = String(input.configurationId || "").trim();
  const appSecret = String(input.appSecret || "").trim();
  const graphVersion = String(input.graphVersion || "v25.0").trim() || "v25.0";
  const redirectUri = String(input.redirectUri || "").trim();

  if (!appId) throw new Error("Informe o App ID da Meta.");
  if (!configurationId) throw new Error("Informe o Configuration ID do Facebook Login for Business.");
  if (!appSecret) throw new Error("Informe o App Secret da Meta.");
  if (!/^v\d+\.\d+$/.test(graphVersion)) throw new Error("Graph Version inválida. Ex: v25.0.");

  const saved = writeStoredConfig({
    appId,
    configurationId,
    appSecret,
    graphVersion,
    redirectUri,
    enabled: true,
  });

  return {
    ok: true,
    appId: saved.appId,
    configurationId: saved.configurationId,
    graphVersion: saved.graphVersion,
    redirectUri: saved.redirectUri || "",
    hasAppSecret: !!saved.appSecret,
    appSecretMasked: maskValue(saved.appSecret),
  };
}

async function getPhoneNumberInfo(phoneNumberId, token) {
  if (!phoneNumberId) return null;
  try {
    const fields = "id,display_phone_number,verified_name,quality_rating,platform_type,code_verification_status";
    const url = `${graphBase()}/${encodeURIComponent(phoneNumberId)}?fields=${encodeURIComponent(fields)}`;
    return await graphFetch(url, { method: "GET", token });
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

async function subscribeWabaWebhooks(wabaId, token) {
  if (!wabaId) return null;
  const url = `${graphBase()}/${encodeURIComponent(wabaId)}/subscribed_apps`;
  return await graphFetch(url, { method: "POST", token });
}

async function exchangeEmbeddedSignupCode(input = {}) {
  const cfg = getRuntimeConfig();
  const code = String(input.code || "").trim();
  const wabaId = String(input.wabaId || input.waba_id || "").trim();
  const phoneNumberId = String(input.phoneNumberId || input.phone_number_id || "").trim();
  const businessId = String(input.businessId || input.business_id || "").trim();

  if (!cfg.appId) throw new Error("App ID não configurado.");
  if (!cfg.appSecret) throw new Error("App Secret não configurado.");
  if (!cfg.configurationId) throw new Error("Configuration ID não configurado.");
  if (!code) throw new Error("Código de autorização ausente.");
  if (!wabaId) throw new Error("WABA ID não retornado pelo Embedded Signup.");
  if (!phoneNumberId) throw new Error("Phone Number ID não retornado pelo Embedded Signup.");

  const params = new URLSearchParams({
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    code,
  });

  // Normalmente o fluxo via JavaScript SDK não exige redirect_uri.
  // Algumas configurações OAuth antigas exigem. Por isso deixamos configurável pelo painel/env.
  if (cfg.redirectUri) params.set("redirect_uri", cfg.redirectUri);

  const tokenUrl = `${graphBase()}/oauth/access_token?${params.toString()}`;
  const tokenOut = await graphFetchNoAuth(tokenUrl, { method: "GET" });
  const accessToken = String(tokenOut?.access_token || "").trim();
  if (!accessToken) throw new Error("A Meta não retornou access_token no code exchange.");

  const phoneInfo = await getPhoneNumberInfo(phoneNumberId, accessToken);
  let subscribeOut = null;
  let subscribeError = null;
  try {
    subscribeOut = await subscribeWabaWebhooks(wabaId, accessToken);
  } catch (err) {
    subscribeError = {
      message: err?.message || String(err),
      status: err?.status || null,
      payload: err?.payload || null,
    };
  }

  const saved = writeStoredConfig({
    enabled: true,
    accessToken,
    tokenType: tokenOut?.token_type || "bearer",
    tokenExpiresIn: tokenOut?.expires_in ? String(tokenOut.expires_in) : "",
    wabaId,
    phoneNumberId,
    businessId,
    displayPhoneNumber: phoneInfo?.display_phone_number || "",
    verifiedName: phoneInfo?.verified_name || "",
    linkedAt: new Date().toISOString(),
    subscribedAt: subscribeOut ? new Date().toISOString() : "",
    lastSubscribeError: subscribeError,
    lastEmbeddedSession: input.sessionInfo || null,
  });

  return {
    ok: true,
    linked: true,
    wabaId: saved.wabaId,
    phoneNumberId: saved.phoneNumberId,
    businessId: saved.businessId || "",
    displayPhoneNumber: saved.displayPhoneNumber || "",
    verifiedName: saved.verifiedName || "",
    tokenMasked: maskValue(saved.accessToken),
    subscribed: !!subscribeOut,
    subscribe: subscribeOut || null,
    subscribeError,
    phoneInfo,
  };
}

function disconnectCloudApi() {
  clearLinkedCloudConfig();
  return { ok: true, disconnected: true };
}

module.exports = {
  isCloudConfigured,
  saveEmbeddedSignupSettings,
  exchangeEmbeddedSignupCode,
  disconnectCloudApi,
  createTemplate,
  sendTemplate,
  listTemplates,
  handleWebhook,
  getCloudStatus,
  upsertStatus,
  getStatus,
  listStatus,
};
