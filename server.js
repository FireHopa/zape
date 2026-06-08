require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { adminAuth } = require("./src/adminAuth");
const { panelAuth } = require("./src/panelAuth");
const { reginaAuth } = require("./src/reginaAuth"); // NOVO: Autenticação da Regina
const { portugalAuth } = require("./src/portugalAuth"); // NOVO: Autenticação do painel Portugal
const { felipeAuth } = require("./src/felipeAuth"); // NOVO: Autenticação do painel Felipe
const { registerAuthRoutes, anyTenantAuth } = require("./src/basicAuthFactory");

const { normalizeBRPhoneToE164Digits, normalizePhoneToE164Digits, phoneSearchVariants, extractPhoneRegion } = require("./src/phone");

const { readLeads, appendLead, deleteLeadById, toCSV } = require("./src/tenantLeadsStore");
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
const { isWhatsAppConfigured, computeLeadStatus, getTenantWA, sendCustomMessage, sendCustomAudioMessage, getChatTextMessages, getChatsSnapshotForDigits, destroyCachedWhatsAppClients } = require("./src/whatsappManager");
const { listConversationDigits, listConversationMessages, listConversationSummaries, getConversationMediaPath } = require("./src/tenantConversationStore");

// CORREÇÃO: importando updateWebhook
const { listWebhooks, createWebhook, updateWebhook, deleteWebhook, resolveWebhookToken } = require("./src/webhooksStore");

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
  listStatus: listCloudStatus,
} = require("./src/waCloud");
const {
  createCampaign: createCloudDispatchCampaign,
  recordEvent: recordCloudDispatchEvent,
  updateEvent: updateCloudDispatchEvent,
  updateByMessageId: updateCloudDispatchByMessageId,
  markReply: markCloudDispatchReply,
  listCampaigns: listCloudDispatchCampaigns,
  listEvents: listCloudDispatchEvents,
} = require("./src/waCloudDispatchStore");
const { normalizeMetaError, groupMetaErrors } = require("./src/metaErrorHelper");

const app = express();

// Respeita HTTPS quando o app roda atrás de Nginx/Cloudflare/PM2.
app.set("trust proxy", true);

const DEBUG = String(process.env.DEBUG || "").toLowerCase() === "true" || process.env.DEBUG === "1";
const logOk = (...a) => console.log("[OK]", ...a);
const logErr = (...a) => console.error("[ERROR]", ...a);
const PORT = process.env.PORT || 3000;

const TENANT_ADMIN = "admin";
const TENANT_PANEL = "panel";
const TENANT_REGINA = "regina"; // NOVO: Inquilino da Regina
const TENANT_PORTUGAL = "portugal"; // NOVO: Inquilino do painel Portugal
const TENANT_FELIPE = "felipe"; // NOVO: Inquilino do painel Felipe

/* -------------------- middlewares -------------------- */
app.use(cors());
app.use(express.urlencoded({ extended: true, limit: "60mb" }));
app.use(express.json({ limit: "60mb" }));

registerAuthRoutes(app);

// debug request logger
app.use((req, res, next) => {
  if (!DEBUG) return next();
  const t0 = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - t0;
    const ok = res.statusCode < 400;
    (ok ? logOk : logErr)(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
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
app.get(["/index.html", "/app.html", "/admin.html", "/panel.html", "/regina.html", "/portugal.html", "/felipe.html"], (req, res) => {
  const p = String(req.path || "");
  const target = p.includes("panel") ? "/panel" : p.includes("regina") ? "/regina" : p.includes("portugal") ? "/portugal" : p.includes("felipe") ? "/felipe" : "/admin";
  res.redirect(target);
});

// estático
app.use(express.static(path.join(__dirname, "public"), { index: false }));

/* -------------------- helpers -------------------- */
function genId() {
  return crypto.randomBytes(12).toString("hex");
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
  await appendLead(tenantId, lead);
}

async function processLead(tenantId, source, payload) {
  const whatsappDigits = normalizeBRPhoneToE164Digits(payload.whatsapp);

  const lead = {
    id: genId(),
    source,
    sourceDetail: payload.sourceDetail || payload.originDetail || "",
    sourceMeta: payload.sourceMeta && typeof payload.sourceMeta === "object" ? payload.sourceMeta : null,
    createdAt: new Date().toISOString(),

    nome: (payload.nome || "").trim(),
    empresa: (payload.empresa || "").trim(),
    jaAnuncia: (payload.jaAnuncia || "").trim(),
    website: (payload.website || "").trim(),
    email: (payload.email || "").trim(),

    whatsapp_raw: (payload.whatsapp || "").trim(),
    whatsapp_digits: whatsappDigits,

    tags: payload.tags || "",
    active_contact_id: payload.active_contact_id || "",
    active_seriesid: payload.active_seriesid || "",
  };

  if (!lead.nome || !lead.email || !lead.whatsapp_digits) {
    throw new Error("Lead inválido (nome/email/whatsapp válido).");
  }

  await saveLead(tenantId, lead);
  console.log(`✅ Lead salvo [${tenantId}]:`, lead);

  return lead;
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

function shouldDedupeLeads(req) {
  const v = String(req.query.dedupe ?? "1").toLowerCase().trim();
  return !(v === "0" || v === "false" || v === "no" || v === "nao" || v === "não");
}

function getLeadItemsForRequest(tenantId, req, { limit = 2000 } = {}) {
  const q = String(req.query.q || "").toLowerCase().trim();
  const from = String(req.query.from || "").trim();
  const to = String(req.query.to || "").trim();

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
    const qDigits = String(req.query.q || "").replace(/\D+/g, "");
    leads = leads.filter(
      (l) =>
        String(l.nome || "").toLowerCase().includes(q) ||
        String(l.email || "").toLowerCase().includes(q) ||
        String(l.empresa || "").toLowerCase().includes(q) ||
        String(l.whatsapp_raw || "").toLowerCase().includes(q) ||
        String(l.whatsapp_digits || "").toLowerCase().includes(q) ||
        phoneMatchesSearch(l, qDigits)
    );
  }

  if (ddd) {
    leads = leads.filter((l) => extractDDDFromDigits(l.whatsapp_digits) === ddd);
  }

  const leadTags = getLeadTagsMap(tenantId);
  const tags = listTags(tenantId);
  const tagById = Object.fromEntries(tags.map((t) => [t.id, t]));

  const wa = getTenantWA(tenantId);

  let items = leads.map((l) => {
    const ids = Array.isArray(leadTags[l.id]) ? leadTags[l.id] : [];
    const full = ids.map((id) => tagById[id]).filter(Boolean);

    const ms = wa.getMessageStatusFor(l.whatsapp_digits || leadPhoneKey(l));
    const leadStatus = computeLeadStatus(ms, { notDeliveredAfterMs });

    return { ...l, tagIds: ids, tagsFull: full, messageStatus: ms, leadStatus };
  });

  if (shouldDedupeLeads(req)) {
    items = dedupeLeadItemsByWhatsapp(items);
  }

  if (filterTagIds.length) {
    items = items.filter((l) => {
      const ids = Array.isArray(l.tagIds) ? l.tagIds : [];
      return filterTagIds.some((t) => ids.includes(t));
    });
  }

  if (statusFilter) {
    items = items.filter((l) => String(l.leadStatus || "") === statusFilter);
  }

  return { total: items.length, items: items.slice(0, limit), tags };
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
    return {
      ...item,
      chat,
      unreadCount: Number((chat && chat.unreadCount) || item.unreadCount || 0),
      lastMessage,
      lastActivity: (lastMessage && lastMessage.createdAt) || item.lastActivity || item.createdAt || null,
    };
  });

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
    if (out.mediaFile && out.mediaKind === 'audio') {
      out.mediaUrl = `${prefix}/conversations/${encodeURIComponent(safeDigits)}/media/${encodeURIComponent(out.mediaFile)}`;
    }
    return out;
  });
}

