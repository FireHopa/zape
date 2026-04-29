// src/whatsappManager.js
const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");

const DEBUG = String(process.env.DEBUG || "").toLowerCase() === "true" || process.env.DEBUG === "1";
const logOk = (tenant, msg, extra) => { if (!DEBUG) return; console.log(`[OK][wa:${tenant}] ${msg}`, extra || ""); };
const logErr = (tenant, msg, extra) => { console.error(`[ERROR][wa:${tenant}] ${msg}`, extra || ""); };
const { ensureTenantDir, tenantDir } = require("./tenantPaths");
const { getTemplate } = require("./messageTemplateStore");

function isWhatsAppConfigured() {
  return String(process.env.WEBJS_ENABLED || "") === "1";
}

function resolveChromeExecutablePath() {
  const fromEnv = String(process.env.CHROME_EXECUTABLE_PATH || "").trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const candidates = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }

  // tenta achar no cache padrão do puppeteer (ex.: ~/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome)
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const base = home ? path.join(home, ".cache", "puppeteer", "chrome") : null;
    if (base && fs.existsSync(base)) {
      const entries = fs
        .readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^linux-\d+/.test(d.name))
        .map((d) => d.name)
        .sort((a, b) => {
          const na = Number((a.match(/linux-(\d+)/) || [0, 0])[1]);
          const nb = Number((b.match(/linux-(\d+)/) || [0, 0])[1]);
          return nb - na;
        });

      for (const dirName of entries) {
        const exe = path.join(base, dirName, "chrome-linux64", "chrome");
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch {}

  return null;
}

function computeLeadStatus(ms, { notDeliveredAfterMs } = {}) {
  const t = ms || null;
  if (!t) return "none";
  if (t.notOnWhatsapp) return "notExists";
  if (t.repliedAt) return "replied";

  const ack = Number.isFinite(t.ack) ? t.ack : -1;
  if (ack >= 2) return "delivered";

  if (t.lastSendAt) {
    const age = Date.now() - new Date(t.lastSendAt).getTime();
    const timeout = Number.isFinite(notDeliveredAfterMs) ? notDeliveredAfterMs : 30 * 60 * 1000;
    if (age >= timeout) return "notDelivered";
    return "pending";
  }

  return "none";
}

class TenantWhatsApp {
  constructor(tenantId) {
    this.tenantId = String(tenantId || "").trim() || "admin";

    this.client = null;
    this.initPromise = null;

    this.lastQrDataUrl = null;
    this.sessionStatus = "idle"; // idle | starting | qr | connected | error
    this.lastError = null;

    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;

    const dir = ensureTenantDir(this.tenantId);
    this.DATA_DIR = dir;
    this.STATUS_FILE = path.join(dir, "message_status.json");

    this.statusMap = this._loadStatusMap();
    this.saveTimer = null;
  }

