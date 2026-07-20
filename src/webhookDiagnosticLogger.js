'use strict';

const crypto = require('node:crypto');

const SENSITIVE_KEY = /(authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|access[-_]?token|client[-_]?secret|session|signature)/i;
const PHONE_KEY = /(phone|telefone|celular|mobile|whatsapp|wa_id)/i;
const EMAIL_KEY = /(email|e-mail)/i;

function envEnabled(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

function positiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function tokenReference(value) {
  const text = String(value || '').trim();
  return text ? `sha256:${sha256(text).slice(0, 12)}` : '';
}

function maskPhone(value) {
  const original = String(value || '').trim();
  const digits = original.replace(/\D+/g, '');
  if (!digits) return original ? '[masked-phone]' : '';
  const last = digits.slice(-4);
  return `[masked-phone:length=${digits.length},last4=${last}]`;
}

function maskEmail(value) {
  const text = String(value || '').trim();
  const at = text.lastIndexOf('@');
  if (at <= 0) return text ? '[masked-email]' : '';
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  return `${local.slice(0, 1) || '*'}***@${domain || 'masked'}`;
}

function cleanText(value, maxChars) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...[truncated:${text.length - maxChars}]`;
}

function sanitizeWebhookData(value, options = {}, state = {}) {
  const maxDepth = positiveInt(options.maxDepth, 6, 1, 12);
  const maxKeys = positiveInt(options.maxKeys, 80, 10, 500);
  const maxArray = positiveInt(options.maxArray, 30, 1, 200);
  const maxString = positiveInt(options.maxString, 1200, 50, 20000);
  const depth = Number(state.depth || 0);
  const key = String(state.key || '');

  if (value === null || value === undefined) return value;
  if (SENSITIVE_KEY.test(key)) {
    if (typeof value === 'boolean') return value;
    return value ? '[redacted]' : value;
  }
  if (PHONE_KEY.test(key)) return maskPhone(value);
  if (EMAIL_KEY.test(key)) return maskEmail(value);
  if (depth >= maxDepth) return '[max-depth]';

  if (value instanceof Error) {
    return {
      name: cleanText(value.name || 'Error', 120),
      code: cleanText(value.code || '', 120),
      message: cleanText(value.message || 'Erro', maxString),
      status: value.statusCode || value.status || undefined,
      stack: cleanText(value.stack || '', Math.min(maxString * 2, 8000)),
    };
  }

  if (Buffer.isBuffer(value)) {
    return {
      type: 'Buffer',
      bytes: value.length,
      sha256: crypto.createHash('sha256').update(value).digest('hex').slice(0, 16),
    };
  }

  if (typeof value === 'string') return cleanText(value, maxString);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return cleanText(value, maxString);

  if (Array.isArray(value)) {
    const items = value.slice(0, maxArray).map((item, index) => sanitizeWebhookData(item, options, {
      depth: depth + 1,
      key: `${key}[${index}]`,
    }));
    if (value.length > maxArray) items.push(`[truncated-items:${value.length - maxArray}]`);
    return items;
  }

  const out = {};
  const entries = Object.entries(value);
  for (const [childKey, childValue] of entries.slice(0, maxKeys)) {
    out[childKey] = sanitizeWebhookData(childValue, options, { depth: depth + 1, key: childKey });
  }
  if (entries.length > maxKeys) out.__truncatedKeys = entries.length - maxKeys;
  return out;
}

function rawBodySummary(req) {
  const raw = req?.rawBody;
  if (!raw) return null;
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
  return {
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16),
  };
}

function output(level, event, metadata) {
  let serialized = '{}';
  try {
    serialized = JSON.stringify(metadata);
  } catch (error) {
    serialized = JSON.stringify({ serializationError: String(error?.message || error) });
  }
  const line = `[WEBHOOK_DIAG] ${event} ${serialized}\n`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line);
}

function safeWebhookPath(req) {
  const original = String(req?.originalUrl || req?.url || '');
  return original.replace(/(\/webhooks\/)[^/?#]+/i, '$1[redacted]').slice(0, 500);
}


function webhookTransportDiagnosticsMiddleware() {
  return function webhookTransportDiagnostics(req, res, next) {
    const enabled = envEnabled(process.env.WEBHOOK_DIAGNOSTIC_LOGS, true);
    if (!enabled) return next();

    const startedAt = Date.now();
    const endpointRef = tokenReference(String(req?.path || '').split('/').filter(Boolean).pop() || '');
    let stageName = 'received_before_body_parser';
    let finished = false;

    function emit(level, event, extra = {}) {
      output(level, event, sanitizeWebhookData({
        correlationId: String(req?.correlationId || ''),
        operationId: String(req?.operationId || ''),
        endpointRef,
        stage: stageName,
        elapsedMs: Date.now() - startedAt,
        ...extra,
      }));
    }

    emit('info', 'transport.received', {
      method: req?.method || '',
      path: safeWebhookPath(req),
      contentType: req?.get?.('content-type') || '',
      contentLength: req?.get?.('content-length') || '',
      transferEncoding: req?.get?.('transfer-encoding') || '',
      userAgent: cleanText(req?.get?.('user-agent') || '', 500),
      hasSignatureHeader: Boolean(req?.get?.('x-zape-signature')),
      hasTimestampHeader: Boolean(req?.get?.('x-zape-timestamp')),
      hasEventIdHeader: Boolean(req?.get?.('x-zape-event-id') || req?.get?.('x-idempotency-key')),
      clientIpHash: tokenReference(req?.ip || ''),
    });

    req.webhookTransportDiagnostic = {
      stage(name, extra = {}, level = 'info') {
        stageName = String(name || stageName);
        emit(level, `transport.${stageName}`, extra);
      },
      fail(error, extra = {}) {
        stageName = 'failed_before_route_completion';
        emit('error', 'transport.failed', {
          error: sanitizeWebhookData(error),
          ...extra,
        });
      },
    };

    req.once?.('aborted', () => {
      stageName = 'request_aborted';
      emit('warn', 'transport.aborted', {});
    });

    res.once?.('finish', () => {
      if (finished) return;
      finished = true;
      emit(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'transport.completed', {
        statusCode: res.statusCode,
        responseContentType: res.getHeader?.('content-type') || '',
        responseContentLength: res.getHeader?.('content-length') || '',
      });
    });

    res.once?.('close', () => {
      if (finished || res.writableEnded) return;
      finished = true;
      stageName = 'connection_closed';
      emit('warn', 'transport.connection_closed', { statusCode: res.statusCode });
    });

    return next();
  };
}

function createWebhookRequestDiagnostics({ req, res, token } = {}) {
  const enabled = envEnabled(process.env.WEBHOOK_DIAGNOSTIC_LOGS, true);
  const includeBody = envEnabled(process.env.WEBHOOK_DIAGNOSTIC_LOG_BODY, true);
  const maxBodyChars = positiveInt(process.env.WEBHOOK_DIAGNOSTIC_MAX_BODY_CHARS, 12000, 500, 100000);
  const startedAt = Date.now();
  let finished = false;

  const context = {
    correlationId: String(req?.correlationId || ''),
    operationId: String(req?.operationId || ''),
    endpointRef: tokenReference(token),
    tenantId: '',
    webhookId: '',
    webhookName: '',
    eventId: '',
    stage: 'request_received',
  };

  function base(extra = {}) {
    const safeContext = { ...context };
    if (safeContext.eventId) {
      safeContext.eventIdRef = tokenReference(safeContext.eventId);
      delete safeContext.eventId;
    }
    return sanitizeWebhookData({
      ...safeContext,
      elapsedMs: Date.now() - startedAt,
      ...extra,
    });
  }

  function emit(level, event, extra = {}) {
    if (!enabled) return;
    output(level, event, base(extra));
  }

  function setContext(patch = {}) {
    for (const key of ['tenantId', 'webhookId', 'webhookName', 'eventId', 'stage']) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) context[key] = String(patch[key] || '');
    }
  }

  function stage(name, extra = {}, level = 'info') {
    context.stage = String(name || context.stage);
    emit(level, `custom.${context.stage}`, extra);
  }

  if (enabled) {
    const requestData = includeBody ? sanitizeWebhookData(req?.body || {}) : '[disabled]';
    const preview = typeof requestData === 'string'
      ? cleanText(requestData, maxBodyChars)
      : cleanText(JSON.stringify(requestData), maxBodyChars);

    emit('info', 'custom.received', {
      method: req?.method || '',
      path: safeWebhookPath(req),
      contentType: req?.get?.('content-type') || '',
      contentLength: req?.get?.('content-length') || '',
      userAgent: cleanText(req?.get?.('user-agent') || '', 500),
      eventHeaderRef: tokenReference(req?.get?.('x-zape-event-id') || req?.get?.('x-idempotency-key') || ''),
      signaturePresent: Boolean(req?.get?.('x-zape-signature')),
      timestampPresent: Boolean(req?.get?.('x-zape-timestamp')),
      clientIpHash: tokenReference(req?.ip || ''),
      parsedBodyType: Array.isArray(req?.body) ? 'array' : typeof req?.body,
      parsedBodyKeys: req?.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? Object.keys(req.body).slice(0, 100)
        : [],
      requestDataPreview: preview,
      rawBody: rawBodySummary(req),
    });
  }

  res?.once?.('finish', () => {
    if (finished) return;
    finished = true;
    emit(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'custom.completed', {
      statusCode: res.statusCode,
      responseContentType: res.getHeader?.('content-type') || '',
      responseContentLength: res.getHeader?.('content-length') || '',
    });
  });

  res?.once?.('close', () => {
    if (finished || res.writableEnded) return;
    finished = true;
    emit('warn', 'custom.connection_closed', { statusCode: res.statusCode });
  });

  return {
    enabled,
    info: (event, extra) => emit('info', event, extra),
    warn: (event, extra) => emit('warn', event, extra),
    error: (event, extra) => emit('error', event, extra),
    setContext,
    stage,
    response(responseBody, statusCode) {
      emit(Number(statusCode || res?.statusCode || 200) >= 400 ? 'warn' : 'info', 'custom.response', {
        statusCode: Number(statusCode || res?.statusCode || 200),
        responseData: sanitizeWebhookData(responseBody),
      });
    },
    failure(error, extra = {}) {
      context.stage = 'failed';
      emit('error', 'custom.failed', { error: sanitizeWebhookData(error), ...extra });
    },
  };
}

module.exports = {
  createWebhookRequestDiagnostics,
  webhookTransportDiagnosticsMiddleware,
  sanitizeWebhookData,
};