function buildConversationsRoutes({ tenantId, authMw, prefix }) {
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

  app.get(`${prefix}/conversations/:digits/media/:file`, authMw, (req, res) => {
    try {
      const digits = leadPhoneKey({ whatsapp_digits: req.params.digits });
      if (!digits) return res.status(400).send('Número inválido.');
      const filePath = getConversationMediaPath(tenantId, req.params.file);
      if (!filePath) return res.status(404).send('Áudio não encontrado.');
      res.sendFile(filePath);
    } catch (err) {
      res.status(400).send(err?.message || String(err));
    }
  });

  app.post(`${prefix}/conversations/:digits/audio`, authMw, async (req, res) => {
    try {
      const digits = leadPhoneKey({ whatsapp_digits: req.params.digits });
      if (!digits) return res.status(400).json({ ok: false, error: 'Número inválido.' });

      // Aceita Base64 puro, DataURL completo ou o campo legado `audio`.
      // Isso evita erro quando o navegador envia `data:audio/webm;base64,...`.
      const audioBase64 = String(req.body?.audioBase64 || req.body?.audioDataUrl || req.body?.dataUrl || req.body?.audio || '').trim();
      const mimetype = String(req.body?.mimetype || req.body?.mimeType || '').trim() || 'audio/webm';
      const filename = String(req.body?.filename || 'audio.webm').trim();
      if (!audioBase64) return res.status(400).json({ ok: false, error: 'Áudio vazio. Grave novamente e tente enviar.' });

      const result = await sendCustomAudioMessage(tenantId, {
        toDigits: digits,
        audioBase64,
        mimetype,
        filename,
      });

      const message = enrichConversationMessagesForClient(tenantId, prefix, digits, [result.message])[0];
      res.json({ ok: true, message });
    } catch (err) {
      const raw = err?.message || String(err);
      const error = raw && raw.length <= 2 ? 'Não consegui enviar este áudio. Grave novamente e tente outra vez.' : raw;
      res.status(400).json({ ok: false, error });
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

function buildLeadsHandler({ tenantId, authMw }) {
  return (req, res) => {
    res.json(getLeadItemsForRequest(tenantId, req, { limit: 2000 }));
  };
}

async function createManualLead(tenantId, payload) {
  const whatsappDigits = payload.whatsapp ? normalizeBRPhoneToE164Digits(payload.whatsapp) : "";
  const lead = {
    id: genId(),
    source: payload.source || "manual",
    sourceDetail: payload.sourceDetail || payload.originDetail || (payload.source === "conversation_register" ? "Registrado pela aba Conversas" : "Criado manualmente no painel"),
    sourceMeta: payload.sourceMeta && typeof payload.sourceMeta === "object" ? payload.sourceMeta : null,
    createdAt: new Date().toISOString(),

    nome: (payload.nome || "").trim(),
    empresa: (payload.empresa || "").trim(),
    jaAnuncia: (payload.jaAnuncia || "").trim(),
    website: (payload.website || "").trim(),
    email: (payload.email || "").trim(),

    whatsapp_raw: (payload.whatsapp || "").trim(),
    whatsapp_digits: whatsappDigits,

    tags: payload.tags || "",
    active_contact_id: payload.active_contact_id || "",
    active_seriesid: payload.active_seriesid || "",
  };

  if (!lead.nome) throw new Error("Nome é obrigatório.");
  if (!lead.email && !lead.whatsapp_digits) throw new Error("Informe e-mail ou WhatsApp.");

  await saveLead(tenantId, lead);
  return lead;
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

  let sentCount = 0;
  for (const template of templates) {
    const text = renderCrmStageAutoMessage(template, lead, pipeline, stage);
    if (!text) continue;

    await sendCustomMessage(tenantId, {
      toDigits: digits,
      nome: lead.nome || "",
      text,
      waitReadyMs: 60000,
    });
    sentCount += 1;
  }

  if (!sentCount) return { ok: false, skipped: true, reason: "empty_after_render" };
  return { ok: true, sent: true, sentCount, reason: reason || "crm_stage_enter", leadId, stageId: stage && stage.id, pipelineId: pipeline && pipeline.id };
}

function queueCrmStageAutoMessage(tenantId, leadId, pipeline, stage, reason) {
  const templates = getCrmStageAutoMessages(stage);
  if (!templates.length) return;
  setTimeout(() => {
    sendCrmStageAutoMessage(tenantId, leadId, pipeline, stage, reason)
      .then((out) => {
        if (out && out.sent) {
          console.log(`✅ Mensagem automática do CRM enviada [${tenantId}]:`, { leadId, pipelineId: pipeline && pipeline.id, stageId: stage && stage.id, reason, sentCount: out.sentCount || 1 });
        }
      })
      .catch((err) => {
        console.error(`❌ Falha ao enviar mensagem automática do CRM [${tenantId}/${leadId}]:`, err?.message || err);
      });
  }, 250);
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

function deleteLeadEverywhere(tenantId, leadId, req) {
  const out = deleteLeadById(tenantId, leadId);
  if (!out.ok || !out.deleted) {
    return { ok: false, error: "Lead não encontrado." };
  }

  const deleted = out.deleted;
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

  return {
    ok: true,
    deletedLeadId: String(leadId),
    removed: out.removed || 1,
    tagsRemoved,
    crmRemoved,
    whatsappStatusCleared,
  };
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
  const map = { pending: "Na fila", queued: "Na fila", sent: "Enviado", delivered: "Entregue", read: "Lido", responded: "Respondido", failed: "Falhou", canceled: "Cancelado" };
  return map[s] || (s ? s.replace(/_/g, " ") : "Sem status");
}

function dispatchStatusClass(status) {
  const s = String(status || "").toLowerCase();
  if (s === "responded") return "ok";
  if (s === "read") return "read";
  if (s === "delivered") return "delivered";
  if (s === "failed") return "err";
  if (s === "sent") return "sent";
  return "pending";
}

function normalizeDispatchFinalStatus(event) {
  const s = String((event && event.status) || "").toLowerCase();
  if (s === "responded" || event?.respondedAt) return "responded";
  if (s === "read" || event?.readAt) return "read";
  if (s === "delivered" || event?.deliveredAt) return "delivered";
  if (s === "failed" || event?.failedAt || event?.error) return "failed";
  if (s === "sent" || event?.sentAt || event?.messageId) return "sent";
  return "pending";
}

function dispatchMetricBlank() {
  return { total: 0, sent: 0, delivered: 0, read: 0, responded: 0, failed: 0, pending: 0 };
}

function addDispatchMetric(metrics, status) {
  metrics.total += 1;
  const s = normalizeDispatchFinalStatus({ status });
  if (["sent", "delivered", "read", "responded"].includes(s)) metrics.sent += 1;
  if (["delivered", "read", "responded"].includes(s)) metrics.delivered += 1;
  if (["read", "responded"].includes(s)) metrics.read += 1;
  if (s === "responded") metrics.responded += 1;
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

function syncCloudDispatchFromWebhook(body) {
  const nowIso = new Date().toISOString();
  const entry = Array.isArray(body && body.entry) ? body.entry : [];
  for (const e of entry) {
    const changes = Array.isArray(e && e.changes) ? e.changes : [];
    for (const c of changes) {
      const value = c && c.value ? c.value : {};
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      for (const st of statuses) {
        const messageId = String(st && st.id || "").trim();
        const state = String(st && st.status || "").trim().toLowerCase();
        if (!messageId || !state) continue;
        const patch = { deliveryState: state };
        if (state === "sent") { patch.status = "sent"; patch.sentAckAt = nowIso; }
        else if (state === "delivered") { patch.status = "delivered"; patch.deliveredAt = nowIso; }
        else if (state === "read") { patch.status = "read"; patch.readAt = nowIso; }
        else if (state === "failed") {
          const webhookError = (Array.isArray(st.errors) && st.errors[0]) || null;
          patch.status = "failed";
          patch.failedAt = nowIso;
          patch.error = webhookError;
          patch.errorInfo = webhookError ? normalizeMetaError(webhookError) : null;
        }
        patch.conversation = st.conversation || null;
        patch.pricing = st.pricing || null;
        updateCloudDispatchByMessageId(messageId, patch);
      }
      const msgs = Array.isArray(value.messages) ? value.messages : [];
      for (const msg of msgs) {
        const from = String(msg && msg.from || "").trim();
        if (!from) continue;
        markCloudDispatchReply(from, {
          respondedAt: nowIso,
          inbound: { id: msg.id || null, type: msg.type || null, text: msg.text && msg.text.body ? msg.text.body : null, timestamp: msg.timestamp || null },
        }, { windowMs: 7 * 24 * 60 * 60 * 1000 });
      }
    }
  }
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
app.get("/health", (_, res) => res.json({ ok: true }));

/** mantém comportamento antigo: formulário público cria lead no tenant ADMIN */
app.post("/api/leads", async (req, res) => {
  try {
    const lead = await processLead(TENANT_ADMIN, "local_form", {
      sourceDetail: "Formulário local antigo do site",
      sourceMeta: { type: "form", form: "local_form" },
      nome: req.body.nome,
      empresa: req.body.empresa,
      jaAnuncia: req.body.jaAnuncia,
      website: req.body.website,
      email: req.body.email,
      whatsapp: req.body.whatsapp,
    });

    res.json({ ok: true, leadId: lead.id });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/debug/active", (req, res) => {
  console.log("========== ACTIVE HEADERS ==========");
  console.dir(req.headers, { depth: null });
  console.log("========== ACTIVE BODY =============");
  console.dir(req.body, { depth: null });
  console.log("====================================");
  res.json({ ok: true });
});

/** mantém comportamento antigo: ActiveCampaign cai no tenant ADMIN */
app.post("/webhooks/activecampaign", async (req, res) => {
  try {
    const c = req.body?.contact || {};
    const f = c?.fields || {};

    const lead = await processLead(TENANT_ADMIN, "activecampaign", {
      sourceDetail: "Webhook fixo do ActiveCampaign",
      sourceMeta: { type: "activecampaign", payloadType: "activecampaign" },
      active_contact_id: c.id || "",
      active_seriesid: req.body?.seriesid || "",
      tags: c.tags || "",

      nome: c.first_name || "",
      empresa: f.empresa || c.orgname || "",
      jaAnuncia: f.j_anuncia_no_google_ads_2 || "",

      website: "",
      email: c.email || "",
      whatsapp: c.phone || "",
    });

    res.json({ ok: true, leadId: lead.id });
  } catch (err) {
    console.error("❌ Active webhook error:", err?.message || err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

/** Webhook gerado (multi-tenant): /webhooks/<token> */
app.post("/webhooks/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    const row = resolveWebhookToken(token);
    if (!row) return res.status(404).json({ ok: false, error: "Webhook não encontrado." });

    const tenantId = row.tenantId;
    const body = req.body || {};
    const webhookUrl = webhookFullUrl(req, row);
    const webhookName = webhookEffectiveName(row, webhookUrl);

    let lead = null;

    // Payload estilo ActiveCampaign
    if (body.contact || body.seriesid) {
      const c = body.contact || {};
      const f = c?.fields || {};
      lead = await processLead(tenantId, "generated_webhook_activecampaign", {
        sourceDetail: `Webhook ${webhookName || row.id} recebido no formato ActiveCampaign`,
        sourceMeta: {
          type: "webhook",
          webhookId: row.id,
          webhookName,
          webhookUrl,
          webhookToken: row.token || "",
          webhookMessages: Array.isArray(row.messages) ? row.messages : (row.messageText ? [row.messageText] : []),
          payloadType: "activecampaign"
        },
        active_contact_id: c.id || "",
        active_seriesid: body?.seriesid || "",
        tags: c.tags || "",
        nome: c.first_name || "",
        empresa: f.empresa || c.orgname || "",
        jaAnuncia: f.j_anuncia_no_google_ads_2 || "",
        website: "",
        email: c.email || "",
        whatsapp: c.phone || "",
      });
    } else {
      // Payload genérico
      const p = body;
      lead = await processLead(tenantId, "generated_webhook_generic", {
        sourceDetail: `Webhook ${webhookName || row.id} recebido por POST JSON`,
        sourceMeta: {
          type: "webhook",
          webhookId: row.id,
          webhookName,
          webhookUrl,
          webhookToken: row.token || "",
          webhookMessages: Array.isArray(row.messages) ? row.messages : (row.messageText ? [row.messageText] : []),
          payloadType: "json"
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
      });
    }

    const crmTargetResult = addLeadToCrmTargetFromWebhook(tenantId, row, lead);
    if (crmTargetResult && crmTargetResult.added) {
      console.log(`✅ Lead vinculado ao CRM pelo webhook [${tenantId}]:`, { leadId: lead.id, webhookId: row.id, pipelineId: crmTargetResult.pipelineId, stageId: crmTargetResult.stageId });
    } else if (row && row.crmTarget && row.crmTarget.enabled !== false) {
      console.warn(`⚠️ Webhook com vínculo de CRM não aplicado [${tenantId}]:`, { webhookId: row.id, leadId: lead && lead.id, reason: crmTargetResult && crmTargetResult.reason });
    }

    // NOVO: dispara mensagens em lote salvas no webhook, se existirem
    if (row.messages && Array.isArray(row.messages) && row.messages.length > 0) {
      for (const msg of row.messages) {
        try {
          const text = String(msg || "").replace(/\{\{\s*nome\s*\}\}/gi, lead.nome || "").trim();
          if (!text) continue;

          await sendCustomMessage(row.tenantId, {
            toDigits: lead.whatsapp_digits,
            text: text,
            waitReadyMs: 60000
          });
        } catch (error) {
          console.error(`❌ Falha ao enviar msg em lote do webhook para ${lead.whatsapp_digits}:`, error?.message || error);
        }
      }
    }

    // Compatibilidade com messageText antigo
    else if (row.messageText) {
      try {
        const text = String(row.messageText || "").replace(/\{\{\s*nome\s*\}\}/gi, lead.nome || "").trim();
        if (text) {
          await sendCustomMessage(row.tenantId, {
            toDigits: lead.whatsapp_digits,
            text: text,
            waitReadyMs: 60000
          });
        }
      } catch (error) {
        console.error(`❌ Falha ao enviar msg do webhook para ${lead.whatsapp_digits}:`, error?.message || error);
      }
    }

    return res.json({ ok: true, tenantId, leadId: lead.id });
  } catch (err) {
    console.error("❌ Webhook token error:", err?.message || err);
    return res.status(400).json({ ok: false, error: err?.message || String(err) });
  }
});


/* -------------------- Business Owner (Dono do Negócio) API -------------------- */
// CORREÇÃO: Rotas para visualização/edição das informações do Dono (atrelado ao ADMIN)
app.get("/api/business", anyTenantAuth, (req, res) => {
  const owner = readBusinessOwner(TENANT_ADMIN);
  res.json({ ok: true, owner });
});

app.put("/api/business", adminAuth, (req, res) => {
  const data = req.body && req.body.owner ? req.body.owner : req.body;
  const owner = writeBusinessOwner(TENANT_ADMIN, data);
  res.json({ ok: true, owner });
});


/* -------------------- Admin UI + API -------------------- */
app.get("/admin", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

app.get("/api/admin/leads", adminAuth, buildLeadsHandler({ tenantId: TENANT_ADMIN }));

app.delete("/api/admin/leads/:id", adminAuth, (req, res) => {
  const out = deleteLeadEverywhere(TENANT_ADMIN, req.params.id, req);
  if (!out.ok) return res.status(404).json(out);
  res.json(out);
});

// CRM (Funil de Vendas) - admin
app.get("/api/admin/crm", adminAuth, (req, res) => {
  const state = readCrmState(TENANT_ADMIN);
  res.json({ ok: true, state });
});
app.put("/api/admin/crm", adminAuth, (req, res) => {
  const state = saveCrmStateAndQueueMessages(TENANT_ADMIN, req.body && (req.body.state || req.body));
  res.json({ ok: true, state });
});
app.post("/api/admin/leads/manual", adminAuth, async (req, res) => {
  try {
    const lead = await createManualLead(TENANT_ADMIN, req.body || {});
    res.json({ ok: true, lead });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/admin/leads.csv", adminAuth, (req, res) => {
  const payload = getLeadItemsForRequest(TENANT_ADMIN, req, { limit: 100000 });
  const csv = toCSV(payload.items);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="leads_admin.csv"`);
  res.send(csv);
});

app.get("/api/admin/whatsapp/status", adminAuth, (req, res) => {
  res.json(getTenantWA(TENANT_ADMIN).getWhatsAppStatus());
});

app.post("/api/admin/whatsapp/init", adminAuth, async (req, res) => {
  try {
    await getTenantWA(TENANT_ADMIN).initWhatsApp();
    res.json({ ok: true, ...getTenantWA(TENANT_ADMIN).getWhatsAppStatus() });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      ...getTenantWA(TENANT_ADMIN).getWhatsAppStatus(),
    });
  }
});

app.get("/api/admin/whatsapp/qr", adminAuth, (req, res) => {
  res.json({ ok: true, qr: getTenantWA(TENANT_ADMIN).getLatestQr() });
});

app.get("/api/admin/whatsapp/stats", adminAuth, (req, res) => {
  const notDeliveredAfterMin = Number(req.query.notDeliveredAfterMin || 30);
  res.json({ ok: true, ...summarizeLeadWhatsappStats(TENANT_ADMIN, { notDeliveredAfterMin }) });
});
app.get("/api/admin/insights", adminAuth, (req, res) => {
  try { res.json(buildTenantInsights(TENANT_ADMIN, req)); }
  catch (e) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
});
buildConversationsRoutes({ tenantId: TENANT_ADMIN, authMw: adminAuth, prefix: "/api/admin" });

app.get("/api/admin/tags", adminAuth, (req, res) => {
  res.json({ ok: true, items: listTags(TENANT_ADMIN) });
});

app.post("/api/admin/tags", adminAuth, (req, res) => {
  try {
    const tag = upsertTag(TENANT_ADMIN, {
      id: req.body?.id || null,
      name: req.body?.name,
      color: req.body?.color,
    });
    res.json({ ok: true, item: tag });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete("/api/admin/tags/:id", adminAuth, (req, res) => {
  try {
    const id = req.params.id;
    deleteTag(TENANT_ADMIN, id);
    removeTagFromAllLeads(TENANT_ADMIN, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/leads/:id/tags", adminAuth, (req, res) => {
  try {
    const leadId = req.params.id;
    const tagIds = req.body?.tagIds;

    const allTags = listTags(TENANT_ADMIN);
    const allowed = new Set(allTags.map((t) => t.id));
    const cleaned = (Array.isArray(tagIds) ? tagIds : [])
      .map((x) => String(x).trim())
      .filter((x) => allowed.has(x));

    const out = setLeadTags(TENANT_ADMIN, leadId, cleaned);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/leads/bulk-tags", adminAuth, buildBulkLeadTagsHandler(TENANT_ADMIN));

app.get("/api/admin/message-template", adminAuth, (req, res) => {
  res.json({ ok: true, ...getTemplate(TENANT_ADMIN) });
});

app.post("/api/admin/message-template", adminAuth, (req, res) => {
  try {
    const out = updateTemplateSafe(TENANT_ADMIN, req.body?.text);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// CORREÇÃO: O GET agora retorna messages e messageText pro frontend exibir na tela
app.get("/api/admin/webhooks", adminAuth, (req, res) => {
  const items = listWebhooks(TENANT_ADMIN).map((w) => serializeWebhook(w, req));
  res.json({ ok: true, webhooks: items });
});

app.post("/api/admin/webhooks", adminAuth, (req, res) => {
  const w = createWebhook(TENANT_ADMIN, { name: req.body && req.body.name });
  res.json({ ok: true, ...serializeWebhook(w, req) });
});

// CORREÇÃO: Rota PUT adicionada para permitir o salvamento de mensagens no webhook (Admin)
app.put("/api/admin/webhooks/:id", adminAuth, (req, res) => {
  const out = updateWebhook(TENANT_ADMIN, req.params.id, req.body);
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.delete("/api/admin/webhooks/:id", adminAuth, (req, res) => {
  const out = deleteWebhook(TENANT_ADMIN, req.params.id);
  if (!out.ok) return res.status(400).json(out);
  res.json({ ok: true });
});


/* -------------------- Panel UI + API -------------------- */
app.get("/panel", panelAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

app.get("/api/panel/leads", panelAuth, buildLeadsHandler({ tenantId: TENANT_PANEL }));

app.delete("/api/panel/leads/:id", panelAuth, (req, res) => {
  const out = deleteLeadEverywhere(TENANT_PANEL, req.params.id, req);
  if (!out.ok) return res.status(404).json(out);
  res.json(out);
});

app.get("/api/panel/crm", panelAuth, (req, res) => {
  const state = readCrmState(TENANT_PANEL);
  res.json({ ok: true, state });
});
app.put("/api/panel/crm", panelAuth, (req, res) => {
  const state = saveCrmStateAndQueueMessages(TENANT_PANEL, req.body && (req.body.state || req.body));
  res.json({ ok: true, state });
});
app.post("/api/panel/leads/manual", panelAuth, async (req, res) => {
  try {
    const lead = await createManualLead(TENANT_PANEL, req.body || {});
    res.json({ ok: true, lead });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/panel/leads.csv", panelAuth, (req, res) => {
  const payload = getLeadItemsForRequest(TENANT_PANEL, req, { limit: 100000 });
  const csv = toCSV(payload.items);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="leads_panel.csv"`);
  res.send(csv);
});

app.get("/api/panel/whatsapp/status", panelAuth, (req, res) => {
  res.json(getTenantWA(TENANT_PANEL).getWhatsAppStatus());
});

app.post("/api/panel/whatsapp/init", panelAuth, async (req, res) => {
  try {
    await getTenantWA(TENANT_PANEL).initWhatsApp();
    res.json({ ok: true, ...getTenantWA(TENANT_PANEL).getWhatsAppStatus() });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      ...getTenantWA(TENANT_PANEL).getWhatsAppStatus(),
    });
  }
});

app.get("/api/panel/whatsapp/qr", panelAuth, (req, res) => {
  res.json({ ok: true, qr: getTenantWA(TENANT_PANEL).getLatestQr() });
});

app.get("/api/panel/whatsapp/stats", panelAuth, (req, res) => {
  const notDeliveredAfterMin = Number(req.query.notDeliveredAfterMin || 30);
  res.json({ ok: true, ...summarizeLeadWhatsappStats(TENANT_PANEL, { notDeliveredAfterMin }) });
});
app.get("/api/panel/insights", panelAuth, (req, res) => {
  try { res.json(buildTenantInsights(TENANT_PANEL, req)); }
  catch (e) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
});
buildConversationsRoutes({ tenantId: TENANT_PANEL, authMw: panelAuth, prefix: "/api/panel" });

app.get("/api/panel/tags", panelAuth, (req, res) => {
  res.json({ ok: true, items: listTags(TENANT_PANEL) });
});

app.post("/api/panel/tags", panelAuth, (req, res) => {
  try {
    const tag = upsertTag(TENANT_PANEL, {
      id: req.body?.id || null,
      name: req.body?.name,
      color: req.body?.color,
    });
    res.json({ ok: true, item: tag });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete("/api/panel/tags/:id", panelAuth, (req, res) => {
  try {
    const id = req.params.id;
    deleteTag(TENANT_PANEL, id);
    removeTagFromAllLeads(TENANT_PANEL, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/panel/leads/:id/tags", panelAuth, (req, res) => {
  try {
    const leadId = req.params.id;
    const tagIds = req.body?.tagIds;

    const allTags = listTags(TENANT_PANEL);
    const allowed = new Set(allTags.map((t) => t.id));
    const cleaned = (Array.isArray(tagIds) ? tagIds : [])
      .map((x) => String(x).trim())
      .filter((x) => allowed.has(x));

    const out = setLeadTags(TENANT_PANEL, leadId, cleaned);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/panel/leads/bulk-tags", panelAuth, buildBulkLeadTagsHandler(TENANT_PANEL));

app.get("/api/panel/message-template", panelAuth, (req, res) => {
  res.json({ ok: true, ...getTemplate(TENANT_PANEL) });
});

app.post("/api/panel/message-template", panelAuth, (req, res) => {
  try {
    const out = updateTemplateSafe(TENANT_PANEL, req.body?.text);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// CORREÇÃO: O GET agora retorna messages e messageText pro frontend exibir na tela (Panel)
app.get("/api/panel/webhooks", panelAuth, (req, res) => {
  const items = listWebhooks(TENANT_PANEL).map((w) => serializeWebhook(w, req));
  res.json({ ok: true, webhooks: items });
});

app.post("/api/panel/webhooks", panelAuth, (req, res) => {
  const w = createWebhook(TENANT_PANEL, { name: req.body && req.body.name });
  res.json({ ok: true, ...serializeWebhook(w, req) });
});

// CORREÇÃO: Rota PUT adicionada para permitir o salvamento de mensagens no webhook (Panel)
app.put("/api/panel/webhooks/:id", panelAuth, (req, res) => {
  const out = updateWebhook(TENANT_PANEL, req.params.id, req.body);
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.delete("/api/panel/webhooks/:id", panelAuth, (req, res) => {
  const out = deleteWebhook(TENANT_PANEL, req.params.id);
  if (!out.ok) return res.status(400).json(out);
  res.json({ ok: true });
});


/* -------------------- Regina UI + API -------------------- */
app.get("/regina", reginaAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

app.get("/api/regina/leads", reginaAuth, buildLeadsHandler({ tenantId: TENANT_REGINA }));

app.delete("/api/regina/leads/:id", reginaAuth, (req, res) => {
  const out = deleteLeadEverywhere(TENANT_REGINA, req.params.id, req);
  if (!out.ok) return res.status(404).json(out);
  res.json(out);
});

app.get("/api/regina/crm", reginaAuth, (req, res) => {
  const state = readCrmState(TENANT_REGINA);
  res.json({ ok: true, state });
});
app.put("/api/regina/crm", reginaAuth, (req, res) => {
  const state = saveCrmStateAndQueueMessages(TENANT_REGINA, req.body && (req.body.state || req.body));
  res.json({ ok: true, state });
});
app.post("/api/regina/leads/manual", reginaAuth, async (req, res) => {
  try {
    const lead = await createManualLead(TENANT_REGINA, req.body || {});
    res.json({ ok: true, lead });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/regina/leads.csv", reginaAuth, (req, res) => {
  const payload = getLeadItemsForRequest(TENANT_REGINA, req, { limit: 100000 });
  const csv = toCSV(payload.items);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="leads_regina.csv"`);
  res.send(csv);
});

app.get("/api/regina/whatsapp/status", reginaAuth, (req, res) => {
  res.json(getTenantWA(TENANT_REGINA).getWhatsAppStatus());
});

app.post("/api/regina/whatsapp/init", reginaAuth, async (req, res) => {
  try {
    await getTenantWA(TENANT_REGINA).initWhatsApp();
    res.json({ ok: true, ...getTenantWA(TENANT_REGINA).getWhatsAppStatus() });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      ...getTenantWA(TENANT_REGINA).getWhatsAppStatus(),
    });
  }
});

app.get("/api/regina/whatsapp/qr", reginaAuth, (req, res) => {
  res.json({ ok: true, qr: getTenantWA(TENANT_REGINA).getLatestQr() });
});

app.get("/api/regina/whatsapp/stats", reginaAuth, (req, res) => {
  const notDeliveredAfterMin = Number(req.query.notDeliveredAfterMin || 30);
  res.json({ ok: true, ...summarizeLeadWhatsappStats(TENANT_REGINA, { notDeliveredAfterMin }) });
});
app.get("/api/regina/insights", reginaAuth, (req, res) => {
  try { res.json(buildTenantInsights(TENANT_REGINA, req)); }
  catch (e) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
});
buildConversationsRoutes({ tenantId: TENANT_REGINA, authMw: reginaAuth, prefix: "/api/regina" });

app.get("/api/regina/tags", reginaAuth, (req, res) => {
  res.json({ ok: true, items: listTags(TENANT_REGINA) });
});

app.post("/api/regina/tags", reginaAuth, (req, res) => {
  try {
    const tag = upsertTag(TENANT_REGINA, {
      id: req.body?.id || null,
      name: req.body?.name,
      color: req.body?.color,
    });
    res.json({ ok: true, item: tag });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete("/api/regina/tags/:id", reginaAuth, (req, res) => {
  try {
    const id = req.params.id;
    deleteTag(TENANT_REGINA, id);
    removeTagFromAllLeads(TENANT_REGINA, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/regina/leads/:id/tags", reginaAuth, (req, res) => {
  try {
    const leadId = req.params.id;
    const tagIds = req.body?.tagIds;

    const allTags = listTags(TENANT_REGINA);
    const allowed = new Set(allTags.map((t) => t.id));
    const cleaned = (Array.isArray(tagIds) ? tagIds : [])
      .map((x) => String(x).trim())
      .filter((x) => allowed.has(x));

    const out = setLeadTags(TENANT_REGINA, leadId, cleaned);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/regina/leads/bulk-tags", reginaAuth, buildBulkLeadTagsHandler(TENANT_REGINA));

app.get("/api/regina/message-template", reginaAuth, (req, res) => {
  res.json({ ok: true, ...getTemplate(TENANT_REGINA) });
});

app.post("/api/regina/message-template", reginaAuth, (req, res) => {
  try {
    const out = updateTemplateSafe(TENANT_REGINA, req.body?.text);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// CORREÇÃO: O GET agora retorna messages e messageText pro frontend exibir na tela (Regina)
app.get("/api/regina/webhooks", reginaAuth, (req, res) => {
  const items = listWebhooks(TENANT_REGINA).map((w) => serializeWebhook(w, req));
  res.json({ ok: true, webhooks: items });
});

app.post("/api/regina/webhooks", reginaAuth, (req, res) => {
  const w = createWebhook(TENANT_REGINA, { name: req.body && req.body.name });
  res.json({ ok: true, ...serializeWebhook(w, req) });
});

// CORREÇÃO: Rota PUT adicionada para permitir o salvamento de mensagens no webhook (Regina)
app.put("/api/regina/webhooks/:id", reginaAuth, (req, res) => {
  const out = updateWebhook(TENANT_REGINA, req.params.id, req.body);
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.delete("/api/regina/webhooks/:id", reginaAuth, (req, res) => {
  const out = deleteWebhook(TENANT_REGINA, req.params.id);
  if (!out.ok) return res.status(400).json(out);
  res.json({ ok: true });
});


// Painel Portugal: tenant independente com as mesmas rotas do painel/regina.
app.get("/portugal", portugalAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

app.get("/api/portugal/leads", portugalAuth, buildLeadsHandler({ tenantId: TENANT_PORTUGAL }));

app.delete("/api/portugal/leads/:id", portugalAuth, (req, res) => {
  const out = deleteLeadEverywhere(TENANT_PORTUGAL, req.params.id, req);
  if (!out.ok) return res.status(404).json(out);
  res.json(out);
});

app.get("/api/portugal/crm", portugalAuth, (req, res) => {
  const state = readCrmState(TENANT_PORTUGAL);
  res.json({ ok: true, state });
});
app.put("/api/portugal/crm", portugalAuth, (req, res) => {
  const state = saveCrmStateAndQueueMessages(TENANT_PORTUGAL, req.body && (req.body.state || req.body));
  res.json({ ok: true, state });
});
app.post("/api/portugal/leads/manual", portugalAuth, async (req, res) => {
  try {
    const lead = await createManualLead(TENANT_PORTUGAL, req.body || {});
    res.json({ ok: true, lead });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/portugal/leads.csv", portugalAuth, (req, res) => {
  const payload = getLeadItemsForRequest(TENANT_PORTUGAL, req, { limit: 100000 });
  const csv = toCSV(payload.items);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="leads_portugal.csv"`);
  res.send(csv);
});

app.get("/api/portugal/whatsapp/status", portugalAuth, (req, res) => {
  res.json(getTenantWA(TENANT_PORTUGAL).getWhatsAppStatus());
});

app.post("/api/portugal/whatsapp/init", portugalAuth, async (req, res) => {
  try {
    await getTenantWA(TENANT_PORTUGAL).initWhatsApp();
    res.json({ ok: true, ...getTenantWA(TENANT_PORTUGAL).getWhatsAppStatus() });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      ...getTenantWA(TENANT_PORTUGAL).getWhatsAppStatus(),
    });
  }
});

app.get("/api/portugal/whatsapp/qr", portugalAuth, (req, res) => {
  res.json({ ok: true, qr: getTenantWA(TENANT_PORTUGAL).getLatestQr() });
});

app.get("/api/portugal/whatsapp/stats", portugalAuth, (req, res) => {
  const notDeliveredAfterMin = Number(req.query.notDeliveredAfterMin || 30);
  res.json({ ok: true, ...summarizeLeadWhatsappStats(TENANT_PORTUGAL, { notDeliveredAfterMin }) });
});
app.get("/api/portugal/insights", portugalAuth, (req, res) => {
  try { res.json(buildTenantInsights(TENANT_PORTUGAL, req)); }
  catch (e) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
});
buildConversationsRoutes({ tenantId: TENANT_PORTUGAL, authMw: portugalAuth, prefix: "/api/portugal" });

app.get("/api/portugal/tags", portugalAuth, (req, res) => {
  res.json({ ok: true, items: listTags(TENANT_PORTUGAL) });
});

app.post("/api/portugal/tags", portugalAuth, (req, res) => {
  try {
    const tag = upsertTag(TENANT_PORTUGAL, {
      id: req.body?.id || null,
      name: req.body?.name,
      color: req.body?.color,
    });
    res.json({ ok: true, item: tag });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete("/api/portugal/tags/:id", portugalAuth, (req, res) => {
  try {
    const id = req.params.id;
    deleteTag(TENANT_PORTUGAL, id);
    removeTagFromAllLeads(TENANT_PORTUGAL, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/portugal/leads/:id/tags", portugalAuth, (req, res) => {
  try {
    const leadId = req.params.id;
    const tagIds = req.body?.tagIds;

    const allTags = listTags(TENANT_PORTUGAL);
    const allowed = new Set(allTags.map((t) => t.id));
    const cleaned = (Array.isArray(tagIds) ? tagIds : [])
      .map((x) => String(x).trim())
      .filter((x) => allowed.has(x));

    const out = setLeadTags(TENANT_PORTUGAL, leadId, cleaned);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/portugal/leads/bulk-tags", portugalAuth, buildBulkLeadTagsHandler(TENANT_PORTUGAL));

app.get("/api/portugal/message-template", portugalAuth, (req, res) => {
  res.json({ ok: true, ...getTemplate(TENANT_PORTUGAL) });
});

app.post("/api/portugal/message-template", portugalAuth, (req, res) => {
  try {
    const out = updateTemplateSafe(TENANT_PORTUGAL, req.body?.text);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// CORREÇÃO: O GET agora retorna messages e messageText pro frontend exibir na tela (Portugal)
app.get("/api/portugal/webhooks", portugalAuth, (req, res) => {
  const items = listWebhooks(TENANT_PORTUGAL).map((w) => serializeWebhook(w, req));
  res.json({ ok: true, webhooks: items });
});

app.post("/api/portugal/webhooks", portugalAuth, (req, res) => {
  const w = createWebhook(TENANT_PORTUGAL, { name: req.body && req.body.name });
  res.json({ ok: true, ...serializeWebhook(w, req) });
});

// CORREÇÃO: Rota PUT adicionada para permitir o salvamento de mensagens no webhook (Portugal)
app.put("/api/portugal/webhooks/:id", portugalAuth, (req, res) => {
  const out = updateWebhook(TENANT_PORTUGAL, req.params.id, req.body);
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.delete("/api/portugal/webhooks/:id", portugalAuth, (req, res) => {
  const out = deleteWebhook(TENANT_PORTUGAL, req.params.id);
  if (!out.ok) return res.status(400).json(out);
  res.json({ ok: true });
});


// Painel Felipe: tenant independente com as mesmas rotas do painel/regina.
app.get("/felipe", felipeAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

app.get("/api/felipe/leads", felipeAuth, buildLeadsHandler({ tenantId: TENANT_FELIPE }));

app.delete("/api/felipe/leads/:id", felipeAuth, (req, res) => {
  const out = deleteLeadEverywhere(TENANT_FELIPE, req.params.id, req);
  if (!out.ok) return res.status(404).json(out);
  res.json(out);
});

app.get("/api/felipe/crm", felipeAuth, (req, res) => {
  const state = readCrmState(TENANT_FELIPE);
  res.json({ ok: true, state });
});
app.put("/api/felipe/crm", felipeAuth, (req, res) => {
  const state = saveCrmStateAndQueueMessages(TENANT_FELIPE, req.body && (req.body.state || req.body));
  res.json({ ok: true, state });
});
app.post("/api/felipe/leads/manual", felipeAuth, async (req, res) => {
  try {
    const lead = await createManualLead(TENANT_FELIPE, req.body || {});
    res.json({ ok: true, lead });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/felipe/leads.csv", felipeAuth, (req, res) => {
  const payload = getLeadItemsForRequest(TENANT_FELIPE, req, { limit: 100000 });
  const csv = toCSV(payload.items);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="leads_felipe.csv"`);
  res.send(csv);
});

app.get("/api/felipe/whatsapp/status", felipeAuth, (req, res) => {
  res.json(getTenantWA(TENANT_FELIPE).getWhatsAppStatus());
});

app.post("/api/felipe/whatsapp/init", felipeAuth, async (req, res) => {
  try {
    await getTenantWA(TENANT_FELIPE).initWhatsApp();
    res.json({ ok: true, ...getTenantWA(TENANT_FELIPE).getWhatsAppStatus() });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      ...getTenantWA(TENANT_FELIPE).getWhatsAppStatus(),
    });
  }
});

app.get("/api/felipe/whatsapp/qr", felipeAuth, (req, res) => {
  res.json({ ok: true, qr: getTenantWA(TENANT_FELIPE).getLatestQr() });
});

app.get("/api/felipe/whatsapp/stats", felipeAuth, (req, res) => {
  const notDeliveredAfterMin = Number(req.query.notDeliveredAfterMin || 30);
  res.json({ ok: true, ...summarizeLeadWhatsappStats(TENANT_FELIPE, { notDeliveredAfterMin }) });
});
app.get("/api/felipe/insights", felipeAuth, (req, res) => {
  try { res.json(buildTenantInsights(TENANT_FELIPE, req)); }
  catch (e) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
});
buildConversationsRoutes({ tenantId: TENANT_FELIPE, authMw: felipeAuth, prefix: "/api/felipe" });

app.get("/api/felipe/tags", felipeAuth, (req, res) => {
  res.json({ ok: true, items: listTags(TENANT_FELIPE) });
});

app.post("/api/felipe/tags", felipeAuth, (req, res) => {
  try {
    const tag = upsertTag(TENANT_FELIPE, {
      id: req.body?.id || null,
      name: req.body?.name,
      color: req.body?.color,
    });
    res.json({ ok: true, item: tag });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete("/api/felipe/tags/:id", felipeAuth, (req, res) => {
  try {
    const id = req.params.id;
    deleteTag(TENANT_FELIPE, id);
    removeTagFromAllLeads(TENANT_FELIPE, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/felipe/leads/:id/tags", felipeAuth, (req, res) => {
  try {
    const leadId = req.params.id;
    const tagIds = req.body?.tagIds;

    const allTags = listTags(TENANT_FELIPE);
    const allowed = new Set(allTags.map((t) => t.id));
    const cleaned = (Array.isArray(tagIds) ? tagIds : [])
      .map((x) => String(x).trim())
      .filter((x) => allowed.has(x));

    const out = setLeadTags(TENANT_FELIPE, leadId, cleaned);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/felipe/leads/bulk-tags", felipeAuth, buildBulkLeadTagsHandler(TENANT_FELIPE));

app.get("/api/felipe/message-template", felipeAuth, (req, res) => {
  res.json({ ok: true, ...getTemplate(TENANT_FELIPE) });
});

app.post("/api/felipe/message-template", felipeAuth, (req, res) => {
  try {
    const out = updateTemplateSafe(TENANT_FELIPE, req.body?.text);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// CORREÇÃO: O GET agora retorna messages e messageText pro frontend exibir na tela (Felipe)
app.get("/api/felipe/webhooks", felipeAuth, (req, res) => {
  const items = listWebhooks(TENANT_FELIPE).map((w) => serializeWebhook(w, req));
  res.json({ ok: true, webhooks: items });
});

app.post("/api/felipe/webhooks", felipeAuth, (req, res) => {
  const w = createWebhook(TENANT_FELIPE, { name: req.body && req.body.name });
  res.json({ ok: true, ...serializeWebhook(w, req) });
});

// CORREÇÃO: Rota PUT adicionada para permitir o salvamento de mensagens no webhook (Felipe)
app.put("/api/felipe/webhooks/:id", felipeAuth, (req, res) => {
  const out = updateWebhook(TENANT_FELIPE, req.params.id, req.body);
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.delete("/api/felipe/webhooks/:id", felipeAuth, (req, res) => {
  const out = deleteWebhook(TENANT_FELIPE, req.params.id);
  if (!out.ok) return res.status(400).json(out);
  res.json({ ok: true });
});


/* -------------------- WhatsApp Cloud API (oficial) -------------------- */
// Mantido como ADMIN (segurança).
function getCloudSheetsFile() {
  return path.join(__dirname, "data", TENANT_ADMIN, "wa_cloud_saved_sheets.json");
}

function readCloudSavedSheets() {
  try {
    const file = getCloudSheetsFile();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf8") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("[wa-cloud:sheets] read error", err);
    return [];
  }
}

function writeCloudSavedSheets(items) {
  const file = getCloudSheetsFile();
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

app.get("/api/wa-cloud/sheets", adminAuth, (req, res) => {
  const items = readCloudSavedSheets()
    .map(cloudSavedSheetListMeta)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  res.json({ ok: true, items });
});

app.get("/api/wa-cloud/sheets/:id", adminAuth, (req, res) => {
  const id = String(req.params.id || "");
  const item = readCloudSavedSheets().find((sheet) => String(sheet.id) === id);
  if (!item) return res.status(404).json({ ok: false, error: "Planilha não encontrada" });
  res.json({ ok: true, item });
});

app.post("/api/wa-cloud/sheets", adminAuth, (req, res) => {
  try {
    const next = normalizeCloudSavedSheetPayload(req.body || {});
    if (!next.rows.length || !next.columns.length) {
      return res.status(400).json({ ok: false, error: "Envie uma planilha com linhas e colunas." });
    }
    const items = readCloudSavedSheets();
    const idx = items.findIndex((sheet) => String(sheet.id) === String(next.id));
    if (idx >= 0) {
      next.createdAt = items[idx].createdAt || next.createdAt;
      items[idx] = next;
    } else {
      items.unshift(next);
    }
    writeCloudSavedSheets(items);
    res.json({ ok: true, item: cloudSavedSheetListMeta(next) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erro ao salvar planilha" });
  }
});

app.delete("/api/wa-cloud/sheets/:id", adminAuth, (req, res) => {
  const id = String(req.params.id || "");
  const before = readCloudSavedSheets();
  const after = before.filter((sheet) => String(sheet.id) !== id);
  writeCloudSavedSheets(after);
  res.json({ ok: true, removed: before.length - after.length });
});

app.get("/api/wa-cloud/status", adminAuth, (req, res) => {
  res.json(getCloudStatus());
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

app.put("/api/wa-cloud/embedded/settings", adminAuth, (req, res) => {
  try {
    const out = saveEmbeddedSignupSettings(req.body || {});
    res.json(out);
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post("/api/wa-cloud/embedded/exchange", adminAuth, async (req, res) => {
  try {
    const out = await exchangeEmbeddedSignupCode(req.body || {});
    res.json(out);
  } catch (err) {
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

app.delete("/api/wa-cloud/embedded", adminAuth, (req, res) => {
  try {
    res.json(disconnectCloudApi());
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get("/api/wa-cloud/templates", adminAuth, async (req, res) => {
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

app.get("/api/wa-cloud/template-library", adminAuth, async (req, res) => {
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

app.post("/api/wa-cloud/templates", adminAuth, async (req, res) => {
  try {
    if (!isCloudApiConfigured()) throw new Error("WA_CLOUD não configurado.");
    const out = await createCloudTemplate(req.body || {});
    res.json({ ok: true, ...out });
  } catch (err) {
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

app.post("/api/wa-cloud/send-template-batch", adminAuth, async (req, res) => {
  try {
    if (!isCloudApiConfigured()) throw new Error("WA_CLOUD não configurado.");

    const templateName = String(req.body?.templateName || "").trim();
    const languageCode = String(req.body?.languageCode || "pt_BR").trim();
    const contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
    const throttleMs = Math.max(0, Number(req.body?.throttleMs || 250));
    const campaignName = String(req.body?.campaignName || templateName || "Campanha oficial").trim();

    if (!templateName) throw new Error("templateName obrigatório.");
    if (!contacts.length) throw new Error("contacts vazio.");

    const webhookLookup = buildWebhookLookup(listWebhooks(TENANT_ADMIN), req);
    const sourceSummary = {};
    for (const c of contacts) {
      const src = dispatchSourceInfo(c).label || "Contato do disparo";
      sourceSummary[src] = (sourceSummary[src] || 0) + 1;
    }

    const campaign = createCloudDispatchCampaign({
      tenantId: TENANT_ADMIN,
      name: campaignName,
      templateName,
      languageCode,
      total: contacts.length,
      sourceSummary,
    });

    const results = [];
    for (const c of contacts) {
      const to = String(c?.to || "").replace(/\D+/g, "");
      if (!to) continue;

      const vars = Array.isArray(c?.vars) ? c.vars.map((x) => String(x ?? "")) : [];
      const components = vars.length
        ? [{ type: "body", parameters: vars.map((t) => ({ type: "text", text: t })) }]
        : [];

      const lead = findLeadByDigits(TENANT_ADMIN, to);
      const origin = lead ? leadOriginInfo(lead, webhookLookup) : dispatchSourceInfo(c);
      const dispatchSource = dispatchSourceInfo(c);
      const event = recordCloudDispatchEvent({
        tenantId: TENANT_ADMIN,
        campaignId: campaign.id,
        campaignName: campaign.name,
        templateName,
        languageCode,
        toDigits: to,
        leadId: lead ? lead.id : "",
        leadSnapshot: lead ? { id: lead.id, nome: lead.nome || "", empresa: lead.empresa || "", email: lead.email || "", source: lead.source || "" } : { nome: c?.nome || "", empresa: c?.companyName || "", email: c?.email || "" },
        origin,
        dispatchSource,
        vars,
        status: "pending",
      });

      try {
        const out = await sendCloudTemplate({
          toE164Digits: to,
          templateName,
          languageCode,
          components,
          meta: { nome: c?.nome || null, source: "admin-batch", campaignId: campaign.id, dispatchEventId: event.id },
        });
        const messageId = out?.messages?.[0]?.id || null;
        updateCloudDispatchEvent(event.id, { status: "sent", sentAt: new Date().toISOString(), messageId });
        results.push({ to, ok: true, messageId, campaignId: campaign.id, eventId: event.id });
      } catch (err) {
        const errorInfo = normalizeMetaError(err);
        const rawError = err?.payload || err?.message || String(err);
        updateCloudDispatchEvent(event.id, {
          status: "failed",
          failedAt: new Date().toISOString(),
          error: rawError,
          errorInfo,
        });
        if (isMetaTokenInvalidError(err)) throw err;
        results.push({
          to,
          ok: false,
          error: errorInfo.display || err?.message || String(err),
          errorInfo,
          campaignId: campaign.id,
          eventId: event.id,
        });
      }

      if (throttleMs) await new Promise((r) => setTimeout(r, throttleMs));
    }

    const sentCount = results.filter((x) => x && x.ok).length;
    const failedCount = results.filter((x) => x && !x.ok).length;
    res.json({
      ok: true,
      campaignId: campaign.id,
      campaignName: campaign.name,
      total: results.length,
      summary: {
        total: results.length,
        sent: sentCount,
        failed: failedCount,
        errorGroups: groupMetaErrors(results),
      },
      results,
    });
  } catch (err) {
    if (isMetaTokenInvalidError(err)) return sendMetaTokenInvalid(res, err);
    res.status(400).json({ ok: false, error: err?.message || String(err), errorInfo: normalizeMetaError(err), details: err?.payload || null });
  }
});

app.get("/api/wa-cloud/statuses", adminAuth, (req, res) => {
  res.json({ total: listCloudStatus().length, items: listCloudStatus() });
});

app.get("/webhooks/wa-cloud", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expected = process.env.WA_CLOUD_WEBHOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && expected && token === expected) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhooks/wa-cloud", (req, res) => {
  handleCloudWebhook(req.body);
  try { syncCloudDispatchFromWebhook(req.body); }
  catch (err) { console.error("⚠️ WA_CLOUD dispatch sync error:", err?.message || err); }
  res.sendStatus(200);
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

function dirHasAnyFile(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (!entries.length) return false;
    return entries.some((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isFile() || (entry.isDirectory() && dirHasAnyFile(full));
    });
  } catch {
    return false;
  }
}

function hasExistingWhatsAppSession(tenantId) {
  const authBase = path.join(__dirname, "data", tenantId, "wwebjs_auth");
  const expectedLocalAuthSession = path.join(authBase, `session-tenant_${tenantId}`);
  return dirHasAnyFile(expectedLocalAuthSession) || dirHasAnyFile(authBase);
}

function tenantHasLoginConfigured(tenantId) {
  const t = String(tenantId || "").trim().toLowerCase();
  const map = {
    admin: ["ADMIN_USER", "ADMIN_PASS"],
    panel: ["PANEL_USER", "PANEL_PASS"],
    regina: ["REGINA_USER", "REGINA_PASS"],
    portugal: ["PORTUGAL_USER", "PORTUGAL_PASS"],
    felipe: ["FELIPE_USER", "FELIPE_PASS"],
  };
  const keys = map[t];
  return Boolean(keys && String(process.env[keys[0]] || "").trim() && String(process.env[keys[1]] || "").trim());
}

function getWhatsAppAutoStartTenants() {
  const allowed = [TENANT_ADMIN, TENANT_PANEL, TENANT_REGINA, TENANT_PORTUGAL, TENANT_FELIPE];
  const explicit = String(process.env.WEBJS_AUTO_START_TENANTS || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  if (explicit.length) {
    return [...new Set(explicit.filter((tenant) => allowed.includes(tenant)))];
  }

  // Comportamento seguro por padrão:
  // tenants antigos só sobem automaticamente quando já têm sessão salva.
  // O tenant Portugal também sobe quando o login dele está configurado no .env,
  // para ficar visível no boot e disponível para gerar QR/conectar como os outros painéis.
  return allowed.filter((tenantId) => hasExistingWhatsAppSession(tenantId) || ((tenantId === TENANT_PORTUGAL || tenantId === TENANT_FELIPE) && tenantHasLoginConfigured(tenantId)));
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
async function gracefulShutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;

  console.log(`🛑 Recebido ${signal}. Encerrando clientes do WhatsApp com segurança...`);
  try {
    await destroyCachedWhatsAppClients();
  } catch (err) {
    console.error("⚠️ Falha ao encerrar clientes WhatsApp:", err?.message || err);
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// global error handler
app.use((err, req, res, next) => {
  logErr("Unhandled error:", err?.stack || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: "internal_error" });
});

/* -------------------- start -------------------- */
migrateLegacyData().finally(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Rodando em http://localhost:${PORT}`);
    console.log("➡️ Admin:", "/admin");
    console.log("➡️ Panel:", "/panel");
    console.log("➡️ Regina:", "/regina");
    console.log("➡️ Portugal:", "/portugal");
    console.log("➡️ Felipe:", "/felipe");

    // Mantém a sessão do WhatsApp viva após pm2 restart.
    // Se já existe sessão local salva, o painel volta conectado sem precisar clicar em Conectar.
    setTimeout(startWhatsAppClientsInBackground, 1500);
  });
});
