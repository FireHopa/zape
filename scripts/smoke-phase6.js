#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputFile = outputArg ? path.resolve(outputArg.slice('--output='.length)) : '';
const PNG = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(128, 0)]);

function randomSecret(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
async function waitForHealth(baseUrl, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Servidor encerrou antes do health check: ${child.exitCode}`);
    try { const response = await fetch(`${baseUrl}/health`); if (response.status === 200) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Timeout aguardando health check.');
}
async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers.get('set-cookie');
  return combined ? combined.split(/,(?=\s*[^;,]+=)/g) : [];
}
function cookieHeader(setCookies) { return setCookies.map((value) => value.split(';', 1)[0]).join('; '); }
function cookieValue(setCookies, name) {
  for (const value of setCookies) {
    const first = value.split(';', 1)[0];
    const index = first.indexOf('=');
    if (index > 0 && first.slice(0, index).trim() === name) return decodeURIComponent(first.slice(index + 1));
  }
  return '';
}

(async () => {
  const evidence = { phase: 6, syntheticOnly: true, generatedAt: new Date().toISOString(), checks: {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-phase6-'));
  const dataDir = path.join(tmp, 'data');
  let child = null;
  let stdout = '';
  let stderr = '';
  try {
    const fixture = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'create-sanitized-fixture.js'), `--output=${dataDir}`], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);

    const adminDir = path.join(dataDir, 'admin');
    const mediaDir = path.join(adminDir, 'conversation_media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const mediaId = `m_${crypto.randomBytes(24).toString('hex')}`;
    const mediaFile = `${mediaId}.png`;
    fs.writeFileSync(path.join(mediaDir, mediaFile), PNG, { mode: 0o600 });
    fs.writeFileSync(path.join(mediaDir, 'legacy-malicious.jpg'), Buffer.from('<!doctype html><script>alert(1)</script>'), { mode: 0o600 });
    const digits = '5513999999001';
    const otherDigits = '5513999999002';
    fs.writeFileSync(path.join(adminDir, 'conversations.json'), JSON.stringify({
      [digits]: [
        { id: 'safe-media', fromMe: false, body: 'Imagem sintética', type: 'image', hasMedia: true, mediaKind: 'image', mediaMime: 'image/png', mediaId, mediaFile, mediaSize: PNG.length, filename: 'foto.png', originalName: 'foto.png', timestamp: Math.floor(Date.now()/1000) },
        { id: 'missing-media', fromMe: false, body: 'PDF ausente', type: 'document', hasMedia: true, mediaKind: 'pdf', mediaMime: 'application/pdf', mediaId: 'm_missing', mediaFile: 'm_missing.pdf', filename: 'ausente.pdf', originalName: 'ausente.pdf', timestamp: Math.floor(Date.now()/1000)+1 },
        { id: 'bad-media', fromMe: false, body: 'Disfarçado', type: 'image', hasMedia: true, mediaKind: 'image', mediaMime: 'image/jpeg', mediaId: 'm_bad', mediaFile: 'legacy-malicious.jpg', filename: 'foto.jpg', originalName: 'foto.jpg', timestamp: Math.floor(Date.now()/1000)+2 },
      ],
      [otherDigits]: [],
    }, null, 2));

    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const adminUser = `admin_${randomSecret(8)}`;
    const adminPassword = randomSecret(24);
    const env = {
      ...process.env,
      NODE_ENV: 'development', PORT: String(port), PUBLIC_BASE_URL: baseUrl,
      SESSION_SECRET: randomSecret(48), SESSION_STORE_FILE: path.join(dataDir, 'auth_sessions.json'),
      SECURITY_AUDIT_FILE: path.join(dataDir, 'security_audit.jsonl'), CONFIG_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
      ZAPE_DATA_DIR: dataDir, WEBHOOK_IDEMPOTENCY_FILE: path.join(dataDir, 'webhook_idempotency.json'),
      ADMIN_ENABLED: '1', ADMIN_USER: adminUser, ADMIN_PASS: adminPassword, ADMIN_ROLE: 'super_admin',
      PANEL_ENABLED: '0', REGINA_ENABLED: '0', PORTUGAL_ENABLED: '0', FELIPE_ENABLED: '0', ANA_ENABLED: '0',
      WEBJS_ENABLED: '0', WEBJS_AUTO_START: '0', CRM_INTEGRATION_ENABLED: '0', WA_CLOUD_ENABLED: '0',
      ENABLE_DEBUG_ACTIVE: '0', PUBLIC_LEAD_FORM_ENABLED: '0', ACTIVECAMPAIGN_WEBHOOK_ENABLED: '0',
      MEDIA_IMAGE_MAX_BYTES: '1024', MEDIA_SCANNER_REQUIRED: '0',
    };
    child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    await waitForHealth(baseUrl, child);

    const login = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant: 'admin', username: adminUser, password: adminPassword }) });
    assert.equal(login.status, 200);
    const setCookies = getSetCookies(login.headers);
    const cookies = cookieHeader(setCookies);
    const csrf = cookieValue(setCookies, 'zape_csrf');
    assert.ok(csrf);

    const messagesResponse = await fetch(`${baseUrl}/api/admin/conversations/${digits}/messages`, { headers: { Cookie: cookies } });
    assert.equal(messagesResponse.status, 200);
    const messagesBody = await messagesResponse.json();
    const safeMessage = messagesBody.messages.find((item) => item.id === 'safe-media');
    const missingMessage = messagesBody.messages.find((item) => item.id === 'missing-media');
    assert.equal(safeMessage.mediaId, mediaId);
    assert.equal('mediaFile' in safeMessage, false);
    assert.ok(safeMessage.mediaUrl);
    assert.equal(missingMessage.mediaUnavailable, true);
    assert.equal(Boolean(missingMessage.mediaUrl), false);
    evidence.checks.apiDoesNotExposePhysicalPath = true;
    evidence.checks.missingMediaState = true;

    const allowed = await fetch(`${baseUrl}${safeMessage.mediaUrl}`, { headers: { Cookie: cookies } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('content-type'), 'image/png');
    assert.match(allowed.headers.get('content-disposition') || '', /^inline;/);
    assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), PNG);

    const download = await fetch(`${baseUrl}${safeMessage.mediaDownloadUrl}`, { headers: { Cookie: cookies } });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') || '', /^attachment;/);

    const wrongConversation = await fetch(`${baseUrl}/api/admin/conversations/${otherDigits}/media/${encodeURIComponent(mediaId)}`, { headers: { Cookie: cookies } });
    assert.equal(wrongConversation.status, 404);
    const unknown = await fetch(`${baseUrl}/api/admin/conversations/${digits}/media/m_unknown`, { headers: { Cookie: cookies } });
    assert.equal(unknown.status, 404);
    const missing = await fetch(`${baseUrl}/api/admin/conversations/${digits}/media/m_missing`, { headers: { Cookie: cookies } });
    assert.equal(missing.status, 410);
    const malicious = await fetch(`${baseUrl}/api/admin/conversations/${digits}/media/m_bad`, { headers: { Cookie: cookies } });
    assert.equal(malicious.status, 415);
    evidence.checks.mediaAuthorization = { allowed: 200, wrongConversation: 404, unknown: 404, missing: 410, activeContent: 415 };

    const svgUpload = await fetch(`${baseUrl}/api/admin/conversations/${digits}/attachments`, {
      method: 'POST', headers: { Origin: baseUrl, Cookie: cookies, 'X-Zape-CSRF-Token': csrf, 'Content-Type': 'image/svg+xml', 'X-Zape-Filename': encodeURIComponent('x.svg') },
      body: '<svg onload="alert(1)"></svg>',
    });
    assert.equal(svgUpload.status, 415);

    const oversized = await fetch(`${baseUrl}/api/admin/conversations/${digits}/attachments`, {
      method: 'POST', headers: { Origin: baseUrl, Cookie: cookies, 'X-Zape-CSRF-Token': csrf, 'Content-Type': 'image/png', 'X-Zape-Filename': encodeURIComponent('large.png') },
      body: Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(2048)]),
    });
    assert.equal(oversized.status, 413);
    evidence.checks.uploadValidation = { svg: 415, oversized: 413 };

    if (outputFile) { fs.mkdirSync(path.dirname(outputFile), { recursive: true }); fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`); }
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    console.error(error && error.stack || error);
    if (stdout) console.error('--- server stdout ---\n' + stdout.slice(-8000));
    if (stderr) console.error('--- server stderr ---\n' + stderr.slice(-8000));
    process.exitCode = 1;
  } finally {
    await stopChild(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
