const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');

const MIB = 1024 * 1024;

function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

const MEDIA_LIMITS = Object.freeze({
  audio: positiveInt(process.env.MEDIA_AUDIO_MAX_BYTES, 10 * MIB, { max: 50 * MIB }),
  image: positiveInt(process.env.MEDIA_IMAGE_MAX_BYTES, 12 * MIB, { max: 50 * MIB }),
  video: positiveInt(process.env.MEDIA_VIDEO_MAX_BYTES, 25 * MIB, { max: 100 * MIB }),
  pdf: positiveInt(process.env.MEDIA_PDF_MAX_BYTES, 20 * MIB, { max: 50 * MIB }),
  document: positiveInt(process.env.MEDIA_DOCUMENT_MAX_BYTES, 20 * MIB, { max: 50 * MIB }),
  spreadsheet: positiveInt(process.env.MEDIA_SPREADSHEET_MAX_BYTES, 20 * MIB, { max: 50 * MIB }),
  presentation: positiveInt(process.env.MEDIA_PRESENTATION_MAX_BYTES, 20 * MIB, { max: 50 * MIB }),
  archive: positiveInt(process.env.MEDIA_ARCHIVE_MAX_BYTES, 15 * MIB, { max: 50 * MIB }),
  text: positiveInt(process.env.MEDIA_TEXT_MAX_BYTES, 2 * MIB, { max: 10 * MIB }),
});

const ABSOLUTE_MAX_BYTES = positiveInt(
  process.env.MEDIA_ABSOLUTE_MAX_BYTES,
  Math.max(...Object.values(MEDIA_LIMITS)),
  { min: 1024, max: 100 * MIB }
);

const MIME_BY_EXTENSION = Object.freeze({
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.wav': 'audio/wav', '.amr': 'audio/amr',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation', '.zip': 'application/zip',
});

const BLOCKED_EXTENSIONS = new Set([
  '.svg', '.svgz', '.html', '.htm', '.xhtml', '.xml', '.js', '.mjs', '.cjs', '.css', '.exe', '.dll', '.bat', '.cmd',
  '.ps1', '.sh', '.php', '.jar', '.apk', '.msi', '.scr', '.com', '.vbs', '.hta', '.lnk', '.iso',
]);

const BLOCKED_MIME_PATTERNS = [
  /^image\/svg\+xml$/i,
  /^text\/html$/i,
  /^application\/(xhtml\+xml|javascript|x-javascript|xml)$/i,
  /^text\/(javascript|css|xml)$/i,
  /^application\/x-msdownload$/i,
];

function mediaError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function baseMime(value) {
  return String(value || '').toLowerCase().split(';')[0].trim();
}

function sanitizeFilename(value, fallback = 'arquivo') {
  const raw = path.basename(String(value || '').replace(/[\r\n\0]/g, ' ').trim());
  const normalized = raw.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, '_').replace(/\s+/g, ' ').trim();
  const withoutDots = normalized.replace(/^\.+/, '').slice(0, 180);
  return withoutDots || fallback;
}

function classifyMedia(mime, filename = '') {
  const basic = baseMime(mime);
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (basic.startsWith('audio/')) return 'audio';
  if (basic.startsWith('image/')) return 'image';
  if (basic.startsWith('video/')) return 'video';
  if (basic === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (basic.includes('spreadsheet') || basic.includes('excel') || ['.csv', '.xls', '.xlsx', '.ods'].includes(ext)) return 'spreadsheet';
  if (basic.includes('word') || basic.includes('opendocument.text') || ['.doc', '.docx', '.odt'].includes(ext)) return 'document';
  if (basic.includes('presentation') || ['.ppt', '.pptx', '.odp'].includes(ext)) return 'presentation';
  if (basic.includes('zip') || ext === '.zip') return 'archive';
  if (basic.startsWith('text/') || ['.txt', '.csv'].includes(ext)) return 'text';
  return 'file';
}

function startsWith(buffer, bytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < bytes.length) return false;
  return bytes.every((value, index) => buffer[index] === value);
}

function looksLikeText(buffer) {
  if (!buffer.length) return true;
  if (buffer.includes(0)) return false;
  let controls = 0;
  for (const byte of buffer) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return controls / buffer.length < 0.02;
}

