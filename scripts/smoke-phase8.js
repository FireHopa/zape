#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputFile = outputArg ? path.resolve(outputArg.slice('--output='.length)) : '';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map(JSON.stringify).join('\n')}\n`, { mode: 0o600 });
}
function buildFixture(dataDir) {
  const tenantDir = path.join(dataDir, 'panel');
  const rows = Array.from({ length: 2505 }, (_, index) => ({
    id: `lead-${String(index + 1).padStart(5, '0')}`,
    nome: `Lead ${index + 1}`,
    email: `lead${index + 1}@example.invalid`,
    whatsapp_raw: `+55 11 9${String(index + 10000000).slice(-8)}`,
    whatsapp_digits: `55119${String(index + 10000000).slice(-8)}`,
    source: index % 2 ? 'webhook' : 'manual',
    createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
  }));
  writeJsonl(path.join(tenantDir, 'leads.jsonl'), rows);
  writeJson(path.join(tenantDir, 'tags.json'), []);
  writeJson(path.join(tenantDir, 'lead_tags.json'), {});
  writeJson(path.join(tenantDir, 'crm.json'), {
    version: 1,
    activePipelineId: 'p',
    pipelines: [{ id: 'p', stageOrder: ['s'], stages: { s: { id: 's', leadIds: ['lead-00001', 'lead-00002'] } } }],
  });
  writeJson(path.join(tenantDir, 'funnel_lead_stage.json'), { 'lead-00001': 'new', 'lead-00002': 'new' });
}
async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
async function waitForHealth(baseUrl, child, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) return false;
    try { if ((await fetch(`${baseUrl}/health`)).status === 200) return true; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
function cookiesFrom(response) {
  return response.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
}
function cookieValue(cookieHeader, name) {
  const part = cookieHeader.split(/;\s*/).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-phase8-smoke-'));
  const dataDir = path.join(root, 'data');
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const username = `panel_${crypto.randomBytes(6).toString('hex')}`;
  const password = crypto.randomBytes(32).toString('base64url');
  buildFixture(dataDir);
  const env = {
    ...process.env,
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), PUBLIC_BASE_URL: baseUrl,
    ZAPE_DATA_DIR: dataDir,
    SESSION_SECRET: crypto.randomBytes(48).toString('base64url'),
    SESSION_STORE_FILE: path.join(root, 'sessions.json'),
    SECURITY_AUDIT_FILE: path.join(root, 'security.jsonl'),
    PANEL_ENABLED: '1', PANEL_USER: username, PANEL_PASS: password,
    ADMIN_ENABLED: '0', REGINA_ENABLED: '0', PORTUGAL_ENABLED: '0', FELIPE_ENABLED: '0', ANA_ENABLED: '0',
    WEBJS_ENABLED: '0', WEBJS_AUTO_START: '0', CRM_INTEGRATION_ENABLED: '0', WA_CLOUD_ENABLED: '0',
    PUBLIC_LEAD_FORM_ENABLED: '0', ACTIVECAMPAIGN_WEBHOOK_ENABLED: '0', ENABLE_DEBUG_ACTIVE: '0',
    DATA_INTEGRITY_VALIDATE_ON_BOOT: '0',
  };
  let stdout = ''; let stderr = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const evidence = { phase: 8, syntheticOnly: true, generatedAt: new Date().toISOString(), checks: {} };
  try {
    assert.equal(await waitForHealth(baseUrl, child), true, JSON.stringify({ stdout, stderr }));
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ tenant: 'panel', username, password }),
    });
    assert.equal(login.status, 200);
    const cookie = cookiesFrom(login);
    const csrf = cookieValue(cookie, 'zape_csrf');
    assert.ok(csrf);

    const page1 = await fetch(`${baseUrl}/api/panel/leads?page=1&pageSize=500`, { headers: { Cookie: cookie } });
    const first = await page1.json();
    assert.equal(page1.status, 200);
    assert.equal(first.total, 2505);
    assert.equal(first.items.length, 500);
    assert.equal(first.totalPages, 6);
    assert.equal(first.hasNext, true);

    const page6 = await fetch(`${baseUrl}/api/panel/leads?page=6&pageSize=500`, { headers: { Cookie: cookie } });
    const last = await page6.json();
    assert.equal(last.items.length, 5);
    assert.equal(last.hasNext, false);
    evidence.checks.pagination = { total: first.total, totalPages: first.totalPages, firstPage: first.items.length, lastPage: last.items.length };

    const csv = await fetch(`${baseUrl}/panel/leads.csv?sortBy=createdAt&sortDir=desc`, { headers: { Cookie: cookie } });
    const csvText = await csv.text();
    assert.equal(csv.status, 200);
    assert.equal(csvText.trim().split(/\r?\n/).length, 2506);
    evidence.checks.exportRows = 2505;

    const filteredResponse = await fetch(`${baseUrl}/api/panel/leads?origin=webhook&page=1&pageSize=500`, { headers: { Cookie: cookie } });
    const filteredPayload = await filteredResponse.json();
    assert.equal(filteredPayload.total, 1252);
    const filteredCsv = await fetch(`${baseUrl}/panel/leads.csv?origin=webhook`, { headers: { Cookie: cookie } });
    const filteredCsvText = await filteredCsv.text();
    assert.equal(filteredCsvText.trim().split(/\r?\n/).length, 1253);
    evidence.checks.filterConsistency = { apiTotal: filteredPayload.total, exportRows: 1252 };

    const lead = first.items[0];
    const update = await fetch(`${baseUrl}/api/panel/leads/${encodeURIComponent(lead.id)}`, {
      method: 'PUT',
      headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json', 'X-Zape-CSRF-Token': csrf },
      body: JSON.stringify({ _version: lead._version, nome: 'Lead atualizado', email: lead.email, whatsapp: lead.whatsapp_raw }),
    });
    const updated = await update.json();
    assert.equal(update.status, 200);
    assert.equal(updated.lead.nome, 'Lead atualizado');

    const stale = await fetch(`${baseUrl}/api/panel/leads/${encodeURIComponent(lead.id)}`, {
      method: 'PUT',
      headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json', 'X-Zape-CSRF-Token': csrf },
      body: JSON.stringify({ _version: lead._version, nome: 'Stale', email: lead.email, whatsapp: lead.whatsapp_raw }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'LEAD_VERSION_CONFLICT');

    const source = last.items.find((item) => item.id === 'lead-00002');
    assert.ok(source);
    const conflict = await fetch(`${baseUrl}/api/panel/leads/${encodeURIComponent(updated.lead.id)}`, {
      method: 'PUT',
      headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json', 'X-Zape-CSRF-Token': csrf },
      body: JSON.stringify({ _version: updated.lead._version, nome: updated.lead.nome, email: updated.lead.email, whatsapp: source.whatsapp_raw }),
    });
    const conflictBody = await conflict.json();
    assert.equal(conflict.status, 409);
    assert.equal(conflictBody.code, 'LEAD_PHONE_CONFLICT');
    assert.equal(conflictBody.mergeAvailable, true);
    evidence.checks.editing = { update: 200, stale: 409, phoneConflict: 409, mergeOffered: true };

    const historyFile = path.join(dataDir, 'panel', 'lead_changes.jsonl');
    assert.equal(fs.existsSync(historyFile), true);
    assert.equal(fs.readFileSync(historyFile, 'utf8').trim().split('\n').length, 1);
    evidence.checks.historyWritten = true;

    if (outputFile) {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    console.error(error?.stack || error);
    console.error({ stdout, stderr });
    process.exitCode = 1;
  } finally {
    await stop(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
