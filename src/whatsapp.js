// src/whatsapp.js
const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");

let client = null;
let initPromise = null;

let lastQrDataUrl = null;
let sessionStatus = "idle"; // idle | starting | qr | connected | error
let lastError = null;

let readyPromise = null;
let readyResolve = null;
let readyReject = null;

/** ===== persistência (status) ===== */
const DATA_DIR = path.join(__dirname, "..", "data");
const STATUS_FILE = path.join(DATA_DIR, "message_status.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadStatusMap() {
  ensureDataDir();
  if (!fs.existsSync(STATUS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

// guarda em memória e salva com debounce
let statusMap = loadStatusMap();
let saveTimer = null;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      ensureDataDir();
      fs.writeFileSync(STATUS_FILE, JSON.stringify(statusMap, null, 2), "utf-8");
    } catch (e) {
      console.error("⚠️ Falha ao salvar message_status.json:", e?.message || e);
    }
  }, 1200);
}

function upsertStatus(toDigits, patch) {
  if (!toDigits) return null;
  const prev = statusMap[toDigits] || { toDigits };
  const next = { ...prev, ...patch, toDigits, updatedAt: new Date().toISOString() };
  statusMap[toDigits] = next;
  scheduleSave();
  return next;
}

function getMessageStatusFor(toDigits) {
  if (!toDigits) return null;
  return statusMap[toDigits] || null;
}

function listStatus() {
  return Object.values(statusMap);
}

function isWhatsAppConfigured() {
  return process.env.WEBJS_ENABLED === "1";
}

function toChatId(toDigits) {
  return `${toDigits}@c.us`;
}

function ensureReady() {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  return readyPromise;
}

function hardReset(reason) {
  console.error("♻️ WhatsApp reset:", reason);
  client = null;
  initPromise = null;
  readyPromise = null;
  readyResolve = null;
  readyReject = null;
  sessionStatus = "qr";
  lastError = String(reason || "reset");
}

/**
 * Converte status salvo em um status “do lead” para filtro:
 * - replied
 * - notExists
 * - delivered
 * - notDelivered
 * - pending (tentou enviar mas ainda sem confirmação e sem timeout)
 * - none (nunca tentou)
 */
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

function getWhatsAppStatus() {
  return {
    enabled: isWhatsAppConfigured(),
    status: sessionStatus,
    lastError,
    hasQr: !!lastQrDataUrl,
    webVersion: process.env.WEBJS_WEB_VERSION,
  };
}

function getLatestQr() {
  return lastQrDataUrl;
}

/** stats agregadas (igual teu KPI) */
function getMessageStats({ notDeliveredAfterMin } = {}) {
  const notDeliveredAfterMs = Math.max(1, Number(notDeliveredAfterMin || 30)) * 60 * 1000;
  const rows = listStatus();
  const now = Date.now();

  let replied = 0;
  let deliveredNoReply = 0;
  let notDelivered = 0;
  let notOnWhatsapp = 0;

  for (const r of rows) {
    if (r.notOnWhatsapp) {
      notOnWhatsapp++;
      continue;
    }
    if (!r.lastSendAt) continue;

    if (r.repliedAt) {
      replied++;
      continue;
    }

    const ack = Number.isFinite(r.ack) ? r.ack : -1;
    if (ack >= 2) {
      deliveredNoReply++;
      continue;
    }

    const age = now - new Date(r.lastSendAt).getTime();
    if (age >= notDeliveredAfterMs) notDelivered++;
  }

  return {
    replied,
    deliveredNoReply,
    notDelivered,
    notOnWhatsapp,
    totalTracked: rows.length,
    notDeliveredAfterMin: Math.round(notDeliveredAfterMs / 60000),
  };
}

