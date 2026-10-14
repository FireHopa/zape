'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tenantDir } = require('./tenantPaths');
const { atomicWriteFile } = require('./dataIntegrity');
const { withTenantLeadWrite } = require('./leadWriteCoordinator');
const { buildContactTable, tableToCsv } = require('./contactSpreadsheetData');
const { createGoogleMirror, googleConfig } = require('./contactSpreadsheetGoogle');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const timestamp = () => new Date().toISOString();
function enabled(env) { return !/^(0|false|no|off)$/i.test(String(env.CONTACT_SPREADSHEET_ENABLED || '1')); }
function interval(env) { return Math.max(15000, Math.min(3600000, Number(env.CONTACT_SPREADSHEET_INTERVAL_MS) || 60000)); }

async function readCurrentLeads(tenantId) {
  // Lazy imports avoid a cycle with the intake service. DB mode never falls back
  // to obsolete JSON files, including after an LGPD deletion outside the cache.
  const runtime = require('./database/runtime');
  return withTenantLeadWrite(tenantId, async () => {
    if (!runtime.isDatabasePrimary()) {
      const { readJsonlDetailed } = require('./dataIntegrity');
      const parsed = readJsonlDetailed(path.join(tenantDir(tenantId), 'leads.jsonl'));
      if (parsed.invalidLines.length) {
        throw Object.assign(new Error('Corrija as linhas inv\u00e1lidas de leads antes de atualizar a planilha.'), { code: 'SPREADSHEET_SOURCE_CORRUPT' });
      }
      return parsed.records.map((record) => record.value);
    }
    const state = runtime.getState();
    if (!state.initialized || !state.leadRepository) throw Object.assign(new Error('Banco indispon\u00edvel.'), { code: 'SPREADSHEET_DATABASE_UNAVAILABLE' });
    const rows = [];
    for (let page = 1; ; page += 1) {
      const result = await state.leadRepository.list(tenantId, { page, pageSize: 500 });
      rows.push(...result.items.map(runtime.legacyLead));
      if (!result.hasNext) break;
    }
    return rows;
  });
}

