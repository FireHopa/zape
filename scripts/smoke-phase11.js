#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { SqliteClient } = require('../src/database/client');
const { migrateDatabase } = require('../src/database/migrations');
const { buildImportPlan, applyImportPlan } = require('../src/database/importer');

const ROOT = path.resolve(__dirname, '..');
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputFile = outputArg ? path.resolve(outputArg.slice('--output='.length)) : '';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function port() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); }); }
async function waitHealth(base, child, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { if (child.exitCode !== null) return false; try { if ((await fetch(`${base}/health`)).status === 200) return true; } catch {} await sleep(100); } return false; }
async function stop(child) { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
function cookies(response) { return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; '); }
function cookieValue(cookie, name) { const item = cookie.split(/;\s*/).find((value) => value.startsWith(`${name}=`)); return item ? decodeURIComponent(item.slice(name.length + 1)) : ''; }
async function login(base, tenant, username, password) { const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ tenant, username, password }) }); assert.equal(response.status, 200, await response.text()); const cookie = cookies(response); return { cookie, csrf: cookieValue(cookie, 'zape_csrf') }; }

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-phase11-smoke-'));
  const dataDir = path.join(root, 'data');
  const databaseFile = path.join(root, 'zape.sqlite');
  const fixture = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'create-sanitized-fixture.js'), `--output=${dataDir}`, '--force'], { encoding: 'utf8' });
  assert.equal(fixture.status, 0, fixture.stderr);
  const db = new SqliteClient(`sqlite:${databaseFile}`);
  try {
    await migrateDatabase(db, path.join(ROOT, 'db', 'migrations', 'sqlite'));
    const imported = await applyImportPlan(db, buildImportPlan(dataDir));
    assert.equal(imported.report.inserted.leads, 6);
  } finally { await db.close(); }

  const appPort = await port(); const base = `http://127.0.0.1:${appPort}`;
  const user = `panel_${crypto.randomBytes(4).toString('hex')}`; const password = crypto.randomBytes(32).toString('base64url');
  const env = {
    ...process.env,
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(appPort), PUBLIC_BASE_URL: base, ZAPE_DATA_DIR: dataDir,
    SESSION_SECRET: crypto.randomBytes(48).toString('base64url'), SESSION_STORE_FILE: path.join(root, 'sessions.json'), SECURITY_AUDIT_FILE: path.join(root, 'audit.jsonl'), CONFIG_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    ADMIN_ENABLED: '0', PANEL_ENABLED: '1', PANEL_USER: user, PANEL_PASS: password, REGINA_ENABLED: '0', PORTUGAL_ENABLED: '0', FELIPE_ENABLED: '0', ANA_ENABLED: '0',
    WEBJS_ENABLED: '0', WEBJS_AUTO_START: '0', CRM_INTEGRATION_ENABLED: '0', PUBLIC_LEAD_FORM_ENABLED: '0', ACTIVECAMPAIGN_WEBHOOK_ENABLED: '0', DATA_INTEGRITY_VALIDATE_ON_BOOT: '0', WA_CLOUD_ENABLED: '0',
    PERSISTENCE_MODE: 'database', DATABASE_URL: `sqlite:${databaseFile}`, DATABASE_SSL: 'disable',
  };
  let child; let stdout = ''; let stderr = '';
  const spawnApp = () => { const app = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }); app.stdout.on('data', (chunk) => { stdout += chunk; }); app.stderr.on('data', (chunk) => { stderr += chunk; }); return app; };
  const evidence = { phase: 11, syntheticOnly: true, generatedAt: new Date().toISOString(), checks: {} };
  try {
    child = spawnApp(); assert.equal(await waitHealth(base, child), true, JSON.stringify({ stdout, stderr }));
    let health = await fetch(`${base}/health`).then((response) => response.json());
    assert.equal(health.persistenceMode, 'database'); assert.equal(health.database.ok, true);
    let auth = await login(base, 'panel', user, password);
    let list = await fetch(`${base}/api/panel/leads?page=1&pageSize=100`, { headers: { Cookie: auth.cookie } }).then((response) => response.json());
    assert.equal(list.total, 1);
    const create = await fetch(`${base}/api/panel/leads/manual`, { method: 'POST', headers: { Cookie: auth.cookie, Origin: base, 'Content-Type': 'application/json', 'X-Zape-CSRF-Token': auth.csrf }, body: JSON.stringify({ nome: 'Lead Banco', email: 'banco@example.invalid', whatsapp: '+55 11 98888-7777', empresa: 'Banco Teste' }) });
    const createdBody = await create.json(); assert.equal(create.status, 200, JSON.stringify(createdBody));
    list = await fetch(`${base}/api/panel/leads?page=1&pageSize=100`, { headers: { Cookie: auth.cookie } }).then((response) => response.json());
    assert.equal(list.total, 2);
    const created = list.items.find((row) => row.email === 'banco@example.invalid'); assert.ok(created);
    const update = await fetch(`${base}/api/panel/leads/${created.id}`, { method: 'PUT', headers: { Cookie: auth.cookie, Origin: base, 'Content-Type': 'application/json', 'X-Zape-CSRF-Token': auth.csrf }, body: JSON.stringify({ _version: created._version, nome: 'Lead Banco Atualizado', email: created.email, whatsapp: created.whatsapp_digits, empresa: created.empresa }) });
    assert.equal(update.status, 200, await update.text());
    const jsonRowsBeforeRestart = fs.readFileSync(path.join(dataDir, 'panel', 'leads.jsonl'), 'utf8').trim().split('\n').length;
    assert.equal(jsonRowsBeforeRestart, 1);
    await stop(child);
    child = spawnApp(); assert.equal(await waitHealth(base, child), true, JSON.stringify({ stdout, stderr }));
    auth = await login(base, 'panel', user, password);
    list = await fetch(`${base}/api/panel/leads?page=1&pageSize=100`, { headers: { Cookie: auth.cookie } }).then((response) => response.json());
    assert.equal(list.total, 2);
    assert.equal(list.items.some((row) => row.nome === 'Lead Banco Atualizado'), true);
    const dbCheck = new SqliteClient(`sqlite:${databaseFile}`);
    try { assert.equal(Number((await dbCheck.query('SELECT COUNT(*) total FROM leads WHERE tenant_id=$1', ['panel'])).rows[0].total), 2); } finally { await dbCheck.close(); }
    evidence.checks = { migrations: true, importedTenants: 6, databaseHealth: true, databasePrimary: true, jsonNotWrittenAfterCutover: true, persistedAfterRestart: true, leadsAfterRestart: 2 };
    if (outputFile) { fs.mkdirSync(path.dirname(outputFile), { recursive: true }); fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`); }
    console.log(JSON.stringify(evidence, null, 2));
  } finally { await stop(child); fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
