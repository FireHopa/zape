#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createDatabase } = require('../src/database/client');
const { loadDatabaseConfig } = require('../src/database/config');
const { migrateDatabase } = require('../src/database/migrations');
const { buildImportPlan, applyImportPlan } = require('../src/database/importer');

function arg(name, fallback = '') { const prefix = `--${name}=`; const item = process.argv.find((x) => x.startsWith(prefix)); return item ? item.slice(prefix.length) : fallback; }
(async () => {
  const dataDir = path.resolve(arg('data-dir', process.env.ZAPE_DATA_DIR || path.join(process.cwd(), 'data')));
  const reportFile = path.resolve(arg('report', path.join(process.cwd(), 'reports', 'database-import-plan.json')));
  const apply = process.argv.includes('--apply');
  if (apply && arg('confirm') !== 'IMPORT_JSON_TO_DATABASE') throw new Error('Aplicação exige --confirm=IMPORT_JSON_TO_DATABASE.');
  const plan = buildImportPlan(dataDir);
  const publicPlan = { ...plan, tenants: plan.tenants.map((row) => ({ tenantId: row.tenantId, counts: { leads: row.leads.length, tags: row.tags.length, conversations: Object.keys(row.conversations).length } })), cloudConfig: undefined, cloud: undefined, jobs: undefined, webhooks: undefined };
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...publicPlan }, null, 2)}\n`, { mode: 0o600 });
  if (!apply) return console.log(JSON.stringify({ ok: true, mode: 'dry-run', reportFile, sourceChecksum: plan.sourceChecksum, totals: plan.totals }, null, 2));
  const config = loadDatabaseConfig();
  if (config.mode === 'json') throw new Error('PERSISTENCE_MODE deve ser shadow ou database para aplicar importação.');
  const db = createDatabase(config);
  try {
    await migrateDatabase(db, config.migrationsDir);
    const result = await applyImportPlan(db, plan, { batchId: arg('batch-id') || undefined });
    console.log(JSON.stringify({ ok: true, mode: 'apply', reportFile, ...result }, null, 2));
  } finally { await db.close(); }
})().catch((error) => { console.error(JSON.stringify({ ok: false, code: error.code || 'DATABASE_IMPORT_FAILED', message: error.message }, null, 2)); process.exit(1); });
