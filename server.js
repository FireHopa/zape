require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { adminAuth } = require("./src/adminAuth");
const { panelAuth } = require("./src/panelAuth");
const { reginaAuth } = require("./src/reginaAuth"); // NOVO: Autenticação da Regina

const { normalizeBRPhoneToE164Digits } = require("./src/phone");

const { readLeads, appendLead, toCSV } = require("./src/tenantLeadsStore");
const { listTags, upsertTag, deleteTag } = require("./src/tenantTagsStore");
const { getLeadTagsMap, setLeadTags, removeTagFromAllLeads } = require("./src/tenantLeadTagsStore");
const { readCrmState, writeCrmState } = require("./src/tenantCrmStore");

const { getTemplate, setTemplate } = require("./src/messageTemplateStore");

function updateTemplateSafe(tenantId, text) {
  if (typeof setTemplate !== "function") {
    throw new Error("Template store inválido: setTemplate não encontrado");
  }
  return setTemplate(tenantId, String(text || "").trim());
}
const { isWhatsAppConfigured, computeLeadStatus, getTenantWA, sendCustomMessage } = require("./src/whatsappManager");

// CORREÇÃO: importando updateWebhook
const { listWebhooks, createWebhook, updateWebhook, deleteWebhook, resolveWebhookToken } = require("./src/webhooksStore");

// CORREÇÃO: importando as funções do Dono do Negócio
const { readBusinessOwner, writeBusinessOwner } = require("./src/businessStore");

const {
  isCloudConfigured: isCloudApiConfigured,
  sendTemplate: sendCloudTemplate,
  listTemplates: listCloudTemplates,
  handleWebhook: handleCloudWebhook,
  getCloudStatus,
  listStatus: listCloudStatus,
} = require("./src/waCloud");

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

/* -------------------- middlewares -------------------- */
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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

// estático
app.use(express.static(path.join(__dirname, "public")));

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
  const d = String(digits || "").replace(/\D+/g, "");
  if (!d) return "";
  if (d.length >= 13 && d.startsWith("55")) return d.slice(2, 4);
  if (d.length >= 11) return d.slice(0, 2);
  return "";
}

function buildLeadsHandler({ tenantId, authMw }) {
  return (req, res) => {
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
      leads = leads.filter(
        (l) =>
          String(l.nome || "").toLowerCase().includes(q) ||
          String(l.email || "").toLowerCase().includes(q) ||
          String(l.empresa || "").toLowerCase().includes(q)
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

      const ms = wa.getMessageStatusFor(l.whatsapp_digits);
      const leadStatus = computeLeadStatus(ms, { notDeliveredAfterMs });

      return { ...l, tagIds: ids, tagsFull: full, messageStatus: ms, leadStatus };
    });

    if (filterTagIds.length) {
      items = items.filter((l) => {
        const ids = Array.isArray(l.tagIds) ? l.tagIds : [];
        return filterTagIds.every((t) => ids.includes(t));
      });
    }

    if (statusFilter) {
      items = items.filter((l) => String(l.leadStatus || "") === statusFilter);
    }

    res.json({ total: items.length, items: items.slice(0, 2000), tags });
  };
}


