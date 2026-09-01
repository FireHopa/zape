require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { assertAuthConfiguration, listTenantConfigs, getTenantConfig, isTenantEnabled, refreshTenantConfigs } = require("./src/authConfig");
const { assertRuntimeConfiguration, applyTrustProxy } = require("./src/runtimeConfig");
const {
  FEATURES,
  assertDeploymentConfiguration,
  requireFeature,
  resolveFeature,
  releaseMetadata,
  featureSnapshot,
} = require("./src/deploymentControl");

let runtimeConfig;
let deploymentConfig;
try {
  const authConfig = assertAuthConfiguration();
  for (const warning of authConfig.warnings) console.warn(`[CONFIG] ${warning}`);
  runtimeConfig = assertRuntimeConfiguration();
  for (const warning of runtimeConfig.warnings) console.warn(`[CONFIG] ${warning}`);
  deploymentConfig = assertDeploymentConfiguration();
  for (const warning of deploymentConfig.warnings) console.warn(`[CONFIG] ${warning}`);
} catch (error) {
  console.error(`[SECURITY] ${error.code || "CONFIGURATION_INVALID"}: ${error.message}`);
  process.exit(1);
}

const { adminAuth } = require("./src/adminAuth");
const { panelAuth } = require("./src/panelAuth");
const { reginaAuth } = require("./src/reginaAuth"); // NOVO: Autenticação da Regina
const { portugalAuth } = require("./src/portugalAuth"); // NOVO: Autenticação do painel Portugal
const { felipeAuth } = require("./src/felipeAuth"); // NOVO: Autenticação do painel Felipe
const { anaAuth } = require("./src/anaAuth"); // NOVO: Autenticação do painel Ana Salomão
const { registerAuthRoutes, anyTenantAuth, makeTenantAuth } = require("./src/basicAuthFactory");
const { ROLES, PERMISSIONS, requireRole, requirePermission } = require("./src/authorization");
const { recordSecurityAudit } = require("./src/securityAuditStore");
const { buildHelmetMiddleware, buildCorsMiddleware, securityResponseHeaders } = require("./src/httpSecurity");
const { csrfProtection, loginOriginProtection } = require("./src/csrfProtection");
const { registerTenantPanelRoutes } = require("./src/routes/tenant/registerTenantPanelRoutes");
const { createLeadFromPayload, findLeadByWhatsapp: findLeadByWhatsappIntake, saveLeadRecord } = require("./src/leadIntakeService");
const { handleInboundCloudLead } = require("./src/inboundLeadAutomation");
const { resolveCloudInboundTenant } = require("./src/waCloudTenantRouting");
const { registerHealthRoutes } = require("./src/routes/healthRoutes");
const { registerBusinessRoutes } = require("./src/routes/businessRoutes");
const { registerAdminMonitoringRoutes } = require("./src/routes/adminMonitoringRoutes");
const { registerAdminDeploymentRoutes } = require("./src/routes/adminDeploymentRoutes");

const { normalizeBRPhoneToE164Digits, normalizePhoneToE164Digits, phoneSearchVariants, extractPhoneRegion } = require("./src/phone");

const { readLeads: readJsonLeads, deleteLeadById, toCSV, leadVersion } = require("./src/tenantLeadsStore");
const { RepositoryConflictError } = require("./src/repositories/leadRepository");
const databaseRuntime = require("./src/database/runtime");
const { parseLeadQuery, sortLeadItems, paginateLeadItems } = require("./src/leadQuery");
const { LeadServiceError, updateLead, mergeLeads } = require("./src/leadService");
const { validateDataIntegrityOnBoot } = require("./src/dataIntegrity");
const { dataRoot, ensureTenantDir } = require("./src/tenantPaths");
const { inspectTenantSession } = require("./src/whatsappSessionGuard");
const { listTags, upsertTag, deleteTag } = require("./src/tenantTagsStore");
const { getLeadTagsMap, setLeadTags, removeTagFromAllLeads, removeLeadTags } = require("./src/tenantLeadTagsStore");
const { readCrmState, writeCrmState } = require("./src/tenantCrmStore");

const { getTemplate, setTemplate } = require("./src/messageTemplateStore");

function updateTemplateSafe(tenantId, text) {
  if (typeof setTemplate !== "function") {
    throw new Error("Template store inválido: setTemplate não encontrado");
  }
  return setTemplate(tenantId, String(text || "").trim());
}
const { isWhatsAppConfigured, computeLeadStatus, getTenantWA, sendCustomMessage, sendCustomAudioMessage, sendCustomAttachmentMessage, getChatTextMessages, getChatsSnapshotForDigits, destroyCachedWhatsAppClients } = require("./src/whatsappManager");
const { listConversationDigits, listConversationMessages, listConversationSummaries, resolveConversationMedia } = require("./src/tenantConversationStore");

// CORREÇÃO: importando updateWebhook
const { listWebhooks, createWebhook, updateWebhook, deleteWebhook, resolveWebhookToken } = require("./src/webhooksStore");
const {
  enqueueExternalCrmLead,
  enqueueExternalCrmConversationEvent,
  fetchExternalCrmCatalog,
  getExternalCrmQueueStatus,
  getExternalCrmMonitorOverview,
  getExternalCrmEventDetail,
  getLegacyActiveCampaignTarget,
  retryExternalCrmQueue,
  startExternalCrmWorker,
  stopExternalCrmWorker,
} = require("./src/externalCrmIntegration");
const { authorizeBobCrmReverseSync, applyBobCrmEvent, initializeBobCrmReverseSync, getBobCrmReverseSyncStatus } = require("./src/bobCrmReverseSync");

// CORREÇÃO: importando as funções do Dono do Negócio
const { readBusinessOwner, writeBusinessOwner } = require("./src/businessStore");

const {
  isCloudConfigured: isCloudApiConfigured,
  saveEmbeddedSignupSettings,
  exchangeEmbeddedSignupCode,
  disconnectCloudApi,
  createTemplate: createCloudTemplate,
  sendTemplate: sendCloudTemplate,
  listTemplates: listCloudTemplates,
  listTemplateLibrary: listCloudTemplateLibrary,
  handleWebhook: handleCloudWebhook,
  getCloudStatus,
  runCloudHealthCheck,
  listStatus: listCloudStatus,
} = require("./src/waCloud");
const {
  createCampaign: createCloudDispatchCampaign,
  updateCampaign: updateCloudDispatchCampaign,
  recordEvent: recordCloudDispatchEvent,
  updateEvent: updateCloudDispatchEvent,
  updateByMessageId: updateCloudDispatchByMessageId,
  correlateInbound: correlateCloudInbound,
  recordProviderEvent: recordCloudProviderEvent,
  listCampaigns: listCloudDispatchCampaigns,
  listEvents: listCloudDispatchEvents,
} = require("./src/waCloudDispatchStore");
const { normalizeMetaError } = require("./src/metaErrorHelper");
const { PersistentJobQueue, QueueError } = require("./src/persistentJobQueue");
const { createAutomaticMessageQueue } = require("./src/automaticMessageQueue");
const { maskIdentifier, safeError, sanitizeForLog } = require("./src/safeLog");
const { StructuredLogger, correlationMiddleware, installConsoleBridge } = require("./src/structuredLogger");
const { createWebhookRequestDiagnostics, webhookTransportDiagnosticsMiddleware } = require("./src/webhookDiagnosticLogger");
const { defaultMetrics } = require("./src/metricsRegistry");
const { AlertManager } = require("./src/alertManager");
const { collectSystemSnapshot, evaluateSystemAlerts } = require("./src/systemMonitor");
const { exportJsonContact, deleteJsonContact, exportDatabaseContact, deleteDatabaseContact } = require("./src/lgpdService");
const {
  ABSOLUTE_MAX_BYTES: MEDIA_ABSOLUTE_MAX_BYTES,
  baseMime: baseMediaMime,
  sanitizeFilename: sanitizeMediaFilename,
  validateMediaFile,
  streamRequestToTempFile,
  scanMediaFile,
  shouldServeInline,
  safeContentDisposition,
} = require("./src/mediaSecurity");
const { getRuntimeConfig: getWaCloudRuntimeConfig } = require("./src/waCloudConfigStore");
const { connectionFromRuntimeConfig, assertWebhookMatchesConnection } = require("./src/waCloudConnection");
const {
  envBool: securityEnvBool,
  customWebhookSignatureRequired,
  positiveInt: securityPositiveInt,
  sha256: securitySha256,
  timingSafeEqualText,
  getRawBody,
  parseJsonBuffer,
  isJsonContentType,
  resolveClientIp,
  validateMetaSignature,
  validateCustomWebhookSignature,
  validateFixedWebhookToken,
  validatePublicLeadPayload,
  validateActiveCampaignPayload,
  validateCustomWebhookPayload,
  validateMetaWebhookPayload,
  extractMetaPhoneNumberId,
  deriveMetaEventKey,
  InMemoryRateLimiter,
  respondSecurityError,
  enforceRateLimit,
} = require("./src/webhookSecurity");
const {
  claimWebhookEvent,
  completeWebhookEvent,
  releaseWebhookEvent,
} = require("./src/webhookEventStore");

const app = express();
const structuredLogger = new StructuredLogger();
const alertManager = new AlertManager({ logger: structuredLogger });
installConsoleBridge({ logger: structuredLogger, passthrough: true });

// Confia somente na quantidade explícita de proxies reversos definida no boot.
// Nunca use `true`: isso permitiria que um cliente externo forjasse cabeçalhos encaminhados.
applyTrustProxy(app, runtimeConfig.trustProxyHops);
app.use(correlationMiddleware({ logger: structuredLogger, metrics: defaultMetrics }));

const DEBUG = String(process.env.DEBUG || "").toLowerCase() === "true" || process.env.DEBUG === "1";
const logOk = (...a) => console.log("[OK]", ...a);
const logErr = (...a) => console.error("[ERROR]", ...a);
const PORT = runtimeConfig.port;
const HOST = runtimeConfig.host;

const automaticMessageQueue = createAutomaticMessageQueue({
  file: path.join(dataRoot(), "automatic_message_jobs.json"),
  sendMessage: sendCustomMessage,
  getTenantWhatsApp: getTenantWA,
  logger: console,
  pollIntervalMs: Number(process.env.AUTOMATIC_MESSAGE_QUEUE_POLL_MS || 500),
  maxAttempts: Number(process.env.AUTOMATIC_MESSAGE_QUEUE_MAX_ATTEMPTS || 5),
  baseDelayMs: Number(process.env.AUTOMATIC_MESSAGE_QUEUE_RETRY_BASE_MS || 30000),
  maxDelayMs: Number(process.env.AUTOMATIC_MESSAGE_QUEUE_RETRY_MAX_MS || 600000),
  readyTimeoutMs: Number(process.env.AUTOMATIC_MESSAGE_READY_TIMEOUT_MS || process.env.WA_READY_TIMEOUT_MS || 60000),
});

function readLeads(tenantId) {
  return databaseRuntime.isDatabasePrimary()
    ? databaseRuntime.readLeadsFromCache(tenantId)
    : readJsonLeads(tenantId);
}

const TENANT_ADMIN = "admin";
const TENANT_PANEL = "panel";
const TENANT_REGINA = "regina"; // NOVO: Inquilino da Regina
const TENANT_PORTUGAL = "portugal"; // NOVO: Inquilino do painel Portugal
const TENANT_FELIPE = "felipe"; // NOVO: Inquilino do painel Felipe
const TENANT_ANA = "ana"; // NOVO: Inquilino do painel Ana Salomão

const STATIC_TENANT_AUTHS = Object.freeze({
  [TENANT_ADMIN]: adminAuth,
  [TENANT_PANEL]: panelAuth,
  [TENANT_REGINA]: reginaAuth,
  [TENANT_PORTUGAL]: portugalAuth,
  [TENANT_FELIPE]: felipeAuth,
  [TENANT_ANA]: anaAuth,
});

const publicEndpointRateLimiter = new InMemoryRateLimiter();
const PUBLIC_RATE_WINDOW_MS = securityPositiveInt(process.env.PUBLIC_RATE_LIMIT_WINDOW_MS, 60_000, { min: 1_000, max: 3_600_000 });
const PUBLIC_FORM_RATE_MAX = securityPositiveInt(process.env.PUBLIC_FORM_RATE_LIMIT_MAX, 20, { min: 1, max: 10_000 });
const ACTIVECAMPAIGN_RATE_MAX = securityPositiveInt(process.env.ACTIVECAMPAIGN_RATE_LIMIT_MAX, 120, { min: 1, max: 100_000 });
const CUSTOM_WEBHOOK_RATE_MAX = securityPositiveInt(process.env.CUSTOM_WEBHOOK_RATE_LIMIT_MAX, 120, { min: 1, max: 100_000 });
const META_WEBHOOK_RATE_MAX = securityPositiveInt(process.env.META_WEBHOOK_RATE_LIMIT_MAX, 600, { min: 1, max: 100_000 });

/* -------------------- middlewares -------------------- */
app.use(buildHelmetMiddleware());
app.use(securityResponseHeaders);
app.use(buildCorsMiddleware());
app.use(loginOriginProtection());
app.use(csrfProtection());

// Endpoints públicos recebem parsers e limites próprios antes do parser amplo das rotas autenticadas.
// O raw body não é armazenado globalmente: ele existe apenas durante a validação HMAC dos webhooks.
const PUBLIC_FORM_BODY_LIMIT = process.env.PUBLIC_FORM_BODY_LIMIT || "250kb";
const PUBLIC_WEBHOOK_BODY_LIMIT = process.env.PUBLIC_WEBHOOK_BODY_LIMIT || "500kb";
const META_WEBHOOK_BODY_LIMIT = process.env.META_WEBHOOK_BODY_LIMIT || "1mb";

app.use("/api/leads", express.json({ limit: PUBLIC_FORM_BODY_LIMIT, strict: true }));
app.use("/api/leads", express.urlencoded({ extended: true, limit: PUBLIC_FORM_BODY_LIMIT, parameterLimit: 50 }));
app.use("/webhooks/activecampaign", express.json({ limit: PUBLIC_WEBHOOK_BODY_LIMIT, strict: true }));
app.use("/webhooks/activecampaign", express.urlencoded({ extended: true, limit: PUBLIC_WEBHOOK_BODY_LIMIT, parameterLimit: 500 }));
app.use("/webhooks/wa-cloud", express.raw({ type: "application/json", limit: META_WEBHOOK_BODY_LIMIT }));
const generatedWebhookPath = /^\/webhooks\/(?!wa-cloud(?:\/|$)|activecampaign(?:\/|$))[^/]+$/;
const captureRawBody = (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); };
app.use(generatedWebhookPath, webhookTransportDiagnosticsMiddleware());
app.use(generatedWebhookPath, express.json({ limit: PUBLIC_WEBHOOK_BODY_LIMIT, strict: true, verify: captureRawBody }));
app.use(generatedWebhookPath, express.urlencoded({ extended: true, limit: PUBLIC_WEBHOOK_BODY_LIMIT, parameterLimit: 500, verify: captureRawBody }));

const AUTHENTICATED_BODY_LIMIT = process.env.AUTHENTICATED_BODY_LIMIT || "16mb";
app.use(express.urlencoded({ extended: true, limit: AUTHENTICATED_BODY_LIMIT }));
app.use(express.json({ limit: AUTHENTICATED_BODY_LIMIT }));

registerAuthRoutes(app);