function detectMagic(header, declaredMime, filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  const declared = baseMime(declaredMime);
  const ascii = header.slice(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();

  if (startsWith(header, [0xff, 0xd8, 0xff])) return { family: 'jpeg', mime: 'image/jpeg' };
  if (startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { family: 'png', mime: 'image/png' };
  if (header.slice(0, 6).toString('ascii') === 'GIF87a' || header.slice(0, 6).toString('ascii') === 'GIF89a') return { family: 'gif', mime: 'image/gif' };
  if (header.length >= 12 && header.slice(0, 4).toString('ascii') === 'RIFF' && header.slice(8, 12).toString('ascii') === 'WEBP') return { family: 'webp', mime: 'image/webp' };
  if (header.slice(0, 5).toString('ascii') === '%PDF-') return { family: 'pdf', mime: 'application/pdf' };
  if (header.slice(0, 4).toString('ascii') === 'OggS') return { family: 'ogg', mime: declared.startsWith('video/') ? 'video/ogg' : 'audio/ogg' };
  if (header.length >= 12 && header.slice(0, 4).toString('ascii') === 'RIFF' && header.slice(8, 12).toString('ascii') === 'WAVE') return { family: 'wav', mime: 'audio/wav' };
  if (startsWith(header, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { family: 'webm', mime: declared.startsWith('audio/') ? 'audio/webm' : 'video/webm' };
  }
  if (header.slice(0, 3).toString('ascii') === 'ID3' || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0)) return { family: 'mp3-aac', mime: declared === 'audio/aac' ? 'audio/aac' : 'audio/mpeg' };
  if (header.slice(0, 6).toString('ascii') === '#!AMR\n') return { family: 'amr', mime: 'audio/amr' };
  if (header.length >= 12 && header.slice(4, 8).toString('ascii') === 'ftyp') {
    return { family: 'mp4', mime: declared.startsWith('audio/') || ext === '.m4a' ? 'audio/mp4' : (ext === '.mov' ? 'video/quicktime' : 'video/mp4') };
  }
  if (startsWith(header, [0x50, 0x4b, 0x03, 0x04]) || startsWith(header, [0x50, 0x4b, 0x05, 0x06]) || startsWith(header, [0x50, 0x4b, 0x07, 0x08])) {
    return { family: 'zip', mime: MIME_BY_EXTENSION[ext] || 'application/zip' };
  }
  if (startsWith(header, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { family: 'ole', mime: MIME_BY_EXTENSION[ext] || 'application/x-ole-storage' };
  }
  if (looksLikeText(header)) {
    if (/^(<\?xml|<!doctype\s+html|<html\b|<script\b|<svg\b)/i.test(ascii)) {
      throw mediaError('MEDIA_ACTIVE_CONTENT_BLOCKED', 'Arquivos HTML, XML executável e SVG não são permitidos.', 415);
    }
    return { family: 'text', mime: ext === '.csv' || declared === 'text/csv' ? 'text/csv' : 'text/plain' };
  }
  return null;
}

function extractZipEntryNames(buffer) {
  const names = [];
  let offset = 0;
  while (offset + 46 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x02014b50) { offset += 1; continue; }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length) break;
    names.push(buffer.slice(offset + 46, offset + 46 + nameLength).toString('utf8').replace(/\\/g, '/'));
    offset = end;
    if (names.length > 10000) break;
  }
  return names;
}

function validateZipPackage(filename, names) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.zip') return;
  const normalized = new Set((names || []).map((name) => String(name || '').toLowerCase()));
  const hasPrefix = (prefix) => [...normalized].some((name) => name.startsWith(prefix));
  const hasContentTypes = normalized.has('[content_types].xml');
  let valid = true;
  if (ext === '.docx') valid = hasContentTypes && hasPrefix('word/');
  else if (ext === '.xlsx') valid = hasContentTypes && hasPrefix('xl/');
  else if (ext === '.pptx') valid = hasContentTypes && hasPrefix('ppt/');
  else if (['.odt', '.ods', '.odp'].includes(ext)) valid = normalized.has('mimetype') && normalized.has('content.xml');
  if (!valid) throw mediaError('MEDIA_PACKAGE_MISMATCH', 'O pacote do documento não corresponde à extensão informada.', 415);
}