async function createManualLead(tenantId, payload) {
  const whatsappDigits = payload.whatsapp ? normalizeBRPhoneToE164Digits(payload.whatsapp) : "";
  const lead = {
    id: genId(),
    source: payload.source || "manual",
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

/* -------------------- routes -------------------- */
app.get("/health", (_, res) => res.json({ ok: true }));

/** mantém comportamento antigo: formulário público cria lead no tenant ADMIN */
app.post("/api/leads", async (req, res) => {
  try {
    const lead = await processLead(TENANT_ADMIN, "local_form", {
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

    let lead = null;

    // Payload estilo ActiveCampaign
    if (body.contact || body.seriesid) {
      const c = body.contact || {};
      const f = c?.fields || {};
      lead = await processLead(tenantId, "generated_webhook_activecampaign", {
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
app.get("/api/business", adminAuth, (req, res) => {
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
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/api/admin/leads", adminAuth, buildLeadsHandler({ tenantId: TENANT_ADMIN }));

// CRM (Funil de Vendas) - admin
app.get("/api/admin/crm", adminAuth, (req, res) => {
  const state = readCrmState(TENANT_ADMIN);
  res.json({ ok: true, state });
});
app.put("/api/admin/crm", adminAuth, (req, res) => {
  const state = writeCrmState(TENANT_ADMIN, req.body && (req.body.state || req.body));
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
  const csv = toCSV(readLeads(TENANT_ADMIN));
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
  const base = getPublicBaseUrl(req);
  const items = listWebhooks(TENANT_ADMIN).map((w) => ({
    id: w.id,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    url: `${base}/webhooks/${w.token}`,
    messages: w.messages || [],
    messageText: w.messageText || ""
  }));
  res.json({ ok: true, webhooks: items });
});

app.post("/api/admin/webhooks", adminAuth, (req, res) => {
  const base = getPublicBaseUrl(req);
  const w = createWebhook(TENANT_ADMIN);
  res.json({ ok: true, id: w.id, createdAt: w.createdAt, url: `${base}/webhooks/${w.token}` });
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
  res.sendFile(path.join(__dirname, "public", "panel.html"));
});

app.get("/api/panel/leads", panelAuth, buildLeadsHandler({ tenantId: TENANT_PANEL }));

app.get("/api/panel/crm", panelAuth, (req, res) => {
  const state = readCrmState(TENANT_PANEL);
  res.json({ ok: true, state });
});
app.put("/api/panel/crm", panelAuth, (req, res) => {
  const state = writeCrmState(TENANT_PANEL, req.body && (req.body.state || req.body));
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
  const csv = toCSV(readLeads(TENANT_PANEL));
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
  const base = getPublicBaseUrl(req);
  const items = listWebhooks(TENANT_PANEL).map((w) => ({
    id: w.id,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    url: `${base}/webhooks/${w.token}`,
    messages: w.messages || [],
    messageText: w.messageText || ""
  }));
  res.json({ ok: true, webhooks: items });
});

app.post("/api/panel/webhooks", panelAuth, (req, res) => {
  const base = getPublicBaseUrl(req);
  const w = createWebhook(TENANT_PANEL);
  res.json({ ok: true, id: w.id, createdAt: w.createdAt, url: `${base}/webhooks/${w.token}` });
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
  res.sendFile(path.join(__dirname, "public", "regina.html"));
});

app.get("/api/regina/leads", reginaAuth, buildLeadsHandler({ tenantId: TENANT_REGINA }));

app.get("/api/regina/crm", reginaAuth, (req, res) => {
  const state = readCrmState(TENANT_REGINA);
  res.json({ ok: true, state });
});
app.put("/api/regina/crm", reginaAuth, (req, res) => {
  const state = writeCrmState(TENANT_REGINA, req.body && (req.body.state || req.body));
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
  const csv = toCSV(readLeads(TENANT_REGINA));
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
  const base = getPublicBaseUrl(req);
  const items = listWebhooks(TENANT_REGINA).map((w) => ({
    id: w.id,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    url: `${base}/webhooks/${w.token}`,
    messages: w.messages || [],
    messageText: w.messageText || ""
  }));
  res.json({ ok: true, webhooks: items });
});

app.post("/api/regina/webhooks", reginaAuth, (req, res) => {
  const base = getPublicBaseUrl(req);
  const w = createWebhook(TENANT_REGINA);
  res.json({ ok: true, id: w.id, createdAt: w.createdAt, url: `${base}/webhooks/${w.token}` });
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


/* -------------------- WhatsApp Cloud API (oficial) -------------------- */
// Mantido como ADMIN (segurança).
app.get("/api/wa-cloud/status", adminAuth, (req, res) => {
  res.json(getCloudStatus());
});

app.get("/api/wa-cloud/templates", adminAuth, async (req, res) => {
  try {
    const out = await listCloudTemplates({ limit: 200 });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

app.post("/api/wa-cloud/send-template-batch", adminAuth, async (req, res) => {
  try {
    if (!isCloudApiConfigured()) throw new Error("WA_CLOUD não configurado.");

    const templateName = String(req.body?.templateName || "").trim();
    const languageCode = String(req.body?.languageCode || "pt_BR").trim();
    const contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
    const throttleMs = Math.max(0, Number(req.body?.throttleMs || 250));

    if (!templateName) throw new Error("templateName obrigatório.");
    if (!contacts.length) throw new Error("contacts vazio.");

    const results = [];
    for (const c of contacts) {
      const to = String(c?.to || "").replace(/\D+/g, "");
      if (!to) continue;

      const vars = Array.isArray(c?.vars) ? c.vars.map((x) => String(x ?? "")) : [];
      const components = vars.length
        ? [{ type: "body", parameters: vars.map((t) => ({ type: "text", text: t })) }]
        : [];

      try {
        const out = await sendCloudTemplate({
          toE164Digits: to,
          templateName,
          languageCode,
          components,
          meta: { nome: c?.nome || null, source: "admin-batch" },
        });
        results.push({ to, ok: true, messageId: out?.messages?.[0]?.id || null });
      } catch (err) {
        results.push({ to, ok: false, error: err?.message || String(err) });
      }

      if (throttleMs) await new Promise((r) => setTimeout(r, throttleMs));
    }

    res.json({ ok: true, total: results.length, results });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || String(err) });
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
  });
});
