'use strict';

const crypto = require('crypto');

function envBool(value, fallback = false) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function customWebhookSignatureRequired({ nodeEnv = process.env.NODE_ENV, configured = process.env.CUSTOM_WEBHOOK_REQUIRE_SIGNATURE } = {}) {
  return String(nodeEnv || '').trim().toLowerCase() === 'production' || envBool(configured, true);
}

function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getRawBody(req) {
  if (Buffer.isBuffer(req?.body)) return req.body;
  if (Buffer.isBuffer(req?.rawBody)) return req.rawBody;
  return null;
}

function parseJsonBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const error = new Error('Payload JSON ausente.');
    error.code = 'PAYLOAD_REQUIRED';
    error.statusCode = 400;
    throw error;
  }
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    const error = new Error('Payload JSON malformado.');
    error.code = 'INVALID_JSON';
    error.statusCode = 400;
    throw error;
  }
}

function isJsonContentType(req) {
  const type = String(req?.get?.('content-type') || req?.headers?.['content-type'] || '').toLowerCase();
  return /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(type);
}

function resolveClientIp(req, trustProxyHeaders = envBool(process.env.PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS, false)) {
  if (trustProxyHeaders && req?.ip) return String(req.ip).slice(0, 128);
  return String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || 'unknown').slice(0, 128);
}

function validateMetaSignature(rawBody, signatureHeader, appSecret) {
  const secret = String(appSecret || '').trim();
  const signature = String(signatureHeader || '').trim().toLowerCase();
  if (!Buffer.isBuffer(rawBody) || !rawBody.length || !secret || !signature.startsWith('sha256=')) return false;
  const providedHex = signature.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/.test(providedHex)) return false;
  const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqualText(expectedHex, providedHex);
}

function buildCustomWebhookSignedPayload({ timestamp, eventId, rawBody }) {
  return Buffer.concat([
    Buffer.from(String(timestamp || ''), 'utf8'),
    Buffer.from('.', 'utf8'),
    Buffer.from(String(eventId || ''), 'utf8'),
    Buffer.from('.', 'utf8'),
    Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8'),
  ]);
}

function validateCustomWebhookSignature({
  rawBody,
  signatureHeader,
  timestampHeader,
  eventIdHeader,
  secret,
  nowMs = Date.now(),
  toleranceSeconds = positiveInt(process.env.CUSTOM_WEBHOOK_CLOCK_TOLERANCE_SECONDS, 300, { min: 30, max: 3600 }),
} = {}) {
  const timestampText = String(timestampHeader || '').trim();
  const eventId = String(eventIdHeader || '').trim();
  const signature = String(signatureHeader || '').trim().toLowerCase();
  const secretText = String(secret || '').trim();

  if (!Buffer.isBuffer(rawBody) || !rawBody.length) return { ok: false, code: 'RAW_BODY_REQUIRED' };
  if (!secretText) return { ok: false, code: 'WEBHOOK_SECRET_MISSING' };
  if (!/^\d{10,13}$/.test(timestampText)) return { ok: false, code: 'WEBHOOK_TIMESTAMP_INVALID' };
  if (!eventId || eventId.length > 200 || !/^[A-Za-z0-9._:@-]+$/.test(eventId)) {
    return { ok: false, code: 'WEBHOOK_EVENT_ID_INVALID' };
  }
  if (!signature.startsWith('sha256=')) return { ok: false, code: 'WEBHOOK_SIGNATURE_MISSING' };
  const providedHex = signature.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/.test(providedHex)) return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' };

  const timestampNumber = Number(timestampText);
  const timestampMs = timestampText.length === 10 ? timestampNumber * 1000 : timestampNumber;
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > toleranceSeconds * 1000) {
    return { ok: false, code: 'WEBHOOK_TIMESTAMP_EXPIRED' };
  }

  const expectedHex = crypto.createHmac('sha256', secretText)
    .update(buildCustomWebhookSignedPayload({ timestamp: timestampText, eventId, rawBody }))
    .digest('hex');
  if (!timingSafeEqualText(expectedHex, providedHex)) return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' };
  return { ok: true, eventId, timestampMs };
}

function resolvePresentedToken(req) {
  const explicitHeader = String(req?.get?.('x-zape-webhook-token') || req?.headers?.['x-zape-webhook-token'] || '').trim();
  if (explicitHeader) return explicitHeader;
  const authorization = String(req?.get?.('authorization') || req?.headers?.authorization || '').trim();
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  if (envBool(process.env.ALLOW_WEBHOOK_TOKEN_IN_QUERY, false)) {
    return String(req?.query?.token || '').trim();
  }
  return '';
}

function validateFixedWebhookToken(req, expectedToken) {
  return timingSafeEqualText(resolvePresentedToken(req), String(expectedToken || '').trim());
}

function assertSafeJsonShape(value, {
  maxDepth = 8,
  maxKeys = 500,
  maxStringLength = 20_000,
  maxArrayLength = 500,
} = {}) {
  let keysSeen = 0;
  const visit = (node, depth) => {
    if (depth > maxDepth) throw Object.assign(new Error('Payload excede a profundidade permitida.'), { code: 'PAYLOAD_TOO_DEEP', statusCode: 400 });
    if (typeof node === 'string' && node.length > maxStringLength) {
      throw Object.assign(new Error('Campo de texto excede o limite permitido.'), { code: 'FIELD_TOO_LONG', statusCode: 400 });
    }
    if (Array.isArray(node)) {
      if (node.length > maxArrayLength) throw Object.assign(new Error('Array excede o limite permitido.'), { code: 'ARRAY_TOO_LARGE', statusCode: 400 });
      node.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (node && typeof node === 'object') {
      const entries = Object.entries(node);
      keysSeen += entries.length;
      if (keysSeen > maxKeys) throw Object.assign(new Error('Payload contém campos demais.'), { code: 'TOO_MANY_FIELDS', statusCode: 400 });
      for (const [key, item] of entries) {
        if (key.length > 200) throw Object.assign(new Error('Nome de campo inválido.'), { code: 'FIELD_NAME_TOO_LONG', statusCode: 400 });
        visit(item, depth + 1);
      }
    }
  };
  visit(value, 0);
  return value;
}

function requireObject(value, code = 'PAYLOAD_OBJECT_REQUIRED') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('O payload deve ser um objeto JSON.'), { code, statusCode: 400 });
  }
  return value;
}

