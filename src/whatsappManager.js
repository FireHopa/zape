// src/whatsappManager.js
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const QRCode = require("qrcode");

const DEBUG = String(process.env.DEBUG || "").toLowerCase() === "true" || process.env.DEBUG === "1";
const AUDIO_DEBUG = String(process.env.AUDIO_DEBUG || "1") !== "0";
const logOk = (tenant, msg, extra) => { if (!DEBUG) return; console.log(`[OK][wa:${tenant}] ${msg}`, extra || ""); };
const logErr = (tenant, msg, extra) => { console.error(`[ERROR][wa:${tenant}] ${msg}`, extra || ""); };
function audioDebug(tenant, flowId, step, data = {}) {
  if (!AUDIO_DEBUG) return;
  const safe = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (/base64|dataurl|token|secret|password/i.test(key)) {
      safe[key] = value ? `[redacted:${String(value).length}]` : value;
    } else {
      safe[key] = value;
    }
  }
  console.log(`[AUDIO_DEBUG][wa:${tenant}][${flowId || "no-flow"}] ${step}`, JSON.stringify(safe));
}
function audioWarn(tenant, flowId, step, data = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(data || {})) {
    safe[key] = /base64|dataurl|token|secret|password/i.test(key) ? (value ? `[redacted:${String(value).length}]` : value) : value;
  }
  console.error(`[AUDIO_WARN][wa:${tenant}][${flowId || "no-flow"}] ${step}`, JSON.stringify(safe));
}

function attachmentDebug(tenant, step, data = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(data || {})) {
    safe[key] = /base64|dataurl|token|secret|password/i.test(key) ? (value ? `[redacted:${String(value).length}]` : value) : value;
  }
  console.log(`[ATTACHMENT_DEBUG][wa:${tenant}] ${step}`, JSON.stringify(safe));
}
function shortHash(buffer) {
  try { return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16); } catch { return ""; }
}
function fileInfo(filePath, mimetype) {
  try {
    const st = fs.statSync(filePath);
    const buf = fs.readFileSync(filePath);
    return {
      path: filePath,
      ext: path.extname(filePath),
      mimetype: mimetype || "",
      size: st.size,
      sha256_16: shortHash(buf),
      headerHex: buf.slice(0, 16).toString("hex"),
    };
  } catch (err) {
    return { path: filePath, error: err?.message || String(err) };
  }
}
function ffmpegProbe(ffmpeg, filePath) {
  if (!ffmpeg || !filePath) return "";
  try {
    const r = spawnSync(ffmpeg, ["-hide_banner", "-i", filePath], { encoding: "utf8", timeout: 12000 });
    return String((r.stderr || r.stdout || "")).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 12).join(" | ");
  } catch (err) {
    return err?.message || String(err);
  }
}
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


let cachedFfmpegBinary = undefined;
function resolveFfmpegBinary() {
  if (cachedFfmpegBinary !== undefined) return cachedFfmpegBinary;

  const fromEnv = String(process.env.FFMPEG_PATH || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return (cachedFfmpegBinary = fromEnv);

  try {
    const staticFfmpeg = require('ffmpeg-static');
    if (staticFfmpeg && fs.existsSync(staticFfmpeg)) return (cachedFfmpegBinary = staticFfmpeg);
  } catch {}

  const candidates = [
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/bin/ffmpeg',
    '/snap/bin/ffmpeg',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return (cachedFfmpegBinary = c); } catch {}
  }

  try {
    const which = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
    const found = String(which.stdout || '').trim().split(/\r?\n/)[0];
    if (which.status === 0 && found && fs.existsSync(found)) return (cachedFfmpegBinary = found);
  } catch {}

  return (cachedFfmpegBinary = null);
}

function extensionFromAudioMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('opus')) return 'ogg';
  if (m.includes('webm')) return 'webm';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  return 'bin';
}

function baseMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