async function initWhatsApp() {
  if (!isWhatsAppConfigured()) {
    sessionStatus = "error";
    lastError = "WEBJS_ENABLED!=1";
    throw new Error("WEBJS desabilitado (WEBJS_ENABLED!=1).");
  }

  if (client) return client;
  if (initPromise) return initPromise;

  sessionStatus = "starting";
  lastError = null;

  const authId = process.env.WEBJS_SESSION || "lead-bot";
  const headless = process.env.WEBJS_HEADLESS !== "0";
  const executablePath = process.env.CHROME_EXECUTABLE_PATH || undefined;

  const webVersion = (process.env.WEBJS_WEB_VERSION || "").trim() || undefined;

const remoteCacheEnabled = process.env.WEBJS_REMOTE_CACHE === "1";
const remotePathTpl = (process.env.WEBJS_REMOTE_PATH || "").trim();
const remoteStrict = process.env.WEBJS_REMOTE_STRICT === "1";

const webVersionCache =
  remoteCacheEnabled && webVersion && remotePathTpl
    ? {
        type: "remote",
        remotePath: remotePathTpl.replace("{version}", webVersion),
        strict: remoteStrict,
      }
    : undefined;

const noSandbox = process.env.WEBJS_NO_SANDBOX === "1";

  initPromise = (async () => {
    try {
      client = new Client({
  authStrategy: new LocalAuth({ clientId: authId }),

  // ✅ trava a versão do WhatsApp Web (evita markedUnread quebrando do nada)
  webVersion,

  // ✅ usa cache remoto do wppconnect-team/wa-version (como teu .env antigo)
  webVersionCache,

  puppeteer: {
    headless,
    executablePath,
    args: noSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  },
});

      client.on("qr", async (qr) => {
        try {
          sessionStatus = "qr";
          lastQrDataUrl = await QRCode.toDataURL(qr);
        } catch (e) {
          console.error("QR render fail:", e?.message || e);
        }
      });

      client.on("ready", () => {
        sessionStatus = "connected";
        lastError = null;
        lastQrDataUrl = null;
        if (readyResolve) readyResolve(true);
      });

      client.on("auth_failure", (msg) => {
        sessionStatus = "error";
        lastError = "auth_failure: " + String(msg || "");
        if (readyReject) readyReject(new Error(lastError));
      });

      client.on("disconnected", (reason) => {
        hardReset("disconnected: " + String(reason || ""));
      });

      // ack updates (entregue/lido)
      client.on("message_ack", (msg, ack) => {
        try {
          const toDigits = String(msg?.to || "")
            .replace("@c.us", "")
            .replace(/\D+/g, "");
          if (!toDigits) return;
          upsertStatus(toDigits, { ack, lastAckAt: new Date().toISOString() });
        } catch {}
      });

      // replies
      client.on("message", (msg) => {
        try {
          // msg.from = quem enviou (lead)
          const fromDigits = String(msg?.from || "")
            .replace("@c.us", "")
            .replace(/\D+/g, "");
          if (!fromDigits) return;
          upsertStatus(fromDigits, { repliedAt: new Date().toISOString() });
        } catch {}
      });

      await client.initialize();

      // garante readyPromise
      ensureReady();

      return client;
    } catch (e) {
      sessionStatus = "error";
      lastError = e?.message || String(e);
      hardReset(lastError);
      throw e;
    }
  })();

  return initPromise;
}

/**
 * Envia template simples (texto). Atualiza statusMap:
 * - lastSendAt
 * - ack (zera)
 * - notOnWhatsapp (se detectar erro)
 */
async function sendTemplateMessage({ toDigits, nome }) {
  const c = await initWhatsApp();
  await ensureReady();

  const chatId = toChatId(toDigits);

  // marca tentativa de envio
  upsertStatus(toDigits, {
    lastSendAt: new Date().toISOString(),
    ack: 0,
    notOnWhatsapp: false,
    sendError: null,
  });

  const text = `Olá, bom dia ${nome || ""}! Tudo bem?

O Programa Escale com Google e Inteligência Artificial é um evento presencial, 100% prático, pensado para empresários que querem tomar decisões melhores nos anúncios, ganhar previsibilidade nas vendas e escalar com mais lucro em 2026.

Durante o evento, você vai ver na prática:

* Como usar Google Ads com Inteligência Artificial;
* Novas campanhas e públicos inteligentes para atrair clientes mais qualificados;
* Como usar agentes de IA como sócios inteligentes para tomar decisões melhores no negócio;
* Como ser indicado pelo ChatGPT, Gemini e outras IAs sem pagar nada.

Você sairá com um plano de ação claro, pronto para aplicar no seu negócio e escalar em 2026!

Detalhes do evento:

📅 Data: 11/02/2026
🕘 Horário: Das 18h30 às 22h
📍 Local: Sorocaba Park Hotel - Av. Prof. Joaquim da Silva, 205 - Alto da Boa Vista - Sorocaba/SP

🎟️ Ingresso: R$ 97,00
Pagamento via Hotmart – Pix ou cartão (até 3x).

Me tira uma dúvida, você faz anúncios no Google Ads ou está começando agora?`;

  try {
    const r = await c.sendMessage(chatId, text);
    // whatsapp-web.js geralmente retorna msg com id
    upsertStatus(toDigits, { lastMsgId: r?.id?._serialized || null });
    return r;
  } catch (e) {
    const msg = e?.message || String(e);

    // heurística comum: número não está no WhatsApp
    const notOnWhatsapp =
      /not a valid whatsapp user|invalid wid|wid error|not registered|not a whatsapp user/i.test(msg);

    upsertStatus(toDigits, {
      sendError: msg,
      notOnWhatsapp: !!notOnWhatsapp,
    });

    throw e;
  }
}

module.exports = {
  isWhatsAppConfigured,
  initWhatsApp,
  getWhatsAppStatus,
  getLatestQr,
  sendTemplateMessage,
  getMessageStats,
  getMessageStatusFor,
  computeLeadStatus,
};
