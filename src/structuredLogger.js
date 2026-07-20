'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sanitizeForLog, redactText } = require('./safeLog');

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, security: 50 });

function cleanId(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(text) ? text : '';
}
function randomId(prefix = '') { return `${prefix}${crypto.randomBytes(16).toString('hex')}`; }
function logFile(env = process.env) {
  const configured = String(env.STRUCTURED_LOG_FILE || '').trim();
  if (configured) return path.resolve(configured);
  const base = String(env.ZAPE_LOG_DIR || '').trim() || path.join(__dirname, '..', 'logs');
  return path.join(path.resolve(base), 'application.jsonl');
}
function maxBytes(env = process.env) { return Math.max(64 * 1024, Number(env.STRUCTURED_LOG_MAX_BYTES || 10 * 1024 * 1024)); }
function maxFiles(env = process.env) { return Math.max(1, Math.min(30, Number(env.STRUCTURED_LOG_MAX_FILES || 10))); }
function configuredLevel(env = process.env) {
  const value = String(env.LOG_LEVEL || (env.NODE_ENV === 'production' ? 'info' : 'debug')).trim().toLowerCase();
  return LEVELS[value] ? value : 'info';
}
function rotate(file, env = process.env) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < maxBytes(env)) return;
    const keep = maxFiles(env);
    for (let index = keep - 1; index >= 1; index -= 1) {
      const source = `${file}.${index}`;
      const target = `${file}.${index + 1}`;
      if (fs.existsSync(source)) fs.renameSync(source, target);
    }
    fs.renameSync(file, `${file}.1`);
    for (let index = keep + 1; index <= keep + 5; index += 1) {
      const stale = `${file}.${index}`;
      if (fs.existsSync(stale)) fs.unlinkSync(stale);
    }
  } catch {}
}
function safeMessage(value) { return redactText(String(value || '')).replace(/[\r\n]+/g, ' ').slice(0, 2000); }

class StructuredLogger {
  constructor({ env = process.env, service = 'zape', stream = null } = {}) {
    this.env = env;
    this.service = service;
    this.file = logFile(env);
    this.stream = stream;
    this.threshold = LEVELS[configuredLevel(env)];
  }
  child(base = {}) {
    const parent = this;
    return Object.fromEntries(Object.keys(LEVELS).map((level) => [level, (message, meta) => parent.log(level, message, { ...base, ...(meta || {}) })]));
  }
  log(level, message, metadata = {}) {
    const normalized = LEVELS[level] ? level : 'info';
    if (LEVELS[normalized] < this.threshold) return null;
    const meta = sanitizeForLog(metadata || {});
    const entry = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      level: normalized,
      service: this.service,
      event: safeMessage(metadata?.event || 'application.log'),
      message: safeMessage(message),
      correlationId: cleanId(metadata?.correlationId),
      operationId: cleanId(metadata?.operationId),
      tenantId: String(metadata?.tenantId || '').slice(0, 40),
      metadata: meta,
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (this.stream && typeof this.stream.write === 'function') this.stream.write(line);
    else {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      rotate(this.file, this.env);
      fs.appendFileSync(this.file, line, { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(this.file, 0o600); } catch {}
    }
    return entry;
  }
  debug(message, meta) { return this.log('debug', message, meta); }
  info(message, meta) { return this.log('info', message, meta); }
  warn(message, meta) { return this.log('warn', message, meta); }
  error(message, meta) { return this.log('error', message, meta); }
  security(message, meta) { return this.log('security', message, meta); }
}

function correlationMiddleware({ logger, metrics } = {}) {
  return function correlation(req, res, next) {
    const started = process.hrtime.bigint();
    req.correlationId = cleanId(req.get('x-correlation-id')) || randomId('req_');
    req.operationId = cleanId(req.get('x-operation-id')) || randomId('op_');
    res.setHeader('X-Correlation-Id', req.correlationId);
    res.once('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const route = String(req.route?.path || req.path || '/').replace(/\/[^/]{20,}/g, '/:id').slice(0, 180);
      metrics?.observeHttp?.({ method: req.method, route, statusCode: res.statusCode, durationMs });
      logger?.info?.('Requisição concluída.', {
        event: 'http.request.completed', correlationId: req.correlationId, operationId: req.operationId,
        tenantId: req.auth?.tenantId || '', method: req.method, route, statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100, clientIpHash: crypto.createHash('sha256').update(String(req.ip || '')).digest('hex').slice(0, 12),
      });
    });
    next();
  };
}

function installConsoleBridge({ logger, passthrough = true } = {}) {
  if (!logger || console.__zapeStructuredBridge) return () => {};
  const original = { log: console.log.bind(console), info: console.info.bind(console), warn: console.warn.bind(console), error: console.error.bind(console), debug: console.debug.bind(console) };
  const mapping = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };
  for (const [method, level] of Object.entries(mapping)) {
    console[method] = (...args) => {
      const message = args.filter((item) => typeof item !== 'object').map((item) => safeMessage(item)).join(' ') || 'Log da aplicação.';
      const objects = args.filter((item) => typeof item === 'object');
      const entry = logger.log(level, message, { event: `console.${method}`, arguments: objects });
      if (passthrough && entry) original[method](JSON.stringify(entry));
    };
  }
  console.__zapeStructuredBridge = true;
  return () => { for (const [method, fn] of Object.entries(original)) console[method] = fn; delete console.__zapeStructuredBridge; };
}

module.exports = { StructuredLogger, correlationMiddleware, installConsoleBridge, cleanId, randomId, logFile, LEVELS };