  _loadStatusMap() {
    if (!fs.existsSync(this.STATUS_FILE)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.STATUS_FILE, "utf-8"));
    } catch {
      return {};
    }
  }

  _scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.writeFileSync(this.STATUS_FILE, JSON.stringify(this.statusMap, null, 2), "utf-8");
      } catch (e) {
        console.error(`[${this.tenantId}] ⚠️ Falha ao salvar message_status.json:`, e?.message || e);
      }
    }, 1200);
  }

  _upsertStatus(toDigits, patch) {
    if (!toDigits) return null;
    const prev = this.statusMap[toDigits] || { toDigits };
    const next = { ...prev, ...patch, toDigits, updatedAt: new Date().toISOString() };
    this.statusMap[toDigits] = next;
    this._scheduleSave();
    return next;
  }

  getMessageStatusFor(toDigits) {
    const d = String(toDigits || "").replace(/\D+/g, "");
    return d ? (this.statusMap[d] || null) : null;
  }

  getMessageStats({ notDeliveredAfterMin = 30 } = {}) {
    const map = this.statusMap || {};
    const vals = Object.values(map);
    const timeout = Math.max(1, Number(notDeliveredAfterMin || 30)) * 60 * 1000;

    let delivered = 0;
    let replied = 0;
    let notDelivered = 0;
    let notExists = 0;
    let pending = 0;

    for (const ms of vals) {
      const st = computeLeadStatus(ms, { notDeliveredAfterMs: timeout });
      if (st === "delivered") delivered++;
      else if (st === "replied") replied++;
      else if (st === "notDelivered") notDelivered++;
      else if (st === "notExists") notExists++;
      else if (st === "pending") pending++;
    }

    return { delivered, replied, notDelivered, notExists, pending, total: vals.length };
  }

  getLatestQr() {
    return this.lastQrDataUrl;
  }

  getWhatsAppStatus() {
    return {
      enabled: isWhatsAppConfigured(),
      tenantId: this.tenantId,
      status: this.sessionStatus,
      lastError: this.lastError,
      hasQr: !!this.lastQrDataUrl,
    };
  }

  async _ensureReady(timeoutMs = Number(process.env.WA_READY_TIMEOUT_MS || 60000)) {
    if (this.sessionStatus === "connected") return true;

    if (!this.readyPromise) {
      this.readyPromise = new Promise((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
    }

    // timeout to avoid infinite await
    return Promise.race([
      this.readyPromise,
      new Promise((_, reject) =>
        setTimeout(() => {
          const err = new Error(`wa_ready_timeout (${timeoutMs}ms) status=${this.sessionStatus}`);
          this.lastError = err.message;
          logErr(this.tenantId, "READY timeout", { status: this.sessionStatus });
          reject(err);
        }, timeoutMs)
      ),
    ]);
  }

  async initWhatsApp() {
    if (!isWhatsAppConfigured()) throw new Error("WEBJS_ENABLED!=1 (WhatsApp WebJS desativado).");

    if (this.client) return this.client;
    if (this.initPromise) return this.initPromise;

    this.sessionStatus = "starting";
    this.lastError = null;

    // auth isolada por tenant
    const authPath = path.join(this.DATA_DIR, "wwebjs_auth");

    const chromePath = resolveChromeExecutablePath();
    if (!chromePath) {
      throw new Error("Chrome/Chromium não encontrado. Instale chromium no servidor ou defina CHROME_EXECUTABLE_PATH.");
    }

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: `tenant_${this.tenantId}`, dataPath: authPath }),

      // Cache do HTML do WhatsApp Web (não é sessão). Mantém por-tenant pra evitar conflito.
      webVersionCache: {
        type: "local",
        path: path.join(this.DATA_DIR, "wwebjs_cache"),
      },

      puppeteer: {
        headless: true,
        executablePath: chromePath,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      },
    });

    this.client.on("qr", async (qr) => {
      try {
        this.sessionStatus = "qr";
        logOk(this.tenantId, "qr generated");
        this.lastQrDataUrl = await QRCode.toDataURL(qr);
      } catch (e) {
        this.lastError = e?.message || String(e);
        this.sessionStatus = "error";
        logErr(this.tenantId, "qr handler error", this.lastError);
      }
    });

    
    this.client.on("authenticated", () => {
      // Nem sempre "ready" é imediato; marca como autenticado pra UI parar de "QR infinito"
      if (this.sessionStatus !== "connected") this.sessionStatus = "authenticated";
      this.lastError = null;
      logOk(this.tenantId, "authenticated");

      // Watchdog: em alguns ambientes o evento "ready" não dispara, mas o state já vira CONNECTED.
      if (this._authWatchdogTimer) return;

      const startedAt = Date.now();
      this._authWatchdogTimer = setInterval(async () => {
        try {
          if (!this.client) return;
          if (this.sessionStatus === "connected" || this.sessionStatus === "error") return;

          const st = await this.client.getState().catch(() => null);
          const stUp = String(st || "").toUpperCase();

          if (stUp === "CONNECTED") {
            logOk(this.tenantId, "getState CONNECTED -> promoting to connected");
            this.sessionStatus = "connected";
            this.lastError = null;
            this.lastQrDataUrl = null;
            if (this.readyResolve) this.readyResolve(true);
            this.readyResolve = null;
            this.readyReject = null;
          }

          if (Date.now() - startedAt > Number(process.env.WA_AUTH_WATCHDOG_MS || 60000)) {
            logErr(this.tenantId, "authenticated watchdog timeout", { state: stUp || null });
            clearInterval(this._authWatchdogTimer);
            this._authWatchdogTimer = null;
          }
        } catch (e) {
          logErr(this.tenantId, "authenticated watchdog error", e?.message || String(e));
        }
      }, Number(process.env.WA_AUTH_WATCHDOG_INTERVAL_MS || 2000));
    });

    this.client.on("change_state", (state) => {
      logOk(this.tenantId, "change_state", state);
      // Alguns ambientes reportam melhor via change_state
      if (String(state || "").toUpperCase() === "CONNECTED") {
        if (this._authWatchdogTimer) { clearInterval(this._authWatchdogTimer); this._authWatchdogTimer = null; }
        this.sessionStatus = "connected";
        this.lastError = null;
        this.lastQrDataUrl = null;
        if (this.readyResolve) this.readyResolve(true);
        this.readyResolve = null;
        this.readyReject = null;
      }
    });

    this.client.on("ready", () => {
      logOk(this.tenantId, "ready");
      if (this._authWatchdogTimer) { clearInterval(this._authWatchdogTimer); this._authWatchdogTimer = null; }
      this.sessionStatus = "connected";
      this.lastError = null;
      this.lastQrDataUrl = null;
      if (this.readyResolve) this.readyResolve(true);
      this.readyResolve = null;
      this.readyReject = null;
    });

    this.client.on("auth_failure", (msg) => {
      logErr(this.tenantId, "auth_failure", msg);
      this.sessionStatus = "error";
      this.lastError = `auth_failure: ${msg}`;
      if (this.readyReject) this.readyReject(new Error(this.lastError));
    });

    this.client.on("disconnected", async (reason) => {
      logErr(this.tenantId, "disconnected", reason);
      if (this._authWatchdogTimer) { clearInterval(this._authWatchdogTimer); this._authWatchdogTimer = null; }
      this.sessionStatus = "error";
      this.lastError = `disconnected: ${reason}`;
      try {
        await this.client?.destroy();
      } catch (e) {
        logErr(this.tenantId, "destroy after disconnect failed", e?.message || String(e));
      }
      this.client = null;
      this.initPromise = null;

      // cria novo ready promise na próxima init
      this.readyPromise = null;
      this.readyResolve = null;
      this.readyReject = null;
      this._authWatchdogRunning = false;
    });

    // marca replies (básico): qualquer msg recebida do número -> replied
    this.client.on("message", (m) => {
      try {
        // m.from = "<digits>@c.us"
        const from = String(m?.from || "");
        const digits = from.replace("@c.us", "").replace(/\D+/g, "");
        if (!digits) return;
        this._upsertStatus(digits, { repliedAt: new Date().toISOString() });
      } catch {}
    });

    this.initPromise = this.client.initialize()
      .then(() => this.client)
      .catch((e) => {
        this.sessionStatus = "error";
        logErr(this.tenantId, "initialize failed", e?.message || String(e));
        this.lastError = e?.message || String(e);
        this.client = null;
        this.initPromise = null;
        throw e;
      });

    return this.initPromise;
  }

  async _getValidChatId(toDigits) {
    const d = String(toDigits || "").replace(/\D+/g, "");
    if (!d) throw new Error("toDigits vazio.");
    try {
      const numberId = await this.client.getNumberId(d);
      if (!numberId) {
        throw new Error("Not on WhatsApp (unregistered).");
      }
      return numberId._serialized;
    } catch (err) {
      throw err;
    }
  }

  async sendTemplateMessage({ toDigits, nome }) {
    const c = await this.initWhatsApp();
    await this._ensureReady();

    this._upsertStatus(toDigits, {
      lastSendAt: new Date().toISOString(),
      ack: 0,
      notOnWhatsapp: false,
      sendError: null,
    });

    const tpl = getTemplate(this.tenantId);
    const msg = String(tpl?.text || "")
      .replace(/\{\{\s*nome\s*\}\}/gi, String(nome || "").trim());
    const msgTrim = String(msg || '').trim();
    if (!msgTrim) throw new Error('Template de mensagem vazio. Configure a mensagem padrão.');

    try {
      const chatId = await this._getValidChatId(toDigits);
      const sent = await c.sendMessage(chatId, msgTrim);

      this._upsertStatus(toDigits, {
        ack: sent?.ack ?? 0,
        messageId: sent?.id?._serialized || null,
        sendError: null,
      });

      return sent;
    } catch (err) {
      const msgError = err?.message || String(err);
      const notOn = /not on whatsapp|unregistered|does not exist/i.test(msgError);

      this._upsertStatus(toDigits, {
        sendError: msgError,
        notOnWhatsapp: notOn,
      });
      throw err;
    }
  }

  async sendCustomMessageText({ toDigits, nome, text }) {
    const c = await this.initWhatsApp();
    await this._ensureReady();

    this._upsertStatus(toDigits, {
      lastSendAt: new Date().toISOString(),
      ack: 0,
      notOnWhatsapp: false,
      sendError: null,
    });

    const msg = String(text || "")
      .replace(/\{\{\s*nome\s*\}\}/gi, String(nome || "").trim());
    const msgTrim = String(msg || '').trim();
    if (!msgTrim) throw new Error('Texto da mensagem vazio após substituições.');

    try {
      const chatId = await this._getValidChatId(toDigits);
      const sent = await c.sendMessage(chatId, msgTrim);

      this._upsertStatus(toDigits, {
        ack: sent?.ack ?? 0,
        messageId: sent?.id?._serialized || null,
        sendError: null,
      });

      return sent;
    } catch (err) {
      const m = err?.message || String(err);
      const notOn = /not on whatsapp|unregistered|does not exist/i.test(m);
      
      this._upsertStatus(toDigits, {
        sendError: m,
        notOnWhatsapp: notOn,
      });
      throw err;
    }
  }

}

const cache = new Map();

function getTenantWA(tenantId) {
  const t = String(tenantId || "").trim() || "admin";
  if (!cache.has(t)) cache.set(t, new TenantWhatsApp(t));
  return cache.get(t);
}

async function sendTemplateMessage(tenantId, { toDigits, nome } = {}) {
  const wa = getTenantWA(tenantId);
  return wa.sendTemplateMessage({ toDigits, nome });
}

async function sendCustomMessage(tenantId, { toDigits, nome, text } = {}) {
  const wa = getTenantWA(tenantId);
  const t = String(text || "").trim();
  if (!t) throw new Error("Texto da mensagem vazio (sendCustomMessage).");
  return wa.sendCustomMessageText({ toDigits, nome, text: t });
}

module.exports = {
  isWhatsAppConfigured,
  computeLeadStatus,
  getTenantWA,
  sendTemplateMessage,
  sendCustomMessage,
};