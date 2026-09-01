const fs = require("fs");
const path = require("path");
const { defaultExternalCrmQueueStore: queueStore } = require("./externalCrmQueueStore");
const crypto = require("crypto");

const DEFAULT_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000];
const DEFAULT_MAX_ATTEMPTS = DEFAULT_RETRY_DELAYS_MS.length + 1;
const DEFAULT_WORKER_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_DELIVERED_RETENTION_DAYS = 365;
const DEFAULT_QUEUE_MAX_ROWS = 500_000;

let processing = false;
let workerTimer = null;
let wakeTimer = null;

const workerTelemetry = {
  running: false,
  startedAt: "",
  lastCycleStartedAt: "",
  lastCycleCompletedAt: "",
  lastCycleProcessed: 0,
  lastCycleError: "",
  totalProcessed: 0,
  lastDeliveryAt: "",
  lastFailureAt: "",
  lastHttpStatus: 0,
  lastLatencyMs: 0,
};

function nowIso() {
  return new Date().toISOString();
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

function buildPayload({ tenantId, webhook, lead, target, payloadType = "json", eventType = "lead.created", eventKey = "", metadata = {} }) {
  const safeTarget = target && typeof target === "object" ? target : {};
  const sourceMeta = lead && lead.sourceMeta && typeof lead.sourceMeta === "object" ? lead.sourceMeta : {};
  const webhookId = String((webhook && webhook.id) || sourceMeta.webhookId || "").trim();
  const webhookName = String((webhook && (webhook.displayName || webhook.name)) || sourceMeta.webhookName || "").trim();

  const resolvedEventKey = String(eventKey || `zape:${String(tenantId || "admin")}:${String(lead.id || "")}`).trim();

  return {
    eventKey: resolvedEventKey,
    eventType: String(eventType || "lead.created").trim().slice(0, 120),
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
      profile: String(safeTarget.profile || "").trim().slice(0, 120),
      temperature: String(safeTarget.temperature || "").trim().slice(0, 80),
      priority: String(safeTarget.priority || "").trim().slice(0, 80),
      commercialTreatment: String(safeTarget.commercialTreatment || "").trim().slice(0, 120),
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
      ...(lead.sourceMeta && typeof lead.sourceMeta === "object" ? lead.sourceMeta : {}),
      ...(metadata && typeof metadata === "object" ? metadata : {}),
    },
  };
}

async function enqueueExternalCrmLead({ tenantId, webhook, lead, target, payloadType, eventType, eventKey, metadata }) {
  if (!lead || !lead.id) return { ok: false, queued: false, reason: "invalid_lead" };
  if (!target || target.enabled === false) return { ok: false, queued: false, reason: "disabled" };

  const payload = buildPayload({ tenantId, webhook, lead, target, payloadType, eventType, eventKey, metadata });
  const existing = await queueStore.findByEventKey(payload.eventKey);
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
    attemptHistory: [],
    createdAt: at,
    updatedAt: at,
    deliveredAt: "",
  };

  const inserted = await queueStore.insert(item);
  const stored = inserted.item || item;
  scheduleWake(25);
  return { ok: true, queued: stored.status !== "delivered", duplicate: !inserted.inserted, eventKey: payload.eventKey, status: stored.status };
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