// debug request logger
app.use((req, res, next) => {
  if (!DEBUG) return next();
  const t0 = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - t0;
    const ok = res.statusCode < 400;
    (ok ? logOk : logErr)(`${req.method} ${safeRequestPath(req)} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Entrada padrão do sistema.
// O formulário antigo de leads não é mais usado na interface pública.
// A raiz agora abre o painel unificado e, quando houver senha configurada, cai na tela de login.
app.get("/", (req, res) => {
  res.redirect("/admin");
});

// Evita acesso direto aos HTMLs estáticos. As telas passam pelas rotas autenticadas.
app.get(["/index.html", "/app.html", "/admin.html", "/panel.html", "/regina.html", "/portugal.html", "/felipe.html", "/ana.html"], (req, res) => {
  const p = String(req.path || "");
  const target = p.includes("panel") ? "/panel" : p.includes("regina") ? "/regina" : p.includes("portugal") ? "/portugal" : p.includes("felipe") ? "/felipe" : p.includes("ana") ? "/ana" : "/admin";
  res.redirect(target);
});

// estático
app.get("/vendor/dompurify.min.js", (req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "node_modules", "dompurify", "dist", "purify.min.js"));
});
app.use(
  "/vendor/phosphor",
  express.static(path.join(__dirname, "node_modules", "@phosphor-icons", "web", "src", "regular"), {
    index: false,
    immutable: process.env.NODE_ENV === "production",
    maxAge: process.env.NODE_ENV === "production" ? "7d" : 0,
  })
);
app.use(express.static(path.join(__dirname, "public"), { index: false }));

/* -------------------- helpers -------------------- */
function genId() {
  return crypto.randomBytes(12).toString("hex");
}

function isProduction() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function safeRequestPath(req) {
  const pathname = String(req?.path || "").split("?")[0];
  if (/^\/webhooks\/[^/]+$/.test(pathname) && pathname !== "/webhooks/wa-cloud" && pathname !== "/webhooks/activecampaign") {
    return "/webhooks/[redacted]";
  }
  return pathname || "/";
}

function publicEndpointIdentity(req, suffix = "") {
  return `${resolveClientIp(req)}:${String(suffix || "").slice(0, 160)}`;
}

function requireSupportedBody(req, res, { allowForm = false } = {}) {
  const contentType = String(req.get("content-type") || "").toLowerCase();
  const supported = isJsonContentType(req) || (allowForm && /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType));
  if (!supported) {
    respondSecurityError(res, 415, "UNSUPPORTED_CONTENT_TYPE", allowForm
      ? "Use application/json ou application/x-www-form-urlencoded."
      : "Use application/json.");
    return false;
  }
  return true;
}

function publicEndpointErrorStatus(error) {
  const explicit = Number(error?.statusCode || error?.status || 0);
  if (explicit >= 400 && explicit < 600) return explicit;
  const code = String(error?.code || "");
  if (/^(INVALID_|PAYLOAD_|FIELD_|UNKNOWN_FIELDS|TOO_MANY_FIELDS|ARRAY_TOO_LARGE|WEBHOOK_(TIMESTAMP|EVENT_ID|SIGNATURE)_)/.test(code)) return 400;
  if (/^Lead inválido/i.test(String(error?.message || ""))) return 400;
  return 500;
}

function handlePublicEndpointError(res, error, fallbackCode = "INVALID_PAYLOAD") {
  const safeStatus = publicEndpointErrorStatus(error);
  const message = safeStatus >= 500 ? "Endpoint temporariamente indisponível." : (error?.message || "Payload inválido.");
  return respondSecurityError(res, safeStatus, error?.code || fallbackCode, message);
}

function duplicateWebhookResponse(res, claim) {
  if (claim.conflict) return respondSecurityError(res, 409, "IDEMPOTENCY_CONFLICT", "A chave de idempotência já foi usada com outro payload.");
  if (claim.pending) return res.status(202).json({ ok: true, duplicate: true, pending: true });
  const body = claim.responseBody && typeof claim.responseBody === "object"
    ? { ...claim.responseBody, duplicate: true }
    : { ok: true, duplicate: true };
  return res.status(Number(claim.statusCode || 200)).json(body);
}

function idempotencyUnavailableError(cause) {
  const error = new Error("Armazenamento de idempotência indisponível.");
  error.code = "WEBHOOK_IDEMPOTENCY_UNAVAILABLE";
  error.statusCode = 503;
  error.cause = cause;
  return error;
}

function completeWebhookEventRequired(args) {
  try {
    if (!completeWebhookEvent(args)) throw new Error("Evento de webhook não encontrado para conclusão.");
    return true;
  } catch (error) {
    throw idempotencyUnavailableError(error);
  }
}

function completeWebhookEventBestEffort(args) {
  try {
    return completeWebhookEvent(args);
  } catch (error) {
    logErr("Falha ao persistir resultado técnico do webhook:", safeError(error));
    return false;
  }
}

function activeCampaignEventId(req) {
  const explicit = String(req.get("x-zape-event-id") || req.get("x-idempotency-key") || "").trim();
  if (explicit) return explicit.slice(0, 200);
  return `payload:${securitySha256(JSON.stringify(req.body || {}))}`;
}

function isActiveCampaignWebhookPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const contact = payload.contact;
  if (!contact || typeof contact !== "object" || Array.isArray(contact)) return false;

  const hasContactIdentity = Boolean(
    String(contact.id || "").trim()
    || String(contact.email || "").trim()
    || String(contact.phone || "").trim()
  );
  const hasActiveCampaignShape = Boolean(
    Object.prototype.hasOwnProperty.call(payload, "seriesid")
    || Object.prototype.hasOwnProperty.call(contact, "fields")
    || Object.prototype.hasOwnProperty.call(contact, "tags")
    || Object.prototype.hasOwnProperty.call(contact, "first_name")
  );

  return hasContactIdentity && hasActiveCampaignShape;
}

function auditSecurityAction(req, action, resource, outcome = "success", details = undefined) {
  try {
    return recordSecurityAudit({
      req,
      action,
      resource,
      outcome,
      targetTenantId: req?.auth?.tenantId || "",
      details,
    });
  } catch (error) {
    console.error("[SECURITY] Falha ao registrar auditoria:", safeError(error));
    return null;
  }
}

function auditDeniedAdministrativeRequest(action, resource) {
  return function auditDeniedMiddleware(req, res, next) {
    res.once("finish", () => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        auditSecurityAction(req, action, resource, "denied", { statusCode: res.statusCode });
      }
    });
    next();
  };
}

function getPublicBaseUrl(req) {
  const envBase = String(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
  if (envBase) return envBase;

  const host = req.get("x-forwarded-host") || req.get("host") || "localhost";
  const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim();
  const proto = forwardedProto || req.protocol || (req.secure ? "https" : "http");
  return `${proto}://${host}`;
}

function summarizeLeadWhatsappStats(tenantId, { notDeliveredAfterMin = 30 } = {}) {
  const timeout = Math.max(1, Number(notDeliveredAfterMin || 30)) * 60 * 1000;
  const wa = getTenantWA(tenantId);
  const leads = readLeads(tenantId);

  const seen = new Set();
  const out = {
    replied: 0,
    deliveredNoReply: 0,
    notDelivered: 0,
    notOnWhatsapp: 0,
    pending: 0,
    none: 0,
    totalLeads: leads.length,
    totalWithWhatsapp: 0,
  };

  for (const lead of leads) {
    const digits = String((lead && lead.whatsapp_digits) || "").replace(/\D+/g, "");
    if (!digits || seen.has(digits)) continue;
    seen.add(digits);
    out.totalWithWhatsapp++;

    const ms = wa.getMessageStatusFor(digits);
    const st = computeLeadStatus(ms, { notDeliveredAfterMs: timeout });
    if (st === "replied") out.replied++;
    else if (st === "delivered") out.deliveredNoReply++;
    else if (st === "notDelivered") out.notDelivered++;
    else if (st === "notExists") out.notOnWhatsapp++;
    else if (st === "pending") out.pending++;
    else out.none++;
  }

  return out;
}

async function saveLead(tenantId, lead) {
  return saveLeadRecord(tenantId, lead);
}

async function processLead(tenantId, source, payload) {
  const lead = await createLeadFromPayload(tenantId, source, payload, {
    allowPhoneOnly: payload?.allowPhoneOnly === true,
  });

  console.log(`✅ Lead salvo [${tenantId}]`, {
    leadId: lead.id,
    source: lead.source,
    contact: maskIdentifier(lead.whatsapp_digits),
  });

  return lead;
}

function findExistingLeadByWhatsapp(tenantId, whatsapp) {
  return findLeadByWhatsappIntake(tenantId, whatsapp);
}

async function processWebhookLead(tenantId, source, payload, diagnostic) {
  try {
    const lead = await processLead(tenantId, source, payload);
    return { lead, created: true, reused: false };
  } catch (error) {
    if (String(error?.code || "") !== "LEAD_PHONE_CONFLICT") throw error;

    const existing = findExistingLeadByWhatsapp(tenantId, payload?.whatsapp);
    if (!existing) throw error;

    diagnostic?.warn("custom.existing_lead_reused", {
      leadId: existing.id || "",
      reason: "phone_already_registered",
      conflictLeadId: error?.details?.conflictLeadId || existing.id || "",
      source: existing.source || "",
      createdAt: existing.createdAt || "",
    });

    return { lead: existing, created: false, reused: true };
  }
}

function extractDDDFromDigits(digits) {
  return extractPhoneRegion(digits);
}

function digitsOnlyServer(input) {
  return String(input || "").replace(/\D+/g, "").replace(/^0+/, "");
}

function extractPhoneGeoFromDigits(input) {
  const raw = digitsOnlyServer(input);
  const d = normalizePhoneToE164Digits(input) || raw;
  if (!d) return null;

  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const prefix = d.slice(2, 4);
    return {
      key: `BR:${prefix}`,
      country: "BR",
      countryName: "Brasil",
      ddi: "55",
      prefix,
      ddd: prefix,
      label: `DDD ${prefix}`,
      filterValue: prefix,
    };
  }

  if (d.startsWith("351") && d.length === 12) {
    const prefix = d.slice(3, 5);
    return {
      key: `PT:${prefix}`,
      country: "PT",
      countryName: "Portugal",
      ddi: "351",
      prefix,
      ddd: prefix,
      label: `Portugal ${prefix}`,
      filterValue: prefix,
    };
  }

  // Compatibilidade: registros antigos do Brasil sem DDI.
  if (raw && (raw.length === 10 || raw.length === 11)) {
    const prefix = raw.slice(0, 2);
    return {
      key: `BR:${prefix}`,
      country: "BR",
      countryName: "Brasil",
      ddi: "55",
      prefix,
      ddd: prefix,
      label: `DDD ${prefix}`,
      filterValue: prefix,
    };
  }

  // Compatibilidade: registros antigos de Portugal sem DDI.
  if (raw && raw.length === 9 && /^[2-9]/.test(raw)) {
    const prefix = raw.slice(0, 2);
    return {
      key: `PT:${prefix}`,
      country: "PT",
      countryName: "Portugal",
      ddi: "351",
      prefix,
      ddd: prefix,
      label: `Portugal ${prefix}`,
      filterValue: prefix,
    };
  }

  const prefix = extractPhoneRegion(d) || extractPhoneRegion(raw);
  return prefix ? {
    key: `UNK:${prefix}`,
    country: "",
    countryName: "",
    ddi: "",
    prefix,
    ddd: prefix,
    label: `Prefixo ${prefix}`,
    filterValue: prefix,
  } : null;
}

function getMessageStatusForPhoneVariants(wa, input) {
  if (!wa || typeof wa.getMessageStatusFor !== "function") return null;
  const variants = phoneSearchVariants(input);
  for (const variant of variants) {
    const ms = wa.getMessageStatusFor(variant);
    if (ms) return ms;
  }
  const raw = digitsOnlyServer(input);
  return raw ? wa.getMessageStatusFor(raw) : null;
}

function findLeadByPhoneVariants(byPhone, input) {
  if (!byPhone || !input) return null;
  const variants = phoneSearchVariants(input);
  for (const variant of variants) {
    const row = byPhone.get(variant);
    if (row && row.lead) return row.lead;
  }
  return null;
}

function phoneMatchesSearch(lead, queryDigits) {
  const queryVariants = phoneSearchVariants(queryDigits);
  if (!queryVariants.length) return false;

  const candidateVariants = new Set();
  for (const value of [lead.whatsapp_raw, lead.whatsapp_digits, lead.whatsapp, lead.phone, lead.telefone]) {
    for (const variant of phoneSearchVariants(value)) candidateVariants.add(variant);
  }

  for (const candidate of candidateVariants) {
    for (const query of queryVariants) {
      if (candidate.includes(query) || query.includes(candidate)) return true;
    }
  }

  return false;
}

function leadPhoneKey(lead) {
  if (!lead) return "";
  const candidates = [
    lead.whatsapp_digits,
    lead.whatsapp_raw,
    lead.whatsapp,
    lead.phone,
    lead.telefone,
  ];

  for (const value of candidates) {
    const normalized = normalizePhoneToE164Digits(value);
    if (normalized) return normalized;

    const d = String(value || "").replace(/\D+/g, "").replace(/^0+/, "");
    if (d) return d;
  }

  return "";
}

function mergeLeadTagData(target, incoming) {
  const ids = new Set();
  for (const id of Array.isArray(target.tagIds) ? target.tagIds : []) {
    if (id) ids.add(String(id));
  }
  for (const id of Array.isArray(incoming.tagIds) ? incoming.tagIds : []) {
    if (id) ids.add(String(id));
  }
  target.tagIds = Array.from(ids);

  const byId = new Map();
  for (const tag of Array.isArray(target.tagsFull) ? target.tagsFull : []) {
    if (tag && tag.id) byId.set(String(tag.id), tag);
  }
  for (const tag of Array.isArray(incoming.tagsFull) ? incoming.tagsFull : []) {
    if (tag && tag.id && !byId.has(String(tag.id))) byId.set(String(tag.id), tag);
  }
  target.tagsFull = Array.from(byId.values());
}

function dedupeLeadItemsByWhatsapp(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  const byPhone = new Map();

  for (const item of list) {
    const phoneKey = leadPhoneKey(item);

    // Lead sem WhatsApp continua aparecendo, porque não existe número para deduplicar.
    if (!phoneKey) {
      out.push({ ...item, duplicateCount: 0, duplicateLeadIds: [] });
      continue;
    }

    const existing = byPhone.get(phoneKey);
    if (!existing) {
      const cloned = { ...item, duplicateCount: 0, duplicateLeadIds: [], whatsappKey: phoneKey };
      byPhone.set(phoneKey, cloned);
      out.push(cloned);
      continue;
    }

    existing.duplicateCount = Number(existing.duplicateCount || 0) + 1;
    if (item.id) {
      existing.duplicateLeadIds = Array.from(new Set([...(existing.duplicateLeadIds || []), String(item.id)]));
    }

    // Mantém o registro mais recente como principal, mas aproveita dados que estiverem faltando.
    for (const field of ["nome", "empresa", "email", "website", "jaAnuncia", "whatsapp_raw", "whatsapp_digits"]) {
      if (!existing[field] && item[field]) existing[field] = item[field];
    }

    mergeLeadTagData(existing, item);
  }

  return out;
}

function getLeadItemsForRequest(tenantId, req, { paginate = true } = {}) {
  const q = String(req.query.q || "").toLowerCase().trim();
  const from = String(req.query.from || "").trim();
  const to = String(req.query.to || "").trim();
  const origin = String(req.query.origin || "").toLowerCase().trim();
  const parsedQuery = parseLeadQuery(req.query || {});

  const ddd = String(req.query.ddd || "").trim().replace(/\D+/g, "");
  const statusFilter = String(req.query.status || "").trim();
  const notDeliveredAfterMin = Number(req.query.notDeliveredAfterMin || 30);
  const notDeliveredAfterMs = Math.max(1, notDeliveredAfterMin) * 60 * 1000;

  const tag = String(req.query.tag || "").trim();
  const tagsCsv = String(req.query.tags || "").trim();
  const filterTagIds = []
    .concat(tag ? [tag] : [])
    .concat(tagsCsv ? tagsCsv.split(",") : [])
    .map((x) => String(x).trim())
    .filter(Boolean);

  let leads = readLeads(tenantId);

  if (from) {
    const fromISO = new Date(from + "T00:00:00.000Z").toISOString();
    leads = leads.filter((l) => String(l.createdAt) >= fromISO);
  }
  if (to) {
    const toISO = new Date(to + "T23:59:59.999Z").toISOString();
    leads = leads.filter((l) => String(l.createdAt) <= toISO);
  }
  if (q) {
    const rawQuery = String(req.query.q || "").trim();
    const qDigits = rawQuery.replace(/\D+/g, "");
    const phoneLikeQuery = qDigits.length >= 4 && /^[+\d\s().-]+$/.test(rawQuery);
    leads = leads.filter(
      (l) =>
        String(l.nome || "").toLowerCase().includes(q) ||
        String(l.email || "").toLowerCase().includes(q) ||
        String(l.empresa || "").toLowerCase().includes(q) ||
        String(l.whatsapp_raw || "").toLowerCase().includes(q) ||
        String(l.whatsapp_digits || "").toLowerCase().includes(q) ||
        (phoneLikeQuery && phoneMatchesSearch(l, qDigits))
    );
  }

  if (origin) {
    leads = leads.filter((lead) => [lead.source, lead.sourceDetail, lead.originDetail, lead.webhookName]
      .map((value) => String(value || "").toLowerCase())
      .some((value) => value.includes(origin)));
  }

  if (ddd) leads = leads.filter((l) => extractDDDFromDigits(l.whatsapp_digits) === ddd);

  const leadTags = getLeadTagsMap(tenantId);
  const tags = listTags(tenantId);
  const tagById = Object.fromEntries(tags.map((t) => [t.id, t]));
  const wa = getTenantWA(tenantId);

  let items = leads.map((l) => {
    const ids = Array.isArray(leadTags[l.id]) ? leadTags[l.id] : [];
    const full = ids.map((id) => tagById[id]).filter(Boolean);
    const ms = wa.getMessageStatusFor(l.whatsapp_digits || leadPhoneKey(l));
    const leadStatus = computeLeadStatus(ms, { notDeliveredAfterMs });
    return { ...l, _version: leadVersion(l), tagIds: ids, tagsFull: full, messageStatus: ms, leadStatus };
  });

  if (parsedQuery.dedupe) items = dedupeLeadItemsByWhatsapp(items);

  if (filterTagIds.length) {
    items = items.filter((l) => {
      const ids = Array.isArray(l.tagIds) ? l.tagIds : [];
      return filterTagIds.some((t) => ids.includes(t));
    });
  }

  if (statusFilter) items = items.filter((l) => String(l.leadStatus || "") === statusFilter);

  items = sortLeadItems(items, parsedQuery);
  return { ...paginateLeadItems(items, req.query || {}, { paginate }), tags };
}


function getConversationStatusForItem(item, lastMessage = null) {
  let status = String((item && item.leadStatus) || '').trim();
  if (!status || status === 'none') {
    try {
      status = computeLeadStatus(item && item.messageStatus, { notDeliveredAfterMs: 30 * 60 * 1000 });
    } catch (e) {
      status = 'none';
    }
  }
  if ((!status || status === 'none') && lastMessage && lastMessage.fromMe === false) return 'replied';
  return status || 'none';
}

async function getConversationContacts(tenantId, req) {
  // Lista unificada: leads da planilha + conversas locais + chats reais do WhatsApp Web.
  // Assim, se um número novo mandar mensagem antes de estar na planilha, ele aparece em Conversas.
  const reqForLeads = { query: { dedupe: '1', status: '', limit: 100000 } };
  const payload = getLeadItemsForRequest(tenantId, reqForLeads, { limit: 100000 });
  const leads = (payload.items || []).filter((lead) => leadPhoneKey(lead));

  const byDigits = new Map();

  for (const lead of leads) {
    const digits = leadPhoneKey(lead);
    if (!digits) continue;
    const ms = getTenantWA(tenantId).getMessageStatusFor(digits) || null;
    const lastActivity = (ms && (ms.lastIncomingAt || ms.repliedAt || ms.lastSendAt || ms.lastAckAt || ms.updatedAt)) || lead.createdAt || null;
    byDigits.set(digits, {
      id: String(lead.id || digits),
      nome: lead.nome || '',
      empresa: lead.empresa || '',
      email: lead.email || '',
      whatsapp_digits: digits,
      whatsapp_raw: lead.whatsapp_raw || lead.whatsapp_digits || digits,
      createdAt: lead.createdAt || null,
      leadStatus: lead.leadStatus || 'none',
      messageStatus: ms,
      source: lead.source || lead.origem || 'planilha',
      isLead: true,
      isNewConversationOnly: false,
      lastActivity,
    });
  }

  const localSummaries = listConversationSummaries(tenantId, 2000);
  for (const summary of localSummaries) {
    const digits = leadPhoneKey({ whatsapp_digits: summary.whatsapp_digits });
    if (!digits) continue;
    const ms = getTenantWA(tenantId).getMessageStatusFor(digits) || null;
    const existing = byDigits.get(digits) || {
      id: `chat_${digits}`,
      nome: '',
      empresa: '',
      email: '',
      whatsapp_digits: digits,
      whatsapp_raw: digits,
      createdAt: null,
      leadStatus: 'none',
      source: 'conversa',
      isLead: false,
      isNewConversationOnly: true,
    };
    byDigits.set(digits, {
      ...existing,
      messageStatus: existing.messageStatus || ms,
      lastMessage: summary.lastMessage || existing.lastMessage || null,
      lastActivity: summary.lastActivity || existing.lastActivity || null,
      messageCount: summary.messageCount || existing.messageCount || 0,
    });
  }

  let chats = {};
  try {
    const knownDigits = Array.from(new Set([...byDigits.keys(), ...listConversationDigits(tenantId)]));
    chats = await getChatsSnapshotForDigits(tenantId, knownDigits, { includeAll: true });
  } catch (e) {
    chats = {};
  }

  for (const digits of Object.keys(chats || {})) {
    const chat = chats[digits] || null;
    if (!digits || !chat) continue;
    const ms = getTenantWA(tenantId).getMessageStatusFor(digits) || null;
    const existing = byDigits.get(digits) || {
      id: `chat_${digits}`,
      nome: chat.displayName || '',
      empresa: '',
      email: '',
      whatsapp_digits: digits,
      whatsapp_raw: digits,
      createdAt: null,
      leadStatus: 'none',
      source: 'whatsapp',
      isLead: false,
      isNewConversationOnly: true,
    };

    byDigits.set(digits, {
      ...existing,
      nome: existing.nome || chat.displayName || '',
      messageStatus: existing.messageStatus || ms,
      chat,
      unreadCount: Number(chat.unreadCount || existing.unreadCount || 0),
      lastMessage: (chat.lastMessage || existing.lastMessage || null),
      lastActivity: (chat.lastMessage && chat.lastMessage.createdAt) || existing.lastActivity || null,
      isNewConversationOnly: existing.isLead ? false : true,
    });
  }

  let merged = Array.from(byDigits.values()).map((item) => {
    const digits = leadPhoneKey(item);
    const chat = chats[digits] || item.chat || null;
    const lastMessage = (chat && chat.lastMessage) || item.lastMessage || null;
    const computedStatus = getConversationStatusForItem(item, lastMessage);
    return {
      ...item,
      chat,
      unreadCount: Number((chat && chat.unreadCount) || item.unreadCount || 0),
      lastMessage,
      lastActivity: (lastMessage && lastMessage.createdAt) || item.lastActivity || item.createdAt || null,
      conversationStatus: computedStatus,
    };
  });

  const statusParam = String((req && req.query && (req.query.status || req.query.chatStatus)) || '').trim();
  if (statusParam) {
    const allowed = statusParam === 'active'
      ? ['replied', 'delivered']
      : statusParam.split(',').map((x) => String(x || '').trim()).filter(Boolean);
    if (allowed.length) {
      merged = merged.filter((item) => allowed.includes(String(item.conversationStatus || 'none')));
    }
  }

  const q = String((req && req.query && req.query.q) || '').trim().toLowerCase();
  const qDigits = q.replace(/\D+/g, '');
  if (q || qDigits) {
    merged = merged.filter((item) => {
      const hay = [
        item.nome,
        item.empresa,
        item.email,
        item.whatsapp_raw,
        item.whatsapp_digits,
        item.source,
        item.lastMessage && item.lastMessage.body,
      ].map((x) => String(x || '').toLowerCase()).join(' ');
      const digits = String(item.whatsapp_digits || item.whatsapp_raw || '').replace(/\D+/g, '');
      return (q && hay.includes(q)) || (qDigits && digits.includes(qDigits));
    });
  }

  merged.sort((a, b) => {
    const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return tb - ta;
  });

  const limit = Math.max(1, Math.min(1000, Number((req && req.query && req.query.limit) || 300)));
  return { ok: true, total: merged.length, items: merged.slice(0, limit) };
}

function findLeadByDigits(tenantId, toDigits) {
  const wanted = leadPhoneKey({ whatsapp_digits: toDigits });
  if (!wanted) return null;
  const leads = readLeads(tenantId);
  return leads.find((lead) => leadPhoneKey(lead) === wanted) || null;
}

function enrichConversationMessagesForClient(tenantId, prefix, digits, messages) {
  const safeDigits = leadPhoneKey({ whatsapp_digits: digits });
  return (Array.isArray(messages) ? messages : []).map((msg) => {
    const out = { ...msg };
    const mediaRef = String(out.mediaId || out.mediaFile || '').trim();
    if (mediaRef) {
      const resolved = resolveConversationMedia(tenantId, safeDigits, mediaRef);
      out.mediaId = mediaRef;
      out.mediaName = sanitizeMediaFilename(out.originalName || out.filename || 'arquivo');
      if (resolved && resolved.exists) {
        const encodedRef = encodeURIComponent(mediaRef);
        out.mediaUrl = `${prefix}/conversations/${encodeURIComponent(safeDigits)}/media/${encodedRef}`;
        out.mediaDownloadUrl = `${out.mediaUrl}?download=1`;
        // O arquivo no disco é a fonte de verdade. Uma falha transitória anterior no
        // downloadMedia() não pode manter a mídia bloqueada para sempre na interface.
        delete out.mediaUnavailable;
        delete out.mediaErrorCode;
      } else {
        out.mediaUnavailable = true;
      }
    }
    delete out.mediaFile;
    return out;
  });
}

function decodeMediaHeader(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function buildConversationsRoutes({ tenantId, authMw, prefix, secureMediaFeatureGate }) {
  const mediaMiddleware = secureMediaFeatureGate ? [authMw, secureMediaFeatureGate] : [authMw];
  app.get(`${prefix}/conversations`, authMw, async (req, res) => {
    try {
      const payload = await getConversationContacts(tenantId, req);
      res.json(payload);
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.get(`${prefix}/conversations/:digits/messages`, authMw, async (req, res) => {
    try {
      const digits = leadPhoneKey({ whatsapp_digits: req.params.digits });
      if (!digits) return res.status(400).json({ ok: false, error: 'Número inválido.' });
      const lead = findLeadByDigits(tenantId, digits);
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 80)));
      const rawMessages = await getChatTextMessages(tenantId, { toDigits: digits, limit });
      const messages = enrichConversationMessagesForClient(tenantId, prefix, digits, rawMessages);
      res.json({ ok: true, contact: {
        id: lead ? lead.id : `chat_${digits}`,
        nome: lead ? (lead.nome || '') : '',
        empresa: lead ? (lead.empresa || '') : '',
        email: lead ? (lead.email || '') : '',
        whatsapp_digits: digits,
        whatsapp_raw: lead ? (lead.whatsapp_raw || lead.whatsapp_digits || digits) : digits,
        isLead: Boolean(lead),
        isNewConversationOnly: !lead,
      }, messages });
    } catch (err) {
      res.status(400).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post(`${prefix}/conversations/:digits/register`, authMw, async (req, res) => {
    let lead = null;
    let created = false;
    let externalCrm = { requested: false, queued: false, configured: false };
    try {
      const digits = leadPhoneKey({ whatsapp_digits: req.params.digits });
      if (!digits) return res.status(400).json({ ok: false, code: 'INVALID_PHONE', error: 'Número inválido.' });

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const syncExternalCrm = body.syncExternalCrm !== false;
      const targetInput = body.externalCrmTarget && typeof body.externalCrmTarget === 'object'
        ? body.externalCrmTarget
        : {};

      if (syncExternalCrm) {
        const crmStatus = await getExternalCrmQueueStatus(tenantId);
        if (!crmStatus.configured) {
          return res.status(503).json({
            ok: false,
            code: 'EXTERNAL_CRM_NOT_CONFIGURED',
            error: 'O CRM Inteligente não está configurado. Desative o envio ao CRM ou revise a integração.',
            localRegistered: false,
            externalCrm: { requested: true, queued: false, configured: false },
          });
        }
      }

      lead = findLeadByDigits(tenantId, digits);
      if (!lead) {
        try {
          lead = await createManualLead(tenantId, {
            source: 'conversation_register',
            sourceDetail: 'Contato cadastrado diretamente pela conversa do WhatsApp',
            sourceMeta: {
              type: 'conversation_register',
              registeredFrom: 'chat',
              registeredBy: String(req.auth?.userId || ''),
            },
            nome: String(body.nome || '').trim(),
            empresa: String(body.empresa || '').trim(),
            jaAnuncia: String(body.jaAnuncia || '').trim(),
            website: String(body.website || '').trim(),
            email: String(body.email || '').trim(),
            whatsapp: digits,
            tags: String(body.tags || '').trim(),
          });
          created = true;
        } catch (error) {
          if (error?.code === 'LEAD_PHONE_CONFLICT') {
            lead = findLeadByDigits(tenantId, digits);
          }
          if (!lead) throw error;
        }
      }

      if (syncExternalCrm) {
        const queued = await enqueueExternalCrmLead({
          tenantId,
          webhook: {
            id: 'conversation-register',
            name: 'Cadastro pela conversa',
            displayName: 'Cadastro pela conversa do WhatsApp',
          },
          lead,
          target: {
            enabled: true,
            pipelineId: String(targetInput.pipelineId || '').trim(),
            stageId: String(targetInput.stageId || '').trim(),
            source: String(targetInput.source || 'WhatsApp').trim() || 'WhatsApp',
          },
          payloadType: 'conversation',
        });
        externalCrm = {
          requested: true,
          configured: true,
          queued: Boolean(queued?.queued),
          duplicate: Boolean(queued?.duplicate),
          status: String(queued?.status || ''),
          eventKey: String(queued?.eventKey || ''),
        };
      }

      auditSecurityAction(req, 'conversation.contact_register', `conversation:${digits}`, 'success', {
        tenantId,
        leadId: String(lead?.id || ''),
        created,
        externalCrmRequested: syncExternalCrm,
        externalCrmQueued: Boolean(externalCrm.queued || externalCrm.duplicate),
      });

      return res.status(created ? 201 : 200).json({
        ok: true,
        created,
        alreadyExisted: !created,
        lead,
        contact: {
          id: lead.id,
          nome: lead.nome || '',
          empresa: lead.empresa || '',
          email: lead.email || '',
          whatsapp_digits: lead.whatsapp_digits || digits,
          whatsapp_raw: lead.whatsapp_raw || digits,
          isLead: true,
          isNewConversationOnly: false,
        },
        externalCrm,
      });
    } catch (error) {
      auditSecurityAction(req, 'conversation.contact_register', `conversation:${req.params.digits}`, 'failed', {
        tenantId,
        leadId: String(lead?.id || ''),
        created,
        code: error?.code || 'CONVERSATION_REGISTER_FAILED',
      });
      const status = Number(error?.statusCode || 400);
      return res.status(status >= 400 && status <= 599 ? status : 400).json({
        ok: false,
        code: error?.code || 'CONVERSATION_REGISTER_FAILED',
        error: error?.message || 'Não foi possível cadastrar este contato.',
        localRegistered: Boolean(lead),
        lead: lead || undefined,
        externalCrm,
      });
    }
  });

  app.get(`${prefix}/conversations/:digits/media/:mediaId`, ...mediaMiddleware, (req, res) => {
    try {
      const digits = leadPhoneKey({ whatsapp_digits: req.params.digits });
      if (!digits) return res.status(400).send('Número inválido.');
      const resolved = resolveConversationMedia(tenantId, digits, req.params.mediaId);
      if (!resolved) return res.status(404).send('Mídia não pertence a esta conversa.');
      if (!resolved.exists || !resolved.filePath) return res.status(410).send('Mídia indisponível.');

      const validated = validateMediaFile(resolved.filePath, {
        declaredMime: resolved.mimetype,
        filename: resolved.filename,
      });
      const inline = req.query.download !== '1' && shouldServeInline(validated.kind);
      res.setHeader('Content-Type', validated.mimetype);
      res.setHeader('Content-Disposition', safeContentDisposition(resolved.filename, inline));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Cache-Control', 'private, max-age=300, no-transform');
      if (validated.kind === 'pdf') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
      return res.sendFile(resolved.filePath);
    } catch (err) {
      const status = Number(err?.statusCode || 400);
      return res.status(status >= 400 && status <= 599 ? status : 400).send(err?.message || 'Mídia inválida.');
    }
  });


  app.post(`${prefix}/conversations/:digits/audio`, ...mediaMiddleware, async (req, res) => {
    let uploaded = null;
    try {
      const digits = leadPhoneKey({ whatsapp_digits: req.params.digits });
      if (!digits) return res.status(400).json({ ok: false, error: 'Número inválido.' });
      const contentType = baseMediaMime(req.headers['content-type']);
      let result;

      if (contentType.startsWith('audio/')) {
        const filename = sanitizeMediaFilename(decodeMediaHeader(req.headers['x-zape-filename'], 'audio.webm'), 'audio.webm');
        uploaded = await streamRequestToTempFile(req, { maxBytes: MEDIA_ABSOLUTE_MAX_BYTES, prefix: `zape-audio-${tenantId}-` });
        const validated = validateMediaFile(uploaded.filePath, { declaredMime: contentType, filename });
        if (validated.kind !== 'audio') return res.status(415).json({ ok: false, error: 'O conteúdo enviado não é um áudio válido.' });
        scanMediaFile(uploaded.filePath);
        result = await sendCustomAudioMessage(tenantId, {
          toDigits: digits,
          audioFilePath: uploaded.filePath,
          mimetype: validated.mimetype,
          filename: validated.filename,
        });
      } else {
        // Compatibilidade temporária com clientes antigos. O frontend atual usa upload binário.
        const audioBase64 = String(req.body?.audioBase64 || req.body?.audioDataUrl || req.body?.dataUrl || req.body?.audio || '').trim();
        const mimetype = String(req.body?.mimetype || req.body?.mimeType || '').trim() || 'audio/webm';
        const filename = sanitizeMediaFilename(String(req.body?.filename || 'audio.webm').trim(), 'audio.webm');
        if (!audioBase64) return res.status(400).json({ ok: false, error: 'Áudio vazio. Grave novamente e tente enviar.' });
        if (audioBase64.length > Math.ceil(MEDIA_ABSOLUTE_MAX_BYTES * 4 / 3) + 1024) {
          return res.status(413).json({ ok: false, error: 'Áudio acima do limite permitido.' });
        }
        result = await sendCustomAudioMessage(tenantId, { toDigits: digits, audioBase64, mimetype, filename });
      }

      const message = enrichConversationMessagesForClient(tenantId, prefix, digits, [result.message])[0];
      return res.json({ ok: true, message });
    } catch (err) {
      const raw = err?.message || String(err);
      const error = raw && raw.length <= 2 ? 'Não consegui enviar este áudio. Grave novamente e tente outra vez.' : raw;
      const status = Number(err?.statusCode || 400);
      return res.status(status >= 400 && status <= 599 ? status : 400).json({ ok: false, error, code: err?.code || undefined });
    } finally {
      if (uploaded?.tempDir) {
        try { fs.rmSync(uploaded.tempDir, { recursive: true, force: true }); } catch {}
      }
    }
  });

  app.post(`${prefix}/conversations/:digits/attachments`, ...mediaMiddleware, async (req, res) => {
    let uploaded = null;
    try {
      const digits = leadPhoneKey({ whatsapp_digits: req.params.digits });
      if (!digits) return res.status(400).json({ ok: false, error: 'Número inválido.' });
      const declaredMime = baseMediaMime(req.headers['content-type']);
      if (!declaredMime || declaredMime === 'application/octet-stream') {
        return res.status(415).json({ ok: false, error: 'Informe o tipo real do arquivo no Content-Type.' });
      }
      const filename = sanitizeMediaFilename(decodeMediaHeader(req.headers['x-zape-filename'], 'arquivo'), 'arquivo');
      const caption = decodeMediaHeader(req.headers['x-zape-caption'], '').slice(0, 1000);
      uploaded = await streamRequestToTempFile(req, { maxBytes: MEDIA_ABSOLUTE_MAX_BYTES, prefix: `zape-attachment-${tenantId}-` });
      const validated = validateMediaFile(uploaded.filePath, { declaredMime, filename });
      scanMediaFile(uploaded.filePath);
      const result = await sendCustomAttachmentMessage(tenantId, {
        toDigits: digits,
        filePath: uploaded.filePath,
        mimetype: validated.mimetype,
        filename: validated.filename,
        caption,
      });
      const message = enrichConversationMessagesForClient(tenantId, prefix, digits, [result.message])[0];
      return res.json({ ok: true, message });
    } catch (err) {
      const status = Number(err?.statusCode || 400);
      return res.status(status >= 400 && status <= 599 ? status : 400).json({
        ok: false,
        code: err?.code || 'MEDIA_UPLOAD_FAILED',
        error: err?.message || 'Não foi possível enviar o arquivo.',
      });
    } finally {
      if (uploaded?.tempDir) {
        try { fs.rmSync(uploaded.tempDir, { recursive: true, force: true }); } catch {}
      }
    }
  });


  app.post(`${prefix}/conversations/:digits/messages`, authMw, async (req, res) => {
    try {
      const digits = leadPhoneKey({ whatsapp_digits: req.params.digits });
      if (!digits) return res.status(400).json({ ok: false, error: 'Número inválido.' });
      const lead = findLeadByDigits(tenantId, digits);
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ ok: false, error: 'Digite uma mensagem.' });
      if (text.length > 4000) return res.status(400).json({ ok: false, error: 'Mensagem muito longa. Use até 4000 caracteres.' });

      const sent = await sendCustomMessage(tenantId, {
        toDigits: digits,
        nome: lead ? (lead.nome || '') : '',
        text,
      });

      const messageId = String(sent?.id?._serialized || sent?.id?.id || '');
      res.json({ ok: true, message: {
        id: messageId,
        fromMe: true,
        body: text,
        createdAt: new Date().toISOString(),
        timestamp: Math.floor(Date.now() / 1000),
      }});
    } catch (err) {
      res.status(400).json({ ok: false, error: err?.message || String(err) });
    }
  });
}

function buildLeadsHandler({ tenantId }) {
  return (req, res) => {
    res.json(getLeadItemsForRequest(tenantId, req, { paginate: true }));
  };
}

function respondLeadServiceError(res, error) {
  if (error instanceof LeadServiceError || error instanceof RepositoryConflictError || (error && error.statusCode && error.code)) {
    return res.status(error.statusCode || 400).json({
      ok: false,
      code: error.code,
      error: error.message,
      ...(error.details || {}),
    });
  }
  console.error('[LEADS] Falha inesperada:', safeError(error));
  return res.status(500).json({ ok: false, code: 'LEAD_OPERATION_FAILED', error: 'Não foi possível concluir a operação com o lead.' });
}

function buildUpdateLeadHandler(tenantId) {
  return async (req, res) => {
    try {
      let result;
      if (databaseRuntime.isDatabasePrimary()) {
        const before = readLeads(tenantId).find((lead) => String(lead.id) === String(req.params.id));
        const lead = await databaseRuntime.updateLead(tenantId, req.params.id, req.body?._version, req.body || {}, req.auth?.userId || null);
        if (!lead) return res.status(404).json({ ok: false, error: 'Lead não encontrado.' });
        const fields = ['nome','empresa','email','website','jaAnuncia','whatsapp_digits'];
        const changes = fields.filter((field) => String(before?.[field] || '') !== String(lead?.[field] || '')).map((field) => ({ field, previous: before?.[field] || '', next: lead?.[field] || '' }));
        result = { lead: { ...lead, _version: leadVersion(lead) }, changes };
      } else {
        result = updateLead(tenantId, req.params.id, req.body || {}, req);
      }
      auditSecurityAction(req, 'lead.update', `lead:${req.params.id}`, 'success', { changedFields: result.changes.map((item) => item.field) });
      return res.json({ ok: true, ...result });
    } catch (error) {
      auditSecurityAction(req, 'lead.update', `lead:${req.params.id}`, 'failed', { code: error?.code || 'LEAD_OPERATION_FAILED' });
      return respondLeadServiceError(res, error);
    }
  };
}

function buildMergeLeadHandler(tenantId) {
  return async (req, res) => {
    try {
      let result;
      if (databaseRuntime.isDatabasePrimary()) {
        if (String(req.body?.confirm || '') !== 'MERGE_LEADS') throw new RepositoryConflictError('MERGE_CONFIRMATION_REQUIRED', 'Confirmação explícita MERGE_LEADS é obrigatória.');
        const sourceId = String(req.body?.sourceLeadId || '');
        const lead = await databaseRuntime.mergeLeads(tenantId, req.params.id, sourceId, req.body?.targetVersion, req.body?.sourceVersion, req.auth?.userId || null);
        if (!lead) return res.status(404).json({ ok: false, error: 'Lead não encontrado.' });
        result = { lead: { ...lead, _version: leadVersion(lead) }, mergedLeadId: sourceId };
      } else {
        result = mergeLeads(tenantId, req.params.id, req.body || {}, req);
      }
      auditSecurityAction(req, 'lead.merge', `lead:${req.params.id}`, 'success', { mergedLeadId: result.mergedLeadId });
      return res.json({ ok: true, ...result });
    } catch (error) {
      auditSecurityAction(req, 'lead.merge', `lead:${req.params.id}`, 'failed', { code: error?.code || 'LEAD_OPERATION_FAILED' });
      return respondLeadServiceError(res, error);
    }
  };
}

async function createManualLead(tenantId, payload) {
  const nome = String(payload?.nome || '').trim();
  if (!nome) throw new Error("Nome é obrigatório.");

  return createLeadFromPayload(
    tenantId,
    payload?.source || "manual",
    {
      ...payload,
      nome,
      sourceDetail: payload?.sourceDetail
        || payload?.originDetail
        || (payload?.source === "conversation_register" ? "Registrado pela aba Conversas" : "Criado manualmente no painel"),
    },
    { allowEmailOnly: true }
  );
}

function removeLeadFromCrmState(tenantId, leadId) {
  const id = String(leadId || "").trim();
  if (!id) return false;

  const state = readCrmState(tenantId);
  let changed = false;

  for (const pipeline of Array.isArray(state.pipelines) ? state.pipelines : []) {
    const stages = pipeline && pipeline.stages && typeof pipeline.stages === "object" ? pipeline.stages : {};
    for (const stage of Object.values(stages)) {
      if (!stage || !Array.isArray(stage.leadIds)) continue;
      const before = stage.leadIds.length;
      stage.leadIds = stage.leadIds.filter((x) => String(x) !== id);
      if (stage.leadIds.length !== before) changed = true;
    }
  }

  if (changed) writeCrmState(tenantId, state);
  return changed;
}

function addLeadToCrmTargetFromWebhook(tenantId, webhookRow, lead) {
  const leadId = String((lead && lead.id) || "").trim();
  const target = webhookRow && webhookRow.crmTarget && typeof webhookRow.crmTarget === "object" ? webhookRow.crmTarget : null;
  if (!leadId || !target || target.enabled === false) {
    return { ok: false, added: false, reason: "no_target" };
  }

  const pipelineId = String(target.pipelineId || "").trim();
  const requestedStageId = String(target.stageId || "").trim();
  if (!pipelineId || !requestedStageId) {
    return { ok: false, added: false, reason: "invalid_target" };
  }

  const state = readCrmState(tenantId);
  const pipelines = Array.isArray(state.pipelines) ? state.pipelines : [];
  const pipeline = pipelines.find((p) => p && String(p.id) === pipelineId);
  if (!pipeline) {
    return { ok: false, added: false, reason: "pipeline_not_found" };
  }

  pipeline.stages = pipeline.stages && typeof pipeline.stages === "object" ? pipeline.stages : {};
  pipeline.stageOrder = Array.isArray(pipeline.stageOrder) ? pipeline.stageOrder : Object.keys(pipeline.stages || {});

  let stageId = requestedStageId;
  if (!pipeline.stages[stageId]) {
    stageId = pipeline.stageOrder.find((sid) => pipeline.stages[sid]) || "";
  }
  if (!stageId || !pipeline.stages[stageId]) {
    return { ok: false, added: false, reason: "stage_not_found" };
  }

  let wasAlreadyInTargetStage = false;
  const targetStageBefore = pipeline.stages[stageId];
  if (targetStageBefore && Array.isArray(targetStageBefore.leadIds)) {
    wasAlreadyInTargetStage = targetStageBefore.leadIds.some((id) => String(id) === leadId);
  }

  // Evita duplicar o mesmo lead na pipeline alvo. Se ele existir em outra etapa, move para a etapa configurada.
  for (const sid of Object.keys(pipeline.stages)) {
    const st = pipeline.stages[sid];
    if (!st || !Array.isArray(st.leadIds)) continue;
    st.leadIds = st.leadIds.filter((id) => String(id) !== leadId);
  }

  const stage = pipeline.stages[stageId];
  stage.leadIds = Array.isArray(stage.leadIds) ? stage.leadIds : [];
  stage.leadIds.push(leadId);

  writeCrmState(tenantId, state);
  if (!wasAlreadyInTargetStage) {
    queueCrmStageAutoMessage(tenantId, leadId, pipeline, stage, "webhook_crm_target");
  }
  return { ok: true, added: true, pipelineId: pipeline.id, stageId };
}


function getCrmStageAutoMessages(stage) {
  if (!stage || typeof stage !== "object") return [];

  const rawList = Array.isArray(stage.autoMessages)
    ? stage.autoMessages
    : (Array.isArray(stage.crmAutoMessages)
      ? stage.crmAutoMessages
      : (Array.isArray(stage.crmMessageTexts)
        ? stage.crmMessageTexts
        : (Array.isArray(stage.messageTexts) ? stage.messageTexts : null)));

  const fallback = stage.autoMessageText ?? stage.crmAutoMessageText ?? stage.crmMessageText ?? stage.messageText ?? "";
  const list = rawList || (fallback ? [fallback] : []);

  return list
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, 10);
}

function getCrmStageAutoMessageText(stage) {
  return getCrmStageAutoMessages(stage)[0] || "";
}

function findCrmLeadForMessage(tenantId, leadId) {
  const id = String(leadId || "").trim();
  if (!id) return null;
  try {
    return (readLeads(tenantId) || []).find((lead) => lead && String(lead.id) === id) || null;
  } catch (err) {
    console.error(`⚠️ Falha ao localizar lead para mensagem automática do CRM [${tenantId}/${id}]:`, err?.message || err);
    return null;
  }
}

function renderCrmStageAutoMessage(template, lead, pipeline, stage) {
  return String(template || "")
    .replace(/\{\{\s*nome\s*\}\}/gi, String((lead && lead.nome) || "").trim())
    .replace(/\{\{\s*empresa\s*\}\}/gi, String((lead && lead.empresa) || "").trim())
    .replace(/\{\{\s*email\s*\}\}/gi, String((lead && lead.email) || "").trim())
    .replace(/\{\{\s*whatsapp\s*\}\}/gi, String((lead && (lead.whatsapp_raw || lead.whatsapp_digits)) || "").trim())
    .replace(/\{\{\s*etapa\s*\}\}/gi, String((stage && stage.name) || "").trim())
    .replace(/\{\{\s*funil\s*\}\}/gi, String((pipeline && pipeline.name) || "").trim())
    .trim();
}

async function sendCrmStageAutoMessage(tenantId, leadId, pipeline, stage, reason) {
  const templates = getCrmStageAutoMessages(stage);
  if (!templates.length) return { ok: false, skipped: true, reason: "empty_message" };

  const lead = findCrmLeadForMessage(tenantId, leadId);
  if (!lead) return { ok: false, skipped: true, reason: "lead_not_found" };

  const digits = normalizePhoneToE164Digits(lead.whatsapp_digits || lead.whatsapp_raw || "");
  if (!digits) return { ok: false, skipped: true, reason: "lead_without_whatsapp" };

  const messages = templates
    .map((template) => renderCrmStageAutoMessage(template, lead, pipeline, stage))
    .filter(Boolean);
  if (!messages.length) return { ok: false, skipped: true, reason: "empty_after_render" };

  const triggerId = genId();
  const queued = automaticMessageQueue.enqueueBatch({
    tenantId,
    toDigits: digits,
    nome: lead.nome || "",
    messages,
    idempotencyPrefix: `crm-stage:${leadId}:${pipeline && pipeline.id}:${stage && stage.id}:${triggerId}`,
    source: {
      type: "crm_stage",
      reason: reason || "crm_stage_enter",
      leadId,
      pipelineId: pipeline && pipeline.id,
      stageId: stage && stage.id,
    },
  });

  return {
    ok: true,
    queued: true,
    queuedCount: queued.queued,
    existingCount: queued.existing,
    reason: reason || "crm_stage_enter",
    leadId,
    stageId: stage && stage.id,
    pipelineId: pipeline && pipeline.id,
  };
}

function queueCrmStageAutoMessage(tenantId, leadId, pipeline, stage, reason) {
  const templates = getCrmStageAutoMessages(stage);
  if (!templates.length) return;
  sendCrmStageAutoMessage(tenantId, leadId, pipeline, stage, reason)
    .then((out) => {
      if (out && out.queued) {
        console.log(`📥 Mensagem automática do CRM enfileirada [${tenantId}]:`, {
          leadId,
          pipelineId: pipeline && pipeline.id,
          stageId: stage && stage.id,
          reason,
          queuedCount: out.queuedCount || 0,
        });
      }
    })
    .catch((err) => {
      console.error(`❌ Falha ao enfileirar mensagem automática do CRM [${tenantId}/${leadId}]:`, err?.message || err);
    });
}

function crmStageLeadSet(state, pipelineId, stageId) {
  const p = state && Array.isArray(state.pipelines) ? state.pipelines.find((x) => x && String(x.id) === String(pipelineId)) : null;
  const st = p && p.stages && p.stages[String(stageId)];
  return new Set(((st && Array.isArray(st.leadIds)) ? st.leadIds : []).map((id) => String(id)));
}

function queueCrmAutoMessagesForNewEntries(tenantId, beforeState, afterState, reason) {
  const pipelines = Array.isArray(afterState && afterState.pipelines) ? afterState.pipelines : [];
  for (const pipeline of pipelines) {
    if (!pipeline || !pipeline.stages) continue;
    const stageIds = Array.isArray(pipeline.stageOrder) ? pipeline.stageOrder : Object.keys(pipeline.stages || {});
    for (const stageId of stageIds) {
      const stage = pipeline.stages[stageId];
      if (!stage || !getCrmStageAutoMessages(stage).length) continue;
      const beforeLeadIds = crmStageLeadSet(beforeState, pipeline.id, stageId);
      const afterLeadIds = Array.isArray(stage.leadIds) ? stage.leadIds.map((id) => String(id)) : [];
      for (const leadId of afterLeadIds) {
        if (!leadId || beforeLeadIds.has(leadId)) continue;
        queueCrmStageAutoMessage(tenantId, leadId, pipeline, stage, reason || "crm_stage_enter");
      }
    }
  }
}

function saveCrmStateAndQueueMessages(tenantId, incomingState) {
  const beforeState = readCrmState(tenantId);
  const savedState = writeCrmState(tenantId, incomingState);
  queueCrmAutoMessagesForNewEntries(tenantId, beforeState, savedState, "crm_put");
  return savedState;
}

function shouldClearLeadWhatsappStatus(req) {
  const v = String(req.query.clearWhatsappStatus ?? req.query.clearStatus ?? "1").toLowerCase().trim();
  return !(v === "0" || v === "false" || v === "no" || v === "nao" || v === "não");
}

async function deleteLeadEverywhere(tenantId, leadId, req) {
  const out = databaseRuntime.isDatabasePrimary() ? null : deleteLeadById(tenantId, leadId);
  const databaseDeleted = databaseRuntime.isDatabasePrimary() ? await databaseRuntime.deleteLead(tenantId, leadId) : null;
  const normalizedOut = databaseRuntime.isDatabasePrimary()
    ? { ok: Boolean(databaseDeleted), deleted: databaseDeleted, removed: databaseDeleted ? 1 : 0 }
    : out;
  if (!normalizedOut.ok || !normalizedOut.deleted) {
    return { ok: false, error: "Lead não encontrado." };
  }

  const deleted = normalizedOut.deleted;
  const digits = String(deleted.whatsapp_digits || deleted.whatsapp_raw || "").replace(/\D+/g, "");

  let tagsRemoved = false;
  let crmRemoved = false;
  let whatsappStatusCleared = false;

  try {
    const tagOut = removeLeadTags(tenantId, leadId);
    tagsRemoved = Boolean(tagOut && tagOut.changed);
  } catch (e) {
    console.error(`⚠️ Falha ao remover tags do lead [${tenantId}/${leadId}]:`, e?.message || e);
  }

  try {
    crmRemoved = removeLeadFromCrmState(tenantId, leadId);
  } catch (e) {
    console.error(`⚠️ Falha ao remover lead do CRM [${tenantId}/${leadId}]:`, e?.message || e);
  }

  if (digits && shouldClearLeadWhatsappStatus(req)) {
    try {
      const remainingSameNumber = readLeads(tenantId).some((lead) => {
        const d = String(lead && (lead.whatsapp_digits || lead.whatsapp_raw || "")).replace(/\D+/g, "");
        return d === digits;
      });

      if (!remainingSameNumber) {
        whatsappStatusCleared = Boolean(getTenantWA(tenantId).deleteMessageStatusFor(digits));
      }
    } catch (e) {
      console.error(`⚠️ Falha ao limpar status WhatsApp do lead [${tenantId}/${leadId}]:`, e?.message || e);
    }
  }

  const result = {
    ok: true,
    deletedLeadId: String(leadId),
    removed: normalizedOut.removed || 1,
    tagsRemoved,
    crmRemoved,
    whatsappStatusCleared,
  };
  auditSecurityAction(req, "lead.delete", `lead:${leadId}`, "success", { tenantId, tagsRemoved, crmRemoved, whatsappStatusCleared });
  return result;
}


function startOfDayIso(value) {
  const d = value ? new Date(value) : new Date();
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

function daysAgoIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function percent(part, total) {
  const p = Number(part || 0);
  const t = Number(total || 0);
  if (!t) return 0;
  return Math.round((p / t) * 1000) / 10;
}

function sourceLabel(source) {
  const s = String(source || "").trim();
  const map = {
    local_form: "Formulário local",
    activecampaign: "ActiveCampaign",
    generated_webhook_activecampaign: "Webhook ActiveCampaign",
    generated_webhook_generic: "Webhook JSON",
    manual: "Registro manual",
    conversation_register: "Registrado pela conversa",
    conversa: "Conversa WhatsApp",
    whatsapp: "WhatsApp",
    planilha: "Planilha",
  };
  return map[s] || (s ? s.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()) : "Sem origem");
}

function isGenericWebhookName(name) {
  const n = String(name || "").trim();
  return !n || n.toLowerCase() === "webhook";
}

function webhookFullUrl(req, webhook) {
  if (!webhook || !webhook.token) return "";
  const base = req ? getPublicBaseUrl(req) : "";
  return `${base}/webhooks/${webhook.token}`;
}

function webhookEffectiveName(webhook, url) {
  const name = String((webhook && webhook.name) || "").trim();
  if (!isGenericWebhookName(name)) return name;
  return String(url || (webhook && webhook.token ? `/webhooks/${webhook.token}` : "Webhook")).trim() || "Webhook";
}

function serializeWebhook(webhook, req) {
  const url = webhookFullUrl(req, webhook);
  const isNamed = !isGenericWebhookName(webhook && webhook.name);
  const displayName = webhookEffectiveName(webhook, url);
  return {
    id: webhook.id,
    name: webhook.name || "",
    displayName,
    isNamed,
    createdAt: webhook.createdAt || null,
    updatedAt: webhook.updatedAt || null,
    url,
    messages: Array.isArray(webhook.messages) ? webhook.messages : (webhook.messageText ? [webhook.messageText] : []),
    messageText: webhook.messageText || "",
    crmTarget: webhook.crmTarget && typeof webhook.crmTarget === "object" ? {
      enabled: webhook.crmTarget.enabled !== false,
      pipelineId: String(webhook.crmTarget.pipelineId || ""),
      stageId: String(webhook.crmTarget.stageId || ""),
      linkedAt: webhook.crmTarget.linkedAt || null,
      updatedAt: webhook.crmTarget.updatedAt || null,
    } : null,
    externalCrmTarget: webhook.externalCrmTarget && typeof webhook.externalCrmTarget === "object" ? {
      enabled: webhook.externalCrmTarget.enabled !== false,
      pipelineId: String(webhook.externalCrmTarget.pipelineId || ""),
      stageId: String(webhook.externalCrmTarget.stageId || ""),
      source: String(webhook.externalCrmTarget.source || "WhatsApp"),
      linkedAt: webhook.externalCrmTarget.linkedAt || null,
      updatedAt: webhook.externalCrmTarget.updatedAt || null,
    } : null,
    urlPreview: webhook.token ? `/webhooks/${String(webhook.token).slice(0, 6)}...` : "",
  };
}

function buildWebhookLookup(webhooks, req) {
  const items = (Array.isArray(webhooks) ? webhooks : []).map((w) => serializeWebhook(w, req));
  return {
    items,
    byId: new Map(items.map((w) => [String(w.id), w])),
  };
}

function leadOriginInfo(lead, webhookLookup) {
  const meta = lead && lead.sourceMeta && typeof lead.sourceMeta === "object" ? lead.sourceMeta : null;
  if (meta && meta.type === "webhook") {
    const messages = Array.isArray(meta.webhookMessages) ? meta.webhookMessages.map((m) => String(m || "").trim()).filter(Boolean) : [];
    const webhookId = String(meta.webhookId || "").trim();
    const matchedWebhook = webhookId && webhookLookup && webhookLookup.byId ? webhookLookup.byId.get(webhookId) : null;
    const fallbackName = webhookEffectiveName({ name: meta.webhookName || "", token: meta.webhookToken || "" }, meta.webhookUrl || "");
    const webhookName = matchedWebhook ? matchedWebhook.displayName : fallbackName;
    let detail = lead.sourceDetail || `Origem via webhook${messages.length ? ` com ${messages.length} mensagem(ns) automática(s)` : ""}`;
    if (/Webhook\s+Webhook\s+recebido/i.test(detail) || isGenericWebhookName(meta.webhookName)) {
      detail = `Origem via webhook: ${webhookName}`;
      if (meta.payloadType) detail += ` · Formato: ${meta.payloadType}`;
    }
    return {
      key: `webhook:${webhookId || webhookName || lead.source || "unknown"}`,
      label: `Webhook: ${webhookName || "Webhook"}`,
      type: "webhook",
      detail,
      messages,
      payloadType: meta.payloadType || "",
      webhookId: webhookId || "",
      webhookName: webhookName || "",
    };
  }

  const source = String((lead && lead.source) || "").trim() || "unknown";
  const isWebhook = source.startsWith("generated_webhook");
  return {
    key: isWebhook ? source : source,
    label: sourceLabel(source),
    type: isWebhook ? "webhook" : source,
    detail: (lead && lead.sourceDetail) || (isWebhook ? "Origem via webhook. Leads antigos podem não ter o nome exato do webhook salvo." : sourceLabel(source)),
    messages: [],
    payloadType: "",
  };
}


function dispatchSourceInfo(contact) {
  const source = String((contact && contact.source) || "").trim();
  const sheetName = String((contact && (contact.sheetName || contact.savedSheetName || contact.fileName)) || "").trim();
  if (source === "filtered-leads") return { key: "filtered-leads", label: "Leads filtrados", type: "lead_filter", detail: "Selecionado a partir da base de leads existente." };
  if (source === "spreadsheet") return { key: sheetName ? `spreadsheet:${sheetName}` : "spreadsheet", label: sheetName ? `Planilha: ${sheetName}` : "Planilha importada", type: "spreadsheet", detail: "Contato usado em um disparo a partir de planilha." };
  if (source) return { key: source, label: sourceLabel(source), type: source, detail: "Origem informada no contato do disparo." };
  return { key: "manual_dispatch", label: "Contato do disparo", type: "dispatch", detail: "Contato usado diretamente no disparo oficial." };
}

function dispatchStatusLabel(status) {
  const s = String(status || "").toLowerCase();
  const map = { pending: "Na fila", queued: "Na fila", submitted: "Submetido", sent: "Enviado", delivered: "Entregue", read: "Lido", replied: "Respondido", responded: "Respondido", failed: "Falhou", expired: "Expirado", canceled: "Cancelado" };
  return map[s] || (s ? s.replace(/_/g, " ") : "Sem status");
}

function dispatchStatusClass(status) {
  const s = String(status || "").toLowerCase();
  if (s === "replied" || s === "responded") return "ok";
  if (s === "read") return "read";
  if (s === "delivered") return "delivered";
  if (s === "failed") return "err";
  if (s === "sent" || s === "submitted") return "sent";
  return "pending";
}

function normalizeDispatchFinalStatus(event) {
  const s = String((event && event.status) || "").toLowerCase();
  if (s === "replied" || s === "responded" || event?.repliedAt || event?.respondedAt) return "replied";
  if (s === "read" || event?.readAt) return "read";
  if (s === "delivered" || event?.deliveredAt) return "delivered";
  if (s === "failed" || event?.failedAt || event?.error) return "failed";
  if (s === "sent" || event?.sentAt) return "sent";
  if (s === "submitted" || event?.submittedAt || event?.messageId) return "submitted";
  if (s === "expired") return "expired";
  if (s === "canceled") return "canceled";
  return "queued";
}

function dispatchMetricBlank() {
  return { total: 0, sent: 0, delivered: 0, read: 0, responded: 0, failed: 0, pending: 0 };
}

function addDispatchMetric(metrics, status) {
  metrics.total += 1;
  const s = normalizeDispatchFinalStatus({ status });
  if (["submitted", "sent", "delivered", "read", "replied"].includes(s)) metrics.sent += 1;
  if (["delivered", "read", "replied"].includes(s)) metrics.delivered += 1;
  if (["read", "replied"].includes(s)) metrics.read += 1;
  if (s === "replied") metrics.responded += 1;
  else if (s === "failed") metrics.failed += 1;
  else if (s === "pending" || s === "sent") metrics.pending += 1;
}

function dispatchMetricRates(metrics) {
  return {
    ...metrics,
    deliveryRate: percent(metrics.delivered, metrics.total),
    readRate: percent(metrics.read, metrics.total),
    responseRate: percent(metrics.responded, metrics.total),
    failureRate: percent(metrics.failed, metrics.total),
  };
}

function buildDispatchInsightsForTenant(tenantId, { byPhone, webhookLookup } = {}) {
  const campaigns = listCloudDispatchCampaigns(tenantId);
  const campaignById = new Map(campaigns.map((c) => [String(c.id), c]));
  const storedEvents = listCloudDispatchEvents(tenantId);
  const knownMessageIds = new Set(storedEvents.map((e) => String(e.messageId || "")).filter(Boolean));

  const events = storedEvents.map((ev) => ({ ...ev, legacy: false }));

  // Compatibilidade: mostra status antigos da Cloud API que existiam antes do histórico de campanhas.
  // Não grava nada, não altera lead antigo e evita quebrar bases já existentes.
  if (tenantId === TENANT_ADMIN) {
    for (const st of listCloudStatus()) {
      const msgId = String(st && st.messageId || "").trim();
      if (msgId && knownMessageIds.has(msgId)) continue;
      const to = digitsOnlyServer(st && (st.toDigits || st.to || st.recipient_id));
      if (!to) continue;
      let status = String(st.state || "").toLowerCase() || "sent";
      if (st.repliedAt) status = "responded";
      else if (st.readAt || status === "read") status = "read";
      else if (st.deliveredAt || status === "delivered") status = "delivered";
      else if (status === "failed" || st.error) status = "failed";
      else if (status === "sent") status = "sent";
      else status = "sent";
      events.push({
        id: `legacy_${to}_${msgId || String(st.updatedAt || st.lastSendAt || "")}`,
        tenantId,
        campaignId: "legacy_cloud_history",
        campaignName: "Histórico antigo da API oficial",
        templateName: st.templateName || "Modelo antigo",
        languageCode: st.languageCode || "",
        recipientId: to,
        toDigits: to,
        leadId: "",
        leadSnapshot: null,
        origin: null,
        dispatchSource: { key: "legacy", label: "Histórico antigo", type: "legacy", detail: "Status existente antes da criação do histórico por campanha." },
        status,
        deliveryState: st.state || status,
        messageId: msgId || null,
        error: st.error || null,
        errorInfo: st.errorInfo || (st.error ? normalizeMetaError(st.error) : null),
        sentAt: st.lastSendAt || st.updatedAt || null,
        deliveredAt: st.deliveredAt || null,
        readAt: st.readAt || null,
        respondedAt: st.repliedAt || null,
        inbound: st.inbound || null,
        createdAt: st.lastSendAt || st.updatedAt || null,
        updatedAt: st.updatedAt || st.repliedAt || st.readAt || st.deliveredAt || st.lastSendAt || null,
        legacy: true,
      });
    }
  }

  const summary = dispatchMetricBlank();
  const campaignMap = new Map();
  const originMap = new Map();
  const statusMap = new Map();
  const dailyMap = new Map();
  let webhookImpacted = 0;
  let spreadsheetImpacted = 0;
  let mixedJourney = 0;

  function eventSortDate(ev) {
    return ev && (ev.updatedAt || ev.respondedAt || ev.readAt || ev.deliveredAt || ev.sentAt || ev.createdAt || "");
  }
  function isAfter(a, b) {
    return String(a || "").localeCompare(String(b || "")) > 0;
  }
  function ensureCampaignRow(campaignId, campaignName, ev, campaign) {
    if (!campaignMap.has(campaignId)) {
      const createdAt = (campaign && campaign.createdAt) || ev.createdAt || ev.sentAt || null;
      const updatedAt = (campaign && campaign.updatedAt) || eventSortDate(ev) || createdAt;
      campaignMap.set(campaignId, {
        id: campaignId,
        name: campaignName,
        templateName: ev.templateName || (campaign && campaign.templateName) || "",
        languageCode: ev.languageCode || (campaign && campaign.languageCode) || "",
        createdAt,
        updatedAt,
        total: Number((campaign && campaign.total) || 0),
        metrics: dispatchMetricBlank(),
        context: { webhookImpacted: 0, spreadsheetOnly: 0, mixedJourney: 0, legacyEvents: 0 },
        _originMap: new Map(),
        recent: [],
      });
    }
    const row = campaignMap.get(campaignId);
    const candidateUpdatedAt = (campaign && campaign.updatedAt) || eventSortDate(ev);
    if (isAfter(candidateUpdatedAt, row.updatedAt)) row.updatedAt = candidateUpdatedAt;
    return row;
  }
  function ensureOrigin(map, originKey, finalOrigin) {
    if (!map.has(originKey)) {
      map.set(originKey, {
        key: originKey,
        label: finalOrigin.label || "Origem",
        type: finalOrigin.type || "",
        detail: finalOrigin.detail || "",
        metrics: dispatchMetricBlank(),
      });
    }
    return map.get(originKey);
  }

  const rows = events.map((ev) => {
    const phone = leadPhoneKey({ whatsapp_digits: ev.toDigits });
    const lead = findLeadByPhoneVariants(byPhone, phone) || null;
    const leadOrigin = lead ? leadOriginInfo(lead, webhookLookup) : null;
    const originalOrigin = ev.origin && typeof ev.origin === "object" ? ev.origin : null;
    const dispatchSource = ev.dispatchSource && typeof ev.dispatchSource === "object" ? ev.dispatchSource : null;
    const finalOrigin = leadOrigin || originalOrigin || dispatchSource || { key: "unknown", label: "Sem origem identificada", type: "unknown", detail: "Contato sem lead vinculado." };
    const finalStatus = normalizeDispatchFinalStatus(ev);
    const campaign = campaignById.get(String(ev.campaignId)) || null;
    const campaignId = String(ev.campaignId || "legacy_cloud_history");
    const campaignName = ev.campaignName || (campaign && campaign.name) || ev.templateName || "Campanha oficial";
    const day = startOfDayIso(ev.sentAt || ev.createdAt || ev.updatedAt);
    const isMixed = Boolean(leadOrigin && dispatchSource && dispatchSource.type && leadOrigin.type && String(dispatchSource.type) !== String(leadOrigin.type));
    const originKey = finalOrigin.key || finalOrigin.label || "unknown";
    const campaignRow = ensureCampaignRow(campaignId, campaignName, ev, campaign);

    addDispatchMetric(summary, finalStatus);
    addDispatchMetric(campaignRow.metrics, finalStatus);
    incMap(statusMap, finalStatus);
    if (day) incMap(dailyMap, day);

    const globalOrigin = ensureOrigin(originMap, originKey, finalOrigin);
    addDispatchMetric(globalOrigin.metrics, finalStatus);
    const campaignOrigin = ensureOrigin(campaignRow._originMap, originKey, finalOrigin);
    addDispatchMetric(campaignOrigin.metrics, finalStatus);

    if (finalOrigin.type === "webhook") { webhookImpacted += 1; campaignRow.context.webhookImpacted += 1; }
    if (dispatchSource && dispatchSource.type === "spreadsheet" && !lead) { spreadsheetImpacted += 1; campaignRow.context.spreadsheetOnly += 1; }
    if (isMixed) { mixedJourney += 1; campaignRow.context.mixedJourney += 1; }
    if (ev.legacy) campaignRow.context.legacyEvents += 1;

    const row = {
      id: ev.id,
      campaignId,
      campaignName,
      templateName: ev.templateName || "",
      languageCode: ev.languageCode || "",
      whatsapp_digits: phone,
      nome: (lead && lead.nome) || (ev.leadSnapshot && ev.leadSnapshot.nome) || "",
      empresa: (lead && lead.empresa) || (ev.leadSnapshot && ev.leadSnapshot.empresa) || "",
      email: (lead && lead.email) || (ev.leadSnapshot && ev.leadSnapshot.email) || "",
      leadId: (lead && lead.id) || ev.leadId || "",
      leadExists: Boolean(lead),
      originLabel: finalOrigin.label || "Sem origem",
      originType: finalOrigin.type || "",
      originDetail: finalOrigin.detail || "",
      dispatchSourceLabel: (dispatchSource && dispatchSource.label) || "Disparo oficial",
      mixedJourney: isMixed,
      status: finalStatus,
      statusLabel: dispatchStatusLabel(finalStatus),
      statusClass: dispatchStatusClass(finalStatus),
      messageId: ev.messageId || "",
      error: ev.error || null,
      errorInfo: ev.errorInfo || (ev.error ? normalizeMetaError(ev.error) : null),
      sentAt: ev.sentAt || null,
      deliveredAt: ev.deliveredAt || null,
      readAt: ev.readAt || null,
      respondedAt: ev.respondedAt || null,
      updatedAt: ev.updatedAt || null,
      legacy: Boolean(ev.legacy),
    };

    campaignRow.recent.push(row);
    return row;
  });

  const campaignRows = Array.from(campaignMap.values()).map((c) => {
    const origins = Array.from(c._originMap.values()).map((o) => ({ ...o, metrics: dispatchMetricRates(o.metrics) }))
      .sort((a, b) => b.metrics.total - a.metrics.total || String(a.label).localeCompare(String(b.label))).slice(0, 12);
    const recent = (Array.isArray(c.recent) ? c.recent : [])
      .sort((a, b) => String(eventSortDate(b)).localeCompare(String(eventSortDate(a))))
      .slice(0, 120);
    return {
      id: c.id,
      name: c.name,
      templateName: c.templateName,
      languageCode: c.languageCode,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      total: c.total,
      metrics: dispatchMetricRates(c.metrics),
      context: c.context,
      origins,
      recent,
    };
  }).sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))).slice(0, 50);

  const originRows = Array.from(originMap.values()).map((o) => ({ ...o, metrics: dispatchMetricRates(o.metrics) }))
    .sort((a, b) => b.metrics.total - a.metrics.total || String(a.label).localeCompare(String(b.label))).slice(0, 12);
  const statusRows = Array.from(statusMap.entries()).map(([status, count]) => ({ status, label: dispatchStatusLabel(status), className: dispatchStatusClass(status), count, percentage: percent(count, events.length) }))
    .sort((a, b) => b.count - a.count);

  const last14 = [];
  for (let i = 13; i >= 0; i--) {
    const day = daysAgoIso(i);
    last14.push({ date: day, count: dailyMap.get(day) || 0 });
  }

  return {
    totalEvents: events.length,
    summary: dispatchMetricRates(summary),
    context: {
      webhookImpacted,
      spreadsheetOnly: spreadsheetImpacted,
      mixedJourney,
      legacyEvents: rows.filter((r) => r.legacy).length,
    },
    campaigns: campaignRows,
    selectedCampaignId: campaignRows[0] ? campaignRows[0].id : "",
    origins: originRows,
    statuses: statusRows,
    timeline: { last14 },
    recent: rows.sort((a, b) => String(eventSortDate(b)).localeCompare(String(eventSortDate(a)))).slice(0, 50),
  };
}

