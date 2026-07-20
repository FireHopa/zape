'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sanitizeForLog } = require('./safeLog');

function stateFile(env = process.env) { return path.resolve(env.ALERT_STATE_FILE || path.join(env.ZAPE_DATA_DIR || path.join(__dirname, '..', 'data'), 'alerts_state.json')); }
function hash(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function readState(file) { try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : { alerts: {} }; } catch { return { alerts: {} }; } }
function writeState(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, file); try { fs.chmodSync(file, 0o600); } catch {} }

class AlertManager {
  constructor({ env = process.env, logger = null, now = () => Date.now(), fetchImpl = global.fetch } = {}) { this.env = env; this.logger = logger; this.now = now; this.fetchImpl = fetchImpl; this.file = stateFile(env); }
  async notify({ code, severity = 'warning', message, tenantId = '', details = {}, active = true }) {
    const safeCode = String(code || 'UNKNOWN_ALERT').replace(/[^A-Z0-9_.-]/gi, '_').slice(0, 80);
    const key = `${tenantId || 'global'}:${safeCode}`;
    const state = readState(this.file); state.alerts ||= {};
    const current = state.alerts[key] || {};
    const cooldownMs = Math.max(60_000, Number(this.env.ALERT_COOLDOWN_MS || 900_000));
    const fingerprint = hash(JSON.stringify({ safeCode, severity, message, details: sanitizeForLog(details) }));
    if (!active) { if (current.active) { state.alerts[key] = { ...current, active: false, resolvedAt: new Date(this.now()).toISOString() }; writeState(this.file, state); this.logger?.info?.('Alerta resolvido.', { event: 'alert.resolved', code: safeCode, tenantId }); } return { emitted: false, resolved: Boolean(current.active) }; }
    const shouldEmit = !current.active || current.fingerprint !== fingerprint || this.now() - Number(current.lastEmittedAtMs || 0) >= cooldownMs;
    const record = { code: safeCode, severity, message: String(message || '').slice(0, 300), tenantId: String(tenantId || '').slice(0, 40), details: sanitizeForLog(details), active: true, fingerprint, firstSeenAt: current.firstSeenAt || new Date(this.now()).toISOString(), lastSeenAt: new Date(this.now()).toISOString(), lastEmittedAtMs: shouldEmit ? this.now() : current.lastEmittedAtMs || 0, occurrences: Number(current.occurrences || 0) + 1 };
    state.alerts[key] = record; writeState(this.file, state);
    if (shouldEmit) { this.logger?.security?.(record.message, { event: 'alert.triggered', ...record }); await this.sendWebhook(record); }
    return { emitted: shouldEmit, record };
  }
  async sendWebhook(record) { const url = String(this.env.ALERT_WEBHOOK_URL || '').trim(); if (!url || !this.fetchImpl) return false; try { const headers = { 'content-type': 'application/json' }; const token = String(this.env.ALERT_WEBHOOK_TOKEN || '').trim(); if (token) headers.authorization = `Bearer ${token}`; const response = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ event: 'zape.alert', alert: record }) }); return response.ok; } catch (error) { this.logger?.error?.('Falha ao enviar alerta externo.', { event: 'alert.delivery_failed', code: record.code, error }); return false; } }
  list() { return Object.values(readState(this.file).alerts || {}); }
}
module.exports = { AlertManager, stateFile };
