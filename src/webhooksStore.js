const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "data", "webhooks.json");

function _loadAll() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function _saveAll(arr) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2), "utf-8");
}

function _genId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function _genToken() {
  // 32 chars url-safe
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
  let out = "";
  for (let i = 0; i < 32; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function listWebhooks(tenantId) {
  const t = String(tenantId || "").trim() || "admin";
  return _loadAll().filter((w) => w.tenantId === t && !w.deletedAt);
}

function _sanitizeCrmTarget(value) {
  if (value === null || value === false || value === "") return null;
  if (!value || typeof value !== "object") return undefined;

  const pipelineId = String(value.pipelineId || "").trim();
  const stageId = String(value.stageId || "").trim();
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

function createWebhook(tenantId, { name, messageText, messages, crmTarget } = {}) {
  const t = String(tenantId || "").trim() || "admin";
  const all = _loadAll();

  // ensure token unique
  let token = _genToken();
  const tokens = new Set(all.map((x) => x.token));
  while (tokens.has(token)) token = _genToken();

  const now = new Date().toISOString();
  
  // Suporte para array de mensagens ou fallback para a string antiga
  const msgsArray = Array.isArray(messages) ? messages : (messageText ? [String(messageText).trim()] : []);

  const row = {
    id: _genId(),
    tenantId: t,
    token,
    name: String(name || "Webhook").trim() || "Webhook",
    messageText: msgsArray[0] || "", // mantido por compatibilidade com rotas antigas
    messages: msgsArray,             // NOVO CAMPO: Lista de mensagens
    crmTarget: _sanitizeCrmTarget(crmTarget) || null, // vínculo opcional com o Funil de Vendas
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  all.unshift(row);
  _saveAll(all);
  return row;
}

function updateWebhook(tenantId, webhookId, patch = {}) {
  const t = String(tenantId || "").trim() || "admin";
  const all = _loadAll();
  const idx = all.findIndex((w) => w.id === webhookId && w.tenantId === t && !w.deletedAt);
  if (idx < 0) return { ok: false, error: "Webhook não encontrado." };

  const cur = all[idx];
  const next = { ...cur };

  if (patch.name !== undefined) next.name = String(patch.name || "").trim() || cur.name || "Webhook";
  
  // Atualiza lista de mensagens
  if (patch.messages !== undefined && Array.isArray(patch.messages)) {
    next.messages = patch.messages.map(m => String(m).trim()).filter(Boolean);
    next.messageText = next.messages[0] || ""; // mantém a primeira msg por compatibilidade
  } else if (patch.messageText !== undefined) {
    next.messageText = String(patch.messageText || "").trim();
    if(!next.messages) next.messages = [];
    next.messages[0] = next.messageText;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "crmTarget")) {
    const cleanedTarget = _sanitizeCrmTarget(patch.crmTarget);
    next.crmTarget = cleanedTarget === undefined ? (next.crmTarget || null) : cleanedTarget;
  }

  next.updatedAt = new Date().toISOString();
  all[idx] = next;
  _saveAll(all);
  return { ok: true, webhook: next };
}

function deleteWebhook(tenantId, webhookId) {
  const t = String(tenantId || "").trim() || "admin";
  const all = _loadAll();
  const idx = all.findIndex((w) => w.id === webhookId && w.tenantId === t && !w.deletedAt);
  if (idx < 0) return { ok: false, error: "Webhook não encontrado." };
  all[idx].deletedAt = new Date().toISOString();
  all[idx].updatedAt = new Date().toISOString();
  _saveAll(all);
  return { ok: true };
}

function resolveWebhookToken(token) {
  const tok = String(token || "").trim();
  if (!tok) return null;
  const all = _loadAll();
  const row = all.find((w) => w.token === tok && !w.deletedAt);
  return row || null;
}

module.exports = {
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  resolveWebhookToken,
};