async function syncCloudDispatchFromWebhook(body, connection, metaEventId) {
  const nowIso = new Date().toISOString();
  const parsedEvents = handleCloudWebhook(body);
  const summary = { statuses: 0, replies: 0, unmatchedStatuses: 0, unmatchedReplies: 0, leadsCreated: 0, leadsQueued: 0, leadsReactivated: 0, leadAutomationSkipped: 0 };
  for (const event of parsedEvents) {
    if (event.kind === "status") {
      const state = String(event.state || "").toLowerCase();
      if (!event.messageId || !state) continue;
      const patch = {
        deliveryState: state,
        conversationId: event.conversationId || null,
        conversation: event.raw?.conversation || null,
        pricing: event.raw?.pricing || null,
      };
      if (state === "sent") patch.status = "sent";
      else if (state === "delivered") patch.status = "delivered";
      else if (state === "read") patch.status = "read";
      else if (state === "failed") {
        const webhookError = (Array.isArray(event.raw?.errors) && event.raw.errors[0]) || null;
        patch.status = "failed";
        patch.error = webhookError;
        patch.errorInfo = webhookError ? normalizeMetaError(webhookError) : null;
      } else continue;
      const updated = updateCloudDispatchByMessageId(event.messageId, patch, {
        connectionId: connection.connectionId,
        phoneNumberId: connection.phoneNumberId,
        recipientId: event.recipientId,
        source: "meta_webhook",
        eventId: metaEventId,
        providerStatus: state,
        at: nowIso,
      });
      if (updated) summary.statuses += 1;
      else {
        summary.unmatchedStatuses += 1;
        recordCloudProviderEvent({
          kind: "status",
          connectionId: connection.connectionId,
          phoneNumberId: connection.phoneNumberId,
          wabaId: connection.wabaId,
          recipientId: event.recipientId,
          messageId: event.messageId,
          type: state,
          timestamp: nowIso,
          matchMethod: "unmatched_message_id",
        });
      }
      continue;
    }

    if (event.kind === "message") {
      const correlated = correlateCloudInbound({
        kind: "message",
        connectionId: connection.connectionId,
        phoneNumberId: connection.phoneNumberId,
        wabaId: connection.wabaId,
        recipientId: event.recipientId,
        messageId: event.messageId,
        contextMessageId: event.contextMessageId,
        type: event.type,
        timestamp: event.timestamp,
        at: nowIso,
        eventId: metaEventId,
        inbound: {
          id: event.messageId || null,
          type: event.type || null,
          text: event.text || null,
          timestamp: event.timestamp || null,
          contextMessageId: event.contextMessageId || null,
        },
      });
      if (correlated.matched) summary.replies += 1;
      else summary.unmatchedReplies += 1;

      const routing = resolveCloudInboundTenant({
        phoneNumberId: event.phoneNumberId || connection.phoneNumberId,
        matchedTenantId: correlated.event?.tenantId || '',
        ownerTenantId: connection.ownerTenantId,
        isTenantAllowed: (tenantId) => Boolean(getTenantConfig(tenantId) && isTenantEnabled(tenantId)),
      });
      const rawTimestamp = Number(event.timestamp || 0);
      const receivedAt = Number.isFinite(rawTimestamp) && rawTimestamp > 0
        ? new Date(rawTimestamp * 1000).toISOString()
        : nowIso;
      const automation = await handleInboundCloudLead({
        tenantId: routing.tenantId,
        digits: event.recipientId,
        contactName: event.contactName || '',
        messageId: event.messageId,
        phoneNumberId: event.phoneNumberId || connection.phoneNumberId,
        receivedAt,
        routingMethod: routing.method,
        messageType: event.type,
        messageText: event.text || '',
      });
      if (automation?.created) summary.leadsCreated += 1;
      if (automation?.reactivated) summary.leadsReactivated += 1;
      if (automation?.externalCrm?.queued || automation?.externalCrm?.duplicate) summary.leadsQueued += 1;
      if (automation?.skipped) summary.leadAutomationSkipped += 1;
    }
  }
  return summary;
}