function audioMimeForFile(filePath, fallbackMime, opts = {}) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const voice = Boolean(opts.voice);
  if (ext === '.ogg' || ext === '.opus') return voice ? 'audio/ogg; codecs=opus' : 'audio/ogg';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a' || ext === '.mp4' || ext === '.aac') return 'audio/mp4';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.webm') return 'audio/webm';
  const basic = baseMime(fallbackMime) || 'audio/ogg';
  if (voice && basic === 'audio/ogg') return 'audio/ogg; codecs=opus';
  return basic;
}

function messageMediaFromAudioFile(filePath, mimetype, filename, opts = {}) {
  const data = fs.readFileSync(filePath, { encoding: 'base64' });
  const clean = String(data || '').replace(/\s+/g, '');
  const size = fs.statSync(filePath).size;
  // Para áudio/nota de voz, o filename deve ser null.
  // Na prática, filename é campo de documento; quando vai preenchido, algumas versões
  // do WhatsApp Web/mobile tratam o áudio como arquivo e ele chega sem player válido.
  const fileNameForMedia = opts.asDocument ? (filename || path.basename(filePath)) : null;
  const media = new MessageMedia(mimetype || audioMimeForFile(filePath, null, opts), clean, fileNameForMedia, size);
  try { media.filesize = size; } catch {}
  return media;
}

function normalizeSendMediaError(err) {
  const raw = String(err?.message || err || '').trim();
  if (!raw || raw.length <= 2 || /^Evaluation failed:\s*\w$/i.test(raw)) {
    return 'O WhatsApp Web recusou o áudio nesse formato.';
  }
  return raw;
}

