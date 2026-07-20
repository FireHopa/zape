'use strict';

const fs = require('node:fs');
const path = require('node:path');

function safeJson(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function newestFileTimestamp(dir) { try { return Math.max(0, ...fs.readdirSync(dir).map((name) => fs.statSync(path.join(dir, name)).mtimeMs)); } catch { return 0; } }
function diskUsage(target) {
  try { const stat = fs.statfsSync(target); const total = Number(stat.blocks) * Number(stat.bsize); const free = Number(stat.bavail) * Number(stat.bsize); return { totalBytes: total, freeBytes: free, usedPercent: total ? Math.round(((total - free) / total) * 10000) / 100 : 0 }; } catch { return { totalBytes: 0, freeBytes: 0, usedPercent: 0 }; }
}
async function collectSystemSnapshot({ env = process.env, databaseHealth = null, whatsappStatus = null, cloudStatus = null, metrics = null } = {}) {
  const dataDir = path.resolve(env.ZAPE_DATA_DIR || path.join(__dirname, '..', 'data'));
  const queueFile = path.resolve(env.WA_CLOUD_QUEUE_FILE || path.join(dataDir, 'wa_cloud_jobs.json'));
  const queue = safeJson(queueFile, { jobs: [] }); const jobs = Array.isArray(queue.jobs) ? queue.jobs : [];
  const backupDir = path.resolve(env.BACKUP_REMOTE_DIRECTORY || env.BACKUP_DIRECTORY || path.join(__dirname, '..', 'backups'));
  const snapshot = {
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    disk: diskUsage(dataDir),
    queue: { total: jobs.length, pending: jobs.filter((j) => ['queued','running','paused'].includes(String(j.state))).length, failed: jobs.filter((j) => ['failed','dead_letter'].includes(String(j.state))).length, oldestPendingAgeMs: 0 },
    backup: { directory: backupDir, latestAt: newestFileTimestamp(backupDir) || null },
    database: databaseHealth ? await databaseHealth().catch(() => ({ ok: false })) : { ok: null },
    whatsapp: whatsappStatus ? await Promise.resolve(whatsappStatus()).catch(() => ({ ok: false })) : { ok: null },
    cloud: cloudStatus ? await Promise.resolve(cloudStatus()).catch(() => ({ ok: false })) : { ok: null },
    metrics: metrics?.snapshot ? metrics.snapshot() : null,
  };
  const pendingDates = jobs.filter((j) => ['queued','running','paused'].includes(String(j.state))).map((j) => Date.parse(j.createdAt || j.updatedAt || '')).filter(Number.isFinite);
  if (pendingDates.length) snapshot.queue.oldestPendingAgeMs = Date.now() - Math.min(...pendingDates);
  return snapshot;
}
async function evaluateSystemAlerts(snapshot, alertManager, env = process.env) {
  const results = [];
  const diskMax = Number(env.ALERT_DISK_USED_PERCENT || 85);
  results.push(await alertManager.notify({ code: 'DISK_USAGE_HIGH', severity: 'critical', message: 'Uso de disco acima do limite.', details: { usedPercent: snapshot.disk.usedPercent, threshold: diskMax }, active: snapshot.disk.usedPercent >= diskMax }));
  const queueAge = Number(env.ALERT_QUEUE_STALLED_MS || 15 * 60 * 1000);
  results.push(await alertManager.notify({ code: 'QUEUE_STALLED', severity: 'critical', message: 'Fila possui jobs pendentes há tempo excessivo.', details: { oldestPendingAgeMs: snapshot.queue.oldestPendingAgeMs, pending: snapshot.queue.pending }, active: snapshot.queue.pending > 0 && snapshot.queue.oldestPendingAgeMs >= queueAge }));
  const backupAge = Number(env.ALERT_BACKUP_MAX_AGE_MS || 26 * 60 * 60 * 1000);
  const backupOld = !snapshot.backup.latestAt || Date.now() - snapshot.backup.latestAt > backupAge;
  results.push(await alertManager.notify({ code: 'BACKUP_STALE', severity: 'critical', message: 'Backup válido não foi encontrado dentro da janela esperada.', details: { latestAt: snapshot.backup.latestAt, maxAgeMs: backupAge }, active: backupOld }));
  results.push(await alertManager.notify({ code: 'DATABASE_UNAVAILABLE', severity: 'critical', message: 'Banco de dados indisponível.', details: { database: snapshot.database }, active: snapshot.database?.ok === false }));
  results.push(await alertManager.notify({ code: 'WHATSAPP_DISCONNECTED', severity: 'warning', message: 'WhatsApp desconectado.', details: { whatsapp: snapshot.whatsapp }, active: snapshot.whatsapp?.ok === false }));
  results.push(await alertManager.notify({ code: 'CLOUD_API_INVALID', severity: 'critical', message: 'Configuração da WhatsApp Cloud API inválida.', details: { cloud: snapshot.cloud }, active: snapshot.cloud?.ok === false }));
  const counters = snapshot.metrics?.counters || []; const requests = counters.filter((row) => row.name === 'zape_http_requests_total').reduce((sum,row)=>sum+Number(row.value||0),0); const errors = counters.filter((row) => row.name === 'zape_http_errors_total').reduce((sum,row)=>sum+Number(row.value||0),0); const errorPercent = requests ? (errors / requests) * 100 : 0; const errorLimit = Number(env.ALERT_HTTP_5XX_PERCENT || 10);
  results.push(await alertManager.notify({ code: 'HTTP_ERROR_RATE_HIGH', severity: 'critical', message: 'Taxa de erros HTTP 5xx acima do limite.', details: { requests, errors, errorPercent, threshold: errorLimit }, active: requests >= Number(env.ALERT_HTTP_MIN_REQUESTS || 20) && errorPercent >= errorLimit }));
  return results;
}
module.exports = { collectSystemSnapshot, evaluateSystemAlerts, diskUsage };