function incMap(map, key, amount = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + amount);
}

function topFromMap(map, limit = 10) {
  return Array.from(map.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)))
    .slice(0, limit);
}


function buildBulkLeadTagsHandler(tenantId) {
  return (req, res) => {
    try {
      const leadIds = Array.isArray(req.body?.leadIds) ? req.body.leadIds.map((x) => String(x || "").trim()).filter(Boolean) : [];
      const addTagIds = Array.isArray(req.body?.addTagIds) ? req.body.addTagIds.map((x) => String(x || "").trim()).filter(Boolean) : [];
      const removeTagIds = Array.isArray(req.body?.removeTagIds) ? req.body.removeTagIds.map((x) => String(x || "").trim()).filter(Boolean) : [];

      const uniqueLeadIds = Array.from(new Set(leadIds));
      if (!uniqueLeadIds.length) return res.status(400).json({ ok: false, error: "Nenhum lead informado." });
      if (!addTagIds.length && !removeTagIds.length) return res.status(400).json({ ok: false, error: "Nenhuma tag informada." });

      const allTags = listTags(tenantId);
      const allowedTags = new Set(allTags.map((t) => String(t.id)));
      const addAllowed = addTagIds.filter((id) => allowedTags.has(id));
      const removeAllowed = removeTagIds.filter((id) => allowedTags.has(id));

      if (addTagIds.length && !addAllowed.length) return res.status(400).json({ ok: false, error: "Tag para adicionar não encontrada." });
      if (removeTagIds.length && !removeAllowed.length) return res.status(400).json({ ok: false, error: "Tag para remover não encontrada." });

      const existingLeadIds = new Set(readLeads(tenantId).map((l) => String(l.id)).filter(Boolean));
      const currentMap = getLeadTagsMap(tenantId);

      let updated = 0;
      let skipped = 0;
      for (const leadId of uniqueLeadIds) {
        if (!existingLeadIds.has(leadId)) { skipped++; continue; }
        const current = new Set(Array.isArray(currentMap[leadId]) ? currentMap[leadId].map((x) => String(x)) : []);
        for (const id of addAllowed) current.add(id);
        for (const id of removeAllowed) current.delete(id);
        const cleaned = Array.from(current).filter((id) => allowedTags.has(id));
        setLeadTags(tenantId, leadId, cleaned);
        updated++;
      }

      res.json({ ok: true, updated, skipped, addTagIds: addAllowed, removeTagIds: removeAllowed });
    } catch (e) {
      res.status(400).json({ ok: false, error: e?.message || String(e) });
    }
  };
}

