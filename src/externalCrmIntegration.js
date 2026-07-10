const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000];
const DEFAULT_MAX_ATTEMPTS = DEFAULT_RETRY_DELAYS_MS.length + 1;
const DEFAULT_WORKER_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_BATCH_SIZE = 10;
const DELIVERED_RETENTION_MS = 30 * 24 * 60 * 60_000;

let processing = false;
let workerTimer = null;
let wakeTimer = null;

function nowIso() {
  return new Date().toISOString();
}

function queueFilePath() {
  const configured = String(process.env.EXTERNAL_CRM_QUEUE_FILE || "").trim();
  return configured || path.join(__dirname, "..", "data", "external_crm_queue.json");
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function loadQueue() {
  const filePath = queueFilePath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("❌ Fila do CRM externo inválida:", error?.message || error);
    return [];
  }
}

function saveQueue(items) {
  atomicWriteJson(queueFilePath(), Array.isArray(items) ? items : []);
}

function mutateQueueItem(itemId, mutator) {
  const items = loadQueue();
  const index = items.findIndex((item) => String(item.id) === String(itemId));
  if (index < 0) return null;
  const current = items[index];
  const next = mutator({ ...current }) || current;
  items[index] = next;
  saveQueue(pruneQueue(items));
  return next;
}

function positiveNumber(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function getConfig() {
  const baseUrl = String(process.env.CRM_INTEGRATION_URL || "").trim().replace(/\/+$/, "");
  const key = String(process.env.CRM_INTEGRATION_KEY || "").trim();
  const enabledByEnv = String(process.env.CRM_INTEGRATION_ENABLED || "1") !== "0";
  return {
    enabled: enabledByEnv && Boolean(baseUrl && key),
    baseUrl,
    key,
    requestTimeoutMs: positiveNumber(process.env.CRM_INTEGRATION_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 1_000),
    maxAttempts: Math.trunc(positiveNumber(process.env.CRM_INTEGRATION_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1)),
  };
}

function parseBooleanText(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return ["sim", "s", "yes", "y", "true", "1", "ok", "ativo", "anuncia", "x"].includes(normalized);
}

function normalizeSource(value) {
  const allowed = new Set(["WhatsApp", "Landing Page", "Evento", "Instagram", "Google", "Indicação", "Tráfego Pago", "Outro"]);
  const source = String(value || "WhatsApp").trim();
  return allowed.has(source) ? source : "WhatsApp";
}

function buildPayload({ tenantId, webhook, lead, target, payloadType = "json" }) {
  const safeTarget = target && typeof target === "object" ? target : {};
  const sourceMeta = lead && lead.sourceMeta && typeof lead.sourceMeta === "object" ? lead.sourceMeta : {};
  const webhookId = String((webhook && webhook.id) || sourceMeta.webhookId || "").trim();
  const webhookName = String((webhook && (webhook.displayName || webhook.name)) || sourceMeta.webhookName || "").trim();

  return {
    eventKey: `zape:${String(tenantId || "admin")}:${String(lead.id || "")}`,
    tenantId: String(tenantId || "admin"),
    externalLeadId: String(lead.id || ""),
    webhook: {
      id: webhookId,
      name: webhookName,
      payloadType: String(payloadType || sourceMeta.payloadType || "json"),
    },
    target: {
      pipelineId: String(safeTarget.pipelineId || ""),
      stageId: String(safeTarget.stageId || ""),
      source: normalizeSource(safeTarget.source),
    },
    lead: {
      id: String(lead.id || ""),
      name: String(lead.nome || ""),
      email: String(lead.email || ""),
      phone: String(lead.whatsapp_digits || lead.whatsapp_raw || ""),
      company: String(lead.empresa || ""),
      website: String(lead.website || ""),
      advertisesOnGoogle: parseBooleanText(lead.jaAnuncia),
      advertisesOnGoogleRaw: String(lead.jaAnuncia || ""),
      tags: lead.tags || "",
      createdAt: String(lead.createdAt || nowIso()),
    },
    metadata: {
      source: String(lead.source || ""),
      sourceDetail: String(lead.sourceDetail || ""),
      activeContactId: String(lead.active_contact_id || ""),
      activeSeriesId: String(lead.active_seriesid || ""),
    },
  };
}

function pruneQueue(items) {
  const cutoff = Date.now() - DELIVERED_RETENTION_MS;
  const kept = (Array.isArray(items) ? items : []).filter((item) => {
    if (item.status !== "delivered") return true;
    const deliveredAt = Date.parse(item.deliveredAt || item.updatedAt || "");
    return !Number.isFinite(deliveredAt) || deliveredAt >= cutoff;
  });

  // Nunca remove eventos pendentes ou com falha. O limite serve apenas para o histórico entregue.
  let excess = Math.max(0, kept.length - 10_000);
  if (!excess) return kept;
  return kept.filter((item) => {
    if (excess > 0 && item.status === "delivered") {
      excess -= 1;
      return false;
    }
    return true;
  });
}

function enqueueExternalCrmLead({ tenantId, webhook, lead, target, payloadType }) {
  if (!lead || !lead.id) return { ok: false, queued: false, reason: "invalid_lead" };
  if (!target || target.enabled === false) return { ok: false, queued: false, reason: "disabled" };

  const payload = buildPayload({ tenantId, webhook, lead, target, payloadType });
  const items = loadQueue();
  const existing = items.find((item) => item.eventKey === payload.eventKey);
  if (existing) {
    return { ok: true, queued: existing.status !== "delivered", duplicate: true, eventKey: payload.eventKey, status: existing.status };
  }

  const at = nowIso();
  const item = {
    id: crypto.randomUUID(),
    eventKey: payload.eventKey,
    tenantId: String(tenantId || "admin"),
    externalLeadId: String(lead.id),
    payload,
    status: "pending",
    attempts: 0,
    nextAttemptAt: at,
    lastAttemptAt: "",
    lastError: "",
    lastHttpStatus: 0,
    response: null,
    createdAt: at,
    updatedAt: at,
    deliveredAt: "",
  };

  items.push(item);
  saveQueue(pruneQueue(items));
  scheduleWake(25);
  return { ok: true, queued: true, eventKey: payload.eventKey, status: item.status };
}

function getRetryDelayMs(attempts) {
  if (attempts <= 0) return 0;
  return DEFAULT_RETRY_DELAYS_MS[Math.min(attempts - 1, DEFAULT_RETRY_DELAYS_MS.length - 1)];
}

function shouldRetryHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function postJson(url, body, config) {
  if (typeof fetch !== "function") throw new Error("Node.js sem suporte a fetch. Use Node 18 ou superior.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text ? { message: text.slice(0, 1000) } : null; }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchExternalCrmCatalog() {
  const config = getConfig();
  if (!config.enabled) {
    return { configured: false, enabled: false, pipelines: [], error: "Defina CRM_INTEGRATION_URL e CRM_INTEGRATION_KEY." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/api/integrations/zape/catalog`, {
      headers: { Authorization: `Bearer ${config.key}` },
      signal: controller.signal,
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    if (!response.ok) {
      const error = new Error(data.message || data.error || `CRM respondeu HTTP ${response.status}.`);
      error.statusCode = response.status;
      throw error;
    }
    return { ...data, configured: true, enabled: true };
  } finally {
    clearTimeout(timer);
  }
}

async function processOne(itemId, config) {
  const active = mutateQueueItem(itemId, (item) => {
    const at = nowIso();
    return {
      ...item,
      status: "sending",
      attempts: Number(item.attempts || 0) + 1,
      lastAttemptAt: at,
      updatedAt: at,
    };
  });
  if (!active) return;

  try {
    const result = await postJson(`${config.baseUrl}/api/integrations/zape/leads`, active.payload, config);
    mutateQueueItem(itemId, (current) => {
      const updated = {
        ...current,
        lastHttpStatus: result.status,
        response: result.data,
      };

      if (result.ok) {
        const deliveredAt = nowIso();
        console.log("✅ Lead entregue ao CRM Inteligente:", { eventKey: current.eventKey, leadId: result.data?.leadId, action: result.data?.action });
        return {
          ...updated,
          status: "delivered",
          deliveredAt,
          nextAttemptAt: "",
          lastError: "",
          updatedAt: deliveredAt,
        };
      }

      const message = result.data?.message || result.data?.error || `CRM respondeu HTTP ${result.status}.`;
      const retryable = shouldRetryHttpStatus(result.status);
      const exhausted = Number(current.attempts || 0) >= config.maxAttempts;
      return {
        ...updated,
        status: !retryable || exhausted ? "failed_permanent" : "pending",
        nextAttemptAt: !retryable || exhausted ? "" : new Date(Date.now() + getRetryDelayMs(Number(current.attempts || 0))).toISOString(),
        lastError: String(message).slice(0, 2000),
        updatedAt: nowIso(),
      };
    });
  } catch (error) {
    mutateQueueItem(itemId, (current) => {
      const exhausted = Number(current.attempts || 0) >= config.maxAttempts;
      return {
        ...current,
        lastHttpStatus: 0,
        response: null,
        lastError: String(error?.name === "AbortError" ? "Tempo de resposta do CRM excedido." : error?.message || error).slice(0, 2000),
        status: exhausted ? "failed_permanent" : "pending",
        nextAttemptAt: exhausted ? "" : new Date(Date.now() + getRetryDelayMs(Number(current.attempts || 0))).toISOString(),
        updatedAt: nowIso(),
      };
    });
  }
}

async function processExternalCrmQueue() {
  if (processing) return { ok: true, skipped: true };
  const config = getConfig();
  if (!config.enabled) return { ok: false, skipped: true, reason: "not_configured" };

  processing = true;
  try {
    const items = loadQueue();
    const now = Date.now();
    const dueItems = items
      .filter((item) => item.status === "pending" || item.status === "sending")
      .filter((item) => !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(0, DEFAULT_BATCH_SIZE);

    for (const item of dueItems) {
      await processOne(item.id, config);
    }

    return { ok: true, processed: dueItems.length };
  } finally {
    processing = false;
  }
}

function scheduleWake(delayMs = 100) {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    processExternalCrmQueue().catch((error) => console.error("❌ Erro ao processar fila do CRM externo:", error?.message || error));
  }, Math.max(0, delayMs));
  if (typeof wakeTimer.unref === "function") wakeTimer.unref();
}

function startExternalCrmWorker(options = {}) {
  if (workerTimer) return;
  const intervalMs = positiveNumber(options.intervalMs || process.env.CRM_INTEGRATION_WORKER_INTERVAL_MS, DEFAULT_WORKER_INTERVAL_MS, 5_000);
  scheduleWake(250);
  workerTimer = setInterval(() => {
    processExternalCrmQueue().catch((error) => console.error("❌ Erro no worker do CRM externo:", error?.message || error));
  }, intervalMs);
  if (typeof workerTimer.unref === "function") workerTimer.unref();
}

function stopExternalCrmWorker() {
  if (workerTimer) clearInterval(workerTimer);
  if (wakeTimer) clearTimeout(wakeTimer);
  workerTimer = null;
  wakeTimer = null;
}

function getExternalCrmQueueStatus(tenantId) {
  const items = loadQueue().filter((item) => !tenantId || String(item.tenantId) === String(tenantId));
  const counts = { pending: 0, sending: 0, delivered: 0, failedPermanent: 0 };
  items.forEach((item) => {
    if (item.status === "pending") counts.pending += 1;
    else if (item.status === "sending") counts.sending += 1;
    else if (item.status === "delivered") counts.delivered += 1;
    else if (item.status === "failed_permanent") counts.failedPermanent += 1;
  });
  const config = getConfig();
  return {
    configured: config.enabled,
    baseUrl: config.baseUrl || "",
    counts,
    recent: items.slice(-20).reverse().map((item) => ({
      eventKey: item.eventKey,
      status: item.status,
      attempts: item.attempts,
      lastError: item.lastError,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
  };
}

function getLegacyActiveCampaignTarget() {
  // Este controle afeta somente o repasse ActiveCampaign -> CRM Inteligente.
  // O recebimento no endpoint /webhooks/activecampaign permanece sempre ativo.
  // Por padrão, todo lead recebido da ActiveCampaign também segue para o CRM.
  const rawToggle = process.env.CRM_INTEGRATION_ACTIVE_CAMPAIGN_TO_CRM_ENABLED;
  // A variável antiga CRM_INTEGRATION_ACTIVE_CAMPAIGN_ENABLED é ignorada de propósito:
  // ela tinha nome ambíguo e podia dar a entender que desativava o recebimento da Active.
  if (rawToggle !== undefined && String(rawToggle).trim() === "0") return null;

  return {
    enabled: true,
    pipelineId: String(process.env.CRM_INTEGRATION_ACTIVE_CAMPAIGN_PIPELINE_ID || ""),
    stageId: String(process.env.CRM_INTEGRATION_ACTIVE_CAMPAIGN_STAGE_ID || ""),
    source: normalizeSource(process.env.CRM_INTEGRATION_ACTIVE_CAMPAIGN_SOURCE || "WhatsApp"),
  };
}

module.exports = {
  buildPayload,
  enqueueExternalCrmLead,
  fetchExternalCrmCatalog,
  getExternalCrmQueueStatus,
  getLegacyActiveCampaignTarget,
  processExternalCrmQueue,
  startExternalCrmWorker,
  stopExternalCrmWorker,
};