async function processOne(active, config) {
  if (!active) return;
  const attemptStartedAt = active.lastAttemptAt || nowIso();
  try {
    const requestStartedAt = Date.now();
    const result = await postJson(`${config.baseUrl}/api/integrations/zape/leads`, active.payload, config);
    const latencyMs = Date.now() - requestStartedAt;
    workerTelemetry.lastLatencyMs = latencyMs;
    workerTelemetry.lastHttpStatus = result.status;
    const completedAt = nowIso();
    const attemptEntry = {
      attempt: Number(active.attempts || 0),
      startedAt: attemptStartedAt,
      completedAt,
      latencyMs,
      httpStatus: result.status,
      outcome: result.ok ? "delivered" : "failed",
      error: result.ok ? "" : String(result.data?.message || result.data?.error || `CRM respondeu HTTP ${result.status}.`).slice(0, 1000),
    };
    const updated = {
      ...active,
      lastHttpStatus: result.status,
      response: result.data,
      attemptHistory: [...(Array.isArray(active.attemptHistory) ? active.attemptHistory : []), attemptEntry].slice(-50),
    };

    if (result.ok) {
      console.log("✅ Lead entregue ao CRM Inteligente:", { eventKey: active.eventKey, leadId: result.data?.leadId, action: result.data?.action });
      workerTelemetry.lastDeliveryAt = completedAt;
      await queueStore.update({
        ...updated,
        status: "delivered",
        deliveredAt: completedAt,
        nextAttemptAt: "",
        lastError: "",
        updatedAt: completedAt,
      });
      return;
    }

    const message = result.data?.message || result.data?.error || `CRM respondeu HTTP ${result.status}.`;
    workerTelemetry.lastFailureAt = completedAt;
    const retryable = shouldRetryHttpStatus(result.status);
    const exhausted = Number(active.attempts || 0) >= config.maxAttempts;
    await queueStore.update({
      ...updated,
      status: !retryable || exhausted ? "failed_permanent" : "pending",
      nextAttemptAt: !retryable || exhausted ? "" : new Date(Date.now() + getRetryDelayMs(Number(active.attempts || 0))).toISOString(),
      lastError: String(message).slice(0, 2000),
      updatedAt: completedAt,
    });
  } catch (error) {
    const completedAt = nowIso();
    workerTelemetry.lastFailureAt = completedAt;
    workerTelemetry.lastHttpStatus = 0;
    const exhausted = Number(active.attempts || 0) >= config.maxAttempts;
    const message = String(error?.name === "AbortError" ? "Tempo de resposta do CRM excedido." : error?.message || error).slice(0, 2000);
    await queueStore.update({
      ...active,
      lastHttpStatus: 0,
      response: null,
      lastError: message,
      status: exhausted ? "failed_permanent" : "pending",
      nextAttemptAt: exhausted ? "" : new Date(Date.now() + getRetryDelayMs(Number(active.attempts || 0))).toISOString(),
      attemptHistory: [...(Array.isArray(active.attemptHistory) ? active.attemptHistory : []), {
        attempt: Number(active.attempts || 0),
        startedAt: attemptStartedAt,
        completedAt,
        latencyMs: 0,
        httpStatus: 0,
        outcome: exhausted ? "failed_permanent" : "retry_scheduled",
        error: message.slice(0, 1000),
      }].slice(-50),
      updatedAt: completedAt,
    });
  }
}


async function enqueueExternalCrmConversationEvent({ tenantId, lead, direction = 'inbound', messageId = '', conversationId = '', occurredAt, channel = 'whatsapp_web', preview = '', metadata = {} }) {
  if (['0', 'false', 'no', 'off'].includes(String(process.env.CRM_INTEGRATION_CONVERSATION_SYNC_ENABLED || '1').trim().toLowerCase())) {
    return { ok: true, queued: false, skipped: true, reason: 'conversation_sync_disabled' };
  }
  if (!lead || !lead.id) return { ok: false, queued: false, reason: 'invalid_lead' };
  const dir = direction === 'outbound' ? 'outbound' : 'inbound';
  const token = String(messageId || occurredAt || Date.now()).replace(/[^a-zA-Z0-9._:-]+/g, '_').slice(0, 160);
  return enqueueExternalCrmLead({
    tenantId,
    webhook: { id: 'whatsapp-conversation', name: 'Eventos da conversa WhatsApp', displayName: 'Sincronização da conversa WhatsApp' },
    lead,
    target: {
      enabled: true,
      source: String(process.env.WHATSAPP_INBOUND_CRM_SOURCE || 'WhatsApp'),
      profile: String(process.env.WHATSAPP_INBOUND_CRM_PROFILE || 'whatsapp_immersion_like'),
      temperature: String(process.env.WHATSAPP_INBOUND_CRM_TEMPERATURE || 'Quente'),
      priority: String(process.env.WHATSAPP_INBOUND_CRM_PRIORITY || 'alta'),
      commercialTreatment: 'conversation_sync',
    },
    payloadType: channel,
    eventType: dir === 'outbound' ? 'zape.message.sent' : 'zape.message.received',
    eventKey: `zape:${String(tenantId || 'admin')}:${String(lead.id)}:message:${dir}:${token}`,
    metadata: {
      channel, direction: dir, messageId: String(messageId || ''), conversationId: String(conversationId || ''),
      occurredAt: String(occurredAt || new Date().toISOString()), messagePreview: String(preview || '').slice(0, 500),
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
    },
  });
}