function buildTenantInsights(tenantId, req) {
  const notDeliveredAfterMin = Number((req && req.query && req.query.notDeliveredAfterMin) || 30);
  const notDeliveredAfterMs = Math.max(1, notDeliveredAfterMin) * 60 * 1000;
  const leadsRaw = readLeads(tenantId);
  const leadById = new Map(leadsRaw.map((l) => [String(l && l.id || ""), l]).filter(([id]) => id));
  const leadTags = getLeadTagsMap(tenantId);
  const tags = listTags(tenantId);
  const tagById = Object.fromEntries(tags.map((t) => [String(t.id), t]));
  const webhooks = listWebhooks(tenantId);
  const webhookLookup = buildWebhookLookup(webhooks, req);
  const wa = getTenantWA(tenantId);
  const crm = readCrmState(tenantId);

  const byPhone = new Map();
  let withWhatsapp = 0;
  let withoutWhatsapp = 0;
  let withEmail = 0;
  let withWebsite = 0;
  let withCompany = 0;
  const dddMap = new Map();
  const dddDetails = new Map();
  const dddGeoByKey = new Map();
  const sourceMap = new Map();
  const sourceDetails = new Map();
  const dailyMap = new Map();
  const tagCount = new Map();
  const recentLeads = [];
  const timelineLeadRefsByDay = new Map();
  const webhookLeadRefsById = new Map();

  const statusCounts = { replied: 0, delivered: 0, notDelivered: 0, notExists: 0, pending: 0, none: 0 };
  const statusByPhone = new Map();

  function makeInsightLeadRow(ref) {
    const lead = ref && ref.lead ? ref.lead : ref;
    if (!lead) return null;
    const origin = (ref && ref.origin) ? ref.origin : leadOriginInfo(lead, webhookLookup);
    const ids = Array.isArray(leadTags[lead.id]) ? leadTags[lead.id] : [];
    const phone = leadPhoneKey(lead) || String(lead.whatsapp_digits || lead.whatsapp_raw || "").replace(/\D+/g, "");
    return {
      id: lead.id || "",
      nome: lead.nome || "",
      empresa: lead.empresa || "",
      email: lead.email || "",
      whatsapp_digits: phone,
      createdAt: lead.createdAt || null,
      updatedAt: lead.updatedAt || null,
      source: lead.source || "",
      originLabel: origin.label || "",
      originDetail: origin.detail || "",
      originType: origin.type || "",
      status: phone ? (statusByPhone.get(phone) || "") : "",
      tags: ids.map((id) => tagById[id]).filter(Boolean),
    };
  }

  for (const lead of leadsRaw) {
    const phone = leadPhoneKey(lead);
    if (phone) {
      withWhatsapp++;
      const existing = byPhone.get(phone);
      if (!existing) byPhone.set(phone, { count: 0, lead });
      byPhone.get(phone).count++;
      const geo = extractPhoneGeoFromDigits(phone);
      if (geo) {
        dddGeoByKey.set(geo.key, geo);
        incMap(dddMap, geo.key);
      }
    } else {
      withoutWhatsapp++;
    }
    if (lead.email) withEmail++;
    if (lead.website) withWebsite++;
    if (lead.empresa) withCompany++;

    const day = startOfDayIso(lead.createdAt);
    if (day) {
      incMap(dailyMap, day);
    }

    const origin = leadOriginInfo(lead, webhookLookup);
    if (day) {
      if (!timelineLeadRefsByDay.has(day)) timelineLeadRefsByDay.set(day, []);
      timelineLeadRefsByDay.get(day).push({ lead, origin });
    }
    if (origin && origin.type === "webhook" && origin.webhookId) {
      const whid = String(origin.webhookId);
      if (!webhookLeadRefsById.has(whid)) webhookLeadRefsById.set(whid, []);
      webhookLeadRefsById.get(whid).push({ lead, origin });
    }
    incMap(sourceMap, origin.key);
    if (!sourceDetails.has(origin.key)) {
      sourceDetails.set(origin.key, { ...origin, count: 0, firstAt: lead.createdAt || null, lastAt: lead.createdAt || null });
    }
    const od = sourceDetails.get(origin.key);
    od.count += 1;
    if (lead.createdAt && (!od.firstAt || String(lead.createdAt) < String(od.firstAt))) od.firstAt = lead.createdAt;
    if (lead.createdAt && (!od.lastAt || String(lead.createdAt) > String(od.lastAt))) od.lastAt = lead.createdAt;

    const ids = Array.isArray(leadTags[lead.id]) ? leadTags[lead.id] : [];
    for (const id of ids) incMap(tagCount, id);

    if (phone) {
      const leadGeo = extractPhoneGeoFromDigits(phone);
      if (leadGeo) {
        dddGeoByKey.set(leadGeo.key, leadGeo);
        if (!dddDetails.has(leadGeo.key)) dddDetails.set(leadGeo.key, []);
        dddDetails.get(leadGeo.key).push({
          id: lead.id,
          nome: lead.nome || "",
          empresa: lead.empresa || "",
          email: lead.email || "",
          whatsapp_digits: phone,
          createdAt: lead.createdAt || null,
          source: lead.source || "",
          originLabel: origin.label,
          originDetail: origin.detail,
          tags: ids.map((id) => tagById[id]).filter(Boolean),
        });
      }
    }

    recentLeads.push({
      id: lead.id,
      nome: lead.nome || "",
      empresa: lead.empresa || "",
      email: lead.email || "",
      whatsapp_digits: phone || String(lead.whatsapp_digits || lead.whatsapp_raw || "").replace(/\D+/g, ""),
      createdAt: lead.createdAt || null,
      source: lead.source || "",
      originLabel: origin.label,
      originDetail: origin.detail,
      tags: ids.map((id) => tagById[id]).filter(Boolean),
    });
  }

  for (const [phone] of byPhone.entries()) {
    const ms = getMessageStatusForPhoneVariants(wa, phone);
    const st = computeLeadStatus(ms, { notDeliveredAfterMs });
    statusByPhone.set(phone, st);
    if (st === "replied") statusCounts.replied++;
    else if (st === "delivered") statusCounts.delivered++;
    else if (st === "notDelivered") statusCounts.notDelivered++;
    else if (st === "notExists") statusCounts.notExists++;
    else if (st === "pending") statusCounts.pending++;
    else statusCounts.none++;
  }

  let conversationCount = 0;
  let totalMessages = 0;
  let incomingMessages = 0;
  let outgoingMessages = 0;
  let textMessages = 0;
  let mediaMessages = 0;
  let audioMessages = 0;
  let imageMessages = 0;
  let videoMessages = 0;
  let documentMessages = 0;
  const conversationRows = [];
  for (const digits of listConversationDigits(tenantId)) {
    const messages = listConversationMessages(tenantId, digits, 500);
    if (!messages.length) continue;
    conversationCount++;
    let last = null;
    let inCount = 0;
    let outCount = 0;
    let mediaCount = 0;
    for (const msg of messages) {
      totalMessages++;
      if (msg.fromMe) { outgoingMessages++; outCount++; }
      else { incomingMessages++; inCount++; }
      const kind = String(msg.mediaKind || msg.type || "").toLowerCase();
      const hasMedia = Boolean(msg.hasMedia || msg.mediaFile || (kind && kind !== "chat"));
      if (hasMedia) {
        mediaMessages++; mediaCount++;
        if (kind.includes("audio") || kind === "ptt") audioMessages++;
        else if (kind.includes("image")) imageMessages++;
        else if (kind.includes("video")) videoMessages++;
        else documentMessages++;
      } else {
        textMessages++;
      }
      last = msg;
    }
    const normalizedDigits = normalizePhoneToE164Digits(digits) || digitsOnlyServer(digits);
    const leadMatch = findLeadByPhoneVariants(byPhone, normalizedDigits || digits) || null;
    const convStatus = statusByPhone.get(normalizedDigits || digits) || (leadMatch ? statusByPhone.get(leadPhoneKey(leadMatch)) : "") || "";
    conversationRows.push({
      whatsapp_digits: normalizedDigits || digits,
      nome: leadMatch ? (leadMatch.nome || "") : "",
      empresa: leadMatch ? (leadMatch.empresa || "") : "",
      status: convStatus,
      total: messages.length,
      incoming: inCount,
      outgoing: outCount,
      media: mediaCount,
      lastAt: last ? (last.createdAt || null) : null,
      lastPreview: last ? String(last.body || last.mediaKind || last.type || "Mensagem").slice(0, 140) : "",
    });
  }
  conversationRows.sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));

  const pipelineRows = [];
  let crmCards = 0;
  const pipelines = Array.isArray(crm.pipelines) ? crm.pipelines : [];
  for (const p of pipelines) {
    const stagesObj = p && p.stages && typeof p.stages === "object" ? p.stages : {};
    const stages = Object.values(stagesObj).map((st) => {
      const leadIds = Array.isArray(st.leadIds) ? st.leadIds.map((id) => String(id)) : [];
      const count = leadIds.length;
      crmCards += count;
      const stageLeads = leadIds
        .map((id) => leadById.get(String(id)))
        .filter(Boolean)
        .map((lead) => makeInsightLeadRow({ lead, origin: leadOriginInfo(lead, webhookLookup) }))
        .filter(Boolean);
      return { id: st.id || "", name: st.name || "Etapa", count, leads: stageLeads };
    });
    pipelineRows.push({ id: p.id || "", name: p.name || "Funil", stages, total: stages.reduce((a, s) => a + s.count, 0) });
  }

  const today = daysAgoIso(0);
  function buildTimelineRange(days) {
    const out = [];
    const n = Math.max(1, Number(days || 30));
    for (let i = n - 1; i >= 0; i--) {
      const day = daysAgoIso(i);
      const refs = timelineLeadRefsByDay.get(day) || [];
      out.push({
        date: day,
        count: dailyMap.get(day) || 0,
        leads: refs
          .slice()
          .sort((a, b) => String((b.lead && b.lead.createdAt) || "").localeCompare(String((a.lead && a.lead.createdAt) || "")))
          .map(makeInsightLeadRow)
          .filter(Boolean)
          .slice(0, 500),
      });
    }
    return out;
  }
  const last7 = buildTimelineRange(7);
  const last30 = buildTimelineRange(30);
  const last60 = buildTimelineRange(60);
  const allDays = Array.from(dailyMap.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const dayLeads = Object.fromEntries(Array.from(timelineLeadRefsByDay.entries()).map(([date, refs]) => [
    date,
    refs
      .slice()
      .sort((a, b) => String((b.lead && b.lead.createdAt) || "").localeCompare(String((a.lead && a.lead.createdAt) || "")))
      .map(makeInsightLeadRow)
      .filter(Boolean)
      .slice(0, 500),
  ]));

  const duplicatePhones = Array.from(byPhone.entries()).filter(([, row]) => row.count > 1);
  const uniqueWhatsapp = byPhone.size;
  const totalLeads = leadsRaw.length;
  const sourceRows = Array.from(sourceDetails.values()).sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label))).map((row) => ({
    ...row,
    percentage: percent(row.count, totalLeads),
  }));

  const webhookLeadStatsById = new Map();
  for (const row of sourceDetails.values()) {
    if (row && row.type === "webhook" && row.webhookId) {
      webhookLeadStatsById.set(String(row.webhookId), {
        count: row.count || 0,
        percentage: percent(row.count || 0, totalLeads),
        firstAt: row.firstAt || null,
        lastAt: row.lastAt || null,
      });
    }
  }

  const webhooksWithCounts = webhookLookup.items.map((wb) => {
    const stats = webhookLeadStatsById.get(String(wb.id)) || { count: 0, percentage: 0, firstAt: null, lastAt: null };
    return {
      ...wb,
      leadCount: stats.count,
      leadPercentage: stats.percentage,
      firstLeadAt: stats.firstAt,
      lastLeadAt: stats.lastAt,
      leads: (webhookLeadRefsById.get(String(wb.id)) || [])
        .slice()
        .sort((a, b) => String((b.lead && b.lead.createdAt) || "").localeCompare(String((a.lead && a.lead.createdAt) || "")))
        .map(makeInsightLeadRow)
        .filter(Boolean)
        .slice(0, 500),
    };
  });

  const dddRows = topFromMap(dddMap, 15).map((x) => {
    const geo = dddGeoByKey.get(x.key) || {
      key: x.key,
      prefix: String(x.key || ""),
      ddd: String(x.key || ""),
      country: "",
      countryName: "",
      ddi: "",
      label: `Prefixo ${String(x.key || "")}`,
      filterValue: String(x.key || ""),
    };
    return {
      groupKey: geo.key,
      ddd: geo.ddd || geo.prefix,
      prefix: geo.prefix || geo.ddd,
      country: geo.country || "",
      countryName: geo.countryName || "",
      ddi: geo.ddi || "",
      label: geo.label || `Prefixo ${geo.prefix || geo.ddd || x.key}`,
      filterValue: geo.filterValue || geo.ddd || geo.prefix || "",
      count: x.count,
      percentage: percent(x.count, withWhatsapp),
      leads: (dddDetails.get(x.key) || [])
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
        .slice(0, 300),
    };
  });

  const dispatchInsights = buildDispatchInsightsForTenant(tenantId, { byPhone, webhookLookup });

  return {
    ok: true,
    tenantId,
    generatedAt: new Date().toISOString(),
    notDeliveredAfterMin,
    summary: {
      totalLeads,
      uniqueWhatsapp,
      duplicateWhatsappNumbers: duplicatePhones.length,
      duplicateLeadRecords: duplicatePhones.reduce((acc, [, row]) => acc + Math.max(0, row.count - 1), 0),
      withWhatsapp,
      withoutWhatsapp,
      withEmail,
      withWebsite,
      withCompany,
      totalTags: tags.length,
      activeWebhooks: webhooks.length,
      conversations: conversationCount,
      totalMessages,
      incomingMessages,
      outgoingMessages,
      textMessages,
      mediaMessages,
      audioMessages,
      imageMessages,
      videoMessages,
      documentMessages,
      crmPipelines: pipelineRows.length,
      crmCards,
      todayLeads: dailyMap.get(today) || 0,
    },
    dispatch: dispatchInsights,
    whatsapp: {
      ...statusCounts,
      totalTrackedUnique: uniqueWhatsapp,
      repliedRate: percent(statusCounts.replied, uniqueWhatsapp),
      deliveredRate: percent(statusCounts.delivered + statusCounts.replied, uniqueWhatsapp),
      notDeliveredRate: percent(statusCounts.notDelivered, uniqueWhatsapp),
      notExistsRate: percent(statusCounts.notExists, uniqueWhatsapp),
    },
    origins: sourceRows,
    ddds: dddRows,
    tags: topFromMap(tagCount, 20).map((x) => ({ ...(tagById[x.key] || { id: x.key, name: x.key, color: "#64748b" }), count: x.count, percentage: percent(x.count, totalLeads) })),
    webhooks: webhooksWithCounts,
    timeline: { last7, last30, last60, allDays, dayLeads },
    crm: { pipelines: pipelineRows },
    conversations: {
      top: conversationRows.slice(0, 15),
      total: conversationRows.length,
    },
    recentLeads: recentLeads.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, 20),
  };
}

/* -------------------- routes -------------------- */
registerHealthRoutes(app, { databaseRuntime, releaseMetadata });

/** Formulário público legado. Em produção permanece desabilitado até ativação explícita. */
app.post("/api/leads", async (req, res) => {
  const enabled = securityEnvBool(process.env.PUBLIC_LEAD_FORM_ENABLED, !isProduction());
  if (!enabled) return res.status(404).json({ ok: false, error: "not_found" });
  if (!requireSupportedBody(req, res, { allowForm: true })) return;

  const expectedToken = String(process.env.PUBLIC_LEAD_FORM_TOKEN || "").trim();
  if (isProduction() && expectedToken.length < 32) {
    return respondSecurityError(res, 503, "PUBLIC_FORM_NOT_CONFIGURED", "Formulário público indisponível.");
  }
  if (expectedToken && !validateFixedWebhookToken(req, expectedToken)) {
    return respondSecurityError(res, 401, "INVALID_PUBLIC_FORM_TOKEN", "Credencial inválida.");
  }
  if (!enforceRateLimit({
    req,
    res,
    limiter: publicEndpointRateLimiter,
    scope: "public-form",
    identity: publicEndpointIdentity(req),
    max: PUBLIC_FORM_RATE_MAX,
    windowMs: PUBLIC_RATE_WINDOW_MS,
  })) return;

  let claim = null;
  let eventId = "";
  try {
    const payload = validatePublicLeadPayload(req.body || {});
    eventId = String(req.get("idempotency-key") || req.get("x-idempotency-key") || "").trim().slice(0, 200);
    if (eventId) {
      claim = claimWebhookEvent({ integration: "public-form", tenantId: TENANT_ADMIN, eventId, requestHash: securitySha256(JSON.stringify(payload)) });
      if (!claim.claimed) return duplicateWebhookResponse(res, claim);
    }

    const lead = await processLead(TENANT_ADMIN, "local_form", {
      sourceDetail: "Formulário local antigo do site",
      sourceMeta: { type: "form", form: "local_form" },
      ...payload,
    });
    const responseBody = { ok: true, leadId: lead.id };
    if (claim?.claimed) completeWebhookEventRequired({ integration: "public-form", tenantId: TENANT_ADMIN, eventId, statusCode: 200, responseBody });
    return res.json(responseBody);
  } catch (error) {
    if (claim?.claimed) {
      const statusCode = publicEndpointErrorStatus(error);
      completeWebhookEventBestEffort({
        integration: "public-form",
        tenantId: TENANT_ADMIN,
        eventId,
        statusCode,
        responseBody: {
          ok: false,
          code: error?.code || "INVALID_PAYLOAD",
          error: statusCode >= 500 ? "Endpoint temporariamente indisponível." : (error?.message || "Payload inválido."),
        },
      });
    }
    return handlePublicEndpointError(res, error);
  }
});

// Endpoint de diagnóstico disponível somente em desenvolvimento, com feature flag e super_admin.
if (!isProduction() && DEBUG && securityEnvBool(process.env.ENABLE_DEBUG_ACTIVE, false)) {
  app.post("/debug/active", adminAuth, requireRole(ROLES.SUPER_ADMIN), (req, res) => {
    console.log("[DEBUG_ACTIVE] requisição autorizada", {
      contentType: req.get("content-type") || "",
      contentLength: req.get("content-length") || "",
      bodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body).slice(0, 30) : [],
    });
    res.json({ ok: true });
  });
}

/**
 * Entrada fixa da ActiveCampaign no tenant ADMIN.
 * Requer ativação explícita e token forte. O evento é idempotente por x-zape-event-id,
 * x-idempotency-key ou hash do payload quando o provedor não envia um identificador.
 */
app.post("/webhooks/activecampaign", async (req, res) => {
  const enabled = securityEnvBool(process.env.ACTIVECAMPAIGN_WEBHOOK_ENABLED, !isProduction());
  if (!enabled) return res.status(404).json({ ok: false, error: "not_found" });
  if (!requireSupportedBody(req, res, { allowForm: true })) return;

  const expectedToken = String(process.env.ACTIVECAMPAIGN_WEBHOOK_TOKEN || "").trim();
  if (expectedToken.length < 32) {
    return respondSecurityError(res, 503, "ACTIVECAMPAIGN_NOT_CONFIGURED", "Webhook indisponível.");
  }
  if (!validateFixedWebhookToken(req, expectedToken)) {
    return respondSecurityError(res, 401, "INVALID_WEBHOOK_TOKEN", "Credencial inválida.");
  }
  if (!enforceRateLimit({
    req,
    res,
    limiter: publicEndpointRateLimiter,
    scope: "activecampaign",
    identity: publicEndpointIdentity(req, securitySha256(expectedToken)),
    max: ACTIVECAMPAIGN_RATE_MAX,
    windowMs: PUBLIC_RATE_WINDOW_MS,
  })) return;

  const eventId = activeCampaignEventId(req);
  let claim = null;
  try {
    claim = claimWebhookEvent({ integration: "activecampaign", tenantId: TENANT_ADMIN, eventId, requestHash: securitySha256(JSON.stringify(req.body || {})) });
    if (!claim.claimed) return duplicateWebhookResponse(res, claim);

    const body = validateActiveCampaignPayload(req.body || {});
    const c = body.contact || {};
    const f = c?.fields || {};

    const lead = await processLead(TENANT_ADMIN, "activecampaign", {
      allowPhoneOnly: true,
      sourceDetail: "Webhook fixo do ActiveCampaign",
      sourceMeta: { type: "activecampaign", payloadType: "activecampaign" },
      active_contact_id: c.id || "",
      active_seriesid: body.seriesid || "",
      tags: c.tags || "",
      nome: c.first_name || "",
      empresa: f.empresa || c.orgname || "",
      jaAnuncia: f.j_anuncia_no_google_ads_2 || "",
      website: "",
      email: c.email || "",
      whatsapp: c.phone || "",
    });

    const legacyExternalTarget = getLegacyActiveCampaignTarget();
    if (legacyExternalTarget) {
      try {
        const queued = await enqueueExternalCrmLead({
          tenantId: TENANT_ADMIN,
          webhook: { id: "activecampaign-legacy", name: "ActiveCampaign legado" },
          lead,
          target: legacyExternalTarget,
          payloadType: "activecampaign",
        });
        console.log("📥 Sincronização com CRM Inteligente registrada:", sanitizeForLog(queued));
      } catch (queueError) {
        console.error("⚠️ Lead salvo, mas não foi possível gravar a fila do CRM Inteligente:", safeError(queueError));
      }
    }

    const responseBody = { ok: true, leadId: lead.id };
    completeWebhookEventRequired({ integration: "activecampaign", tenantId: TENANT_ADMIN, eventId, statusCode: 200, responseBody });
    return res.json(responseBody);
  } catch (error) {
    console.error("❌ Active webhook error:", safeError(error));
    const safeStatus = publicEndpointErrorStatus(error);
    const responseBody = { ok: false, code: error?.code || "INVALID_PAYLOAD", error: safeStatus >= 500 ? "Endpoint temporariamente indisponível." : (error?.message || "Payload inválido.") };
    if (claim?.claimed && error?.code !== "WEBHOOK_IDEMPOTENCY_UNAVAILABLE") {
      completeWebhookEventBestEffort({ integration: "activecampaign", tenantId: TENANT_ADMIN, eventId, statusCode: safeStatus, responseBody });
    }
    return handlePublicEndpointError(res, error);
  }
});