function validateTypeCompatibility({ detected, declaredMime, filename, zipEntryNames }) {
  const declared = baseMime(declaredMime);
  const ext = path.extname(filename).toLowerCase();
  const extensionMime = MIME_BY_EXTENSION[ext] || '';

  if (BLOCKED_EXTENSIONS.has(ext) || BLOCKED_MIME_PATTERNS.some((pattern) => pattern.test(declared))) {
    throw mediaError('MEDIA_TYPE_BLOCKED', 'Este tipo de arquivo não é permitido.', 415);
  }
  if (!detected) throw mediaError('MEDIA_SIGNATURE_UNKNOWN', 'Não foi possível confirmar o tipo real do arquivo.', 415);
  if (detected.family === 'zip') validateZipPackage(filename, zipEntryNames);

  const allowedByFamily = {
    jpeg: ['.jpg', '.jpeg'], png: ['.png'], gif: ['.gif'], webp: ['.webp'], pdf: ['.pdf'],
    ogg: ['.ogg', '.opus'], wav: ['.wav'], webm: ['.webm'], 'mp3-aac': ['.mp3', '.aac'], amr: ['.amr'],
    mp4: ['.mp4', '.m4a', '.mov'], zip: ['.zip', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'],
    ole: ['.doc', '.xls', '.ppt'], text: ['.txt', '.csv'],
  };
  const extensions = allowedByFamily[detected.family] || [];
  if (!extensions.includes(ext)) {
    throw mediaError('MEDIA_EXTENSION_MISMATCH', 'A extensão não corresponde ao conteúdo real do arquivo.', 415);
  }

  if (declared && declared !== 'application/octet-stream') {
    const detectedKind = classifyMedia(detected.mime, filename);
    const declaredKind = classifyMedia(declared, filename);
    if (detectedKind !== declaredKind && !(detected.family === 'zip' && ['archive', 'document', 'spreadsheet', 'presentation'].includes(declaredKind))) {
      throw mediaError('MEDIA_MIME_MISMATCH', 'O tipo informado não corresponde ao conteúdo real do arquivo.', 415);
    }
  }

  const finalMime = extensionMime || detected.mime;
  const kind = classifyMedia(finalMime, filename);
  if (!Object.prototype.hasOwnProperty.call(MEDIA_LIMITS, kind)) {
    throw mediaError('MEDIA_TYPE_NOT_ALLOWED', 'Este tipo de arquivo não está na lista permitida.', 415);
  }
  return { finalMime, kind };
}

function validateMediaDescriptor({ header, size, declaredMime, filename, zipEntryNames }) {
  const safeFilename = sanitizeFilename(filename);
  if (!Number.isFinite(size) || size <= 0) throw mediaError('MEDIA_EMPTY', 'Arquivo vazio.', 400);
  if (size > ABSOLUTE_MAX_BYTES) throw mediaError('MEDIA_TOO_LARGE', 'Arquivo acima do limite máximo permitido.', 413);
  const detected = detectMagic(header, declaredMime, safeFilename);
  const { finalMime, kind } = validateTypeCompatibility({ detected, declaredMime, filename: safeFilename, zipEntryNames });
  const kindLimit = MEDIA_LIMITS[kind];
  if (size > kindLimit) throw mediaError('MEDIA_TOO_LARGE_FOR_TYPE', `Arquivo ${kind} acima do limite permitido.`, 413);
  return { filename: safeFilename, mimetype: finalMime, kind, size, detectedFamily: detected.family, limit: kindLimit };
}

function validateMediaBuffer(buffer, { declaredMime, filename } = {}) {
  const content = Buffer.from(buffer || []);
  const detectedHeader = content.slice(0, 8192);
  const zipEntryNames = startsWith(detectedHeader, [0x50, 0x4b]) ? extractZipEntryNames(content) : undefined;
  return validateMediaDescriptor({ header: detectedHeader, size: content.length, declaredMime, filename, zipEntryNames });
}

function validateMediaFile(filePath, { declaredMime, filename } = {}) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(Math.min(8192, stat.size));
  let zipEntryNames;
  try {
    fs.readSync(fd, header, 0, header.length, 0);
    if (startsWith(header, [0x50, 0x4b])) {
      const tailSize = Math.min(stat.size, 2 * 1024 * 1024);
      const tail = Buffer.alloc(tailSize);
      fs.readSync(fd, tail, 0, tailSize, stat.size - tailSize);
      zipEntryNames = extractZipEntryNames(tail);
    }
  } finally { fs.closeSync(fd); }
  return validateMediaDescriptor({ header, size: stat.size, declaredMime, filename, zipEntryNames });
}