function normalizeAudioBase64Input(value) {
  let raw = String(value || '').trim();
  let detectedMime = '';
  const match = raw.match(/^data:([^,]+);base64,(.*)$/is);
  if (match) {
    detectedMime = String(match[1] || '').trim();
    raw = String(match[2] || '').trim();
  }
  let clean = raw
    .replace(/^data:[^,]+,/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  clean = clean.replace(/[^A-Za-z0-9+/=]/g, '');
  const remainder = clean.length % 4;
  if (remainder) clean += '='.repeat(4 - remainder);
  const buffer = Buffer.from(clean, 'base64');
  if (!buffer || buffer.length < 80) throw new Error('Áudio inválido ou muito curto. Grave novamente e tente enviar.');
  return { buffer, detectedMime };
}

function normalizeFileBase64Input(value, { minBytes = 1 } = {}) {
  let raw = String(value || '').trim();
  let detectedMime = '';
  const match = raw.match(/^data:([^,]+);base64,(.*)$/is);
  if (match) {
    detectedMime = String(match[1] || '').trim();
    raw = String(match[2] || '').trim();
  }
  let clean = raw
    .replace(/^data:[^,]+,/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  clean = clean.replace(/[^A-Za-z0-9+/=]/g, '');
  const remainder = clean.length % 4;
  if (remainder) clean += '='.repeat(4 - remainder);
  const buffer = Buffer.from(clean, 'base64');
  if (!buffer || buffer.length < minBytes) throw new Error('Arquivo inválido ou vazio. Selecione novamente e tente enviar.');
  return { buffer, detectedMime };
}

function mimeFromFilename(filename, fallback = 'application/octet-stream') {
  const ext = path.extname(String(filename || '')).toLowerCase();
  const map = {
    '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml',
    '.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime',
    '.ogg':'audio/ogg','.opus':'audio/ogg','.webm_audio':'audio/webm','.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.wav':'audio/wav',
    '.pdf':'application/pdf','.txt':'text/plain','.csv':'text/csv',
    '.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt':'application/vnd.ms-powerpoint','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip':'application/zip','.rar':'application/vnd.rar'
  };
  return map[ext] || fallback || 'application/octet-stream';
}

function mediaKindFromMime(mime, filename = '') {
  const basic = baseMime(mime);
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (basic.startsWith('audio/')) return 'audio';
  if (basic.startsWith('image/')) return 'image';
  if (basic.startsWith('video/')) return 'video';
  if (basic === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (basic.includes('spreadsheet') || basic.includes('excel') || ['.csv','.xls','.xlsx','.ods'].includes(ext)) return 'spreadsheet';
  if (basic.includes('word') || ['.doc','.docx','.odt'].includes(ext)) return 'document';
  if (basic.includes('presentation') || ['.ppt','.pptx','.odp'].includes(ext)) return 'presentation';
  if (basic.includes('zip') || basic.includes('rar') || basic.includes('compressed') || ['.zip','.rar','.7z','.gz','.tar'].includes(ext)) return 'archive';
  if (basic.startsWith('text/') || ['.txt','.md','.json','.xml','.html','.css','.js'].includes(ext)) return 'text';
  return 'file';
}

function messageMediaFromBuffer(buffer, mimetype, filename) {
  const data = Buffer.from(buffer).toString('base64').replace(/\s+/g, '');
  const safeFilename = String(filename || 'arquivo').trim() || 'arquivo';
  const media = new MessageMedia(mimetype || mimeFromFilename(safeFilename), data, safeFilename, Buffer.byteLength(buffer));
  try { media.filesize = Buffer.byteLength(buffer); } catch {}
  return media;
}

function shouldSendAsDocument(mime, filename = '') {
  const kind = mediaKindFromMime(mime, filename);
  return !['image', 'video', 'audio'].includes(kind);
}

function transcodeWithFfmpeg(inputBuffer, inputMime, tenantId, flowId = "audio") {
  const ffmpeg = resolveFfmpegBinary();
  audioDebug(tenantId, flowId, "ffmpeg.resolve", { ffmpegFound: Boolean(ffmpeg), ffmpegPath: ffmpeg || null });
  if (!ffmpeg) {
    return {
      ok: false,
      code: 'FFMPEG_MISSING',
      error: 'ffmpeg não encontrado no servidor.',
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `zape-audio-${String(tenantId || 'tenant')}-`));
  const inExt = extensionFromAudioMime(inputMime);
  const inputPath = path.join(tempDir, `input.${inExt}`);
  const outputOgg = path.join(tempDir, 'voice.ogg');
  const outputM4a = path.join(tempDir, 'audio.m4a');
  fs.writeFileSync(inputPath, inputBuffer);
  audioDebug(tenantId, flowId, "ffmpeg.input_written", { inputMime, ...fileInfo(inputPath, inputMime), probe: ffmpegProbe(ffmpeg, inputPath) });

  let oggErr = '';
  let m4aErr = '';

  try {
    const ogg = spawnSync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      '-vn', '-ac', '1', '-ar', '48000',
      '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
      '-f', 'ogg',
      outputOgg,
    ], { encoding: 'utf8' });
    oggErr = String(ogg.stderr || '').trim();
    audioDebug(tenantId, flowId, "ffmpeg.ogg_result", { status: ogg.status, signal: ogg.signal || null, error: ogg.error ? (ogg.error.message || String(ogg.error)) : null, stderr: oggErr.slice(0, 1200), output: fs.existsSync(outputOgg) ? fileInfo(outputOgg, 'audio/ogg; codecs=opus') : null, probe: fs.existsSync(outputOgg) ? ffmpegProbe(ffmpeg, outputOgg) : '' });

    const m4a = spawnSync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      '-vn', '-ac', '1', '-ar', '44100',
      '-c:a', 'aac', '-b:a', '64k',
      '-movflags', '+faststart',
      outputM4a,
    ], { encoding: 'utf8' });
    m4aErr = String(m4a.stderr || '').trim();
    audioDebug(tenantId, flowId, "ffmpeg.m4a_result", { status: m4a.status, signal: m4a.signal || null, error: m4a.error ? (m4a.error.message || String(m4a.error)) : null, stderr: m4aErr.slice(0, 1200), output: fs.existsSync(outputM4a) ? fileInfo(outputM4a, 'audio/mp4') : null, probe: fs.existsSync(outputM4a) ? ffmpegProbe(ffmpeg, outputM4a) : '' });

    const hasOgg = ogg.status === 0 && fs.existsSync(outputOgg) && fs.statSync(outputOgg).size > 80;
    const hasM4a = m4a.status === 0 && fs.existsSync(outputM4a) && fs.statSync(outputM4a).size > 80;

    if (hasOgg || hasM4a) {
      return {
        ok: true,
        path: hasOgg ? outputOgg : outputM4a,
        altPath: hasOgg && hasM4a ? outputM4a : null,
        tempDir,
        mimetype: hasOgg ? 'audio/ogg' : 'audio/mp4',
        filename: hasOgg ? 'audio.ogg' : 'audio.m4a',
        sendAsVoice: Boolean(hasOgg),
      };
    }

    return {
      ok: false,
      code: 'FFMPEG_FAILED',
      error: oggErr || m4aErr || 'Falha ao converter áudio.',
      tempDir,
    };
  } catch (err) {
    return {
      ok: false,
      code: 'FFMPEG_EXCEPTION',
      error: err?.message || String(err),
      tempDir,
    };
  }
}

function safeRmDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

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
      rec.mediaKind = fallback.mediaKind || (audio ? 'audio' : mediaKindFromMime(fallback.mediaMime || message.mimetype || '', fallback.filename || ''));
      if (fallback.mediaMime || message.mimetype) rec.mediaMime = fallback.mediaMime || message.mimetype;
      if (fallback.mediaFile) rec.mediaFile = fallback.mediaFile;
      if (fallback.mediaSize) rec.mediaSize = fallback.mediaSize;
      if (fallback.duration) rec.duration = fallback.duration;
      if (fallback.filename) rec.filename = fallback.filename;
      if (fallback.originalName) rec.originalName = fallback.originalName;
    }

    return rec;
  }

  async _messageToConversationRecordWithMedia(message, fallback = {}, toDigits = '') {
    const rec = this._messageToConversationRecord(message, fallback);
    if (!rec) return null;
    if (!message || !message.hasMedia || typeof message.downloadMedia !== 'function') return rec;
    if (rec.mediaFile) return rec;

    try {
      const media = await message.downloadMedia();
      if (!media || !media.data) return rec;
      const mimetype = String(media.mimetype || rec.mediaMime || '').trim() || 'application/octet-stream';
      const filename = media.filename || rec.filename || rec.id || undefined;
      const kind = mediaKindFromMime(mimetype, filename);
      const saved = saveConversationMedia(this.tenantId, {
        toDigits,
        messageId: rec.id || `${rec.fromMe ? 'out' : 'in'}_${rec.timestamp}`,
        mimetype,
        data: media.data,
        filename,
      });
      return {
        ...rec,
        body: rec.body || (kind === 'audio' ? 'Áudio' : (filename || 'Arquivo')),
        hasMedia: true,
        mediaKind: saved.mediaKind || kind,
        mediaMime: mimetype,
        mediaFile: saved.fileName,
        mediaSize: saved.size,
        filename: media.filename || rec.filename || saved.originalName || saved.fileName,
        originalName: media.filename || rec.originalName || saved.originalName || '',
      };
    } catch (e) {
      logErr(this.tenantId, 'download conversation media failed', e?.message || String(e));
      return rec;
    }
  }

  _appendConversationFromMessage(toDigits, message, fallback = {}) {
    const digits = this._normalizeDigits(toDigits) || this._resolveDigitsForMessage(message);
    if (!digits) return null;
    const rec = this._messageToConversationRecord(message, fallback);
    if (!rec) return null;
    const saved = appendConversationMessage(this.tenantId, digits, rec);

    if (message && message.hasMedia) {
      this._messageToConversationRecordWithMedia(message, rec, digits)
        .then((enriched) => {
          if (enriched && enriched.mediaFile) upsertConversationMessages(this.tenantId, digits, [enriched]);
        })
        .catch((e) => logErr(this.tenantId, 'async media cache failed', e?.message || String(e)));
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
      audioDebug(this.tenantId, flowId, "chat.resolved", { chatId });
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

  async sendCustomAttachmentMessage({ toDigits, fileBase64, mimetype, filename = 'arquivo', caption = '' } = {}) {
    const c = await this.initWhatsApp();
    await this._ensureReady();
    if (!c || typeof c.sendMessage !== 'function') {
      throw new Error('Cliente do WhatsApp Web indisponível para enviar arquivo. Reconecte o WhatsApp e tente novamente.');
    }
    const parsed = normalizeFileBase64Input(fileBase64, { minBytes: 1 });
    const cleanFilename = path.basename(String(filename || 'arquivo').trim() || 'arquivo').replace(/[\r\n]+/g, ' ').slice(0, 180) || 'arquivo';
    let finalMime = baseMime(mimetype || parsed.detectedMime || mimeFromFilename(cleanFilename));
    if (!finalMime || finalMime === 'application/octet-stream') finalMime = mimeFromFilename(cleanFilename, 'application/octet-stream');
    const buffer = parsed.buffer;
    attachmentDebug(this.tenantId, 'send.start', {
      toDigits: String(toDigits || '').replace(/\d(?=\d{4})/g, '*'),
      filename: cleanFilename,
      requestedMime: mimetype || null,
      detectedMime: parsed.detectedMime || null,
      finalMime,
      size: buffer.length,
      kind: mediaKindFromMime(finalMime, cleanFilename),
      asDocument: shouldSendAsDocument(finalMime, cleanFilename),
    });
    if (buffer.length > 45 * 1024 * 1024) throw new Error('Arquivo muito grande. Envie arquivos de até 45 MB.');

    this._upsertStatus(toDigits, {
      lastSendAt: new Date().toISOString(),
      ack: 0,
      notOnWhatsapp: false,
      sendError: null,
    });

    const chatId = await this._getValidChatId(toDigits);
    attachmentDebug(this.tenantId, 'chat.resolved', { chatId });
    this._upsertStatus(toDigits, {
      chatId,
      waId: chatId,
      isRegistered: true,
      checkedAt: new Date().toISOString(),
    });

    const kind = mediaKindFromMime(finalMime, cleanFilename);
    const asDocument = shouldSendAsDocument(finalMime, cleanFilename);
    const media = messageMediaFromBuffer(buffer, finalMime, cleanFilename);
    const options = {
      sendMediaAsDocument: asDocument,
      waitUntilMsgSent: true,
    };
    const safeCaption = String(caption || '').trim().slice(0, 1000);
    if (safeCaption && (kind === 'image' || kind === 'video' || asDocument)) options.caption = safeCaption;

    let sent;
    try {
      attachmentDebug(this.tenantId, 'send.attempt', { mode: asDocument ? 'document' : 'media', finalMime, kind, hasCaption: Boolean(safeCaption) });
      sent = await c.sendMessage(chatId, media, options);
    } catch (err) {
      attachmentDebug(this.tenantId, 'send.failed', { mode: asDocument ? 'document' : 'media', error: err?.message || String(err) });
      // Alguns formatos de vídeo/imagem falham como mídia direta. O fallback como documento
      // mantém o envio funcionando para qualquer tipo de arquivo.
      if (!asDocument && (kind === 'image' || kind === 'video')) {
        attachmentDebug(this.tenantId, 'send.retry_as_document', { finalMime, kind, hasCaption: Boolean(safeCaption) });
        sent = await c.sendMessage(chatId, media, { sendMediaAsDocument: true, waitUntilMsgSent: true, ...(safeCaption ? { caption: safeCaption } : {}) });
      } else {
        throw err;
      }
    }

    const messageId = sent?.id?._serialized || `out_file_${Date.now()}`;
    const ack = normalizeAck(sent?.ack, ACK.PENDING);
    attachmentDebug(this.tenantId, 'send.success', { messageId, ack, type: sent?.type || null, hasMedia: sent?.hasMedia });
    const saved = saveConversationMedia(this.tenantId, {
      toDigits,
      messageId,
      mimetype: finalMime,
      buffer,
      filename: cleanFilename,
    });

    const rec = {
      id: messageId,
      fromMe: true,
      body: safeCaption || cleanFilename || 'Arquivo',
      type: kind === 'audio' ? 'audio' : (kind === 'image' ? 'image' : (kind === 'video' ? 'video' : 'document')),
      timestamp: Math.floor(Date.now() / 1000),
      createdAt: new Date().toISOString(),
      ack,
      source: asDocument ? 'send-attachment-document' : 'send-attachment-media',
      hasMedia: true,
      mediaKind: saved.mediaKind || kind,
      mediaMime: finalMime,
      mediaFile: saved.fileName,
      mediaSize: saved.size,
      filename: cleanFilename,
      originalName: saved.originalName || cleanFilename,
      sentAsDocument: Boolean(asDocument),
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
  }

  async sendCustomAudioMessage({ toDigits, audioBase64, mimetype, filename = 'audio.webm', debugId } = {}) {
    const flowId = debugId || `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    audioDebug(this.tenantId, flowId, "send.start", {
      toDigits: String(toDigits || '').replace(/\d(?=\d{4})/g, '*'),
      receivedMime: mimetype || null,
      filename: filename || null,
      payloadLength: String(audioBase64 || '').length,
      payloadPrefix: String(audioBase64 || '').slice(0, 64),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    });
    const c = await this.initWhatsApp();
    await this._ensureReady();

    const parsed = normalizeAudioBase64Input(audioBase64);
    let inputMime = baseMime(mimetype || parsed.detectedMime || 'audio/webm') || 'audio/webm';
    if (!/^audio\//i.test(inputMime)) inputMime = 'audio/webm';
    const inputBuffer = parsed.buffer;
    audioDebug(this.tenantId, flowId, "input.normalized", { detectedMime: parsed.detectedMime || null, inputMime, bufferSize: inputBuffer.length, sha256_16: shortHash(inputBuffer), headerHex: inputBuffer.slice(0, 16).toString('hex') });
    if (inputBuffer.length > 16 * 1024 * 1024) throw new Error('Áudio muito grande. Grave um áudio menor.');

    this._upsertStatus(toDigits, {
      lastSendAt: new Date().toISOString(),
      ack: 0,
      notOnWhatsapp: false,
      sendError: null,
    });

    let tempDir = null;
    const tempDirs = [];
    const attempted = [];

    try {
      const chatId = await this._getValidChatId(toDigits);
      this._upsertStatus(toDigits, {
        chatId,
        waId: chatId,
        isRegistered: true,
        checkedAt: new Date().toISOString(),
      });

      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `zape-audio-send-${this.tenantId}-`));
      tempDirs.push(tempDir);
      const originalExt = extensionFromAudioMime(inputMime);
      const originalPath = path.join(tempDir, `original.${originalExt}`);
      fs.writeFileSync(originalPath, inputBuffer);
      audioDebug(this.tenantId, flowId, "original.written", { inputMime, ...fileInfo(originalPath, inputMime) });

      const candidates = [];
      const needsTranscode = /webm|wav|x-wav|octet-stream/i.test(inputMime) || !/ogg|mpeg|mp3|mp4|aac|m4a/i.test(inputMime);
      const transcode = transcodeWithFfmpeg(inputBuffer, inputMime, this.tenantId, flowId);

      if (transcode.tempDir) tempDirs.push(transcode.tempDir);
      audioDebug(this.tenantId, flowId, "transcode.summary", { ok: Boolean(transcode.ok), code: transcode.code || null, error: transcode.error || null, path: transcode.path || null, altPath: transcode.altPath || null, mimetype: transcode.mimetype || null, sendAsVoice: Boolean(transcode.sendAsVoice) });

      if (transcode.ok) {
        // Ordem pensada para o app mobile conseguir reproduzir:
        // 1) nota de voz OGG/Opus sem filename, conforme suporte de sendAudioAsVoice;
        // 2) mesmo arquivo como áudio comum;
        // 3) M4A/AAC como áudio comum, que costuma ser aceito pelo app mobile.
        candidates.push({
          label: 'voice_opus_mime_with_codec',
          path: transcode.path,
          mimetype: 'audio/ogg; codecs=opus',
          filename: null,
          options: { sendAudioAsVoice: true, sendMediaAsDocument: false, waitUntilMsgSent: true },
          body: 'Áudio de voz',
          type: 'ptt',
          voice: true,
        });
        candidates.push({
          label: 'voice_opus_mime_simple',
          path: transcode.path,
          mimetype: 'audio/ogg',
          filename: null,
          options: { sendAudioAsVoice: true, sendMediaAsDocument: false, waitUntilMsgSent: true },
          body: 'Áudio de voz',
          type: 'ptt',
          voice: true,
        });
        candidates.push({
          label: 'audio_ogg_regular_no_filename',
          path: transcode.path,
          mimetype: 'audio/ogg',
          filename: null,
          options: { sendAudioAsVoice: false, sendMediaAsDocument: false, waitUntilMsgSent: true },
          body: 'Áudio',
          type: 'audio',
        });

        if (transcode.altPath && fs.existsSync(transcode.altPath)) {
          candidates.push({
            label: 'audio_m4a_regular_no_filename',
            path: transcode.altPath,
            mimetype: 'audio/mp4',
            filename: null,
            options: { sendAudioAsVoice: false, sendMediaAsDocument: false, waitUntilMsgSent: true },
            body: 'Áudio',
            type: 'audio',
          });
        }
      } else if (transcode.code === 'FFMPEG_MISSING') {
        if (needsTranscode) {
          throw new Error('O servidor ainda não tem ffmpeg disponível. Rode npm install e reinicie o PM2, ou instale com sudo apt install -y ffmpeg.');
        }
      } else if (needsTranscode) {
        logErr(this.tenantId, 'audio transcode failed', transcode.error || transcode.code);
      }

      // Se o navegador gravar direto em formato aceito, tenta também o original.
      if (/ogg|mpeg|mp3|mp4|aac|m4a/i.test(inputMime)) {
        const originalIsVoice = /ogg|opus/i.test(inputMime);
        candidates.push({
          label: 'original_audio_no_filename',
          path: originalPath,
          mimetype: audioMimeForFile(originalPath, inputMime, { voice: originalIsVoice }),
          filename: null,
          options: { sendAudioAsVoice: originalIsVoice, sendMediaAsDocument: false, waitUntilMsgSent: true },
          body: originalIsVoice ? 'Áudio de voz' : 'Áudio',
          type: originalIsVoice ? 'ptt' : 'audio',
          voice: originalIsVoice,
        });
      }

      // Não fazemos fallback automático como documento, porque ele pode chegar no celular
      // como arquivo enviado, mas sem reprodução correta no app do WhatsApp. Melhor falhar
      // com diagnóstico claro do que entregar um áudio aparentemente enviado e inaudível.

      let sent = null;
      let used = null;
      let lastError = null;

      audioDebug(this.tenantId, flowId, "candidates.ready", { candidates: candidates.map((c) => ({ label: c.label, mimetype: c.mimetype, filename: c.filename, options: c.options, pathInfo: c.path ? fileInfo(c.path, c.mimetype) : null })) });

      for (const candidate of candidates) {
        try {
          if (!candidate.path || !fs.existsSync(candidate.path)) {
            audioWarn(this.tenantId, flowId, "candidate.missing_file", { label: candidate.label, path: candidate.path || null });
            continue;
          }
          const media = messageMediaFromAudioFile(candidate.path, candidate.mimetype, candidate.filename, { asDocument: Boolean(candidate.asDocument), voice: Boolean(candidate.voice) });
          attempted.push(candidate.label);
          audioDebug(this.tenantId, flowId, "candidate.before_send", { label: candidate.label, media: { mimetype: media.mimetype, filename: media.filename || null, filesize: media.filesize || null, dataLength: String(media.data || '').length, dataHash16: shortHash(Buffer.from(String(media.data || ''), 'base64')) }, options: candidate.options || {} });
          sent = await c.sendMessage(chatId, media, candidate.options || {});
          audioDebug(this.tenantId, flowId, "candidate.sent", { label: candidate.label, messageId: sent?.id?._serialized || sent?.id?.id || null, ack: sent?.ack, type: sent?.type || null, hasMedia: sent?.hasMedia, mimetype: sent?._data?.mimetype || sent?.mediaData?.mimetype || null });
          used = { ...candidate, media };
          break;
        } catch (err) {
          lastError = err;
          audioWarn(this.tenantId, flowId, "candidate.failed", { label: candidate.label, rawError: err?.message || String(err), normalizedError: normalizeSendMediaError(err), stack: String(err?.stack || '').split('\n').slice(0, 4).join(' | ') });
          logErr(this.tenantId, `audio send attempt failed (${candidate.label})`, normalizeSendMediaError(err));
        }
      }

      if (!sent || !used) {
        const detail = normalizeSendMediaError(lastError);
        throw new Error(`Não consegui enviar um áudio reproduzível pelo WhatsApp Web. Tentativas: ${attempted.join(', ') || 'nenhuma'}. Último erro: ${detail}`);
      }

      const messageId = sent?.id?._serialized || `out_audio_${Date.now()}`;
      const ack = normalizeAck(sent?.ack, ACK.PENDING);
      const finalPath = used.path;
      const finalMime = baseMime(audioMimeForFile(finalPath, used.mimetype, { voice: Boolean(used.voice) })) || 'audio/ogg';
      const finalData = fs.readFileSync(finalPath, { encoding: 'base64' }).replace(/\s+/g, '');

      const saved = saveConversationMedia(this.tenantId, {
        toDigits,
        messageId,
        mimetype: finalMime,
        data: finalData,
        filename: messageId || used.filename || undefined,
      });

      const rec = {
        id: messageId,
        fromMe: true,
        body: used.body || (used.asDocument ? 'Arquivo de áudio' : 'Áudio'),
        type: used.type || 'audio',
        timestamp: Math.floor(Date.now() / 1000),
        createdAt: new Date().toISOString(),
        ack,
        source: used.label || 'send-audio',
        hasMedia: true,
        mediaKind: 'audio',
        mediaMime: finalMime,
        mediaFile: saved.fileName,
        mediaSize: saved.size,
        sentAsDocument: Boolean(used.asDocument),
      };
      upsertConversationMessages(this.tenantId, toDigits, [rec]);

      audioDebug(this.tenantId, flowId, "local.saved", { usedLabel: used.label, finalMime, savedFile: saved.fileName, savedSize: saved.size, messageId, ack });

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

      audioDebug(this.tenantId, flowId, "send.done", { messageId, usedLabel: used.label, type: rec.type, finalMime, ack });
      return { sent, message: rec, debugId: flowId };
    } catch (err) {
      audioWarn(this.tenantId, flowId, "send.failed_final", { rawError: err?.message || String(err), stack: String(err?.stack || '').split('\n').slice(0, 8).join(' | '), attempted });
      const m = normalizeSendMediaError(err);
      const notOn = /not on whatsapp|unregistered|does not exist/i.test(m);
      this._upsertStatus(toDigits, {
        sendError: m,
        notOnWhatsapp: notOn,
        notOnWhatsappAt: notOn ? new Date().toISOString() : null,
        isRegistered: notOn ? false : undefined,
      });
      throw new Error(m);
    } finally {
      for (const dir of tempDirs) safeRmDir(dir);
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

async function sendCustomAttachmentMessage(tenantId, { toDigits, fileBase64, mimetype, filename, caption } = {}) {
  const wa = getTenantWA(tenantId);
  return wa.sendCustomAttachmentMessage({ toDigits, fileBase64, mimetype, filename, caption });
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
  sendCustomAttachmentMessage,
  getChatTextMessages,
  getChatsSnapshotForDigits,
  destroyCachedWhatsAppClients,
};