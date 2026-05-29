// src/tenantConversationStore.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureTenantDir } = require('./tenantPaths');

const MAX_MESSAGES_PER_CHAT = 600;
const SAVE_DEBOUNCE_MS = 250;
const cache = new Map();
const timers = new Map();

const MIME_EXT = {
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/webm': 'webm',
  'audio/webm; codecs=opus': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
};

function fileForTenant(tenantId) {
  return path.join(ensureTenantDir(tenantId), 'conversations.json');
}

function mediaDirForTenant(tenantId) {
  const dir = path.join(ensureTenantDir(tenantId), 'conversation_media');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function nowIso() {
  return new Date().toISOString();
}

function safeId(value) {
  const raw = String(value || '').trim();
  if (!raw) return crypto.randomBytes(10).toString('hex');
  return raw.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120) || crypto.randomBytes(10).toString('hex');
}

function extensionFromMime(mime) {
  const m = String(mime || '').toLowerCase().trim();
  if (MIME_EXT[m]) return MIME_EXT[m];
  const basic = m.split(';')[0].trim();
  if (MIME_EXT[basic]) return MIME_EXT[basic];
  if (basic.includes('spreadsheet') || basic.includes('excel')) return 'xlsx';
  if (basic.includes('wordprocessing')) return 'docx';
  if (basic.includes('presentation')) return 'pptx';
  if (basic.includes('/')) return basic.split('/')[1].replace(/[^a-z0-9]+/g, '') || 'bin';
  return 'bin';
}

function mediaKindFromMime(mime, filename = '') {
  const basic = String(mime || '').toLowerCase().split(';')[0].trim();
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (basic.startsWith('audio/')) return 'audio';
  if (basic.startsWith('image/')) return 'image';
  if (basic.startsWith('video/')) return 'video';
  if (basic === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (basic.includes('spreadsheet') || basic.includes('excel') || ['.csv', '.xls', '.xlsx', '.ods'].includes(ext)) return 'spreadsheet';
  if (basic.includes('word') || ['.doc', '.docx', '.odt'].includes(ext)) return 'document';
  if (basic.includes('presentation') || ['.ppt', '.pptx', '.odp'].includes(ext)) return 'presentation';
  if (basic.includes('zip') || basic.includes('rar') || basic.includes('compressed') || ['.zip', '.rar', '.7z', '.gz', '.tar'].includes(ext)) return 'archive';
  if (basic.startsWith('text/') || ['.txt', '.md', '.json', '.xml', '.html', '.css', '.js'].includes(ext)) return 'text';
  return 'file';
}

function loadStore(tenantId) {
  const t = String(tenantId || '').trim() || 'admin';
  if (cache.has(t)) return cache.get(t);
  const file = fileForTenant(t);
  let data = {};
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') data = parsed;
    }
  } catch {
    data = {};
  }
  cache.set(t, data);
  return data;
}

