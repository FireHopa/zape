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
const outputFile = outputArg ? path.resolve(outputArg.slice(9)) : '';
const tenants = ['admin', 'panel', 'regina', 'portugal', 'felipe', 'ana'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      if ((await fetch(`${baseUrl}/health`)).status === 200) return true;
    } catch (_) {}
    await sleep(100);
  }
  return false;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function responseCookies(response) {
  return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
}

async function login(baseUrl, tenantId, username, password) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ tenant: tenantId, username, password }),
  });
  assert.equal(response.status, 200, await response.text());
  return responseCookies(response);
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-phase14-smoke-'));
  const dataDir = path.join(root, 'data');
  const fixture = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'create-sanitized-fixture.js'), `--output=${dataDir}`, '--force'],
    { encoding: 'utf8' }
  );
  assert.equal(fixture.status, 0, fixture.stderr);

  const appPort = await freePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const credentials = Object.fromEntries(
    tenants.map((tenantId) => [
      tenantId,
      {
        username: `${tenantId}_${crypto.randomBytes(4).toString('hex')}`,
        password: crypto.randomBytes(32).toString('base64url'),
      },
    ])
  );
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(appPort),
    PUBLIC_BASE_URL: baseUrl,
    ZAPE_DATA_DIR: dataDir,
    SESSION_SECRET: crypto.randomBytes(48).toString('base64url'),
    SESSION_STORE_FILE: path.join(root, 'sessions.json'),
    SECURITY_AUDIT_FILE: path.join(root, 'audit.jsonl'),
    STRUCTURED_LOG_FILE: path.join(root, 'application.jsonl'),
    CONFIG_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    WEBJS_ENABLED: '0',
    WEBJS_AUTO_START: '0',
    CRM_INTEGRATION_ENABLED: '0',
    PUBLIC_LEAD_FORM_ENABLED: '0',
    ACTIVECAMPAIGN_WEBHOOK_ENABLED: '0',
    DATA_INTEGRITY_VALIDATE_ON_BOOT: '0',
    WA_CLOUD_ENABLED: '0',
    PERSISTENCE_MODE: 'json',
  };
  for (const tenantId of tenants) {
    const prefix = tenantId.toUpperCase();
    env[`${prefix}_ENABLED`] = '1';
    env[`${prefix}_USER`] = credentials[tenantId].username;
    env[`${prefix}_PASS`] = credentials[tenantId].password;
  }

  let child;
  let stdout = '';
  let stderr = '';
  const evidence = {
    phase: 14,
    syntheticOnly: true,
    generatedAt: new Date().toISOString(),
    checks: {},
  };

  try {
    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    assert.equal(await waitForHealth(baseUrl, child), true, JSON.stringify({ stdout, stderr }));

    const checks = {};
    for (const tenantId of tenants) {
      const cookie = await login(
        baseUrl,
        tenantId,
        credentials[tenantId].username,
        credentials[tenantId].password
      );
      const endpoints = [
        `/${tenantId}`,
        `/api/${tenantId}/leads`,
        `/api/${tenantId}/crm`,
        `/api/${tenantId}/whatsapp/status`,
        `/api/${tenantId}/tags`,
        `/api/${tenantId}/webhooks`,
      ];
      for (const endpoint of endpoints) {
        const response = await fetch(`${baseUrl}${endpoint}`, { headers: { Cookie: cookie } });
        assert.equal(response.status, 200, `${endpoint}: ${await response.text()}`);
      }
      checks[tenantId] = { endpoints: endpoints.length, ok: true };
    }

    const legacyRedirect = await fetch(`${baseUrl}/admin.html`, { redirect: 'manual' });
    assert.equal(legacyRedirect.status, 302);
    assert.equal(legacyRedirect.headers.get('location'), '/admin');

    const expressVersion = require('express/package.json').version;
    const whatsappVersion = require('whatsapp-web.js/package.json').version;
    const whatsappExports = require('whatsapp-web.js');
    assert.equal(expressVersion, '4.22.2');
    assert.equal(whatsappVersion, '1.34.7');
    assert.equal(typeof whatsappExports.Client, 'function');
    assert.equal(typeof whatsappExports.LocalAuth, 'function');
    assert.equal(typeof whatsappExports.MessageMedia, 'function');
    const packagedFfmpeg = require('ffmpeg-static');
    const ffmpegBinaryResolved = Boolean(
      (packagedFfmpeg && fs.existsSync(packagedFfmpeg)) ||
        ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg'].some((candidate) => fs.existsSync(candidate))
    );
    assert.equal(ffmpegBinaryResolved, true);

    evidence.checks = {
      tenantRoutes: checks,
      legacyHtmlRedirect: true,
      expressVersion,
      whatsappVersion,
      whatsappExportsLoaded: true,
      packagedFfmpegAvailable: Boolean(packagedFfmpeg && fs.existsSync(packagedFfmpeg)),
      ffmpegBinaryResolved,
    };
    if (outputFile) {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await stop(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
