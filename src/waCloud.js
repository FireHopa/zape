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
  readStoredConfig,
  maskValue,
  clearLinkedCloudConfig,
} = require("./waCloudConfigStore");
const { normalizeMetaError } = require("./metaErrorHelper");

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
    const metaError = normalizeMetaError(json || text || {}, { httpStatus: res.status });
    const msg = metaError.display || (json && (json.error?.message || json.error?.error_user_msg)) || text || `HTTP ${res.status}`;
    const e = new Error(msg);
    e.status = res.status;
    e.payload = json || text;
    e.metaError = metaError;
    e.metaCode = metaError.code || null;
    e.metaSubcode = metaError.subcode || null;
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
    const metaError = normalizeMetaError(json || text || {}, { httpStatus: res.status });
    const msg = metaError.display || (json && (json.error?.message || json.error?.error_user_msg)) || text || `HTTP ${res.status}`;
    const e = new Error(msg);
    e.status = res.status;
    e.payload = json || text;
    e.metaError = metaError;
    e.metaCode = metaError.code || null;
    e.metaSubcode = metaError.subcode || null;
    throw e;
  }
  return json;
}

async function graphFetchAllPages(firstUrl, { limitItems = 1000, maxPages = 20 } = {}) {
  const data = [];
  let url = firstUrl;
  let last = null;
  let pages = 0;

  while (url && pages < maxPages && data.length < limitItems) {
    last = await graphFetch(url, { method: "GET" });
    const rows = Array.isArray(last?.data) ? last.data : [];
    for (const row of rows) {
      data.push(row);
      if (data.length >= limitItems) break;
    }
    url = last?.paging?.next || null;
    pages += 1;
  }

  return {
    data,
    paging: last?.paging || null,
    fetchedPages: pages,
    truncated: Boolean(url),
  };
}

function normalizeGraphQuery(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    qs.set(key, String(value));
  }
  return qs.toString();
}

