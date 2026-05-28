// src/whatsappManager.js
const fs = require("fs");
const path = require("path");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const QRCode = require("qrcode");

const DEBUG = String(process.env.DEBUG || "").toLowerCase() === "true" || process.env.DEBUG === "1";
const logOk = (tenant, msg, extra) => { if (!DEBUG) return; console.log(`[OK][wa:${tenant}] ${msg}`, extra || ""); };
const logErr = (tenant, msg, extra) => { console.error(`[ERROR][wa:${tenant}] ${msg}`, extra || ""); };
const { ensureTenantDir, tenantDir } = require("./tenantPaths");
const { getTemplate } = require("./messageTemplateStore");
const {
  appendConversationMessage,
  upsertConversationMessages,
  listConversationMessages,
  getLastConversationMessage,
  saveConversationMedia,
  flushAllConversationStores,
} = require("./tenantConversationStore");

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

const ACK = Object.freeze({
  ERROR: -1,
  PENDING: 0,
  SERVER: 1,
  DEVICE: 2,
  READ: 3,
  PLAYED: 4,
});

function toMs(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function isAck(value) {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

function normalizeAck(value, fallback = ACK.PENDING) {
  if (!isAck(value)) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function hasOutboundAttempt(t) {
  if (!t) return false;
  return Boolean(
    t.lastSendAt ||
    t.messageId ||
    t.lastMessageId ||
    t.sendError ||
    isAck(t.ack) ||
    t.notOnWhatsapp === true
  );
}

function isReplyAfterOutbound(t) {
  if (!t || !t.repliedAt) return false;
  if (!hasOutboundAttempt(t)) return false;

  const sendTs = toMs(t.lastSendAt);
  const replyTs = toMs(t.repliedAt);

  // Se não temos lastSendAt, só considera reply quando há evidência de disparo salvo.
  if (!sendTs) return Boolean(t.messageId || t.lastMessageId);
  if (!replyTs) return false;

  // tolerância pequena para diferenças de relógio/processamento.
  return replyTs + 5000 >= sendTs;
}

function computeLeadStatus(ms, { notDeliveredAfterMs } = {}) {
  const t = ms || null;
  if (!t) return "none";

  if (t.notOnWhatsapp || t.isRegistered === false) return "notExists";

  const outbound = hasOutboundAttempt(t);
  if (!outbound) return "none";

  if (isReplyAfterOutbound(t)) return "replied";

  const ack = isAck(t.ack) ? normalizeAck(t.ack, ACK.PENDING) : null;

  // ACK_DEVICE, ACK_READ e ACK_PLAYED significam que chegou ao dispositivo/leitura.
  if (ack != null && ack >= ACK.DEVICE) return "delivered";

  // Erro explícito de envio não deve esperar timeout.
  if (ack === ACK.ERROR || t.sendError) return "notDelivered";

  if (t.lastSendAt) {
    const sendTs = toMs(t.lastSendAt);
    const timeout = Number.isFinite(notDeliveredAfterMs) ? notDeliveredAfterMs : 30 * 60 * 1000;
    if (sendTs && Date.now() - sendTs >= timeout) return "notDelivered";
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

  _normalizeDigits(toDigits) {
    return String(toDigits || "").replace(/\D+/g, "");
  }

  _upsertStatus(toDigits, patch) {
    const d = this._normalizeDigits(toDigits);
    if (!d) return null;
    const prev = this.statusMap[d] || { toDigits: d };
    const next = { ...prev, ...patch, toDigits: d, updatedAt: new Date().toISOString() };
    this.statusMap[d] = next;
    this._scheduleSave();
    return next;
  }

  _getMessageId(message) {
    return String(
      message?.id?._serialized ||
      message?.id?.id ||
      message?.rawData?.id?._serialized ||
      ""
    ).trim();
  }

  _getRemoteIdFromMessage(message) {
    const fromMe = Boolean(message?.fromMe || message?.id?.fromMe || message?.rawData?.id?.fromMe);
    return String(
      (fromMe ? message?.to : message?.from) ||
      message?.id?.remote ||
      (fromMe ? message?.rawData?.to?._serialized : message?.rawData?.from?._serialized) ||
      message?.rawData?.id?.remote ||
      ""
    ).trim();
  }

  _digitsFromWaId(waId) {
    const id = String(waId || "").trim();
    if (!id) return "";
    if (/@g\.us/i.test(id) || /status@broadcast/i.test(id)) return "";
    // IDs @lid não são telefone. Usa apenas se já houver match por chatId/messageId.
    if (/@lid/i.test(id)) return "";
    return id.split("@")[0].replace(/\D+/g, "");
  }

  _findDigitsByMessageId(messageId) {
    const id = String(messageId || "").trim();
    if (!id) return "";
    for (const [digits, row] of Object.entries(this.statusMap || {})) {
      if (!row) continue;
      if (row.messageId === id || row.lastMessageId === id) return digits;
    }
    return "";
  }

  _findDigitsByChatId(chatId) {
    const id = String(chatId || "").trim();
    if (!id) return "";
    for (const [digits, row] of Object.entries(this.statusMap || {})) {
      if (!row) continue;
      if (row.chatId === id || row.waId === id || row.lastRemoteId === id) return digits;
    }
    return "";
  }

  _resolveDigitsForMessage(message) {
    const messageId = this._getMessageId(message);
    const byMessageId = this._findDigitsByMessageId(messageId);
    if (byMessageId) return byMessageId;

    const remoteId = this._getRemoteIdFromMessage(message);
    const byChatId = this._findDigitsByChatId(remoteId);
    if (byChatId) return byChatId;

    return this._digitsFromWaId(remoteId);
  }

  _isAudioMessage(message, fallback = {}) {
    const type = String(message?.type || fallback.type || '').toLowerCase();
    const mime = String(message?.mimetype || message?.mediaMime || fallback.mimetype || fallback.mediaMime || '').toLowerCase();
    return type === 'audio' || type === 'ptt' || mime.startsWith('audio/');
  }

  _messageToConversationRecord(message, fallback = {}) {
    if (!message) return null;
    const audio = this._isAudioMessage(message, fallback);
    let body = String(message.body || fallback.body || '').trim();
    if (!body && audio) body = 'Áudio';
    const hasMedia = Boolean(message.hasMedia || fallback.hasMedia || fallback.mediaFile || audio);
    if (!body && !hasMedia) return null;

    const ts = Number(message.timestamp || fallback.timestamp || Math.floor(Date.now() / 1000));
    const rec = {
      id: this._getMessageId(message) || fallback.id || fallback.messageId || '',
      fromMe: Boolean(message.fromMe || message.id?.fromMe || fallback.fromMe),
      body,
      type: String(message.type || fallback.type || (audio ? 'audio' : 'chat')),
      timestamp: ts,
      createdAt: ts ? new Date(ts * 1000).toISOString() : (fallback.createdAt || new Date().toISOString()),
      ack: isAck(message.ack) ? normalizeAck(message.ack, ACK.PENDING) : (fallback.ack ?? null),
      source: fallback.source || 'whatsapp-web',
    };

    if (hasMedia || audio || fallback.mediaFile) {
      rec.hasMedia = true;
      rec.mediaKind = fallback.mediaKind || (audio ? 'audio' : 'media');
      if (fallback.mediaMime || message.mimetype) rec.mediaMime = fallback.mediaMime || message.mimetype;
      if (fallback.mediaFile) rec.mediaFile = fallback.mediaFile;
      if (fallback.mediaSize) rec.mediaSize = fallback.mediaSize;
      if (fallback.duration) rec.duration = fallback.duration;
      if (fallback.filename) rec.filename = fallback.filename;
    }

    return rec;
  }

  async _messageToConversationRecordWithMedia(message, fallback = {}, toDigits = '') {
    const rec = this._messageToConversationRecord(message, fallback);
    if (!rec) return null;
    if (!this._isAudioMessage(message, rec)) return rec;
    if (rec.mediaFile) return rec;

    try {
      if (!message || !message.hasMedia || typeof message.downloadMedia !== 'function') return rec;
      const media = await message.downloadMedia();
      if (!media || !media.data) return rec;
      const mimetype = String(media.mimetype || rec.mediaMime || '').trim() || 'audio/ogg; codecs=opus';
      if (!/^audio\//i.test(mimetype)) return rec;
      const saved = saveConversationMedia(this.tenantId, {
        toDigits,
        messageId: rec.id || `${rec.fromMe ? 'out' : 'in'}_${rec.timestamp}`,
        mimetype,
        data: media.data,
        filename: media.filename || rec.id || undefined,
      });
      return {
        ...rec,
        body: rec.body || 'Áudio',
        hasMedia: true,
        mediaKind: 'audio',
        mediaMime: mimetype,
        mediaFile: saved.fileName,
        mediaSize: saved.size,
        filename: media.filename || rec.filename || saved.fileName,
      };
    } catch (e) {
      logErr(this.tenantId, 'download audio media failed', e?.message || String(e));
      return rec;
    }
  }

  _appendConversationFromMessage(toDigits, message, fallback = {}) {
    const digits = this._normalizeDigits(toDigits) || this._resolveDigitsForMessage(message);
    if (!digits) return null;
    const rec = this._messageToConversationRecord(message, fallback);
    if (!rec) return null;
    const saved = appendConversationMessage(this.tenantId, digits, rec);

    if (this._isAudioMessage(message, rec)) {
      this._messageToConversationRecordWithMedia(message, rec, digits)
        .then((enriched) => {
          if (enriched && enriched.mediaFile) upsertConversationMessages(this.tenantId, digits, [enriched]);
        })
        .catch((e) => logErr(this.tenantId, 'async audio cache failed', e?.message || String(e)));
    }

    return saved;
  }

  _markAck(message, ackValue) {
    const messageId = this._getMessageId(message);
    const remoteId = this._getRemoteIdFromMessage(message);
    const digits = this._resolveDigitsForMessage(message);
    if (!digits) return;

    const prev = this.statusMap[digits] || { toDigits: digits };

    // Evita um ACK atrasado de uma mensagem antiga rebaixar a última mensagem enviada ao lead.
    if (messageId && prev.messageId && prev.messageId !== messageId && prev.lastMessageId !== messageId) {
      return;
    }

    const incomingAck = normalizeAck(ackValue, ACK.PENDING);
    const previousAck = isAck(prev.ack) ? normalizeAck(prev.ack, ACK.PENDING) : ACK.PENDING;
    const ack = Math.max(previousAck, incomingAck);
    const now = new Date().toISOString();

    const patch = {
      ack,
      lastAck: ack,
      lastAckAt: now,
      lastRemoteId: remoteId || prev.lastRemoteId || null,
      messageId: prev.messageId || messageId || null,
      lastMessageId: messageId || prev.lastMessageId || null,
    };

    if (ack >= ACK.DEVICE && !prev.deliveredAt) patch.deliveredAt = now;
    if (ack >= ACK.READ && !prev.readAt) patch.readAt = now;
    if (ack === ACK.ERROR) {
      patch.failedAt = now;
      patch.sendError = prev.sendError || "WhatsApp retornou ACK_ERROR para a mensagem.";
    }

    this._upsertStatus(digits, patch);
  }

  _isTrackableDirectMessage(message) {
    if (!message) return false;
    if (message.isStatus || message.broadcast) return false;
    const remoteId = this._getRemoteIdFromMessage(message);
    if (!remoteId) return false;
    if (/@g\.us/i.test(remoteId) || /status@broadcast/i.test(remoteId)) return false;
    return Boolean(String(message.body || '').trim()) || this._isAudioMessage(message, message) || Boolean(message.hasMedia);
  }

  _markIncomingMessage(message) {
    if (!message || message.fromMe) return;
    if (!this._isTrackableDirectMessage(message)) return;

    const remoteId = this._getRemoteIdFromMessage(message);
    const digits = this._resolveDigitsForMessage(message);
    if (!digits) return;

    const prev = this.statusMap[digits] || { toDigits: digits };
    const now = new Date().toISOString();
    const patch = {
      lastIncomingAt: now,
      lastRemoteId: remoteId || prev.lastRemoteId || null,
      chatId: remoteId || prev.chatId || null,
      waId: remoteId || prev.waId || null,
      isRegistered: true,
      checkedAt: now,
    };

    const sendTs = toMs(prev.lastSendAt);
    if (sendTs && Date.now() + 5000 >= sendTs) {
      patch.repliedAt = now;
    }

    this._appendConversationFromMessage(digits, message, { fromMe: false, source: 'incoming-event' });
    this._upsertStatus(digits, patch);
  }

  _markOutgoingCreatedMessage(message) {
    if (!message || !message.fromMe) return;
    if (!this._isTrackableDirectMessage(message)) return;

    const remoteId = this._getRemoteIdFromMessage(message);
    const digits = this._resolveDigitsForMessage(message);
    if (!digits) return;

    const messageId = this._getMessageId(message);
    const now = new Date().toISOString();
    this._appendConversationFromMessage(digits, message, {
      id: messageId,
      fromMe: true,
      source: 'outgoing-external-event',
    });

    const ack = isAck(message.ack) ? normalizeAck(message.ack, ACK.PENDING) : ACK.PENDING;
    const patch = {
      lastSendAt: now,
      ack,
      lastAck: ack,
      lastAckAt: now,
      isRegistered: true,
      checkedAt: now,
      sendError: null,
      notOnWhatsapp: false,
    };
    if (messageId) {
      patch.messageId = messageId;
      patch.lastMessageId = messageId;
    }
    if (remoteId) {
      patch.lastRemoteId = remoteId;
      patch.chatId = remoteId;
      patch.waId = remoteId;
    }
    this._upsertStatus(digits, patch);
  }

  _recordCreatedMessage(message) {
    if (!this._isTrackableDirectMessage(message)) return;
    if (message.fromMe) {
      this._markOutgoingCreatedMessage(message);
    } else {
      this._markIncomingMessage(message);
    }
  }

  getMessageStatusFor(toDigits) {
    const d = String(toDigits || "").replace(/\D+/g, "");
    return d ? (this.statusMap[d] || null) : null;
  }

  deleteMessageStatusFor(toDigits) {
    const d = String(toDigits || "").replace(/\D+/g, "");
    if (!d || !this.statusMap || !Object.prototype.hasOwnProperty.call(this.statusMap, d)) {
      return false;
    }

    delete this.statusMap[d];
    this._scheduleSave();
    return true;
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

    // Atualiza entrega real a partir do evento oficial de ACK do whatsapp-web.js.
    this.client.on("message_ack", (message, ack) => {
      try {
        this._markAck(message, ack);
      } catch (e) {
        logErr(this.tenantId, "message_ack handler failed", e?.message || String(e));
      }
    });

    // Captura mensagens recebidas nesta sessão do WhatsApp Web.
    this.client.on("message", (message) => {
      try {
        this._markIncomingMessage(message);
      } catch (e) {
        logErr(this.tenantId, "message handler failed", e?.message || String(e));
      }
    });

    // Captura toda mensagem criada no WhatsApp Web, inclusive as enviadas fora do painel
    // pelo celular ou por outra aba do WhatsApp Web vinculada à mesma conta.
    this.client.on("message_create", (message) => {
      try {
        this._recordCreatedMessage(message);
      } catch (e) {
        logErr(this.tenantId, "message_create handler failed", e?.message || String(e));
      }
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
      this._upsertStatus(toDigits, {
        chatId,
        waId: chatId,
        isRegistered: true,
        checkedAt: new Date().toISOString(),
      });

      const sent = await c.sendMessage(chatId, msgTrim);
      const messageId = sent?.id?._serialized || null;

      this._upsertStatus(toDigits, {
        ack: normalizeAck(sent?.ack, ACK.PENDING),
        lastAck: normalizeAck(sent?.ack, ACK.PENDING),
        lastAckAt: new Date().toISOString(),
        messageId,
        lastMessageId: messageId,
        chatId,
        waId: chatId,
        sendError: null,
      });

      this._appendConversationFromMessage(toDigits, sent, {
        id: messageId,
        fromMe: true,
        body: msgTrim,
        ack: normalizeAck(sent?.ack, ACK.PENDING),
        source: 'send-template',
      });

      return sent;
    } catch (err) {
      const msgError = err?.message || String(err);
      const notOn = /not on whatsapp|unregistered|does not exist/i.test(msgError);

      this._upsertStatus(toDigits, {
        sendError: msgError,
        notOnWhatsapp: notOn,
        notOnWhatsappAt: notOn ? new Date().toISOString() : null,
        isRegistered: notOn ? false : undefined,
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
      this._upsertStatus(toDigits, {
        chatId,
        waId: chatId,
        isRegistered: true,
        checkedAt: new Date().toISOString(),
      });

      const sent = await c.sendMessage(chatId, msgTrim);
      const messageId = sent?.id?._serialized || null;

      this._upsertStatus(toDigits, {
        ack: normalizeAck(sent?.ack, ACK.PENDING),
        lastAck: normalizeAck(sent?.ack, ACK.PENDING),
        lastAckAt: new Date().toISOString(),
        messageId,
        lastMessageId: messageId,
        chatId,
        waId: chatId,
        sendError: null,
      });

      this._appendConversationFromMessage(toDigits, sent, {
        id: messageId,
        fromMe: true,
        body: msgTrim,
        ack: normalizeAck(sent?.ack, ACK.PENDING),
        source: 'send-custom',
      });

      return sent;
    } catch (err) {
      const m = err?.message || String(err);
      const notOn = /not on whatsapp|unregistered|does not exist/i.test(m);
      
      this._upsertStatus(toDigits, {
        sendError: m,
        notOnWhatsapp: notOn,
        notOnWhatsappAt: notOn ? new Date().toISOString() : null,
        isRegistered: notOn ? false : undefined,
      });
      throw err;
    }
  }

  async sendCustomAudioMessage({ toDigits, audioBase64, mimetype, filename = 'audio.webm' } = {}) {
    const c = await this.initWhatsApp();
    await this._ensureReady();

    let rawAudio = String(audioBase64 || '').trim();
    let detectedMime = '';
    const dataUrlMatch = rawAudio.match(/^data:([^,]+);base64,(.*)$/is);
    if (dataUrlMatch) {
      detectedMime = String(dataUrlMatch[1] || '').trim();
      rawAudio = String(dataUrlMatch[2] || '').trim();
    }

    // O whatsapp-web.js repassa MessageMedia.data para o WhatsApp Web,
    // que usa atob(). Por isso salvamos/enviamos Base64 canônico, não DataURL,
    // não URL-safe e sem quebras, espaços ou caracteres invisíveis.
    let cleanBase64 = rawAudio
      .replace(/^data:[^,]+,/, '')
      .replace(/\s+/g, '')
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    if (!cleanBase64) throw new Error('Áudio vazio. Grave novamente e tente enviar.');
    cleanBase64 = cleanBase64.replace(/[^A-Za-z0-9+/=]/g, '');
    const remainder = cleanBase64.length % 4;
    if (remainder) cleanBase64 += '='.repeat(4 - remainder);

    let audioBuffer = null;
    try {
      audioBuffer = Buffer.from(cleanBase64, 'base64');
    } catch {
      throw new Error('Áudio inválido. Grave novamente e tente enviar.');
    }
    if (!audioBuffer || audioBuffer.length < 100) {
      throw new Error('Áudio inválido ou muito curto. Grave novamente e tente enviar.');
    }
    cleanBase64 = audioBuffer.toString('base64');

    let mime = String(mimetype || detectedMime || 'audio/webm').trim();
    if (detectedMime && (!mimetype || !/^audio\//i.test(String(mimetype)))) mime = detectedMime;
    mime = mime.split(';')[0].trim().toLowerCase() || 'audio/webm';
    if (!/^audio\//i.test(mime)) throw new Error('Formato de áudio inválido.');

    const approxBytes = audioBuffer.length;
    if (approxBytes > 16 * 1024 * 1024) throw new Error('Áudio muito grande. Grave um áudio menor.');

    this._upsertStatus(toDigits, {
      lastSendAt: new Date().toISOString(),
      ack: 0,
      notOnWhatsapp: false,
      sendError: null,
    });

    try {
      const chatId = await this._getValidChatId(toDigits);
      this._upsertStatus(toDigits, {
        chatId,
        waId: chatId,
        isRegistered: true,
        checkedAt: new Date().toISOString(),
      });

      const safeFilename = String(filename || `audio.${mime.includes('ogg') ? 'ogg' : mime.includes('mpeg') ? 'mp3' : 'webm'}`).replace(/[^a-zA-Z0-9_.-]+/g, '_');
      const media = new MessageMedia(mime, cleanBase64, safeFilename);
      let sent;
      let sentAsVoice = true;

      try {
        sent = await c.sendMessage(chatId, media, { sendAudioAsVoice: true });
      } catch (voiceErr) {
        // Alguns ambientes/formatos gravados pelo navegador saem em WebM.
        // Quando o WhatsApp Web não aceita como nota de voz, enviamos como áudio normal.
        sentAsVoice = false;
        logErr(this.tenantId, 'sendAudioAsVoice failed; retrying as regular audio', voiceErr?.message || String(voiceErr));
        sent = await c.sendMessage(chatId, media, { sendAudioAsVoice: false });
      }

      const messageId = sent?.id?._serialized || null;
      const ack = normalizeAck(sent?.ack, ACK.PENDING);

      const saved = saveConversationMedia(this.tenantId, {
        toDigits,
        messageId: messageId || `out_${Date.now()}`,
        mimetype: mime,
        data: cleanBase64,
        filename: messageId || safeFilename || undefined,
      });

      const rec = {
        id: messageId || `out_${Date.now()}`,
        fromMe: true,
        body: sentAsVoice ? 'Áudio de voz' : 'Áudio',
        type: sentAsVoice ? 'ptt' : 'audio',
        timestamp: Math.floor(Date.now() / 1000),
        createdAt: new Date().toISOString(),
        ack,
        source: sentAsVoice ? 'send-audio-voice' : 'send-audio-file',
        hasMedia: true,
        mediaKind: 'audio',
        mediaMime: mime,
        mediaFile: saved.fileName,
        mediaSize: saved.size,
      };
      upsertConversationMessages(this.tenantId, toDigits, [rec]);

      this._upsertStatus(toDigits, {
        ack,
        lastAck: ack,
        lastAckAt: new Date().toISOString(),
        messageId,
        lastMessageId: messageId,
        chatId,
        waId: chatId,
        sendError: null,
      });

      return { sent, message: rec };
    } catch (err) {
      const raw = err?.message || String(err);
      const m = raw && raw.length <= 2 ? 'O WhatsApp Web recusou o áudio gravado. Tente gravar novamente ou atualize o WhatsApp conectado.' : raw;
      const notOn = /not on whatsapp|unregistered|does not exist/i.test(m);
      this._upsertStatus(toDigits, {
        sendError: m,
        notOnWhatsapp: notOn,
        notOnWhatsappAt: notOn ? new Date().toISOString() : null,
        isRegistered: notOn ? false : undefined,
      });
      throw new Error(m);
    }
  }

  async getChatTextMessages({ toDigits, limit = 60 } = {}) {
    const c = await this.initWhatsApp();
    await this._ensureReady();

    const safeLimit = Math.max(1, Math.min(200, Number(limit || 60)));
    const chatId = await this._getValidChatId(toDigits);
    let chat = null;
    let messages = [];

    try {
      chat = await c.getChatById(chatId);
      messages = await chat.fetchMessages({ limit: safeLimit });
    } catch (e) {
      // Número válido, mas o WhatsApp Web nem sempre entrega histórico via fetchMessages.
      // Nesse caso usamos o histórico local salvo pelo painel/eventos.
      this._upsertStatus(toDigits, {
        chatId,
        waId: chatId,
        isRegistered: true,
        checkedAt: new Date().toISOString(),
      });
      return listConversationMessages(this.tenantId, toDigits, safeLimit);
    }

    this._upsertStatus(toDigits, {
      chatId,
      waId: chatId,
      isRegistered: true,
      checkedAt: new Date().toISOString(),
      unreadCount: Number(chat.unreadCount || 0),
    });

    const candidates = (Array.isArray(messages) ? messages : [])
      .filter((m) => {
        if (!m || m.isStatus || m.broadcast) return false;
        return Boolean(String(m.body || '').trim()) || this._isAudioMessage(m, m) || Boolean(m.hasMedia);
      });

    const fetched = (await Promise.all(candidates.map((m) =>
      this._messageToConversationRecordWithMedia(m, { source: 'fetchMessages' }, toDigits)
    ))).filter(Boolean);

    if (fetched.length) upsertConversationMessages(this.tenantId, toDigits, fetched);

    return listConversationMessages(this.tenantId, toDigits, safeLimit);
  }

  async getChatsSnapshotForDigits(toDigitsList = [], opts = {}) {
    const out = {};
    const includeAll = Boolean(opts && opts.includeAll);
    const digitsWanted = new Set((Array.isArray(toDigitsList) ? toDigitsList : [])
      .map((x) => this._normalizeDigits(x))
      .filter(Boolean));

    if (!includeAll && !digitsWanted.size) return out;
    const canReadRemoteChats = this.client && this.sessionStatus === 'connected';

    if (canReadRemoteChats) {
      try {
        const chats = await this.client.getChats();
        for (const chat of Array.isArray(chats) ? chats : []) {
          const chatId = String(chat?.id?._serialized || chat?.id || '').trim();
          if (!chatId || /@g\.us/i.test(chatId) || /status@broadcast/i.test(chatId)) continue;

          const digits = this._digitsFromWaId(chatId);
          if (!digits) continue;
          if (!includeAll && digitsWanted.size && !digitsWanted.has(digits)) continue;

          const last = chat?.lastMessage || null;
          const ts = Number(last?.timestamp || 0);
          const displayName = String(chat?.name || chat?.formattedTitle || '').trim();
          const lastIsAudio = last ? this._isAudioMessage(last, last) : false;
          const lastBody = String(last?.body || '').trim() || (lastIsAudio ? 'Áudio' : '');
          const lastMessage = last && lastBody ? {
            id: this._getMessageId(last) || '',
            body: lastBody,
            fromMe: Boolean(last.fromMe || last.id?.fromMe),
            timestamp: ts,
            createdAt: ts ? new Date(ts * 1000).toISOString() : null,
            source: 'chat-snapshot',
            hasMedia: Boolean(last.hasMedia || lastIsAudio),
            mediaKind: lastIsAudio ? 'audio' : undefined,
          } : null;

          if (lastMessage) {
            this._appendConversationFromMessage(digits, last, {
              id: lastMessage.id,
              fromMe: lastMessage.fromMe,
              body: lastMessage.body,
              timestamp: lastMessage.timestamp,
              createdAt: lastMessage.createdAt,
              source: 'chat-snapshot',
            });
          }

          out[digits] = {
            chatId,
            displayName: displayName || null,
            unreadCount: Number(chat?.unreadCount || 0),
            archived: Boolean(chat?.archived),
            pinned: Boolean(chat?.pinned),
            lastMessage,
          };
        }
      } catch (e) {
        logErr(this.tenantId, 'getChatsSnapshotForDigits failed', e?.message || String(e));
      }
    }

    const digitsForLocalFallback = includeAll ? Array.from(new Set([...digitsWanted, ...Object.keys(out)])) : Array.from(digitsWanted);
    for (const digits of digitsForLocalFallback) {
      const localLast = getLastConversationMessage(this.tenantId, digits);
      if (!localLast) continue;
      const existing = out[digits] || {};
      const localTime = Number(localLast.timestamp || 0) || (new Date(localLast.createdAt || 0).getTime() / 1000) || 0;
      const remoteTime = Number(existing?.lastMessage?.timestamp || 0) || (new Date(existing?.lastMessage?.createdAt || 0).getTime() / 1000) || 0;
      if (!existing.lastMessage || localTime >= remoteTime) {
        out[digits] = {
          ...existing,
          lastMessage: {
            body: localLast.body,
            fromMe: Boolean(localLast.fromMe),
            timestamp: localTime,
            createdAt: localLast.createdAt || (localTime ? new Date(localTime * 1000).toISOString() : null),
            hasMedia: Boolean(localLast.hasMedia),
            mediaKind: localLast.mediaKind || undefined,
          },
        };
      }
    }

    return out;
  }


  async destroy() {
    if (this._authWatchdogTimer) {
      clearInterval(this._authWatchdogTimer);
      this._authWatchdogTimer = null;
    }

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      try {
        fs.writeFileSync(this.STATUS_FILE, JSON.stringify(this.statusMap, null, 2), "utf-8");
      } catch (e) {
        logErr(this.tenantId, "flush status before destroy failed", e?.message || String(e));
      }
    }

    try {
      await this.client?.destroy();
    } catch (e) {
      logErr(this.tenantId, "destroy failed", e?.message || String(e));
    }

    this.client = null;
    this.initPromise = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.sessionStatus = "idle";
  }

}

const cache = new Map();

function getTenantWA(tenantId) {
  const t = String(tenantId || "").trim() || "admin";
  if (!cache.has(t)) cache.set(t, new TenantWhatsApp(t));
  return cache.get(t);
}

async function getChatTextMessages(tenantId, { toDigits, limit } = {}) {
  const wa = getTenantWA(tenantId);
  return wa.getChatTextMessages({ toDigits, limit });
}

async function getChatsSnapshotForDigits(tenantId, toDigitsList = [], opts = {}) {
  const wa = getTenantWA(tenantId);
  return wa.getChatsSnapshotForDigits(toDigitsList, opts);
}

async function destroyCachedWhatsAppClients() {
  flushAllConversationStores();
  const clients = [...cache.values()];
  await Promise.allSettled(clients.map((wa) => wa.destroy()));
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

async function sendCustomAudioMessage(tenantId, { toDigits, audioBase64, mimetype, filename } = {}) {
  const wa = getTenantWA(tenantId);
  return wa.sendCustomAudioMessage({ toDigits, audioBase64, mimetype, filename });
}

module.exports = {
  isWhatsAppConfigured,
  computeLeadStatus,
  getTenantWA,
  sendTemplateMessage,
  sendCustomMessage,
  sendCustomAudioMessage,
  getChatTextMessages,
  getChatsSnapshotForDigits,
  destroyCachedWhatsAppClients,
};