/** Webhook gerado (multi-tenant): /webhooks/<token> */
app.post("/webhooks/:token", async (req, res, next) => {
  if (String(req.params.token || "").trim() === "wa-cloud") return next();

  req.webhookTransportDiagnostic?.stage("route_entered", {
    parsedBodyType: Array.isArray(req.body) ? "array" : typeof req.body,
    parsedBodyKeys: req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? Object.keys(req.body).slice(0, 100)
      : [],
  });

  const diagnostic = createWebhookRequestDiagnostics({
    req,
    res,
    token: req.params.token,
  });

  let claim = null;
  let eventId = "";
  let tenantId = "";
  let integrationId = "";

  try {
    if (!requireSupportedBody(req, res, { allowForm: true })) {
      diagnostic.stage("rejected_unsupported_body", {
        contentType: req.get("content-type") || "",
      }, "warn");
      return;
    }

    const token = String(req.params.token || "").trim();
    const row = resolveWebhookToken(token);
    if (!row) {
      diagnostic.stage("webhook_not_found", {}, "warn");
      const responseBody = { ok: false, error: "Webhook não encontrado." };
      diagnostic.response(responseBody, 404);
      return res.status(404).json(responseBody);
    }

    tenantId = row.tenantId;
    diagnostic.setContext({
      tenantId,
      webhookId: row.id,
      webhookName: row.name || row.displayName || "",
      stage: "webhook_resolved",
    });
    diagnostic.info("custom.webhook_resolved", {
      enabled: row.enabled !== false,
      configuredMessages: Array.isArray(row.messages)
        ? row.messages.length
        : (row.messageText ? 1 : 0),
      crmTargetEnabled: Boolean(row.crmTarget && row.crmTarget.enabled !== false),
      externalCrmTargetEnabled: Boolean(row.externalCrmTarget && row.externalCrmTarget.enabled !== false),
    });

    if (!enforceRateLimit({
      req,
      res,
      limiter: publicEndpointRateLimiter,
      scope: "custom-webhook",
      identity: publicEndpointIdentity(req, `${tenantId}:${row.id}`),
      max: CUSTOM_WEBHOOK_RATE_MAX,
      windowMs: PUBLIC_RATE_WINDOW_MS,
    })) {
      diagnostic.stage("rejected_rate_limit", {}, "warn");
      return;
    }

    const rawBody = getRawBody(req);
    const signatureRequiredByPolicy = customWebhookSignatureRequired();
    const activeCampaignTokenOnly = isActiveCampaignWebhookPayload(req.body || {});
    const requireSignature = signatureRequiredByPolicy && !activeCampaignTokenOnly;
    const authenticationMode = activeCampaignTokenOnly
      ? "activecampaign_url_token"
      : (requireSignature ? "signed_webhook" : "url_token");

    diagnostic.stage("security_validation_started", {
      requireSignature,
      signatureRequiredByPolicy,
      activeCampaignTokenOnly,
      authenticationMode,
      rawBodyBytes: Buffer.isBuffer(rawBody) ? rawBody.length : Buffer.byteLength(String(rawBody || "")),
      rawBodyHash: securitySha256(rawBody || Buffer.alloc(0)).slice(0, 16),
    });

    if (activeCampaignTokenOnly) {
      // O token secreto presente na própria URL já identificou o webhook por resolveWebhookToken().
      // A ActiveCampaign não envia os três headers do protocolo assinado do Zape, por isso
      // geramos uma chave de idempotência estável a partir do payload recebido.
      eventId = activeCampaignEventId(req);
      diagnostic.info("custom.activecampaign_url_token_accepted", {
        authenticationMode,
        signaturePresent: Boolean(req.get("x-zape-signature")),
        timestampPresent: Boolean(req.get("x-zape-timestamp")),
        eventIdPresent: Boolean(req.get("x-zape-event-id") || req.get("x-idempotency-key")),
        generatedEventId: !Boolean(req.get("x-zape-event-id") || req.get("x-idempotency-key")),
      });
    } else if (requireSignature) {
      const signatureResult = validateCustomWebhookSignature({
        rawBody,
        signatureHeader: req.get("x-zape-signature"),
        timestampHeader: req.get("x-zape-timestamp"),
        eventIdHeader: req.get("x-zape-event-id"),
        secret: row.token,
      });
      if (!signatureResult.ok) {
        diagnostic.stage("rejected_invalid_signature", {
          signatureCode: signatureResult.code,
          signaturePresent: Boolean(req.get("x-zape-signature")),
          timestampPresent: Boolean(req.get("x-zape-timestamp")),
          eventIdPresent: Boolean(req.get("x-zape-event-id")),
          authenticationMode,
        }, "warn");
        return respondSecurityError(res, 401, signatureResult.code, "Assinatura do webhook inválida.");
      }
      eventId = signatureResult.eventId;
    } else {
      eventId = String(req.get("x-zape-event-id") || `payload:${securitySha256(rawBody || Buffer.alloc(0))}`).trim().slice(0, 200);
    }

    diagnostic.setContext({ eventId, stage: "security_validated" });
    diagnostic.info("custom.security_validated", {
      requireSignature,
      signatureRequiredByPolicy,
      activeCampaignTokenOnly,
      authenticationMode,
      eventIdHash: securitySha256(eventId).slice(0, 16),
    });

    const body = validateCustomWebhookPayload(req.body || {});
    const payloadType = body.contact || body.seriesid ? "activecampaign" : "json";
    diagnostic.stage("payload_validated", {
      payloadType,
      validatedData: sanitizeForLog(body),
      hasContact: Boolean(body.contact),
      hasSeriesId: Boolean(body.seriesid),
    });

    integrationId = `custom:${row.id}`;
    claim = claimWebhookEvent({
      integration: integrationId,
      tenantId,
      eventId,
      requestHash: securitySha256(rawBody),
    });
    if (!claim.claimed && activeCampaignTokenOnly && !claim.conflict && !claim.pending && Number(claim.statusCode || 0) >= 400) {
      const released = releaseWebhookEvent({ integration: integrationId, tenantId, eventId });
      diagnostic.warn("custom.previous_failed_event_released", {
        previousStatusCode: Number(claim.statusCode || 0),
        released,
      });
      if (released) {
        claim = claimWebhookEvent({
          integration: integrationId,
          tenantId,
          eventId,
          requestHash: securitySha256(rawBody),
        });
      }
    }
    if (!claim.claimed) {
      diagnostic.stage("duplicate_event", {
        claimState: claim?.state || claim?.status || "existing",
        previousStatusCode: Number(claim?.statusCode || 0),
      }, "warn");
      return duplicateWebhookResponse(res, claim);
    }

    diagnostic.stage("event_claimed", {
      integrationId,
      claimCreated: true,
    });

    const webhookUrl = `${getPublicBaseUrl(req)}/webhooks/[redacted]`;
    const webhookName = webhookEffectiveName(row, webhookUrl);
    diagnostic.setContext({ webhookName });
    let lead = null;
    let leadCreated = true;
    let leadReused = false;

    if (payloadType === "activecampaign") {
      const c = body.contact || {};
      const f = c?.fields || {};
      diagnostic.stage("lead_processing_started", {
        payloadType,
        mappedFields: {
          nome: Boolean(c.first_name),
          empresa: Boolean(f.empresa || c.orgname),
          email: Boolean(c.email),
          whatsapp: Boolean(c.phone),
          tags: Boolean(c.tags),
        },
      });
      const processedLead = await processWebhookLead(tenantId, "generated_webhook_activecampaign", {
        allowPhoneOnly: true,
        sourceDetail: `Webhook ${webhookName || row.id} recebido no formato ActiveCampaign`,
        sourceMeta: {
          type: "webhook",
          webhookId: row.id,
          webhookName,
          webhookReference: row.id,
          webhookMessages: Array.isArray(row.messages) ? row.messages : (row.messageText ? [row.messageText] : []),
          payloadType: "activecampaign",
        },
        active_contact_id: c.id || "",
        active_seriesid: body.seriesid || "",
        tags: c.tags || "",
        nome: c.first_name || "",
        empresa: f.empresa || c.orgname || "",
        jaAnuncia: f.j_anuncia_no_google_ads_2 || "",
        website: "",
        email: c.email || "",
        whatsapp: c.phone || "",
      }, diagnostic);
      lead = processedLead.lead;
      leadCreated = processedLead.created;
      leadReused = processedLead.reused;
      diagnostic.info(processedLead.created ? "custom.lead_created" : "custom.lead_reused", {
        leadId: lead?.id || "",
        created: processedLead.created,
        reused: processedLead.reused,
      });
    } else {
      const p = body;
      diagnostic.stage("lead_processing_started", {
        payloadType,
        mappedFields: {
          nome: Boolean(p.nome || p.name || p.first_name),
          empresa: Boolean(p.empresa || p.company || p.orgname),
          website: Boolean(p.website || p.site),
          email: Boolean(p.email),
          whatsapp: Boolean(p.whatsapp || p.phone),
          tags: Boolean(p.tags),
        },
      });
      const processedLead = await processWebhookLead(tenantId, "generated_webhook_generic", {
        allowPhoneOnly: true,
        sourceDetail: `Webhook ${webhookName || row.id} recebido por POST JSON`,
        sourceMeta: {
          type: "webhook",
          webhookId: row.id,
          webhookName,
          webhookReference: row.id,
          webhookMessages: Array.isArray(row.messages) ? row.messages : (row.messageText ? [row.messageText] : []),
          payloadType: "json",
        },
        nome: p.nome || p.name || p.first_name || "",
        empresa: p.empresa || p.company || p.orgname || "",
        jaAnuncia: p.jaAnuncia || p.j_anuncia_no_google_ads_2 || "",
        website: p.website || p.site || "",
        email: p.email || "",
        whatsapp: p.whatsapp || p.phone || "",
        tags: p.tags || "",
        active_contact_id: p.active_contact_id || "",
        active_seriesid: p.active_seriesid || "",
      }, diagnostic);
      lead = processedLead.lead;
      leadCreated = processedLead.created;
      leadReused = processedLead.reused;
      diagnostic.info(processedLead.created ? "custom.lead_created" : "custom.lead_reused", {
        leadId: lead?.id || "",
        created: processedLead.created,
        reused: processedLead.reused,
      });
    }

    diagnostic.stage("lead_saved", {
      leadId: lead?.id || "",
      leadData: {
        nome: lead?.nome || "",
        empresa: lead?.empresa || "",
        email: lead?.email || "",
        whatsapp: lead?.whatsapp_digits || lead?.whatsapp || "",
        source: lead?.source || "",
        createdAt: lead?.createdAt || "",
      },
    });

    const crmTargetResult = addLeadToCrmTargetFromWebhook(tenantId, row, lead);
    if (crmTargetResult && crmTargetResult.added) {
      console.log(`✅ Lead vinculado ao CRM pelo webhook [${tenantId}]:`, { leadId: lead.id, webhookId: row.id, pipelineId: crmTargetResult.pipelineId, stageId: crmTargetResult.stageId });
      diagnostic.info("custom.crm_target_applied", {
        leadId: lead.id,
        pipelineId: crmTargetResult.pipelineId,
        stageId: crmTargetResult.stageId,
      });
    } else if (row.crmTarget && row.crmTarget.enabled !== false) {
      console.warn(`⚠️ Webhook com vínculo de CRM não aplicado [${tenantId}]:`, { webhookId: row.id, leadId: lead?.id, reason: crmTargetResult?.reason });
      diagnostic.warn("custom.crm_target_not_applied", {
        leadId: lead?.id || "",
        reason: crmTargetResult?.reason || "unknown",
      });
    } else {
      diagnostic.info("custom.crm_target_skipped", { reason: "not_configured" });
    }

    if (row.externalCrmTarget && row.externalCrmTarget.enabled !== false) {
      try {
        const queued = await enqueueExternalCrmLead({
          tenantId,
          webhook: { id: row.id, name: row.name, displayName: webhookName },
          lead,
          target: row.externalCrmTarget,
          payloadType: lead?.sourceMeta?.payloadType || "json",
        });
        console.log(`📥 Lead registrado na fila do CRM Inteligente [${tenantId}]:`, sanitizeForLog(queued));
        diagnostic.info("custom.external_crm_queued", {
          leadId: lead.id,
          queueResult: sanitizeForLog(queued),
        });
      } catch (queueError) {
        console.error(`⚠️ Lead salvo, mas não foi possível gravar a fila do CRM Inteligente [${tenantId}]:`, safeError(queueError));
        diagnostic.error("custom.external_crm_queue_failed", {
          leadId: lead.id,
          error: safeError(queueError),
        });
      }
    } else {
      diagnostic.info("custom.external_crm_skipped", { reason: "not_configured" });
    }

    const webhookMessageTemplates = Array.isArray(row.messages) && row.messages.length > 0
      ? row.messages
      : (row.messageText ? [row.messageText] : []);
    const webhookMessages = webhookMessageTemplates
      .map((msg) => String(msg || "").replace(/\{\{\s*nome\s*\}\}/gi, lead.nome || "").trim())
      .filter(Boolean);

    diagnostic.stage("automatic_messages_prepared", {
      templateCount: webhookMessageTemplates.length,
      validMessageCount: webhookMessages.length,
      messageLengths: webhookMessages.map((message) => message.length),
      messagePreviews: webhookMessages.map((message) => message.slice(0, 300)),
      destination: lead.whatsapp_digits || "",
    });

    let automaticMessages = { configured: 0, queued: 0, existing: 0 };
    if (webhookMessages.length) {
      const queued = automaticMessageQueue.enqueueBatch({
        tenantId: row.tenantId,
        toDigits: lead.whatsapp_digits,
        nome: lead.nome || "",
        messages: webhookMessages,
        idempotencyPrefix: `webhook:${row.id}:${eventId}:${lead.id}`,
        source: {
          type: "webhook",
          webhookId: row.id,
          webhookName,
          webhookEventId: eventId,
          leadId: lead.id,
        },
      });
      automaticMessages = { configured: queued.configured, queued: queued.queued, existing: queued.existing };
      console.log(`📥 Mensagem automática do webhook enfileirada [${tenantId}]:`, {
        webhookId: row.id,
        leadId: lead.id,
        configured: queued.configured,
        queued: queued.queued,
        existing: queued.existing,
      });
      diagnostic.stage("automatic_messages_queued", {
        leadId: lead.id,
        automaticMessages,
        jobs: Array.isArray(queued.jobs)
          ? queued.jobs.map((job) => ({ id: job.id, state: job.state, created: job.created }))
          : [],
      });
    } else {
      diagnostic.stage("automatic_messages_skipped", {
        leadId: lead.id,
        reason: webhookMessageTemplates.length ? "templates_empty_after_processing" : "no_message_configured",
      }, "warn");
    }

    const responseBody = { ok: true, tenantId, leadId: lead.id, leadCreated, leadReused, automaticMessages };
    completeWebhookEventRequired({
      integration: integrationId,
      tenantId,
      eventId,
      statusCode: 200,
      responseBody,
    });
    diagnostic.stage("event_completed", {
      leadId: lead.id,
      leadCreated,
      leadReused,
      automaticMessages,
    });
    diagnostic.response(responseBody, 200);
    return res.json(responseBody);
  } catch (error) {
    console.error("❌ Webhook token error:", safeError(error));
    const safeStatus = publicEndpointErrorStatus(error);
    const responseBody = {
      ok: false,
      code: error?.code || "INVALID_PAYLOAD",
      error: safeStatus >= 500
        ? "Endpoint temporariamente indisponível."
        : (error?.message || "Payload inválido."),
    };
    diagnostic.failure(error, {
      safeStatus,
      tenantId,
      integrationId,
      eventIdHash: eventId ? securitySha256(eventId).slice(0, 16) : "",
      claimCreated: Boolean(claim?.claimed),
      responseData: responseBody,
    });
    if (claim?.claimed && tenantId && eventId) {
      completeWebhookEventBestEffort({
        integration: integrationId,
        tenantId,
        eventId,
        statusCode: safeStatus,
        responseBody,
      });
    }
    diagnostic.response(responseBody, safeStatus);
    return handlePublicEndpointError(res, error);
  }
});


app.post('/api/integrations/bobcrm/events', async (req, res) => {
  if (!authorizeBobCrmReverseSync(req)) {
    recordSecurityAudit({ req, action: 'bobcrm_reverse_sync_denied', resource: 'bobcrm_reverse_sync', outcome: 'denied', details: { ip: resolveClientIp(req, true) } });
    return res.status(401).json({ ok: false, error: 'Chave da sincronização BobCRM inválida.' });
  }
  try {
    const result = await applyBobCrmEvent(req.body || {});
    recordSecurityAudit({ req, action: 'bobcrm_reverse_sync_applied', resource: 'lead', targetTenantId: result.tenantId || req.body?.tenantId, outcome: result.ignored ? 'ignored' : 'success', details: { eventKey: req.body?.eventKey, leadId: result.leadId, zapeLeadId: result.zapeLeadId } });
    return res.status(result.idempotentReplay ? 200 : 201).json(result);
  } catch (error) {
    return res.status(Number(error?.statusCode || 500)).json({ ok: false, error: error?.message || 'Não foi possível aplicar o evento do BobCRM.', code: error?.code || 'BOBCRM_REVERSE_SYNC_ERROR' });
  }
});

app.get('/api/integrations/bobcrm/status', integrationMonitorAuth, async (req, res) => {
  return res.json({ ok: true, ...(await getBobCrmReverseSyncStatus()) });
});

function integrationMonitorAuth(req, res, next) {
  const expected = String(process.env.INTEGRATION_MONITOR_KEY || "").trim();
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const presented = String(match?.[1] || "").trim();
  if (!expected) {
    return res.status(503).json({ ok: false, error: "INTEGRATION_MONITOR_KEY não configurada." });
  }
  if (!presented || !timingSafeEqualText(presented, expected)) {
    recordSecurityAudit({
      req,
      action: "integration_monitor_access_denied",
      resource: "integration_monitor",
      outcome: "denied",
      details: { ip: resolveClientIp(req, true) },
    });
    return res.status(401).json({ ok: false, error: "Chave de monitoramento inválida." });
  }
  return next();
}

