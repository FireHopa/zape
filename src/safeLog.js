const crypto = require('crypto');

const SENSITIVE_KEY = /(authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|access[-_]?token|client[-_]?secret|session)/i;
const PII_KEY = /(phone|whatsapp|email|name|nome|message|mensagem|payload|body|document|arquivo|content)/i;

function fingerprint(value) {
  const text = String(value || '');
  if (!text) return '';
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function maskIdentifier(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return `[masked:${fingerprint(text)}]`;
}

function sanitizeForLog(value, { depth = 0, maxDepth = 4 } = {}) {
  if (value === null || value === undefined) return value;
  if (depth > maxDepth) return '[truncated]';
  if (value instanceof Error) {
    return {
      name: value.name || 'Error',
      code: value.code || undefined,
      message: redactText(value.message || 'Erro'),
      status: value.status || value.statusCode || undefined,
    };
  }
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeForLog(item, { depth: depth + 1, maxDepth }));
  }

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = item ? '[redacted]' : item;
    } else if (PII_KEY.test(key)) {
      out[key] = item ? maskIdentifier(typeof item === 'object' ? JSON.stringify(item) : item) : item;
    } else {
      out[key] = sanitizeForLog(item, { depth: depth + 1, maxDepth });
    }
  }
  return out;
}

function redactText(input) {
  let text = String(input || '');
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]');
  text = text.replace(/\bEAA[A-Za-z0-9]{15,}\b/g, '[redacted-meta-token]');
  text = text.replace(/([?&](?:access_token|input_token|client_secret|token|secret)=)[^&\s]+/gi, '$1[redacted]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]');
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (value) => `[masked-email:${fingerprint(value)}]`);
  text = text.replace(/(?<![A-Za-z0-9])\+?\d[\d\s().-]{8,}\d(?![A-Za-z0-9])/g, (value) => `[masked-phone:${fingerprint(value.replace(/\D/g, ''))}]`);
  text = text.replace(/\b\d{8,20}@(c\.us|s\.whatsapp\.net|lid)\b/gi, (value) => `[masked-wa:${fingerprint(value)}]`);
  return text;
}

function safeError(error) {
  return sanitizeForLog(error);
}

module.exports = {
  fingerprint,
  maskIdentifier,
  redactText,
  sanitizeForLog,
  safeError,
};