async function processExternalCrmQueue() {
  if (processing) return { ok: true, skipped: true };
  const config = getConfig();
  if (!config.enabled) return { ok: false, skipped: true, reason: "not_configured" };

  processing = true;
  workerTelemetry.lastCycleStartedAt = nowIso();
  workerTelemetry.lastCycleError = "";
  try {
    await queueStore.initialize();
    const dueItems = await queueStore.claimDue(DEFAULT_BATCH_SIZE);
    for (const item of dueItems) await processOne(item, config);
    await queueStore.prune({
      deliveredRetentionMs: positiveNumber(process.env.EXTERNAL_CRM_QUEUE_DELIVERED_RETENTION_DAYS, DEFAULT_DELIVERED_RETENTION_DAYS, 30) * 24 * 60 * 60_000,
      maxRows: Math.trunc(positiveNumber(process.env.EXTERNAL_CRM_QUEUE_MAX_ROWS, DEFAULT_QUEUE_MAX_ROWS, 10_000)),
    });
    workerTelemetry.lastCycleProcessed = dueItems.length;
    workerTelemetry.totalProcessed += dueItems.length;
    return { ok: true, processed: dueItems.length };
  } catch (error) {
    workerTelemetry.lastCycleError = String(error?.message || error).slice(0, 1000);
    throw error;
  } finally {
    workerTelemetry.lastCycleCompletedAt = nowIso();
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
  queueStore.initialize().catch((error) => { workerTelemetry.lastCycleError = String(error?.message || error).slice(0, 1000); console.error("❌ Não foi possível inicializar a fila do CRM externo:", error?.message || error); });
  workerTelemetry.running = true;
  workerTelemetry.startedAt = workerTelemetry.startedAt || nowIso();
  const intervalMs = positiveNumber(options.intervalMs || process.env.CRM_INTEGRATION_WORKER_INTERVAL_MS, DEFAULT_WORKER_INTERVAL_MS, 5_000);
  scheduleWake(250);
  workerTimer = setInterval(() => {
    processExternalCrmQueue().catch((error) => console.error("❌ Erro no worker do CRM externo:", error?.message || error));
  }, intervalMs);
  if (typeof workerTimer.unref === "function") workerTimer.unref();
}

function stopExternalCrmWorker() {
  workerTelemetry.running = false;
  if (workerTimer) clearInterval(workerTimer);
  if (wakeTimer) clearTimeout(wakeTimer);
  workerTimer = null;
  wakeTimer = null;
}

async function getExternalCrmQueueStatus(tenantId) {
  const items = (await queueStore.listAll()).filter((item) => !tenantId || String(item.tenantId) === String(tenantId));
  const counts = { pending: 0, sending: 0, delivered: 0, failedPermanent: 0 };
  items.forEach((item) => {
    if (item.status === "pending") counts.pending += 1;
    else if (item.status === "sending") counts.sending += 1;
    else if (item.status === "delivered") counts.delivered += 1;
    else if (item.status === "failed_permanent") counts.failedPermanent += 1;
  });
  const config = getConfig();
  const pendingItems = items.filter((item) => ["pending", "sending"].includes(item.status));
  const deliveredItems = items.filter((item) => item.status === "delivered");
  const oldestPending = pendingItems.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null;
  const lastDelivered = deliveredItems.sort((a, b) => String(b.deliveredAt || b.updatedAt).localeCompare(String(a.deliveredAt || a.updatedAt)))[0] || null;
  return {
    configured: config.enabled,
    baseUrl: config.baseUrl || "",
    healthy: Boolean(config.enabled && counts.failedPermanent === 0),
    counts,
    storage: await queueStore.getHealth(),
    oldestPendingAt: oldestPending?.createdAt || "",
    lastDeliveredAt: lastDelivered?.deliveredAt || lastDelivered?.updatedAt || "",
    recent: items.slice(-30).reverse().map((item) => publicQueueEvent(item)),
  };
}

async function retryExternalCrmQueue({ tenantId, eventKey = "" } = {}) {
  const normalizedTenant = String(tenantId || "").trim();
  const normalizedEventKey = String(eventKey || "").trim();
  const retried = await queueStore.retry({ tenantId: normalizedTenant, eventKey: normalizedEventKey });
  if (retried) scheduleWake(25);
  return { ok: true, retried, eventKey: normalizedEventKey, tenantId: normalizedTenant };
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length <= 6) return `${digits.slice(0, 2)}***${digits.slice(-2)}`;
  return `${digits.slice(0, Math.min(4, digits.length - 4))}${"*".repeat(Math.max(3, digits.length - 8))}${digits.slice(-4)}`;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function dateMatches(value, from, to) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return !from && !to;
  if (from && timestamp < from) return false;
  if (to && timestamp > to) return false;
  return true;
}