app.get("/api/integration-monitor/overview", integrationMonitorAuth, async (req, res) => {
  try {
    const overview = await getExternalCrmMonitorOverview({
      from: req.query.from,
      to: req.query.to,
      status: req.query.status,
      tenantId: req.query.tenantId,
      eventType: req.query.eventType,
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return res.json({ ok: true, ...overview });
  } catch (error) {
    const unavailable = ["EXTERNAL_CRM_QUEUE_CORRUPTED", "EXTERNAL_CRM_MYSQL_QUEUE_UNAVAILABLE"].includes(error?.code);
    return res.status(unavailable ? 503 : 500).json({
      ok: false,
      health: { status: "critical", reasons: [error?.message || "Não foi possível ler a fila de integração."] },
      error: error?.message || "Não foi possível carregar o monitoramento.",
      code: error?.code || "INTEGRATION_MONITOR_ERROR",
    });
  }
});

app.get("/api/integration-monitor/events/:eventKey", integrationMonitorAuth, async (req, res) => {
  try {
    const event = await getExternalCrmEventDetail(decodeURIComponent(String(req.params.eventKey || "")));
    if (!event) return res.status(404).json({ ok: false, error: "Evento não encontrado." });
    return res.json({ ok: true, event });
  } catch (error) {
    const unavailable = ["EXTERNAL_CRM_QUEUE_CORRUPTED", "EXTERNAL_CRM_MYSQL_QUEUE_UNAVAILABLE"].includes(error?.code);
    return res.status(unavailable ? 503 : 500).json({ ok: false, error: error?.message || "Não foi possível carregar o evento.", code: error?.code || "INTEGRATION_EVENT_DETAIL_ERROR" });
  }
});

app.post("/api/integration-monitor/retry", integrationMonitorAuth, async (req, res) => {
  try {
    const eventKey = String(req.body?.eventKey || "").trim();
    const tenantId = String(req.body?.tenantId || "").trim();
    if (!eventKey && !tenantId) {
      return res.status(422).json({ ok: false, error: "Informe eventKey ou tenantId para reprocessar com segurança." });
    }
    const result = await retryExternalCrmQueue({ tenantId, eventKey });
    recordSecurityAudit({
      req,
      action: "integration_monitor_retry",
      resource: "integration_queue",
      targetTenantId: tenantId,
      outcome: result.retried ? "success" : "no_change",
      details: { tenantId, eventKey, retried: result.retried },
    });
    return res.json({ ...result, overview: await getExternalCrmMonitorOverview({ tenantId, limit: 20, offset: 0 }) });
  } catch (error) {
    const unavailable = ["EXTERNAL_CRM_QUEUE_CORRUPTED", "EXTERNAL_CRM_MYSQL_QUEUE_UNAVAILABLE"].includes(error?.code);
    return res.status(unavailable ? 503 : 500).json({ ok: false, error: error?.message || "Não foi possível reenfileirar os eventos.", code: error?.code || "INTEGRATION_RETRY_ERROR" });
  }
});

function registerExternalCrmApi(apiPrefix, authMiddleware, tenantId) {
  app.get(`${apiPrefix}/external-crm/status`, authMiddleware, async (req, res) => {
    res.json({ ok: true, ...(await getExternalCrmQueueStatus(tenantId)) });
  });

  app.get(`${apiPrefix}/external-crm/catalog`, authMiddleware, async (req, res) => {
    try {
      const catalog = await fetchExternalCrmCatalog();
      res.json({ ok: true, ...catalog, queue: (await getExternalCrmQueueStatus(tenantId)).counts });
    } catch (error) {
      res.status(error?.statusCode && error.statusCode < 500 ? error.statusCode : 502).json({
        ok: false,
        configured: (await getExternalCrmQueueStatus(tenantId)).configured,
        pipelines: [],
        error: error?.message || "Não foi possível consultar o CRM Inteligente.",
        queue: (await getExternalCrmQueueStatus(tenantId)).counts,
      });
    }
  });

  app.post(`${apiPrefix}/external-crm/retry`, authMiddleware, async (req, res) => {
    try {
      const eventKey = String(req.body?.eventKey || "").trim();
      const result = await retryExternalCrmQueue({ tenantId, eventKey });
      res.json({ ...result, queue: await getExternalCrmQueueStatus(tenantId) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error?.message || "Não foi possível reenfileirar os eventos." });
    }
  });
}


/* -------------------- Business Owner (Dono do Negócio) API -------------------- */
registerBusinessRoutes(app, {
  anyTenantAuth,
  adminAuth,
  requirePermission,
  permissions: PERMISSIONS,
  tenantAdmin: TENANT_ADMIN,
  readBusinessOwner,
  writeBusinessOwner,
  auditSecurityAction,
});

/* -------------------- Tenant UI + shared APIs -------------------- */
const frontendFeatureGate = requireFeature(FEATURES.FRONTEND_V2);
const leadPaginationFeatureGate = requireFeature(FEATURES.LEAD_PAGINATION);
const secureMediaFeatureGate = requireFeature(FEATURES.SECURE_MEDIA);
const cloudApiFeatureGate = requireFeature(FEATURES.CLOUD_API_V2);
const cloudQueueFeatureGate = requireFeature(FEATURES.CLOUD_QUEUE);

const tenantRouteServices = {
  projectRoot: __dirname,
  frontendFeatureGate,
  leadPaginationFeatureGate,
  secureMediaFeatureGate,
  buildLeadsHandler,
  buildUpdateLeadHandler,
  buildMergeLeadHandler,
  deleteLeadEverywhere,
  createManualLead,
  respondLeadServiceError,
  getLeadItemsForRequest,
  auditSecurityAction,
  toCSV,
  readCrmState,
  saveCrmStateAndQueueMessages,
  getTenantWA,
  summarizeLeadWhatsappStats,
  buildTenantInsights,
  buildConversationsRoutes,
  listTags,
  upsertTag,
  deleteTag,
  removeTagFromAllLeads,
  setLeadTags,
  buildBulkLeadTagsHandler,
  getTemplate,
  updateTemplateSafe,
  listWebhooks,
  serializeWebhook,
  createWebhook,
  updateWebhook,
  deleteWebhook,
};

const registeredRuntimeTenants = new Set();
const dynamicTenantAuthCache = new Map();

function authMiddlewareForTenant(tenantId) {
  const tid = String(tenantId || "").trim().toLowerCase();
  if (STATIC_TENANT_AUTHS[tid]) return STATIC_TENANT_AUTHS[tid];
  if (!dynamicTenantAuthCache.has(tid)) dynamicTenantAuthCache.set(tid, makeTenantAuth(tid));
  return dynamicTenantAuthCache.get(tid);
}

function registerRuntimeTenant(tenantInput) {
  const tenantId = String(tenantInput?.tenantId || tenantInput || "").trim().toLowerCase();
  if (!tenantId) throw new Error("Tenant inválido para registro de rotas.");
  refreshTenantConfigs();
  const cfg = getTenantConfig(tenantId);
  if (!cfg) throw new Error(`Tenant ${tenantId} não existe no registro.`);
  if (registeredRuntimeTenants.has(tenantId)) return { tenantId, alreadyRegistered: true };

  ensureTenantDir(tenantId);
  const authMiddleware = authMiddlewareForTenant(tenantId);
  registerTenantPanelRoutes(app, { ...tenantRouteServices, tenantId, authMiddleware });
  registerExternalCrmApi(`/api/${tenantId}`, authMiddleware, tenantId);
  registerPrivacyRoutes(`/api/${tenantId}`, authMiddleware, tenantId);
  registeredRuntimeTenants.add(tenantId);
  console.log(`➡️ Painel registrado: /${tenantId}`);
  return { tenantId, alreadyRegistered: false };
}

tenantRouteServices.onDynamicTenantCreated = async (tenant) => registerRuntimeTenant(tenant);
tenantRouteServices.onDynamicTenantUpdated = async (tenant) => registerRuntimeTenant(tenant);
tenantRouteServices.onDynamicTenantDeleted = async (tenant) => {
  const tenantId = String(tenant?.tenantId || tenant || "").trim().toLowerCase();
  try { await getTenantWA(tenantId).destroy(); } catch {}
  return { tenantId, routesRemainClosed: true };
};

for (const cfg of listTenantConfigs()) registerRuntimeTenant(cfg.tenantId);

/* -------------------- WhatsApp Cloud API (oficial) -------------------- */
// A conexão oficial é global e compartilhada. Dados operacionais (planilhas, campanhas e status)
// permanecem isolados pelo tenant autenticado. Somente super_admin pode alterar a conexão global.
const waCloudAuth = anyTenantAuth;
const waCloudSheetsReadAuth = [waCloudAuth, cloudApiFeatureGate, requirePermission(PERMISSIONS.CLOUD_SHEETS_READ)];
const waCloudSheetsWriteAuth = [waCloudAuth, cloudApiFeatureGate, requirePermission(PERMISSIONS.CLOUD_SHEETS_WRITE)];
const waCloudConnectionViewAuth = [waCloudAuth, cloudApiFeatureGate, auditDeniedAdministrativeRequest("cloud_connection.view", "wa_cloud_connection"), requireRole(ROLES.SUPER_ADMIN), requirePermission(PERMISSIONS.CLOUD_CONNECTION_VIEW)];
const waCloudConnectionManageAuth = [waCloudAuth, cloudApiFeatureGate, auditDeniedAdministrativeRequest("cloud_connection.manage", "wa_cloud_connection"), requireRole(ROLES.SUPER_ADMIN), requirePermission(PERMISSIONS.CLOUD_CONNECTION_MANAGE)];
const waCloudTemplatesReadAuth = [waCloudAuth, cloudApiFeatureGate, requirePermission(PERMISSIONS.CLOUD_TEMPLATES_READ)];
const waCloudTemplatesWriteAuth = [waCloudAuth, cloudApiFeatureGate, auditDeniedAdministrativeRequest("cloud_template.create", "wa_cloud_template"), requireRole(ROLES.SUPER_ADMIN), requirePermission(PERMISSIONS.CLOUD_TEMPLATES_WRITE)];
const waCloudCampaignAuth = [waCloudAuth, cloudApiFeatureGate, cloudQueueFeatureGate, requirePermission(PERMISSIONS.CLOUD_CAMPAIGNS_SEND)];
const waCloudStatusesAuth = [waCloudAuth, cloudApiFeatureGate, requirePermission(PERMISSIONS.CLOUD_STATUSES_READ)];
// A conexão da Cloud API continua compartilhada, mas os dados operacionais
// do disparo precisam respeitar o painel autenticado.
// Ex.: usuário Portugal usa os leads, planilhas salvas e histórico do tenant Portugal.
function getWaCloudTenantId(req) {
  const tenant = String(req?.auth?.tenantId || "").toLowerCase();
  if (!getTenantConfig(tenant) || !isTenantEnabled(tenant)) {
    const error = new Error("Contexto de tenant autenticado ausente ou inválido.");
    error.code = "AUTH_TENANT_CONTEXT_INVALID";
    throw error;
  }
  return tenant;
}

function getCloudSheetsFile(tenantId = TENANT_ADMIN) {
  const safeTenant = String(tenantId || TENANT_ADMIN).replace(/[^a-z0-9_-]/gi, "") || TENANT_ADMIN;
  return path.join(__dirname, "data", safeTenant, "wa_cloud_saved_sheets.json");
}

function readCloudSavedSheets(tenantId = TENANT_ADMIN) {
  try {
    const file = getCloudSheetsFile(tenantId);
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf8") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("[wa-cloud:sheets] read error", safeError(err));
    return [];
  }
}

function writeCloudSavedSheets(tenantId = TENANT_ADMIN, items) {
  const file = getCloudSheetsFile(tenantId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Array.isArray(items) ? items : [], null, 2), "utf8");
}

function normalizeCloudSavedSheetPayload(body = {}) {
  const now = new Date().toISOString();
  const columns = Array.isArray(body.columns) ? body.columns : [];
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const mapping = body.mapping && typeof body.mapping === "object" ? body.mapping : {};
  return {
    id: String(body.id || "").trim() || genId(),
    name: String(body.name || body.fileName || "Planilha sem nome").trim().slice(0, 140),
    fileName: String(body.fileName || "").trim().slice(0, 180),
    columns,
    rows,
    mapping,
    rowCount: rows.length,
    columnCount: columns.length,
    createdAt: String(body.createdAt || now),
    updatedAt: now,
  };
}

function cloudSavedSheetListMeta(sheet) {
  return {
    id: sheet.id,
    name: sheet.name,
    fileName: sheet.fileName,
    rowCount: Number(sheet.rowCount || (Array.isArray(sheet.rows) ? sheet.rows.length : 0)),
    columnCount: Number(sheet.columnCount || (Array.isArray(sheet.columns) ? sheet.columns.length : 0)),
    mapping: sheet.mapping || {},
    createdAt: sheet.createdAt,
    updatedAt: sheet.updatedAt,
  };
}

app.get("/api/wa-cloud/sheets", waCloudSheetsReadAuth, (req, res) => {
  const cloudTenantId = getWaCloudTenantId(req);
  const items = readCloudSavedSheets(cloudTenantId)
    .map(cloudSavedSheetListMeta)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  res.json({ ok: true, items });
});

app.get("/api/wa-cloud/sheets/:id", waCloudSheetsReadAuth, (req, res) => {
  const cloudTenantId = getWaCloudTenantId(req);
  const id = String(req.params.id || "");
  const item = readCloudSavedSheets(cloudTenantId).find((sheet) => String(sheet.id) === id);
  if (!item) return res.status(404).json({ ok: false, error: "Planilha não encontrada" });
  res.json({ ok: true, item });
});

app.post("/api/wa-cloud/sheets", waCloudSheetsWriteAuth, (req, res) => {
  try {
    const next = normalizeCloudSavedSheetPayload(req.body || {});
    if (!next.rows.length || !next.columns.length) {
      return res.status(400).json({ ok: false, error: "Envie uma planilha com linhas e colunas." });
    }
    const cloudTenantId = getWaCloudTenantId(req);
    const items = readCloudSavedSheets(cloudTenantId);
    const idx = items.findIndex((sheet) => String(sheet.id) === String(next.id));
    if (idx >= 0) {
      next.createdAt = items[idx].createdAt || next.createdAt;
      items[idx] = next;
    } else {
      items.unshift(next);
    }
    writeCloudSavedSheets(cloudTenantId, items);
    res.json({ ok: true, item: cloudSavedSheetListMeta(next) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erro ao salvar planilha" });
  }
});

app.delete("/api/wa-cloud/sheets/:id", waCloudSheetsWriteAuth, (req, res) => {
  const cloudTenantId = getWaCloudTenantId(req);
  const id = String(req.params.id || "");
  const before = readCloudSavedSheets(cloudTenantId);
  const after = before.filter((sheet) => String(sheet.id) !== id);
  writeCloudSavedSheets(cloudTenantId, after);
  res.json({ ok: true, removed: before.length - after.length });
});

app.get("/api/wa-cloud/status", waCloudConnectionViewAuth, (req, res) => {
  auditSecurityAction(req, "cloud_connection.view", "wa_cloud_connection", "success");
  res.json(getCloudStatus());
});

app.get("/api/wa-cloud/health", waCloudConnectionViewAuth, async (req, res) => {
  try {
    const health = await runCloudHealthCheck();
    auditSecurityAction(req, "cloud_connection.health", "wa_cloud_connection", health.ok ? "success" : "degraded", { status: health.status });
    res.status(health.ok ? 200 : 424).json(health);
  } catch (err) {
    const errorInfo = normalizeMetaError(err);
    auditSecurityAction(req, "cloud_connection.health", "wa_cloud_connection", "failed", { code: errorInfo.code || err?.code || "HEALTH_CHECK_FAILED" });
    res.status(424).json({ ok: false, status: "degraded", error: errorInfo });
  }
});

function isMetaTokenInvalidError(err) {
  const payload = err && err.payload;
  const metaError = payload && typeof payload === "object" ? payload.error : null;
  const code = metaError && Number(metaError.code);
  const type = String((metaError && metaError.type) || "");
  const msg = String((metaError && metaError.message) || (err && err.message) || "");

  // Meta usa code 190 para token inválido/expirado.
  if (code === 190) return true;
  if (err && err.code === "META_TOKEN_INVALID") return true;

  // Alguns retornos de OAuth vêm sem code normalizado no wrapper.
  if (/OAuthException/i.test(type) && /access token|session/i.test(msg) && /invalid|expired|logged out|expire|expirad|saiu/i.test(msg)) return true;

  // Erros de permissão, WABA incorreto ou objeto inexistente NÃO são tratados como sessão expirada.
  return false;
}

function metaTokenInvalidResponse(err) {
  return {
    ok: false,
    code: "META_TOKEN_INVALID",
    error: "A Meta recusou o token salvo. Refaça o vínculo com o Facebook/WhatsApp para gerar um novo token e carregar os modelos.",
    details: err && err.payload ? err.payload : null,
  };
}

function sendMetaTokenInvalid(res, err) {
  // Não usamos 401 aqui para não confundir com logout do painel/admin.
  // 424 = falha de dependência externa: a Meta recusou o token salvo.
  return res.status(424).json(metaTokenInvalidResponse(err));
}

app.put("/api/wa-cloud/embedded/settings", waCloudConnectionManageAuth, (req, res) => {
  try {
    const out = saveEmbeddedSignupSettings(req.body || {});
    auditSecurityAction(req, "cloud_connection.settings_update", "wa_cloud_connection", "success", { hasAppId: Boolean(req.body?.appId), hasConfigurationId: Boolean(req.body?.configurationId) });
    res.json(out);
  } catch (err) {
    auditSecurityAction(req, "cloud_connection.settings_update", "wa_cloud_connection", "failed", { code: err?.code || "VALIDATION_ERROR" });
    res.status(400).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post("/api/wa-cloud/embedded/exchange", waCloudConnectionManageAuth, async (req, res) => {
  try {
    const out = await exchangeEmbeddedSignupCode(req.body || {});
    auditSecurityAction(req, "cloud_connection.exchange", "wa_cloud_connection", "success", { replacedPreviousConnection: Boolean(out?.replacedPreviousConnection), connectionId: out?.connection?.connectionId || "" });
    res.json(out);
  } catch (err) {
    auditSecurityAction(req, "cloud_connection.exchange", "wa_cloud_connection", "failed", { code: err?.code || "META_EXCHANGE_ERROR" });
    if (isMetaTokenInvalidError(err)) return sendMetaTokenInvalid(res, err);
    const status = Number(err?.status || 400);
    res.status(status >= 400 && status < 600 ? status : 400).json({
      ok: false,
      code: err?.code || err?.payload?.code || undefined,
      error: err?.message || String(err),
      details: err?.payload || null,
    });
  }
});

app.delete("/api/wa-cloud/embedded", waCloudConnectionManageAuth, (req, res) => {
  try {
    const out = disconnectCloudApi();
    auditSecurityAction(req, "cloud_connection.disconnect", "wa_cloud_connection", "success", { connectionId: out?.connectionId || "" });
    res.json(out);
  } catch (err) {
    auditSecurityAction(req, "cloud_connection.disconnect", "wa_cloud_connection", "failed", { code: err?.code || "DISCONNECT_ERROR" });
    res.status(400).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get("/api/wa-cloud/templates", waCloudTemplatesReadAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query?.limit || 1000), 25), 2000);
    const out = await listCloudTemplates({ limit });
    res.json(out);
  } catch (err) {
    if (isMetaTokenInvalidError(err)) {
      return sendMetaTokenInvalid(res, err);
    }
    const status = Number(err?.status || 400);
    res.status(status >= 400 && status < 600 ? status : 400).json({
      ok: false,
      code: err?.code || err?.payload?.code || undefined,
      error: err?.message || String(err),
      details: err?.payload || null,
    });
  }
});

app.get("/api/wa-cloud/template-library", waCloudTemplatesReadAuth, async (req, res) => {
  try {
    const out = await listCloudTemplateLibrary({
      language: String(req.query?.language || "pt_BR"),
      search: String(req.query?.search || ""),
      topic: String(req.query?.topic || ""),
      usecase: String(req.query?.usecase || ""),
      industry: String(req.query?.industry || ""),
      limit: Math.min(Math.max(Number(req.query?.limit || 300), 25), 1000),
    });
    res.json(out);
  } catch (err) {
    if (isMetaTokenInvalidError(err)) {
      return sendMetaTokenInvalid(res, err);
    }
    const status = Number(err?.status || 400);
    res.status(status >= 400 && status < 600 ? status : 400).json({
      ok: false,
      code: err?.code || err?.payload?.code || undefined,
      error: err?.message || String(err),
      details: err?.payload || null,
    });
  }
});

app.post("/api/wa-cloud/templates", waCloudTemplatesWriteAuth, async (req, res) => {
  try {
    if (!isCloudApiConfigured()) throw new Error("WA_CLOUD não configurado.");
    const out = await createCloudTemplate(req.body || {});
    auditSecurityAction(req, "cloud_template.create", "wa_cloud_template", "success", { templateName: String(req.body?.name || req.body?.templateName || "").slice(0, 80) });
    res.json({ ok: true, ...out });
  } catch (err) {
    auditSecurityAction(req, "cloud_template.create", "wa_cloud_template", "failed", { code: err?.code || "TEMPLATE_CREATE_ERROR" });
    if (isMetaTokenInvalidError(err)) return sendMetaTokenInvalid(res, err);
    const status = Number(err?.status || 400);
    res.status(status >= 400 && status < 600 ? status : 400).json({
      ok: false,
      code: err?.code || err?.payload?.code || undefined,
      error: err?.message || String(err),
      details: err?.payload || null,
    });
  }
});

function clampWaCloudThrottleMs(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(0, Math.min(Number(fallback || 0), 600000));
  return Math.max(0, Math.min(Math.round(n), 600000));
}

function normalizeWaCloudThrottle(body = {}) {
  const legacy = clampWaCloudThrottleMs(body.throttleMs, 250);
  let minMs = body.throttleMinMs == null ? legacy : clampWaCloudThrottleMs(body.throttleMinMs, legacy);
  let maxMs = body.throttleMaxMs == null ? minMs : clampWaCloudThrottleMs(body.throttleMaxMs, minMs);
  if (maxMs < minMs) {
    const tmp = minMs;
    minMs = maxMs;
    maxMs = tmp;
  }
  return {
    minMs,
    maxMs,
    mode: maxMs > minMs ? "random" : "fixed",
  };
}

function nextWaCloudThrottleDelay(range) {
  const minMs = clampWaCloudThrottleMs(range?.minMs, 0);
  const maxMs = clampWaCloudThrottleMs(range?.maxMs, minMs);
  if (!maxMs) return 0;
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

const cloudCampaignQueue = new PersistentJobQueue({
  file: path.join(dataRoot(), 'wa_cloud_jobs.json'),
  pollIntervalMs: Number(process.env.WA_CLOUD_QUEUE_POLL_MS || 250),
  maxAttempts: Number(process.env.WA_CLOUD_QUEUE_MAX_ATTEMPTS || 5),
  baseDelayMs: Number(process.env.WA_CLOUD_QUEUE_RETRY_BASE_MS || 1000),
  maxDelayMs: Number(process.env.WA_CLOUD_QUEUE_RETRY_MAX_MS || 60000),
  handler: async (job) => {
    const payload = job.payload || {};
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!payload.campaignId || !items.length) {
      return { retryable: true, itemKey: 'bootstrap', error: { code: 'JOB_NOT_READY', message: 'Campanha ainda está sendo preparada.' } };
    }
    if (job.cursor >= items.length) {
      updateCloudDispatchCampaign(payload.campaignId, { state: job.progress.failed > 0 ? 'completed_with_errors' : 'completed', progress: job.progress, jobId: job.id });
      return { done: true, patch: { progress: { ...job.progress, pending: 0 } } };
    }
    const item = items[job.cursor];
    const components = item.vars.length
      ? [{ type: 'body', parameters: item.vars.map((text) => ({ type: 'text', text })) }]
      : [];
    try {
      updateCloudDispatchEvent(item.eventId, { status: 'submitted' }, { source: 'queue_worker', providerStatus: 'submitted' });
      const out = await sendCloudTemplate({
        toE164Digits: item.to,
        templateName: payload.templateName,
        languageCode: payload.languageCode,
        components,
        meta: { tenantId: job.tenantId, campaignId: payload.campaignId, dispatchEventId: item.eventId, jobId: job.id },
      });
      const messageId = out?.messages?.[0]?.id || null;
      updateCloudDispatchEvent(item.eventId, { messageId }, { source: 'meta_api', providerStatus: 'accepted' });
      try {
        const lead = findLeadByWhatsappIntake(job.tenantId, item.to);
        if (lead) await enqueueExternalCrmConversationEvent({ tenantId: job.tenantId, lead, direction: 'outbound', messageId, conversationId: item.to, occurredAt: new Date().toISOString(), channel: 'whatsapp_cloud', preview: `[Template] ${payload.templateName}`, metadata: { campaignId: payload.campaignId, templateName: payload.templateName } });
      } catch (syncError) {
        console.error('[CLOUD][CRM_SYNC] Falha ao registrar mensagem enviada:', syncError?.message || String(syncError));
      }
      const processed = Number(job.progress.processed || 0) + 1;
      const progress = { ...job.progress, processed, sent: Number(job.progress.sent || 0) + 1, pending: Math.max(0, job.progress.total - processed) };
      const nextCursor = job.cursor + 1;
      const done = nextCursor >= items.length;
      updateCloudDispatchCampaign(payload.campaignId, { state: done ? (progress.failed ? 'completed_with_errors' : 'completed') : 'running', progress, jobId: job.id });
      return { done, delayMs: nextWaCloudThrottleDelay(payload.throttleRange), patch: { cursor: nextCursor, progress } };
    } catch (err) {
      const errorInfo = normalizeMetaError(err);
      const retryable = Boolean(errorInfo.retryable);
      const attemptsForItem = Number(job.itemAttempts[String(job.cursor)] || 0) + 1;
      if (retryable && attemptsForItem < job.maxAttempts) {
        updateCloudDispatchCampaign(payload.campaignId, { state: 'queued', progress: job.progress, jobId: job.id });
        return { retryable: true, itemKey: String(job.cursor), error: { code: errorInfo.code || err.code || 'META_TRANSIENT_ERROR', message: errorInfo.display || err.message || 'Falha temporária' } };
      }
      updateCloudDispatchEvent(item.eventId, { status: 'failed', failedAt: new Date().toISOString(), error: err?.payload || err?.message || String(err), errorInfo });
      const processed = Number(job.progress.processed || 0) + 1;
      const progress = { ...job.progress, processed, failed: Number(job.progress.failed || 0) + 1, pending: Math.max(0, job.progress.total - processed) };
      const nextCursor = job.cursor + 1;
      const done = nextCursor >= items.length;
      updateCloudDispatchCampaign(payload.campaignId, { state: done ? 'completed_with_errors' : 'running', progress, jobId: job.id });
      return { done, delayMs: nextWaCloudThrottleDelay(payload.throttleRange), patch: { cursor: nextCursor, progress, errors: [...(job.errors || []).slice(-49), { code: errorInfo.code || err.code || 'META_SEND_FAILED', message: errorInfo.display || err.message || 'Falha permanente', at: new Date().toISOString(), itemKey: String(job.cursor) }] } };
    }
  },
});

function publicCloudJob(job) {
  if (!job) return null;
  const payload = job.payload || {};
  const campaignEvents = payload.campaignId
    ? listCloudDispatchEvents(job.tenantId).filter((event) => event.campaignId === payload.campaignId)
    : [];
  const progress = { ...(job.progress || {}) };
  if (campaignEvents.length) {
    progress.sent = campaignEvents.filter((event) => ['submitted', 'sent', 'delivered', 'read', 'replied'].includes(event.status)).length;
    progress.delivered = campaignEvents.filter((event) => ['delivered', 'read', 'replied'].includes(event.status)).length;
    progress.read = campaignEvents.filter((event) => ['read', 'replied'].includes(event.status)).length;
    progress.responded = campaignEvents.filter((event) => event.status === 'replied').length;
    progress.failed = campaignEvents.filter((event) => event.status === 'failed').length;
  }
  return {
    id: job.id, tenantId: job.tenantId, type: job.type, state: job.state,
    campaignId: payload.campaignId || '', campaignName: payload.campaignName || '',
    templateName: payload.templateName || '', progress,
    attempts: job.attempts, maxAttempts: job.maxAttempts, cursor: job.cursor,
    nextRunAt: job.nextRunAt, createdAt: job.createdAt, startedAt: job.startedAt,
    updatedAt: job.updatedAt, completedAt: job.completedAt,
    errors: Array.isArray(job.errors) ? job.errors.slice(-10) : [],
  };
}

app.post('/api/wa-cloud/send-template-batch', waCloudCampaignAuth, async (req, res) => {
  let reservedJob = null;
  let reservedTenantId = '';
  let reservedCampaignId = '';
  try {
    if (!isCloudApiConfigured()) throw new Error('WA_CLOUD não configurado.');
    const templateName = String(req.body?.templateName || '').trim();
    const languageCode = String(req.body?.languageCode || 'pt_BR').trim();
    const contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
    const throttleRange = normalizeWaCloudThrottle(req.body || {});
    const campaignName = String(req.body?.campaignName || templateName || 'Campanha oficial').trim();
    const cloudTenantId = getWaCloudTenantId(req);
    const cloudConnection = connectionFromRuntimeConfig(getWaCloudRuntimeConfig());
    if (!cloudConnection.connectionId || !cloudConnection.phoneNumberId || !cloudConnection.wabaId) throw Object.assign(new Error('A conexão da Cloud API está incompleta.'), { code: 'META_CONNECTION_INCOMPLETE' });
    if (!templateName) throw new Error('templateName obrigatório.');
    if (!contacts.length) throw new Error('contacts vazio.');
    const maxCampaignContacts = Math.max(1, Math.min(Number(process.env.WA_CLOUD_CAMPAIGN_MAX_CONTACTS) || 10000, 100000));
    if (contacts.length > maxCampaignContacts) return res.status(413).json({ ok: false, code: 'CAMPAIGN_TOO_LARGE', error: 'Campanha acima do limite permitido.' });

    const preparedContacts = contacts.map((c) => ({
      to: String(c?.to || '').replace(/\D+/g, ''),
      vars: Array.isArray(c?.vars) ? c.vars.map((x) => String(x ?? '')) : [],
      nome: String(c?.nome || ''), companyName: String(c?.companyName || ''), email: String(c?.email || ''),
      source: String(c?.source || ''), spreadsheetName: String(c?.spreadsheetName || ''),
    })).filter((c) => c.to);
    if (!preparedContacts.length) throw new Error('Nenhum contato válido.');

    const requestPayload = { templateName, languageCode, campaignName, throttleRange, contacts: preparedContacts };
    const suppliedKey = String(req.get('Idempotency-Key') || req.body?.idempotencyKey || '').trim();
    const idempotencyKey = suppliedKey || crypto.createHash('sha256').update(JSON.stringify(requestPayload)).digest('hex');
    const enqueued = cloudCampaignQueue.enqueue({ tenantId: cloudTenantId, type: 'wa_cloud_campaign', payload: requestPayload, idempotencyKey, progress: { total: preparedContacts.length } });
    reservedTenantId = cloudTenantId;
    if (enqueued.created) reservedJob = enqueued.job;
    if (!enqueued.created) return res.status(202).json({ ok: true, duplicate: true, job: publicCloudJob(enqueued.job) });

    const webhookLookup = buildWebhookLookup(listWebhooks(cloudTenantId), req);
    const sourceSummary = {};
    for (const c of preparedContacts) { const src = dispatchSourceInfo(c).label || 'Contato do disparo'; sourceSummary[src] = (sourceSummary[src] || 0) + 1; }
    const campaign = createCloudDispatchCampaign({
      tenantId: cloudTenantId, connectionId: cloudConnection.connectionId, phoneNumberId: cloudConnection.phoneNumberId,
      wabaId: cloudConnection.wabaId, name: campaignName, templateName, languageCode,
      total: preparedContacts.length, sourceSummary, jobId: enqueued.job.id, state: 'queued', progress: enqueued.job.progress,
    });
    reservedCampaignId = campaign.id;
    const items = preparedContacts.map((c) => {
      const lead = findLeadByDigits(cloudTenantId, c.to);
      const origin = lead ? leadOriginInfo(lead, webhookLookup) : dispatchSourceInfo(c);
      const event = recordCloudDispatchEvent({
        tenantId: cloudTenantId, connectionId: cloudConnection.connectionId, phoneNumberId: cloudConnection.phoneNumberId,
        wabaId: cloudConnection.wabaId, campaignId: campaign.id, campaignName: campaign.name, templateName, languageCode,
        recipientId: c.to, toDigits: c.to, leadId: lead ? lead.id : '',
        leadSnapshot: lead ? { id: lead.id, nome: lead.nome || '', empresa: lead.empresa || '', email: lead.email || '', source: lead.source || '' } : { nome: c.nome, empresa: c.companyName, email: c.email },
        origin, dispatchSource: dispatchSourceInfo(c), vars: c.vars, status: 'queued',
      });
      return { to: c.to, vars: c.vars, eventId: event.id };
    });
    const ready = cloudCampaignQueue.mutate(enqueued.job.id, cloudTenantId, (job) => ({ ...job, payload: { campaignId: campaign.id, campaignName, templateName, languageCode, throttleRange, items }, nextRunAt: new Date().toISOString() }));
    auditSecurityAction(req, 'cloud_campaign.create', 'wa_cloud_campaign', 'success', { campaignId: campaign.id, jobId: ready.id, tenantId: cloudTenantId, total: items.length });
    return res.status(202).json({ ok: true, duplicate: false, job: publicCloudJob(ready) });
  } catch (err) {
    if (reservedJob && reservedTenantId) {
      cloudCampaignQueue.fail(reservedJob.id, reservedTenantId, { code: err?.code || 'CAMPAIGN_PREPARATION_FAILED', message: err?.message || 'Falha ao preparar campanha.' });
      if (reservedCampaignId) updateCloudDispatchCampaign(reservedCampaignId, { state: 'failed', jobId: reservedJob.id });
    }
    if (err instanceof QueueError) return res.status(err.status || 400).json({ ok: false, code: err.code, error: err.message });
    if (isMetaTokenInvalidError(err)) return sendMetaTokenInvalid(res, err);
    return res.status(Number(err?.status || 400)).json({ ok: false, code: err?.code, error: err?.message || String(err), errorInfo: normalizeMetaError(err) });
  }
});

app.get('/api/wa-cloud/jobs', waCloudCampaignAuth, (req, res) => {
  const tenantId = getWaCloudTenantId(req);
  res.json({ ok: true, jobs: cloudCampaignQueue.list(tenantId, req.query?.limit).map(publicCloudJob) });
});
app.get('/api/wa-cloud/jobs-health', waCloudCampaignAuth, (req, res) => {
  const tenantId = getWaCloudTenantId(req);
  res.json({ ok: true, queue: cloudCampaignQueue.stats(tenantId) });
});
app.get('/api/wa-cloud/jobs/:jobId', waCloudCampaignAuth, (req, res) => {
  const job = cloudCampaignQueue.get(req.params.jobId, getWaCloudTenantId(req));
  if (!job) return res.status(404).json({ ok: false, code: 'JOB_NOT_FOUND', error: 'Job não encontrado.' });
  res.json({ ok: true, job: publicCloudJob(job) });
});
for (const [action, method] of [['pause','pause'], ['resume','resume'], ['cancel','cancel']]) {
  app.post(`/api/wa-cloud/jobs/:jobId/${action}`, waCloudCampaignAuth, (req, res) => {
    const tenantId = getWaCloudTenantId(req);
    const job = cloudCampaignQueue[method](req.params.jobId, tenantId);
    if (!job) return res.status(404).json({ ok: false, code: 'JOB_NOT_FOUND', error: 'Job não encontrado.' });
    if (job.payload?.campaignId) updateCloudDispatchCampaign(job.payload.campaignId, { state: job.state, progress: job.progress, jobId: job.id });
    if (action === 'cancel' && Array.isArray(job.payload?.items)) {
      for (const item of job.payload.items.slice(Number(job.cancelAfterCursor ?? job.cursor ?? 0))) {
        updateCloudDispatchEvent(item.eventId, { status: 'canceled' }, { source: 'queue_control', providerStatus: 'canceled' });
      }
    }
    auditSecurityAction(req, `cloud_campaign.${action}`, 'wa_cloud_job', 'success', { jobId: job.id, campaignId: job.payload?.campaignId || '', tenantId });
    res.json({ ok: true, job: publicCloudJob(job) });
  });
}


function listCloudStatusesForTenant(tenantId, { includeLegacy = false } = {}) {
  const tid = String(tenantId || "").toLowerCase();
  const events = listCloudDispatchEvents(tid);
  const items = events.map((event) => ({
    id: event.id,
    tenantId: tid,
    campaignId: event.campaignId || "",
    toDigits: event.toDigits || "",
    connectionId: event.connectionId || "",
    phoneNumberId: event.phoneNumberId || "",
    wabaId: event.wabaId || "",
    dispatchId: event.dispatchId || event.id,
    recipientId: event.recipientId || event.toDigits || "",
    messageId: event.messageId || null,
    conversationId: event.conversationId || null,
    state: normalizeDispatchFinalStatus(event),
    status: normalizeDispatchFinalStatus(event),
    sentAt: event.sentAt || null,
    deliveredAt: event.deliveredAt || null,
    readAt: event.readAt || null,
    repliedAt: event.repliedAt || event.respondedAt || null,
    failedAt: event.failedAt || null,
    errorInfo: event.errorInfo || null,
    statusHistory: Array.isArray(event.statusHistory) ? event.statusHistory : [],
    updatedAt: event.updatedAt || event.createdAt || null,
  }));

  // Legado global só pode ser visto pelo super_admin e continua identificado como legado.
  if (tid === TENANT_ADMIN && includeLegacy) {
    const knownMessageIds = new Set(items.map((item) => String(item.messageId || "")).filter(Boolean));
    for (const status of listCloudStatus()) {
      const messageId = String(status?.messageId || "");
      if (messageId && knownMessageIds.has(messageId)) continue;
      items.push({ ...status, tenantId: TENANT_ADMIN, legacy: true });
    }
  }

  return items.sort((a, b) => String(b.updatedAt || b.sentAt || "").localeCompare(String(a.updatedAt || a.sentAt || "")));
}

app.get("/api/wa-cloud/statuses", waCloudStatusesAuth, (req, res) => {
  const tenantId = getWaCloudTenantId(req);
  const items = listCloudStatusesForTenant(tenantId, { includeLegacy: false });
  res.json({ total: items.length, tenantId, items });
});

const cloudWebhookFeatureGate = requireFeature(FEATURES.CLOUD_API_V2, { tenantResolver: () => process.env.WA_CLOUD_CONNECTION_OWNER_TENANT || TENANT_ADMIN });

app.get("/webhooks/wa-cloud", cloudWebhookFeatureGate, (req, res) => {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  const expected = String(process.env.WA_CLOUD_WEBHOOK_VERIFY_TOKEN || "").trim();

  if (mode === "subscribe" && expected && timingSafeEqualText(token, expected)) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhooks/wa-cloud", cloudWebhookFeatureGate, async (req, res) => {
  if (!requireSupportedBody(req, res)) return;
  if (!enforceRateLimit({
    req,
    res,
    limiter: publicEndpointRateLimiter,
    scope: "meta-webhook",
    identity: publicEndpointIdentity(req),
    max: META_WEBHOOK_RATE_MAX,
    windowMs: PUBLIC_RATE_WINDOW_MS,
  })) return;

  const rawBody = getRawBody(req);
  let runtimeConfig;
  try {
    runtimeConfig = getWaCloudRuntimeConfig();
  } catch (error) {
    logErr("Falha ao carregar configuração runtime da Meta:", safeError(error));
    return respondSecurityError(res, 503, "META_CONFIGURATION_UNAVAILABLE", "Webhook da Meta indisponível.");
  }
  const appSecret = String(runtimeConfig.appSecret || "").trim();
  if (!appSecret) {
    return respondSecurityError(res, 503, "META_APP_SECRET_MISSING", "Webhook da Meta indisponível.");
  }
  if (!validateMetaSignature(rawBody, req.get("x-hub-signature-256"), appSecret)) {
    return respondSecurityError(res, 401, "META_SIGNATURE_INVALID", "Assinatura da Meta inválida.");
  }

  let body;
  try {
    body = validateMetaWebhookPayload(parseJsonBuffer(rawBody));
  } catch (error) {
    return handlePublicEndpointError(res, error, "INVALID_META_PAYLOAD");
  }

  let cloudConnection;
  try {
    cloudConnection = assertWebhookMatchesConnection(body, runtimeConfig);
  } catch (error) {
    return respondSecurityError(res, Number(error?.status || 403), error?.code || "META_CONNECTION_MISMATCH", "Evento da Meta não pertence à conexão configurada.");
  }

  const phoneNumberId = cloudConnection.phoneNumberId;
  const eventId = deriveMetaEventKey(body, rawBody);
  let claim = null;
  try {
    claim = claimWebhookEvent({ integration: "meta", tenantId: cloudConnection.connectionId, eventId, requestHash: securitySha256(rawBody) });
    if (!claim.claimed) return res.sendStatus(claim.pending ? 202 : 200);

    const correlation = await syncCloudDispatchFromWebhook(body, cloudConnection, eventId);
    completeWebhookEventRequired({
      integration: "meta",
      tenantId: cloudConnection.connectionId,
      eventId,
      statusCode: 200,
      responseBody: { ok: true, correlation },
    });
    return res.sendStatus(200);
  } catch (error) {
    console.error("⚠️ WA_CLOUD webhook processing error:", safeError(error));
    const statusCode = Number(error?.statusCode || 500);
    const safeStatus = statusCode >= 500 && statusCode < 600 ? statusCode : 500;
    if (claim?.claimed && error?.code !== "WEBHOOK_IDEMPOTENCY_UNAVAILABLE") {
      completeWebhookEventBestEffort({
        integration: "meta",
        tenantId: cloudConnection?.connectionId || phoneNumberId,
        eventId,
        statusCode: safeStatus,
        responseBody: { ok: false, error: "processing_failed" },
      });
    }
    return respondSecurityError(res, safeStatus, error?.code || "META_PROCESSING_FAILED", "Não foi possível processar o evento da Meta.");
  }
});

/* -------------------- data migration (safe) -------------------- */
async function migrateLegacyData() {
  try {
    const legacyDir = path.join(__dirname, "data");
    const legacyLeads = path.join(legacyDir, "leads.jsonl");
    const legacyTags = path.join(legacyDir, "tags.json");
    const legacyLeadTags = path.join(legacyDir, "lead_tags.json");
    const legacyStatus = path.join(legacyDir, "message_status.json");

    const adminDir = path.join(legacyDir, TENANT_ADMIN);
    if (!fs.existsSync(adminDir)) fs.mkdirSync(adminDir, { recursive: true });

    const moves = [
      [legacyLeads, path.join(adminDir, "leads.jsonl")],
      [legacyTags, path.join(adminDir, "tags.json")],
      [legacyLeadTags, path.join(adminDir, "lead_tags.json")],
      [legacyStatus, path.join(adminDir, "message_status.json")],
    ];

    for (const [from, to] of moves) {
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        // copy (não remove): sem risco em prod
        fs.copyFileSync(from, to);
        console.log("🧱 Legacy copy ->", to);
      }
    }
  } catch (e) {
    console.error("⚠️ migrateLegacyData falhou:", e?.message || e);
  }
}


/* -------------------- WhatsApp auto-start on boot -------------------- */
function truthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function falseyEnv(value) {
  return ["0", "false", "no", "off"].includes(String(value || "").trim().toLowerCase());
}

function hasExistingWhatsAppSession(tenantId) {
  return inspectTenantSession(tenantId).authenticationExists;
}

function tenantHasLoginConfigured(tenantId) {
  const t = String(tenantId || "").trim().toLowerCase();
  const cfg = getTenantConfig(t);
  if (!cfg || !isTenantEnabled(t)) return false;
  if (cfg.credentialSource === "dynamic") return true;
  return Boolean(String(process.env[cfg.userEnv] || "").trim() && String(process.env[cfg.passEnv] || "").trim());
}

function getWhatsAppAutoStartTenants() {
  const allowed = listTenantConfigs({ includeDisabled: false }).map((cfg) => cfg.tenantId);
  const explicit = String(process.env.WEBJS_AUTO_START_TENANTS || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  if (explicit.length) {
    return [...new Set(explicit.filter((tenant) => allowed.includes(tenant)))];
  }

  // Comportamento seguro por padrão: somente sessões já existentes sobem sozinhas.
  // Painéis novos ficam desconectados até o usuário clicar em Conectar e gerar o primeiro QR.
  return allowed.filter((tenantId) => hasExistingWhatsAppSession(tenantId));
}

function startWhatsAppClientsInBackground() {
  if (!isWhatsAppConfigured()) {
    console.log("ℹ️ WhatsApp WebJS não iniciado automaticamente: WEBJS_ENABLED!=1.");
    return;
  }

  const autoStart = String(process.env.WEBJS_AUTO_START || "").trim();
  if (falseyEnv(autoStart)) {
    console.log("ℹ️ WhatsApp WebJS auto-start desativado por WEBJS_AUTO_START=0.");
    return;
  }

  const tenants = getWhatsAppAutoStartTenants();
  if (!tenants.length) {
    console.log("ℹ️ Nenhuma sessão local do WhatsApp encontrada para auto-start. Use Conectar uma vez pelo painel.");
    return;
  }

  console.log(`🔄 Iniciando WhatsApp automaticamente para: ${tenants.join(", ")}`);

  tenants.forEach((tenantId, index) => {
    // Sobe com pequeno intervalo para não abrir vários Chromiums exatamente no mesmo instante.
    setTimeout(() => {
      getTenantWA(tenantId)
        .initWhatsApp()
        .then(() => console.log(`✅ WhatsApp auto-start disparado: ${tenantId}`))
        .catch((err) => console.error(`❌ Falha no auto-start do WhatsApp (${tenantId}):`, err?.message || err));
    }, index * 2500);
  });
}

let shutdownStarted = false;
let httpServer = null;
let monitorTimer = null;

function operationalWhatsAppStatus() {
  if (!isWhatsAppConfigured()) return { ok: null, disabled: true };
  const tenants = listTenantConfigs({ includeDisabled: false }).map((cfg) => cfg.tenantId).filter(tenantHasLoginConfigured);
  const statuses = tenants.map((tenantId) => getTenantWA(tenantId).getWhatsAppStatus());
  return { ok: statuses.length ? statuses.every((row) => row.status === "connected") : null, tenants: statuses.map((row) => ({ tenantId: row.tenantId, status: row.status, hasError: Boolean(row.lastError) })) };
}
function operationalCloudStatus() {
  if (!securityEnvBool(process.env.WA_CLOUD_ENABLED, false)) return { ok: null, disabled: true };
  try { const status = getCloudStatus(); return { ok: Boolean(status?.configured || status?.connected || status?.enabled), state: status?.status || status?.state || "unknown" }; } catch { return { ok: false }; }
}

async function runOperationalMonitor() {
  try {
    const snapshot = await collectSystemSnapshot({ databaseHealth: () => databaseRuntime.health(), whatsappStatus: operationalWhatsAppStatus, cloudStatus: operationalCloudStatus, metrics: defaultMetrics });
    defaultMetrics.set("zape_disk_used_percent", {}, snapshot.disk.usedPercent);
    defaultMetrics.set("zape_queue_pending", {}, snapshot.queue.pending);
    defaultMetrics.set("zape_queue_failed", {}, snapshot.queue.failed);
    await evaluateSystemAlerts(snapshot, alertManager);
  } catch (error) {
    structuredLogger.error("Falha no monitor operacional.", { event: "monitor.failed", error });
  }
}

function closeHttpServer(timeoutMs = 30000) {
  if (!httpServer) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    httpServer.close(() => {
      clearTimeout(timer);
      done();
    });
    httpServer.closeIdleConnections?.();
  });
}

async function gracefulShutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;

  console.log(`🛑 Recebido ${signal}. Interrompendo novas conexões e encerrando serviços com segurança...`);
  try {
    stopExternalCrmWorker();
    automaticMessageQueue.stop();
    cloudCampaignQueue.stop();
    if (monitorTimer) clearInterval(monitorTimer);
    await Promise.allSettled([
      closeHttpServer(),
      destroyCachedWhatsAppClients(),
      databaseRuntime.close(),
    ]);
  } catch (err) {
    console.error("⚠️ Falha no encerramento controlado:", err?.message || err);
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("message", (message) => {
  if (message === "shutdown") gracefulShutdown("PM2_SHUTDOWN");
});

function privacySource() {
  const state = databaseRuntime.getState();
  return databaseRuntime.isDatabasePrimary() && state.db ? { type: "database", db: state.db } : { type: "json" };
}

function registerPrivacyRoutes(prefix, authMw, tenantId) {
  app.get(`${prefix}/privacy/contact`, authMw, requirePermission(PERMISSIONS.PRIVACY_MANAGE), async (req, res) => {
    const phone = String(req.query?.phone || "").trim();
    if (!phone) return res.status(400).json({ ok: false, code: "PHONE_REQUIRED", error: "Telefone obrigatório." });
    try {
      const source = privacySource();
      const data = source.type === "database"
        ? await exportDatabaseContact({ db: source.db, tenantId, phone })
        : exportJsonContact({ tenantId, phone });
      auditSecurityAction(req, "privacy.export", "contact", "success", { contactRef: data.contactRef, leadCount: data.leads?.length || 0 });
      structuredLogger.security("Exportação LGPD realizada.", { event: "privacy.export", correlationId: req.correlationId, operationId: req.operationId, tenantId, contactRef: data.contactRef });
      res.setHeader("Cache-Control", "no-store");
      return res.json({ ok: true, data });
    } catch (error) {
      auditSecurityAction(req, "privacy.export", "contact", "failed", { code: error.code || "PRIVACY_EXPORT_FAILED" });
      return res.status(error.code === "INVALID_PHONE" ? 400 : 500).json({ ok: false, code: error.code || "PRIVACY_EXPORT_FAILED", error: "Não foi possível exportar os dados." });
    }
  });
  app.post(`${prefix}/privacy/contact/delete`, authMw, requirePermission(PERMISSIONS.PRIVACY_MANAGE), async (req, res) => {
    const phone = String(req.body?.phone || "").trim();
    const confirmation = String(req.body?.confirmation || "").trim();
    const apply = req.body?.apply === true;
    if (!phone) return res.status(400).json({ ok: false, code: "PHONE_REQUIRED", error: "Telefone obrigatório." });
    if (apply && confirmation !== "DELETE_CONTACT_DATA") return res.status(400).json({ ok: false, code: "CONFIRMATION_REQUIRED", error: "Confirmação inválida." });
    try {
      const source = privacySource();
      const backupDir = path.join(dataRoot(), "quarantine", `lgpd-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
      const result = source.type === "database"
        ? await deleteDatabaseContact({ db: source.db, tenantId, phone, apply })
        : deleteJsonContact({ tenantId, phone, apply, backupDir });
      auditSecurityAction(req, "privacy.delete", "contact", apply ? "success" : "dry_run", { contactRef: result.contactRef, counts: result.counts });
      structuredLogger.security(apply ? "Exclusão LGPD aplicada." : "Exclusão LGPD simulada.", { event: apply ? "privacy.delete.applied" : "privacy.delete.dry_run", correlationId: req.correlationId, operationId: req.operationId, tenantId, contactRef: result.contactRef, counts: result.counts });
      return res.json({ ok: true, mode: apply ? "apply" : "dry-run", result });
    } catch (error) {
      auditSecurityAction(req, "privacy.delete", "contact", "failed", { code: error.code || "PRIVACY_DELETE_FAILED" });
      return res.status(error.code === "INVALID_PHONE" ? 400 : 500).json({ ok: false, code: error.code || "PRIVACY_DELETE_FAILED", error: "Não foi possível processar a exclusão." });
    }
  });
}


registerAdminMonitoringRoutes(app, {
  adminAuth,
  requireRole,
  requirePermission,
  roles: ROLES,
  permissions: PERMISSIONS,
  collectSystemSnapshot,
  databaseRuntime,
  operationalWhatsAppStatus,
  operationalCloudStatus,
  metrics: defaultMetrics,
  alertManager,
  auditSecurityAction,
});

registerAdminDeploymentRoutes(app, {
  adminAuth,
  requireRole,
  requirePermission,
  roles: ROLES,
  permissions: PERMISSIONS,
  releaseMetadata,
  featureSnapshot,
  auditSecurityAction,
});

// global error handler
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  req.webhookTransportDiagnostic?.fail(err, {
    errorType: err?.type || "",
    errorCode: err?.code || "",
    errorStatus: err?.status || err?.statusCode || 0,
  });
  if (err?.type === "entity.too.large" || err?.status === 413) {
    return respondSecurityError(res, 413, "PAYLOAD_TOO_LARGE", "Payload acima do limite permitido.");
  }
  if (err?.type === "entity.parse.failed" || (err instanceof SyntaxError && err?.status === 400)) {
    return respondSecurityError(res, 400, "INVALID_BODY", "Payload malformado.");
  }
  if (err?.status === 415 || err?.type === "charset.unsupported") {
    return respondSecurityError(res, 415, "UNSUPPORTED_CONTENT_TYPE", "Formato de conteúdo não suportado.");
  }
  if (err?.code === "WEBHOOK_IDEMPOTENCY_CORRUPT") {
    return respondSecurityError(res, 503, "WEBHOOK_IDEMPOTENCY_UNAVAILABLE", "Endpoint temporariamente indisponível.");
  }
  logErr("Unhandled error:", safeError(err));
  return res.status(500).json({ ok: false, error: "internal_error" });
});

/* -------------------- start -------------------- */
async function startApplication() {
  try {
    await databaseRuntime.initializeDatabaseRuntime();
    if (!databaseRuntime.isDatabasePrimary()) await migrateLegacyData();
  } catch (error) {
    console.error("❌ Inicialização da persistência bloqueou o boot:", error?.code || error?.message || "DATABASE_BOOT_FAILED");
    process.exitCode = 1;
    return;
  }

  const validateOnBoot = !["0", "false", "no", "off"].includes(String(process.env.DATA_INTEGRITY_VALIDATE_ON_BOOT || "1").trim().toLowerCase());
  if (validateOnBoot && !databaseRuntime.isDatabasePrimary()) {
    try {
      const integrity = validateDataIntegrityOnBoot(dataRoot(), {
        strict: ["1", "true", "yes", "on"].includes(String(process.env.DATA_INTEGRITY_STRICT_BOOT || "0").trim().toLowerCase()),
      });
      const issueCount = integrity.tenants.reduce((sum, tenant) => sum + tenant.issues.length, 0);
      console.log(`🧭 Integridade dos dados validada: tenants=${integrity.tenants.length}, issues=${issueCount}`);
    } catch (error) {
      console.error("❌ Validação de integridade dos dados bloqueou o boot:", error?.code || "DATA_INTEGRITY_BOOT_FAILED");
      process.exitCode = 1;
      return;
    }
  }

  if (String(process.env.BOBCRM_REVERSE_INTEGRATION_KEY || '').trim()) {
    try {
      await initializeBobCrmReverseSync();
      console.log('🔄 Sincronização BobCRM → Zape pronta.');
    } catch (error) {
      const requireReverseSyncMysql = !['0','false','no','off'].includes(String(process.env.BOBCRM_REVERSE_SYNC_REQUIRE_MYSQL || '1').trim().toLowerCase());
      if (!requireReverseSyncMysql) {
        console.warn('⚠️ Sincronização reversa sem persistência MySQL:', error?.message || String(error));
      } else {
        console.error('❌ Banco da sincronização reversa indisponível:', error?.message || String(error));
        process.exitCode = 1;
        return;
      }
    }
  }

  httpServer = app.listen(PORT, HOST, () => {
    console.log(`🚀 Rodando em http://${HOST}:${PORT}`);
    console.log(`🗄️ Persistência: ${databaseRuntime.getState().config?.mode || "json"}`);
    console.log(`📦 Release: ${releaseMetadata().releaseId}`);
    const configuredPanels = listTenantConfigs({ includeDisabled: false });
    console.log(`➡️ Painéis ativos (${configuredPanels.length}):`, configuredPanels.map((cfg) => cfg.path).join(", "));
    if (typeof process.send === "function") process.send("ready");
    startExternalCrmWorker();
    automaticMessageQueue.start();
    if (resolveFeature(FEATURES.CLOUD_QUEUE, TENANT_ADMIN).enabled) cloudCampaignQueue.start();
    else console.warn("[DEPLOY] Fila Cloud desativada por feature flag.");
    setTimeout(startWhatsAppClientsInBackground, 1500);
    setTimeout(runOperationalMonitor, 2000);
    const monitorIntervalMs = Math.max(60000, Number(process.env.MONITOR_INTERVAL_MS || 300000));
    monitorTimer = setInterval(runOperationalMonitor, monitorIntervalMs);
    monitorTimer.unref?.();
  });
}

startApplication();
