'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SqliteClient } = require('../src/database/client');
const { migrateDatabase } = require('../src/database/migrations');
const { buildImportPlan, applyImportPlan } = require('../src/database/importer');

function serial(name, fn) { test(name, { concurrency: false }, fn); }

serial('importador faz dry-run, importa todos os tenants e é idempotente', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-import-'));
  const dataDir = path.join(root, 'data');
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'create-sanitized-fixture.js'), `--output=${dataDir}`, '--force'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const plan = buildImportPlan(dataDir);
  assert.equal(plan.totals.tenants, 6);
  assert.equal(plan.totals.leads, 6);
  const db = new SqliteClient(`sqlite:${path.join(root, 'db.sqlite')}`);
  try {
    await migrateDatabase(db, path.join(__dirname, '..', 'db', 'migrations', 'sqlite'));
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM tenants')).rows[0].total), 0);
    const first = await applyImportPlan(db, plan);
    assert.equal(first.idempotent, false);
    assert.equal(first.report.inserted.leads, 6);
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM messages')).rows[0].total), 6);
    const second = await applyImportPlan(db, plan);
    assert.equal(second.idempotent, true);
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM import_batches')).rows[0].total), 1);
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM leads')).rows[0].total), 6);
  } finally { await db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

serial('linha inválida vai para quarentena sem impedir importação válida', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-quarantine-'));
  const dataDir = path.join(root, 'data'); const tenantDir = path.join(dataDir, 'panel'); fs.mkdirSync(tenantDir, { recursive: true });
  fs.writeFileSync(path.join(tenantDir, 'leads.jsonl'), `${JSON.stringify({ id:'ok', nome:'Válido', whatsapp_digits:'5511999990005', createdAt:new Date().toISOString() })}\n{invalid-json}\n`);
  const plan = buildImportPlan(dataDir);
  assert.equal(plan.totals.quarantined, 1);
  const db = new SqliteClient(`sqlite:${path.join(root, 'db.sqlite')}`);
  try {
    await migrateDatabase(db, path.join(__dirname, '..', 'db', 'migrations', 'sqlite'));
    const result = await applyImportPlan(db, plan);
    assert.equal(result.report.inserted.leads, 1);
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM import_quarantine')).rows[0].total), 1);
  } finally { await db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