function publicQueueEvent(item, { detailed = false } = {}) {
  const base = {
    id: String(item.id || ""),
    eventKey: String(item.eventKey || ""),
    eventType: String(item.payload?.eventType || ""),
    tenantId: String(item.tenantId || ""),
    channel: String(item.payload?.metadata?.channel || item.payload?.metadata?.transport || "WhatsApp"),
    externalLeadId: String(item.externalLeadId || ""),
    leadName: String(item.payload?.lead?.name || "").slice(0, 160),
    phoneMasked: maskPhone(item.payload?.lead?.phone),
    status: String(item.status || ""),
    attempts: Number(item.attempts || 0),
    nextAttemptAt: String(item.nextAttemptAt || ""),
    lastAttemptAt: String(item.lastAttemptAt || ""),
    lastHttpStatus: Number(item.lastHttpStatus || 0),
    lastError: String(item.lastError || "").slice(0, 1000),
    crmLeadId: String(item.response?.leadId || ""),
    crmAction: String(item.response?.action || ""),
    responsible: String(item.response?.responsible || ""),
    assignmentMode: String(item.response?.assignmentMode || ""),
    duplicateMatched: Boolean(item.response?.duplicateMatched),
    createdAt: String(item.createdAt || ""),
    updatedAt: String(item.updatedAt || ""),
    deliveredAt: String(item.deliveredAt || ""),
    deliveryTimeMs: item.deliveredAt && item.createdAt ? Math.max(0, Date.parse(item.deliveredAt) - Date.parse(item.createdAt)) : null,
  };
  if (!detailed) return base;
  return {
    ...base,
    target: {
      pipelineId: String(item.payload?.target?.pipelineId || ""),
      stageId: String(item.payload?.target?.stageId || ""),
      source: String(item.payload?.target?.source || ""),
      profile: String(item.payload?.target?.profile || ""),
      temperature: String(item.payload?.target?.temperature || ""),
      priority: String(item.payload?.target?.priority || ""),
      commercialTreatment: String(item.payload?.target?.commercialTreatment || ""),
    },
    webhook: { ...(item.payload?.webhook || {}) },
    metadata: { ...(item.payload?.metadata || {}), phoneNumberId: item.payload?.metadata?.phoneNumberId ? "configured" : "" },
    response: item.response || null,
    attemptHistory: Array.isArray(item.attemptHistory) ? item.attemptHistory.slice(-50) : [],
  };
}

async function getExternalCrmEventDetail(eventKey) {
  const item = await queueStore.findByEventKey(String(eventKey || "").trim());
  return item ? publicQueueEvent(item, { detailed: true }) : null;
}