function createContactSpreadsheetService({
  readLeads = readCurrentLeads,
  listTenants = () => require('./authConfig').listTenantConfigs({ includeDisabled: false }).map((cfg) => cfg.tenantId),
  directory = tenantDir,
  env = process.env,
  google = createGoogleMirror(),
  writeFile = atomicWriteFile,
  logger = console,
} = {}) {
  const states = new Map();
  const localJobs = new Map();
  const remoteJobs = new Map();
  const timers = new Map();
  let periodicTimer = null;
  let started = false;

  function files(tenantId) {
    if (!/^[a-z0-9_-]{1,64}$/i.test(String(tenantId))) throw new Error('Tenant inv\u00e1lido.');
    const dir = path.join(directory(tenantId), 'contact_spreadsheet');
    return { dir, csv: path.join(dir, 'contatos.csv'), state: path.join(dir, 'status.json') };
  }
  function stateFor(tenantId) {
    if (!states.has(tenantId)) {
      let stored = {};
      try { stored = JSON.parse(fs.readFileSync(files(tenantId).state, 'utf8')); } catch { /* Rebuild derived state on corruption/missing file. */ }
      states.set(tenantId, {
        count: Number(stored.count) || 0, localHash: '', csvHash: '', localUpdatedAt: stored.localUpdatedAt || null,
        localCheckedAt: null, localError: null, remoteHash: '', remoteTarget: '', remoteUpdatedAt: stored.remoteUpdatedAt || null,
        remoteTitle: null, remoteUrl: null, remoteError: null, attempts: 0, nextAttemptAt: 0,
      });
    }
    return states.get(tenantId);
  }
  function persist(tenantId, state) {
    // Only operational metadata is stored here, never credentials or contact rows.
    writeFile(files(tenantId).state, JSON.stringify({ schemaVersion: 1, count: state.count,
      localUpdatedAt: state.localUpdatedAt, remoteUpdatedAt: state.remoteUpdatedAt }) + '\n', 0o600);
  }
  function publicError(error, fallback) {
    const code = String(error?.code || fallback);
    if (code.startsWith('GOOGLE_') || code.startsWith('SPREADSHEET_')) return { code, message: error.message };
    return { code: fallback, message: 'N\u00e3o foi poss\u00edvel atualizar a planilha. Verifique o armazenamento do servidor.' };
  }
  function status(tenantId) {
    const state = stateFor(tenantId);
    const config = googleConfig(tenantId, env);
    return {
      enabled: enabled(env), tenantId, count: state.count, intervalMs: interval(env),
      local: { ready: Boolean(state.localHash) && fs.existsSync(files(tenantId).csv),
        updatedAt: state.localUpdatedAt, checkedAt: state.localCheckedAt, error: state.localError,
        downloadUrl: `/api/${encodeURIComponent(tenantId)}/contact-spreadsheet/download` },
      google: { enabled: config.enabled, configured: config.enabled && !config.error,
        state: !config.enabled ? 'disabled' : config.error || state.remoteError ? 'error'
          : remoteJobs.has(tenantId) ? 'syncing'
            : state.remoteHash && state.remoteHash === state.localHash ? 'synced' : 'pending',
        updatedAt: state.remoteUpdatedAt, url: state.remoteUrl || config.url || null,
        title: state.remoteTitle, error: config.error ? { code: 'GOOGLE_CONFIG_INVALID', message: config.error } : state.remoteError,
        nextAttemptAt: state.nextAttemptAt ? new Date(state.nextAttemptAt).toISOString() : null },
    };
  }
  function localError(tenantId, error) {
    const state = stateFor(tenantId);
    const next = publicError(error, 'SPREADSHEET_LOCAL_FAILED');
    if (state.localError?.code !== next.code) logger.error('[CONTACT_SPREADSHEET]', tenantId, next.code);
    state.localError = next;
  }
  function refreshLocal(tenantId) {
    if (localJobs.has(tenantId)) return localJobs.get(tenantId);
    const job = (async () => {
      const state = stateFor(tenantId);
      const table = buildContactTable(await readLeads(tenantId));
      const target = files(tenantId);
      const csv = tableToCsv(table);
      const csvHash = digest(csv);
      let actualHash = '';
      try { actualHash = digest(fs.readFileSync(target.csv)); } catch { /* Missing file is rebuilt. */ }
      if (actualHash !== csvHash) {
        fs.mkdirSync(target.dir, { recursive: true, mode: 0o700 });
        writeFile(target.csv, csv, 0o600);
        state.localUpdatedAt = timestamp();
      }
      state.localHash = table.hash;
      state.csvHash = csvHash;
      state.count = table.count;
      state.localCheckedAt = timestamp();
      state.localUpdatedAt ||= state.localCheckedAt;
      state.localError = null;
      persist(tenantId, state);
      return table;
    })().catch((error) => { localError(tenantId, error); throw error; });
    localJobs.set(tenantId, job);
    job.finally(() => { if (localJobs.get(tenantId) === job) localJobs.delete(tenantId); }).catch(() => {});
    return job;
  }
  function syncRemote(tenantId, table) {
    const config = googleConfig(tenantId, env);
    if (!config.enabled || remoteJobs.has(tenantId)) return remoteJobs.get(tenantId) || Promise.resolve();
    const state = stateFor(tenantId);
    const target = config.spreadsheetId || 'invalid';
    if (state.remoteTarget !== target) {
      state.remoteHash = ''; state.remoteTarget = target; state.remoteUrl = null;
      state.remoteTitle = null; state.remoteUpdatedAt = null; state.nextAttemptAt = 0;
    }
    if (state.nextAttemptAt > Date.now() || (state.remoteHash === table.hash && !state.remoteError)) return Promise.resolve();
    const job = (async () => {
      try {
        const result = await google.sync(config, tenantId, table);
        state.remoteHash = table.hash; state.remoteUpdatedAt = timestamp();
        state.remoteUrl = result.url; state.remoteTitle = result.title; state.remoteError = null;
        state.attempts = 0; state.nextAttemptAt = Date.now() + 60000;
        persist(tenantId, state);
      } catch (error) {
        state.remoteError = publicError(error, 'GOOGLE_SYNC_FAILED');
        state.attempts += 1;
        state.nextAttemptAt = Date.now() + Math.min(30 * 60000, 60000 * 2 ** Math.min(state.attempts - 1, 5));
        logger.error('[CONTACT_SPREADSHEET]', tenantId, state.remoteError.code);
      }
    })();
    remoteJobs.set(tenantId, job);
    job.finally(() => { if (remoteJobs.get(tenantId) === job) remoteJobs.delete(tenantId); }).catch(() => {});
    return job;
  }
  async function syncTenant(tenantId, { waitForGoogle = false, forceGoogle = false } = {}) {
    if (!enabled(env)) return status(tenantId);
    const table = await refreshLocal(tenantId);
    if (forceGoogle) stateFor(tenantId).remoteHash = '';
    const remote = syncRemote(tenantId, table);
    if (waitForGoogle) await remote;
    return status(tenantId);
  }
  function schedule(tenantId, delayMs = 300) {
    if (!started || !enabled(env) || timers.has(tenantId)) return;
    const timer = setTimeout(() => {
      timers.delete(tenantId);
      syncTenant(tenantId).catch(() => {});
    }, delayMs);
    timer.unref?.(); timers.set(tenantId, timer);
  }
  function reconcile() {
    for (const tenantId of listTenants()) schedule(tenantId, 0);
  }
  function start() {
    if (started || !enabled(env)) return;
    started = true; reconcile();
    periodicTimer = setInterval(reconcile, interval(env));
    periodicTimer.unref?.();
  }
  async function stop() {
    started = false;
    if (periodicTimer) clearInterval(periodicTimer);
    periodicTimer = null;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    // Committed leads remain the durable retry source after a forced shutdown.
    await Promise.allSettled([...localJobs.values()]);
  }
  async function download(tenantId) {
    if (!enabled(env)) throw Object.assign(new Error('Planilha autom\u00e1tica desativada.'), { code: 'SPREADSHEET_DISABLED', statusCode: 503 });
    // Generate a fresh snapshot, not a filtered page and not a stale disk copy.
    const table = await refreshLocal(tenantId);
    return { csv: tableToCsv(table), count: table.count };
  }
  return { start, stop, schedule, syncTenant, refreshLocal, download, status, files };
}
const contactSpreadsheet = createContactSpreadsheetService();
module.exports = { createContactSpreadsheetService, contactSpreadsheet, readCurrentLeads };
