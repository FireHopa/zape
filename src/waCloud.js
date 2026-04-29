// src/waCloud.js
/**
 * WhatsApp Business Cloud API (oficial / Meta Graph).
 *
 * Requisitos (env):
 *  - WA_CLOUD_ENABLED=1
 *  - WA_CLOUD_TOKEN=EAAB...
 *  - WA_CLOUD_PHONE_NUMBER_ID=123...
 *  - (opcional) WA_CLOUD_WABA_ID=123...  (para listar templates)
 *  - (opcional) WA_CLOUD_GRAPH_VERSION=v20.0
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
  return process.env.WA_CLOUD_ENABLED === "1" &&
    !!process.env.WA_CLOUD_TOKEN &&
    !!process.env.WA_CLOUD_PHONE_NUMBER_ID;
}

function graphBase() {
  const v = process.env.WA_CLOUD_GRAPH_VERSION || "v20.0";
  return `https://graph.facebook.com/${v}`;
}

async function graphFetch(url, { method = "GET", body, headers } = {}) {
  const token = process.env.WA_CLOUD_TOKEN;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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

/**
 * Envia TEMPLATE (obrigatório para disparo em massa).
 * components: [{type:"body", parameters:[{type:"text", text:"..."}]}, ...]
 */
async function sendTemplate({ toE164Digits, templateName, languageCode, components, meta }) {
  if (!isCloudConfigured()) throw new Error("WA_CLOUD não configurado.");
  const phoneId = process.env.WA_CLOUD_PHONE_NUMBER_ID;

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
  const wabaId = process.env.WA_CLOUD_WABA_ID;
  if (!wabaId) throw new Error("WA_CLOUD_WABA_ID ausente (necessário para listar templates).");

  const url = `${graphBase()}/${encodeURIComponent(wabaId)}/message_templates?limit=${encodeURIComponent(String(limit))}`;
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
  return {
    enabled: process.env.WA_CLOUD_ENABLED === "1",
    configured: isCloudConfigured(),
    hasToken: !!process.env.WA_CLOUD_TOKEN,
    hasPhoneNumberId: !!process.env.WA_CLOUD_PHONE_NUMBER_ID,
    hasWabaId: !!process.env.WA_CLOUD_WABA_ID,
    graphVersion: process.env.WA_CLOUD_GRAPH_VERSION || "v20.0",
  };
}

module.exports = {
  isCloudConfigured,
  sendTemplate,
  listTemplates,
  handleWebhook,
  getCloudStatus,
  upsertStatus,
  getStatus,
  listStatus,
};