function flushStore(tenantId) {
  const t = String(tenantId || '').trim() || 'admin';
  const data = loadStore(t);
  const file = fileForTenant(t);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function scheduleFlush(tenantId) {
  const t = String(tenantId || '').trim() || 'admin';
  if (timers.has(t)) return;
  timers.set(t, setTimeout(() => {
    timers.delete(t);
    try { flushStore(t); } catch (e) { console.error(`[${t}] Falha ao salvar conversations.json:`, e?.message || e); }
  }, SAVE_DEBOUNCE_MS));
}

function isAudioRecord(message, fallback = {}) {
  const type = String(message?.type || fallback.type || '').toLowerCase();
  const mime = String(message?.mediaMime || message?.mimetype || fallback.mediaMime || fallback.mimetype || '').toLowerCase();
  const kind = String(message?.mediaKind || fallback.mediaKind || '').toLowerCase();
  return kind === 'audio' || type === 'audio' || type === 'ptt' || mime.startsWith('audio/');
}

function cleanMessage(message, fallback = {}) {
  if (!message && !fallback) return null;
  const ts = Number(message?.timestamp || fallback.timestamp || Math.floor(Date.now() / 1000));
  const createdAt = message?.createdAt || fallback.createdAt || (ts ? new Date(ts * 1000).toISOString() : nowIso());
  const audio = isAudioRecord(message, fallback);
  let body = String(message?.body || fallback.body || '').trim();
  if (!body && audio) body = 'Áudio';

  const mediaFile = String(message?.mediaFile || fallback.mediaFile || '').trim();
  const mediaMime = String(message?.mediaMime || message?.mimetype || fallback.mediaMime || fallback.mimetype || '').trim();
  const filename = String(message?.filename || fallback.filename || '').trim();
  const originalName = String(message?.originalName || fallback.originalName || '').trim();

  // Importante: não transforme texto comum em anexo.
  // Versões anteriores salvavam mediaKind="file" mesmo quando não havia mídia real;
  // isso fazia mensagens simples aparecerem como card de "Anexo" na interface.
  const explicitHasMedia = Boolean(message?.hasMedia ?? fallback.hasMedia ?? false);
  const hasMediaEvidence = Boolean(audio || mediaFile || mediaMime || filename || originalName);
  const hasMedia = Boolean(audio || mediaFile || (explicitHasMedia && hasMediaEvidence));
  const mediaKind = hasMedia
    ? String(message?.mediaKind || fallback.mediaKind || (audio ? 'audio' : mediaKindFromMime(mediaMime, filename || originalName || mediaFile))).trim()
    : '';

  if (!body && !hasMedia) return null;

  const fromMe = Boolean(message?.fromMe ?? fallback.fromMe);
  const id = String(
    message?.id ||
    message?.messageId ||
    message?._serialized ||
    fallback.id ||
    fallback.messageId ||
    `${fromMe ? 'out' : 'in'}_${ts}_${(body || mediaKind || 'msg').slice(0, 28).replace(/\W+/g, '_')}`
  ).trim();

  const out = {
    id,
    fromMe,
    body,
    type: String(message?.type || fallback.type || (audio ? 'audio' : 'chat')),
    timestamp: ts,
    createdAt,
    ack: message?.ack ?? fallback.ack ?? null,
    source: String(message?.source || fallback.source || 'local'),
  };

  if (hasMedia) {
    out.hasMedia = true;
    out.mediaKind = mediaKind || (audio ? 'audio' : 'media');
    if (mediaMime) out.mediaMime = mediaMime;
    if (mediaFile) out.mediaFile = mediaFile;
    if (message?.mediaSize || fallback.mediaSize) out.mediaSize = Number(message?.mediaSize || fallback.mediaSize) || undefined;
    if (message?.duration || fallback.duration) out.duration = Number(message?.duration || fallback.duration) || undefined;
    if (filename) out.filename = filename;
    if (originalName) out.originalName = originalName;
  }

  return out;
}

function sortMessages(messages) {
  return (Array.isArray(messages) ? messages : []).sort((a, b) => {
    const ta = Number(a.timestamp || 0) || new Date(a.createdAt || 0).getTime() / 1000 || 0;
    const tb = Number(b.timestamp || 0) || new Date(b.createdAt || 0).getTime() / 1000 || 0;
    if (ta !== tb) return ta - tb;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function mergeIntoChat(existing, incoming) {
  const current = Array.isArray(existing) ? existing : [];
  const byId = new Map();
  const noId = [];

  for (const raw of current) {
    const msg = cleanMessage(raw, raw);
    if (!msg) continue;
    if (msg.id) byId.set(msg.id, { ...(byId.get(msg.id) || {}), ...msg });
    else noId.push(msg);
  }

  for (const raw of Array.isArray(incoming) ? incoming : [incoming]) {
    const msg = cleanMessage(raw, raw);
    if (!msg) continue;

    if (msg.id && byId.has(msg.id)) {
      byId.set(msg.id, { ...byId.get(msg.id), ...msg });
      continue;
    }

    const nearDuplicate = [...byId.values()].find((m) => {
      if (!m) return false;
      if (m.fromMe !== msg.fromMe) return false;
      const sameBody = String(m.body || '') === String(msg.body || '');
      const sameMedia = msg.mediaFile && m.mediaFile && msg.mediaFile === m.mediaFile;
      if (!sameBody && !sameMedia) return false;
      const dt = Math.abs(Number(m.timestamp || 0) - Number(msg.timestamp || 0));
      return dt <= 5;
    });

    if (nearDuplicate && nearDuplicate.id) {
      byId.set(nearDuplicate.id, { ...nearDuplicate, ...msg, id: nearDuplicate.id });
    } else {
      byId.set(msg.id, msg);
    }
  }

  const merged = sortMessages([...byId.values(), ...noId]);
  return merged.slice(Math.max(0, merged.length - MAX_MESSAGES_PER_CHAT));
}

function appendConversationMessage(tenantId, toDigits, message) {
  const digits = normalizeDigits(toDigits);
  if (!digits) return null;
  const msg = cleanMessage(message, message);
  if (!msg) return null;
  const store = loadStore(tenantId);
  store[digits] = mergeIntoChat(store[digits] || [], [msg]);
  scheduleFlush(tenantId);
  return msg;
}

function upsertConversationMessages(tenantId, toDigits, messages = []) {
  const digits = normalizeDigits(toDigits);
  if (!digits) return [];
  const clean = (Array.isArray(messages) ? messages : []).map((m) => cleanMessage(m, m)).filter(Boolean);
  if (!clean.length) return listConversationMessages(tenantId, digits);
  const store = loadStore(tenantId);
  store[digits] = mergeIntoChat(store[digits] || [], clean);
  scheduleFlush(tenantId);
  return store[digits];
}

function listConversationMessages(tenantId, toDigits, limit = 80) {
  const digits = normalizeDigits(toDigits);
  if (!digits) return [];
  const store = loadStore(tenantId);
  const raw = Array.isArray(store[digits]) ? store[digits] : [];
  const all = sortMessages(raw.map((m) => cleanMessage(m, m)).filter(Boolean));
  const safeLimit = Math.max(1, Math.min(500, Number(limit || 80)));
  return all.slice(Math.max(0, all.length - safeLimit));
}

function getLastConversationMessage(tenantId, toDigits) {
  const arr = listConversationMessages(tenantId, toDigits, 1);
  return arr.length ? arr[0] : null;
}

function listConversationDigits(tenantId) {
  const store = loadStore(tenantId);
  return Object.keys(store || {}).map(normalizeDigits).filter(Boolean);
}

function listConversationSummaries(tenantId, limit = 500) {
  const store = loadStore(tenantId);
  const rows = Object.keys(store || {}).map((digits) => {
    const cleanDigits = normalizeDigits(digits);
    const last = getLastConversationMessage(tenantId, cleanDigits);
    const lastTs = last ? (Number(last.timestamp || 0) || (new Date(last.createdAt || 0).getTime() / 1000) || 0) : 0;
    return {
      whatsapp_digits: cleanDigits,
      lastMessage: last || null,
      lastActivity: last ? (last.createdAt || (lastTs ? new Date(lastTs * 1000).toISOString() : null)) : null,
      messageCount: Array.isArray(store[digits]) ? store[digits].length : 0,
    };
  }).filter((x) => x.whatsapp_digits);

  rows.sort((a, b) => {
    const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return tb - ta;
  });

  const safeLimit = Math.max(1, Math.min(2000, Number(limit || 500)));
  return rows.slice(0, safeLimit);
}

function saveConversationMedia(tenantId, { messageId, toDigits, mimetype, data, buffer, filename } = {}) {
  const mime = String(mimetype || '').trim() || 'application/octet-stream';
  const digits = normalizeDigits(toDigits) || 'unknown';
  const ext = extensionFromMime(mime);
  const original = String(filename || '').trim();
  const originalExt = path.extname(original).replace(/^\./, '').toLowerCase();
  let baseName = original ? path.basename(original, path.extname(original)) : `${digits}_${messageId || Date.now()}`;
  baseName = safeId(baseName);
  const finalExt = originalExt || ext || 'bin';
  const suffix = crypto.randomBytes(4).toString('hex');
  const fileName = `${baseName}_${suffix}.${finalExt}`;
  const dir = mediaDirForTenant(tenantId);
  const filePath = path.join(dir, fileName);
  const content = buffer ? Buffer.from(buffer) : Buffer.from(String(data || ''), 'base64');
  fs.writeFileSync(filePath, content);
  return { fileName, filePath, mimetype: mime, size: content.length, originalName: original || fileName, mediaKind: mediaKindFromMime(mime, original || fileName) };
}

function getConversationMediaPath(tenantId, fileName) {
  const safeName = path.basename(String(fileName || ''));
  if (!safeName) return null;
  const filePath = path.join(mediaDirForTenant(tenantId), safeName);
  if (!fs.existsSync(filePath)) return null;
  return filePath;
}

function flushAllConversationStores() {
  for (const t of timers.keys()) {
    clearTimeout(timers.get(t));
    timers.delete(t);
  }
  for (const t of cache.keys()) {
    try { flushStore(t); } catch (e) { console.error(`[${t}] Falha ao salvar conversations.json:`, e?.message || e); }
  }
}

module.exports = {
  appendConversationMessage,
  upsertConversationMessages,
  listConversationMessages,
  getLastConversationMessage,
  listConversationDigits,
  listConversationSummaries,
  saveConversationMedia,
  getConversationMediaPath,
  flushAllConversationStores,
};