async function getExternalCrmMonitorOverview(options = {}) {
  const fromTimestamp = options.from ? Date.parse(String(options.from)) : 0;
  const toTimestamp = options.to ? Date.parse(String(options.to)) : 0;
  const from = Number.isFinite(fromTimestamp) ? fromTimestamp : 0;
  const to = Number.isFinite(toTimestamp) ? toTimestamp : 0;
  const statusFilter = String(options.status || "").trim();
  const tenantFilter = String(options.tenantId || "").trim().toLowerCase();
  const eventTypeFilter = String(options.eventType || "").trim();
  const search = String(options.search || "").trim().toLowerCase();
  const limit = boundedInteger(options.limit, 50, 1, 500);
  const offset = boundedInteger(options.offset, 0, 0, 1_000_000);
  await queueStore.initialize();
  const storage = await queueStore.getHealth();
  const mysqlSnapshot = storage.activeMode === "mysql"
    ? await queueStore.getMonitorSnapshot({ from: options.from, to: options.to, status: statusFilter, tenantId: tenantFilter, eventType: eventTypeFilter, search, limit, offset })
    : null;

  let counts;
  let actions;
  let eventTypes;
  let tenants;
  let daily;
  let averageDeliveryMs;
  let oldestPendingAt;
  let lastDeliveredAt;
  let events;
  let pagination;

  if (mysqlSnapshot) {
    counts = mysqlSnapshot.counts;
    actions = mysqlSnapshot.actions;
    eventTypes = mysqlSnapshot.eventTypes;
    tenants = mysqlSnapshot.tenants;
    daily = mysqlSnapshot.daily;
    averageDeliveryMs = mysqlSnapshot.averageDeliveryMs;
    oldestPendingAt = mysqlSnapshot.oldestPendingAt;
    lastDeliveredAt = mysqlSnapshot.lastDeliveredAt;
    events = mysqlSnapshot.events.map((item) => publicQueueEvent(item));
    pagination = mysqlSnapshot.pagination;
  } else {
    const allItems = await queueStore.listAll();
    const periodItems = allItems.filter((item) => dateMatches(item.createdAt, from, to));
    counts = { total: periodItems.length, pending: 0, sending: 0, delivered: 0, failedPermanent: 0 };
    eventTypes = {};
    actions = { created: 0, updated: 0, reactivated: 0, other: 0 };
    const tenantMap = new Map();
    const deliveryTimes = [];
    const dailyMap = new Map();

    for (const item of periodItems) {
      if (item.status === "pending") counts.pending += 1;
      else if (item.status === "sending") counts.sending += 1;
      else if (item.status === "delivered") counts.delivered += 1;
      else if (item.status === "failed_permanent") counts.failedPermanent += 1;
      const day = String(item.createdAt || "").slice(0, 10) || "unknown";
      const dailyRow = dailyMap.get(day) || { date: day, detected: 0, delivered: 0, failed: 0, pending: 0, averageDeliveryMs: 0, _deliveryTimes: [] };
      dailyRow.detected += 1;
      if (item.status === "delivered") dailyRow.delivered += 1;
      else if (item.status === "failed_permanent") dailyRow.failed += 1;
      else dailyRow.pending += 1;

      const eventType = String(item.payload?.eventType || "unknown");
      eventTypes[eventType] = Number(eventTypes[eventType] || 0) + 1;
      const action = String(item.response?.action || "");
      if (Object.prototype.hasOwnProperty.call(actions, action)) actions[action] += 1;
      else if (item.status === "delivered") actions.other += 1;
      if (item.deliveredAt && item.createdAt) {
        const elapsed = Date.parse(item.deliveredAt) - Date.parse(item.createdAt);
        if (Number.isFinite(elapsed) && elapsed >= 0) { deliveryTimes.push(elapsed); dailyRow._deliveryTimes.push(elapsed); }
      }
      dailyMap.set(day, dailyRow);

      const tenantId = String(item.tenantId || "unknown");
      const tenant = tenantMap.get(tenantId) || { tenantId, total: 0, pending: 0, sending: 0, delivered: 0, failedPermanent: 0, created: 0, updated: 0, reactivated: 0, lastDeliveredAt: "", lastError: "" };
      tenant.total += 1;
      if (item.status === "pending") tenant.pending += 1;
      else if (item.status === "sending") tenant.sending += 1;
      else if (item.status === "delivered") tenant.delivered += 1;
      else if (item.status === "failed_permanent") tenant.failedPermanent += 1;
      if (["created", "updated", "reactivated"].includes(action)) tenant[action] += 1;
      if (item.deliveredAt && (!tenant.lastDeliveredAt || item.deliveredAt > tenant.lastDeliveredAt)) tenant.lastDeliveredAt = item.deliveredAt;
      if (item.lastError && (!tenant.lastErrorAt || item.updatedAt > tenant.lastErrorAt)) { tenant.lastError = String(item.lastError).slice(0, 500); tenant.lastErrorAt = item.updatedAt; }
      tenantMap.set(tenantId, tenant);
    }

    const pendingItems = allItems.filter((item) => ["pending", "sending"].includes(item.status));
    const deliveredItems = allItems.filter((item) => item.status === "delivered");
    const oldestPending = [...pendingItems].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null;
    const lastDelivered = [...deliveredItems].sort((a, b) => String(b.deliveredAt || b.updatedAt).localeCompare(String(a.deliveredAt || a.updatedAt)))[0] || null;
    oldestPendingAt = oldestPending?.createdAt || "";
    lastDeliveredAt = lastDelivered?.deliveredAt || lastDelivered?.updatedAt || "";
    averageDeliveryMs = deliveryTimes.length ? Math.round(deliveryTimes.reduce((sum, value) => sum + value, 0) / deliveryTimes.length) : 0;
    tenants = Array.from(tenantMap.values()).sort((a, b) => b.total - a.total);
    daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)).map(({ _deliveryTimes, ...row }) => ({ ...row, averageDeliveryMs: _deliveryTimes.length ? Math.round(_deliveryTimes.reduce((sum, value) => sum + value, 0) / _deliveryTimes.length) : 0 }));

    const filtered = periodItems.filter((item) => {
      if (statusFilter && item.status !== statusFilter) return false;
      if (tenantFilter && String(item.tenantId || "").toLowerCase() !== tenantFilter) return false;
      if (eventTypeFilter && String(item.payload?.eventType || "") !== eventTypeFilter) return false;
      if (search) {
        const haystack = [item.eventKey, item.externalLeadId, item.payload?.lead?.name, item.payload?.lead?.phone, item.response?.leadId, item.response?.responsible].join(" ").toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    events = filtered.slice(offset, offset + limit).map((item) => publicQueueEvent(item));
    pagination = { total: filtered.length, limit, offset, hasMore: offset + limit < filtered.length };
  }

  const pendingAgeMinutes = oldestPendingAt ? Math.max(0, (Date.now() - Date.parse(oldestPendingAt)) / 60_000) : 0;
  const warningPending = positiveNumber(process.env.ZAPE_MONITOR_WARNING_PENDING_MINUTES, 5, 1);
  const criticalPending = positiveNumber(process.env.ZAPE_MONITOR_CRITICAL_PENDING_MINUTES, 15, warningPending);
  const warningFailed = positiveNumber(process.env.ZAPE_MONITOR_WARNING_FAILED_COUNT, 1, 1);
  const criticalFailed = positiveNumber(process.env.ZAPE_MONITOR_CRITICAL_FAILED_COUNT, 5, warningFailed);
  const config = getConfig();
  const reasons = [];
  let healthStatus = "healthy";
  if (!config.enabled) { healthStatus = "critical"; reasons.push("Integração com o BobCRM não configurada."); }
  if (storage.configuredMode === "mysql" && storage.activeMode !== "mysql") { healthStatus = "critical"; reasons.push(`Fila MySQL indisponível: ${storage.fallbackReason || "fallback JSON ativo"}.`); }
  if (counts.failedPermanent >= criticalFailed || pendingAgeMinutes >= criticalPending || workerTelemetry.lastCycleError) healthStatus = "critical";
  else if (counts.failedPermanent >= warningFailed || pendingAgeMinutes >= warningPending) healthStatus = "attention";
  if (counts.failedPermanent) reasons.push(`${counts.failedPermanent} falha(s) permanente(s) no período.`);
  if (pendingAgeMinutes >= warningPending) reasons.push(`Evento pendente mais antigo há ${Math.round(pendingAgeMinutes)} minuto(s).`);
  if (workerTelemetry.lastCycleError) reasons.push(`Último erro do worker: ${workerTelemetry.lastCycleError}`);

  return {
    generatedAt: nowIso(),
    health: { status: healthStatus, reasons },
    configured: config.enabled,
    targetBaseUrl: config.baseUrl,
    worker: { ...workerTelemetry, processing },
    storage,
    queue: { counts, oldestPendingAt, lastDeliveredAt, pendingAgeMinutes: Math.round(pendingAgeMinutes * 10) / 10 },
    metrics: { deliveryRate: counts.total ? Math.round((counts.delivered / counts.total) * 10_000) / 100 : 100, averageDeliveryMs, actions, eventTypes },
    trends: { daily },
    tenants,
    events,
    pagination,
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
  enqueueExternalCrmConversationEvent,
  fetchExternalCrmCatalog,
  getExternalCrmQueueStatus,
  getExternalCrmMonitorOverview,
  getExternalCrmEventDetail,
  getLegacyActiveCampaignTarget,
  processExternalCrmQueue,
  retryExternalCrmQueue,
  startExternalCrmWorker,
  initializeExternalCrmQueueStore: () => queueStore.initialize(),
  stopExternalCrmWorker,
};