function cleanString(value, maxLength = 1000) {
  const text = String(value ?? '').trim();
  if (text.length > maxLength) throw Object.assign(new Error('Campo de texto excede o limite permitido.'), { code: 'FIELD_TOO_LONG', statusCode: 400 });
  return text;
}

function validatePublicLeadPayload(body) {
  requireObject(body);
  assertSafeJsonShape(body, { maxDepth: 3, maxKeys: 30, maxStringLength: 5000, maxArrayLength: 20 });
  const allowed = new Set(['nome', 'empresa', 'jaAnuncia', 'website', 'email', 'whatsapp']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw Object.assign(new Error(`Campos não permitidos: ${unknown.slice(0, 5).join(', ')}.`), { code: 'UNKNOWN_FIELDS', statusCode: 400 });
  }
  return {
    nome: cleanString(body.nome, 200),
    empresa: cleanString(body.empresa, 300),
    jaAnuncia: cleanString(body.jaAnuncia, 100),
    website: cleanString(body.website, 1000),
    email: cleanString(body.email, 320),
    whatsapp: cleanString(body.whatsapp, 80),
  };
}

function validateActiveCampaignPayload(body) {
  requireObject(body);
  assertSafeJsonShape(body, { maxDepth: 8, maxKeys: 500, maxStringLength: 20_000, maxArrayLength: 500 });
  if (body.contact !== undefined && (!body.contact || typeof body.contact !== 'object' || Array.isArray(body.contact))) {
    throw Object.assign(new Error('Campo contact inválido.'), { code: 'INVALID_CONTACT', statusCode: 400 });
  }
  return body;
}

function validateCustomWebhookPayload(body) {
  requireObject(body);
  assertSafeJsonShape(body, { maxDepth: 8, maxKeys: 500, maxStringLength: 20_000, maxArrayLength: 500 });
  return body;
}

function validateMetaWebhookPayload(body) {
  requireObject(body);
  assertSafeJsonShape(body, { maxDepth: 12, maxKeys: 3000, maxStringLength: 100_000, maxArrayLength: 1000 });
  if (body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
    throw Object.assign(new Error('Payload da Meta inválido.'), { code: 'INVALID_META_PAYLOAD', statusCode: 400 });
  }
  return body;
}

function extractMetaPhoneNumberId(body) {
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const id = String(change?.value?.metadata?.phone_number_id || '').trim();
      if (id) return id;
    }
  }
  return '';
}

function extractMetaEventIds(body) {
  const ids = [];
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value || {};
      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        const id = String(status?.id || '').trim();
        if (id) ids.push(`status:${id}:${String(status?.status || '').trim()}`);
      }
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        const id = String(message?.id || '').trim();
        if (id) ids.push(`message:${id}`);
      }
    }
  }
  return [...new Set(ids)].sort();
}

function deriveMetaEventKey(body, rawBody) {
  const ids = extractMetaEventIds(body);
  const phoneNumberId = extractMetaPhoneNumberId(body);
  const material = ids.length ? `${phoneNumberId}|${ids.join('|')}` : rawBody;
  return `meta:${sha256(material)}`;
}

class InMemoryRateLimiter {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.buckets = new Map();
  }

  consume(key, { max = 60, windowMs = 60_000 } = {}) {
    const normalizedKey = sha256(String(key || 'unknown'));
    const now = this.now();
    let bucket = this.buckets.get(normalizedKey);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(normalizedKey, bucket);
    }
    bucket.count += 1;
    if (this.buckets.size > 10_000) {
      for (const [candidate, value] of this.buckets.entries()) {
        if (now >= value.resetAt) this.buckets.delete(candidate);
      }
    }
    return {
      allowed: bucket.count <= max,
      remaining: Math.max(0, max - bucket.count),
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      resetAt: bucket.resetAt,
    };
  }

  reset() {
    this.buckets.clear();
  }
}

function respondSecurityError(res, statusCode, code, message) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(statusCode).json({ ok: false, code, error: message });
}

function enforceRateLimit({ req, res, limiter, scope, identity, max, windowMs }) {
  const result = limiter.consume(`${scope}:${identity}`, { max, windowMs });
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  if (!result.allowed) {
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    respondSecurityError(res, 429, 'RATE_LIMITED', 'Muitas solicitações. Tente novamente mais tarde.');
    return false;
  }
  return true;
}

module.exports = {
  envBool,
  customWebhookSignatureRequired,
  positiveInt,
  sha256,
  timingSafeEqualText,
  getRawBody,
  parseJsonBuffer,
  isJsonContentType,
  resolveClientIp,
  validateMetaSignature,
  buildCustomWebhookSignedPayload,
  validateCustomWebhookSignature,
  resolvePresentedToken,
  validateFixedWebhookToken,
  assertSafeJsonShape,
  validatePublicLeadPayload,
  validateActiveCampaignPayload,
  validateCustomWebhookPayload,
  validateMetaWebhookPayload,
  extractMetaPhoneNumberId,
  extractMetaEventIds,
  deriveMetaEventKey,
  InMemoryRateLimiter,
  respondSecurityError,
  enforceRateLimit,
};