function normalizeLibraryTemplateForUi(t = {}) {
  const components = [];
  const header = String(t.header || "").trim();
  const body = String(t.body || "").trim();
  const footer = String(t.footer || "").trim();
  const buttons = Array.isArray(t.buttons) ? t.buttons : [];

  if (header) components.push({ type: "HEADER", format: "TEXT", text: header });
  if (body) {
    const c = { type: "BODY", text: body };
    if (Array.isArray(t.body_params) && t.body_params.length) c.example = { body_text: [t.body_params] };
    components.push(c);
  }
  if (footer) components.push({ type: "FOOTER", text: footer });
  if (buttons.length) components.push({ type: "BUTTONS", buttons });

  return {
    ...t,
    id: t.id || `library_${t.name || "template"}_${t.language || ""}`,
    source: "library",
    status: "LIBRARY",
    libraryTemplateName: t.name || "",
    name: t.name || "",
    language: t.language || "",
    category: String(t.category || "UTILITY").toUpperCase(),
    components,
  };
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

function normalizeTemplateButtons(buttons, fallbackQuickReplies) {
  const raw = Array.isArray(buttons) && buttons.length
    ? buttons
    : (Array.isArray(fallbackQuickReplies)
      ? fallbackQuickReplies
      : String(fallbackQuickReplies || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean));

  return raw
    .map((b) => (typeof b === "string" ? { type: "QUICK_REPLY", text: b } : b))
    .map((b) => {
      const type = String(b?.type || "QUICK_REPLY").trim().toUpperCase();
      const text = String(b?.text || "").trim();
      if (!text) return null;
      if (type === "URL") {
        const url = String(b?.url || "").trim();
        return { type: "URL", text, url };
      }
      if (type === "PHONE_NUMBER") {
        const phone_number = String(b?.phone_number || b?.phoneNumber || "").trim();
        return { type: "PHONE_NUMBER", text, phone_number };
      }
      return { type: "QUICK_REPLY", text };
    })
    .filter(Boolean)
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

  const buttons = normalizeTemplateButtons(input.templateButtons || input.buttons || [], input.quickReplyButtons || []);
  if (buttons.length) {
    for (const b of buttons) {
      if (b.text.length > 25) throw new Error(`Botão \"${b.text}\" deve ter no máximo 25 caracteres.`);
      if (b.type === "URL" && !/^https:\/\//i.test(b.url || "")) {
        throw new Error(`Botão \"${b.text}\": informe uma URL começando com https://.`);
      }
      if (b.type === "PHONE_NUMBER" && !String(b.phone_number || "").replace(/\D+/g, "")) {
        throw new Error(`Botão \"${b.text}\": informe um telefone válido.`);
      }
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

  const libraryTemplateName = String(input.libraryTemplateName || input.library_template_name || "").trim();
  const category = String(input.category || "MARKETING").trim().toUpperCase();
  const allowedCategories = libraryTemplateName ? ["MARKETING", "UTILITY", "AUTHENTICATION"] : ["MARKETING", "UTILITY"];
  if (!allowedCategories.includes(category)) {
    throw new Error(libraryTemplateName
      ? "Categoria inválida para modelo da biblioteca. Use MARKETING, UTILITY ou AUTHENTICATION."
      : "Categoria suportada nesta tela: MARKETING ou UTILITY. AUTHENTICATION exige estrutura própria.");
  }

  const language = String(input.language || input.languageCode || "pt_BR").trim();
  if (!language) throw new Error("Idioma obrigatório. Ex: pt_BR.");

  const payload = libraryTemplateName
    ? {
        name,
        language,
        category,
        allow_category_change: input.allowCategoryChange !== false,
        library_template_name: libraryTemplateName,
        ...(input.libraryTemplateButtonInputs
          ? {
              library_template_button_inputs: typeof input.libraryTemplateButtonInputs === "string"
                ? input.libraryTemplateButtonInputs
                : JSON.stringify(input.libraryTemplateButtonInputs),
            }
          : {}),
      }
    : {
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
  const cfg = getRuntimeConfig();
  if (!cfg.enabled || !cfg.token || !cfg.phoneNumberId) throw new Error("WA_CLOUD não configurado.");
  if (cfg.credentialSource && cfg.credentialSource.needsRelink) {
    const e = new Error("A conexão do painel está incompleta. Vincule novamente o WhatsApp para salvar Token, WABA ID e Phone Number ID juntos.");
    e.status = 409;
    e.code = "META_PANEL_CONNECTION_INCOMPLETE";
    e.payload = { code: e.code, credentialSource: cfg.credentialSource };
    throw e;
  }
  const wabaId = cfg.wabaId;
  if (!wabaId) throw new Error("WABA ID ausente (necessário para listar templates).");

  await assertTokenCanAccessWabaForTemplates();

  const fields = "id,name,status,category,language,components,quality_score,rejected_reason,created_time,updated_time";
  const qs = normalizeGraphQuery({ fields, limit: Math.min(Math.max(Number(limit) || 200, 25), 250) });
  const url = `${graphBase()}/${encodeURIComponent(wabaId)}/message_templates?${qs}`;
  const out = await graphFetchAllPages(url, { limitItems: Math.max(Number(limit) || 1000, 1000), maxPages: 40 });
  return {
    data: out.data.map((t) => ({ ...t, source: "account" })),
    paging: out.paging,
    fetchedPages: out.fetchedPages,
    truncated: out.truncated,
  };
}

async function listTemplateLibrary({ language = "pt_BR", search = "", limit = 300, topic = "", usecase = "", industry = "" } = {}) {
  const cfg = getRuntimeConfig();
  if (!cfg.enabled || !cfg.token) throw new Error("WA_CLOUD não configurado.");

  const qs = normalizeGraphQuery({
    language: String(language || "pt_BR").trim(),
    name_or_content: String(search || "").trim(),
    topic: String(topic || "").trim(),
    usecase: String(usecase || "").trim(),
    industry: String(industry || "").trim(),
    limit: Math.min(Math.max(Number(limit) || 100, 25), 100),
  });
  const url = `${graphBase()}/message_template_library?${qs}`;
  const out = await graphFetchAllPages(url, { limitItems: Math.max(Number(limit) || 300, 300), maxPages: 20 });
  return {
    data: out.data.map(normalizeLibraryTemplateForUi),
    paging: out.paging,
    fetchedPages: out.fetchedPages,
    truncated: out.truncated,
  };
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
  const configured = Boolean(cfg.enabled && cfg.token && cfg.phoneNumberId);
  const templatesReady = Boolean(configured && cfg.wabaId && !(cfg.credentialSource && cfg.credentialSource.needsRelink));
  return {
    enabled: Boolean(cfg.enabled),
    configured,
    templatesReady,
    needsRelink: Boolean(cfg.credentialSource && cfg.credentialSource.needsRelink),
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
    lastTokenDebug: cfg.lastTokenDebug || null,
    credentialSource: cfg.credentialSource ? {
      source: cfg.credentialSource.source,
      forceEnv: !!cfg.credentialSource.forceEnv,
      complete: !!cfg.credentialSource.complete,
      needsRelink: !!cfg.credentialSource.needsRelink,
      mixedWarning: cfg.credentialSource.mixedWarning || "",
      env: cfg.credentialSource.env || null,
      stored: cfg.credentialSource.stored || null,
    } : null,
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
    preferPanelCredentials: true,
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
  const fields = "id,display_phone_number,verified_name,quality_rating,platform_type,code_verification_status";
  const url = `${graphBase()}/${encodeURIComponent(phoneNumberId)}?fields=${encodeURIComponent(fields)}`;
  return await graphFetch(url, { method: "GET", token });
}

async function debugMetaToken(inputToken) {
  const cfg = getRuntimeConfig();
  if (!inputToken || !cfg.appId || !cfg.appSecret) return null;
  try {
    const appAccessToken = `${cfg.appId}|${cfg.appSecret}`;
    const url = `${graphBase()}/debug_token?input_token=${encodeURIComponent(inputToken)}&access_token=${encodeURIComponent(appAccessToken)}`;
    return await graphFetchNoAuth(url, { method: "GET" });
  } catch (err) {
    return { error: err?.message || String(err), payload: err?.payload || null };
  }
}

function getDebugTokenTargetIds(tokenDebug, scopeName) {
  const data = tokenDebug && tokenDebug.data ? tokenDebug.data : null;
  const granular = Array.isArray(data && data.granular_scopes) ? data.granular_scopes : [];
  const item = granular.find((x) => String(x && x.scope) === scopeName);
  return Array.isArray(item && item.target_ids) ? item.target_ids.map((x) => String(x)) : [];
}

async function assertTokenCanAccessWabaForTemplates() {
  const cfg = getRuntimeConfig();
  if (!cfg.token || !cfg.wabaId) return null;

  const tokenDebug = await debugMetaToken(cfg.token);
  const data = tokenDebug && tokenDebug.data ? tokenDebug.data : null;

  // Se a Meta não permitir debug_token ou não devolver granular_scopes, não bloqueamos aqui.
  // A chamada real de templates ainda retornará o erro bruto da Meta.
  if (!data || tokenDebug.error) return tokenDebug;

  const isValid = data.is_valid !== false;
  if (!isValid) {
    const e = new Error("O token salvo não está válido na Meta.");
    e.status = 424;
    e.code = "META_TOKEN_INVALID";
    e.payload = { tokenDebug };
    throw e;
  }

  const managementTargets = getDebugTokenTargetIds(tokenDebug, "whatsapp_business_management");
  const messagingTargets = getDebugTokenTargetIds(tokenDebug, "whatsapp_business_messaging");
  const allTargets = Array.from(new Set([...managementTargets, ...messagingTargets]));

  // Quando existem target_ids no debug_token, o WABA efetivo precisa estar dentro deles.
  // Esse era exatamente o caso do bug: token de um WABA e WABA ID antigo/inconsistente.
  if (allTargets.length && !allTargets.includes(String(cfg.wabaId))) {
    const e = new Error("Token e WABA ID não pertencem à mesma conexão. O sistema bloqueou a consulta para evitar usar uma conexão antiga ou inconsistente.");
    e.status = 409;
    e.code = "META_WABA_TOKEN_MISMATCH";
    e.payload = {
      code: "META_WABA_TOKEN_MISMATCH",
      message: e.message,
      effectiveWabaId: String(cfg.wabaId),
      tokenTargetWabaIds: allTargets,
      credentialSource: cfg.credentialSource || null,
      tokenDebug,
    };
    throw e;
  }

  return tokenDebug;
}

async function subscribeWabaWebhooks(wabaId, token) {
  if (!wabaId) return null;
  const url = `${graphBase()}/${encodeURIComponent(wabaId)}/subscribed_apps`;
  return await graphFetch(url, { method: "POST", token });
}

function normalizeMetaId(value) {
  return String(value || "").trim();
}

function buildConnectionMismatchDetails(stored = {}, incoming = {}) {
  const currentPhoneNumberId = normalizeMetaId(stored.phoneNumberId);
  const currentWabaId = normalizeMetaId(stored.wabaId);
  const incomingPhoneNumberId = normalizeMetaId(incoming.phoneNumberId);
  const incomingWabaId = normalizeMetaId(incoming.wabaId);

  const hasExistingConnection = Boolean(currentPhoneNumberId || currentWabaId || stored.accessToken);
  if (!hasExistingConnection) return null;

  const phoneMismatch = Boolean(currentPhoneNumberId && incomingPhoneNumberId && currentPhoneNumberId !== incomingPhoneNumberId);
  const wabaMismatch = Boolean(currentWabaId && incomingWabaId && currentWabaId !== incomingWabaId);
  if (!phoneMismatch && !wabaMismatch) return null;

  return {
    code: "CLOUD_CONNECTION_MISMATCH",
    message: "A Meta retornou um WhatsApp Business Account ou Phone Number ID diferente do que já estava salvo. Para evitar trocar o número sem querer, a substituição foi bloqueada.",
    current: {
      phoneNumberId: currentPhoneNumberId,
      wabaId: currentWabaId,
      displayPhoneNumber: stored.displayPhoneNumber || "",
      verifiedName: stored.verifiedName || "",
    },
    incoming: {
      phoneNumberId: incomingPhoneNumberId,
      wabaId: incomingWabaId,
      businessId: normalizeMetaId(incoming.businessId),
    },
  };
}

async function exchangeEmbeddedSignupCode(input = {}) {
  const cfg = getRuntimeConfig();
  const code = String(input.code || "").trim();
  const wabaId = String(input.wabaId || input.waba_id || "").trim();
  const phoneNumberId = String(input.phoneNumberId || input.phone_number_id || "").trim();
  const businessId = String(input.businessId || input.business_id || "").trim();
  const forceReplace = input.forceReplace === true || /^true|1|yes$/i.test(String(input.forceReplace || ""));

  if (!cfg.appId) throw new Error("App ID não configurado.");
  if (!cfg.appSecret) throw new Error("App Secret não configurado.");
  if (!cfg.configurationId) throw new Error("Configuration ID não configurado.");
  if (!code) throw new Error("Código de autorização ausente.");
  if (!wabaId) throw new Error("WABA ID não retornado pelo Embedded Signup.");
  if (!phoneNumberId) throw new Error("Phone Number ID não retornado pelo Embedded Signup.");

  const storedBefore = readStoredConfig();
  const mismatch = buildConnectionMismatchDetails(storedBefore, { wabaId, phoneNumberId, businessId });
  if (mismatch && !forceReplace) {
    const e = new Error(mismatch.message);
    e.status = 409;
    e.code = mismatch.code;
    e.payload = mismatch;
    throw e;
  }

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

  const tokenDebug = await debugMetaToken(accessToken);

  // Validação crítica: não salvar token se ele não consegue acessar o número retornado.
  // Antes, o erro era engolido e um token inválido podia ficar salvo no painel.
  const phoneInfo = await getPhoneNumberInfo(phoneNumberId, accessToken);
  if (phoneInfo && phoneInfo.error) {
    const e = new Error(phoneInfo.error || "Token retornado pela Meta não validou o número selecionado.");
    e.status = 401;
    e.code = "META_TOKEN_INVALID";
    e.payload = phoneInfo;
    throw e;
  }

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
    preferPanelCredentials: true,
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
    lastTokenDebug: tokenDebug || null,
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
    tokenDebug,
    replacedPreviousConnection: !!mismatch,
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
  listTemplateLibrary,
  handleWebhook,
  getCloudStatus,
  upsertStatus,
  getStatus,
  listStatus,
};
