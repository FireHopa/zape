'use strict';

function labelKey(labels = {}) { return Object.entries(labels).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${String(v)}`).join(','); }
function escapeLabel(value) { return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'); }
function labelText(labels = {}) { const items = Object.entries(labels); return items.length ? `{${items.map(([k,v]) => `${k}="${escapeLabel(v)}"`).join(',')}}` : ''; }

class MetricsRegistry {
  constructor() { this.counters = new Map(); this.gauges = new Map(); this.histograms = new Map(); this.startedAt = Date.now(); }
  inc(name, labels = {}, amount = 1) { const key = `${name}|${labelKey(labels)}`; const row = this.counters.get(key) || { name, labels, value: 0 }; row.value += Number(amount || 0); this.counters.set(key, row); return row.value; }
  set(name, labels = {}, value = 0) { const key = `${name}|${labelKey(labels)}`; this.gauges.set(key, { name, labels, value: Number(value || 0) }); }
  observe(name, labels = {}, value = 0) { const key = `${name}|${labelKey(labels)}`; const row = this.histograms.get(key) || { name, labels, count: 0, sum: 0, max: 0 }; const n = Number(value || 0); row.count += 1; row.sum += n; row.max = Math.max(row.max, n); this.histograms.set(key, row); }
  observeHttp({ method, route, statusCode, durationMs }) { const labels = { method: String(method || 'GET'), route: String(route || '/'), status: String(statusCode || 0) }; this.inc('zape_http_requests_total', labels); if (Number(statusCode) >= 500) this.inc('zape_http_errors_total', labels); this.observe('zape_http_request_duration_ms', { method: labels.method, route: labels.route }, durationMs); }
  snapshot() { return { generatedAt: new Date().toISOString(), uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000), counters: Array.from(this.counters.values()), gauges: Array.from(this.gauges.values()), histograms: Array.from(this.histograms.values()) }; }
  prometheus() { const lines = ['# HELP zape_process_uptime_seconds Process uptime.', '# TYPE zape_process_uptime_seconds gauge', `zape_process_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`]; for (const row of this.counters.values()) lines.push(`${row.name}${labelText(row.labels)} ${row.value}`); for (const row of this.gauges.values()) lines.push(`${row.name}${labelText(row.labels)} ${row.value}`); for (const row of this.histograms.values()) { const labels = labelText(row.labels); lines.push(`${row.name}_count${labels} ${row.count}`); lines.push(`${row.name}_sum${labels} ${row.sum}`); lines.push(`${row.name}_max${labels} ${row.max}`); } return `${lines.join('\n')}\n`; }
}

const defaultMetrics = new MetricsRegistry();
module.exports = { MetricsRegistry, defaultMetrics };