async function streamRequestToTempFile(req, { maxBytes = ABSOLUTE_MAX_BYTES, prefix = 'zape-upload-' } = {}) {
  const length = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(length) && length > maxBytes) throw mediaError('MEDIA_TOO_LARGE', 'Arquivo acima do limite máximo permitido.', 413);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filePath = path.join(tempDir, 'upload.bin');
  const hash = crypto.createHash('sha256');
  const chunks = [];
  let captured = 0;
  let total = 0;

  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) return callback(mediaError('MEDIA_TOO_LARGE', 'Arquivo acima do limite máximo permitido.', 413));
      hash.update(chunk);
      if (captured < 8192) {
        const slice = chunk.slice(0, Math.min(chunk.length, 8192 - captured));
        chunks.push(slice);
        captured += slice.length;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(req, limiter, fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
    if (!total) throw mediaError('MEDIA_EMPTY', 'Arquivo vazio.', 400);
    return { tempDir, filePath, size: total, header: Buffer.concat(chunks), sha256: hash.digest('hex') };
  } catch (error) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

function parseScannerCommand() {
  const raw = String(process.env.MEDIA_SCANNER_COMMAND_JSON || '').trim();
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw mediaError('MEDIA_SCANNER_CONFIG_INVALID', 'Configuração do scanner de mídia inválida.', 500); }
  if (!Array.isArray(parsed) || !parsed.length || parsed.some((item) => typeof item !== 'string' || !item.trim())) {
    throw mediaError('MEDIA_SCANNER_CONFIG_INVALID', 'Configuração do scanner de mídia inválida.', 500);
  }
  return parsed.map((item) => item.trim());
}

function scanMediaFile(filePath) {
  const required = String(process.env.MEDIA_SCANNER_REQUIRED || '') === '1';
  const command = parseScannerCommand();
  if (!command) {
    if (required) throw mediaError('MEDIA_SCANNER_REQUIRED', 'Scanner de malware obrigatório, mas não configurado.', 503);
    return { status: 'not_configured' };
  }
  const result = spawnSync(command[0], [...command.slice(1), filePath], {
    encoding: 'utf8',
    timeout: positiveInt(process.env.MEDIA_SCANNER_TIMEOUT_MS, 30_000, { min: 1_000, max: 120_000 }),
    maxBuffer: 64 * 1024,
  });
  if (result.error) throw mediaError('MEDIA_SCANNER_FAILED', 'Não foi possível verificar o arquivo.', 503);
  if (result.status === 0) return { status: 'clean' };
  if (result.status === 1) throw mediaError('MEDIA_MALWARE_DETECTED', 'O arquivo foi bloqueado pela verificação de segurança.', 422);
  throw mediaError('MEDIA_SCANNER_FAILED', 'A verificação de segurança do arquivo falhou.', 503);
}

function shouldServeInline(kind) {
  return ['audio', 'image', 'video', 'pdf'].includes(String(kind || ''));
}

function safeContentDisposition(filename, inline = false) {
  const safe = sanitizeFilename(filename).replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(safe).replace(/['()]/g, escape);
  return `${inline ? 'inline' : 'attachment'}; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

module.exports = {
  MEDIA_LIMITS,
  ABSOLUTE_MAX_BYTES,
  baseMime,
  classifyMedia,
  sanitizeFilename,
  validateMediaBuffer,
  validateMediaFile,
  streamRequestToTempFile,
  scanMediaFile,
  shouldServeInline,
  safeContentDisposition,
  mediaError,
};
