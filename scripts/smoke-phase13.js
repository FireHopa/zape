#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(os.tmpdir(), `zape-phase13-${process.pid}`);
const evidence = {
  phase: 13,
  generatedAt: new Date().toISOString(),
  checks: {},
  warnings: [],
};

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
    server.on('error', reject);
  });
}

function nonLoopbackAddress() {
  for (const rows of Object.values(os.networkInterfaces())) {
    for (const row of rows || []) {
      if (row.family === 'IPv4' && !row.internal) return row.address;
    }
  }
  return '';
}

function tcpConnect(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = (connected) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForHealth(baseUrl, child, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Servidor encerrou com código ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Timeout aguardando /health.');
}

function waitForExit(child, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error('Timeout aguardando encerramento.')), timeout);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

(async () => {
  let child;
  let stdout = '';
  let stderr = '';
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const fixture = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'create-sanitized-fixture.js'), `--output=${DATA_DIR}`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(fixture.status, 0, fixture.stderr);

    const port = await availablePort();
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      TRUST_PROXY_HOPS: '1',
      PUBLIC_BASE_URL: 'https://zape.example.invalid',
      APP_ALLOWED_ORIGINS: 'https://zape.example.invalid',
      INFRA_ALLOW_ROOT_PROCESS: '1',
      AUTH_TRUST_PROXY_HEADERS: '1',
      PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS: '1',
      ZAPE_DATA_DIR: DATA_DIR,
      SESSION_STORE_FILE: path.join(DATA_DIR, 'auth_sessions.json'),
      WEBHOOK_IDEMPOTENCY_FILE: path.join(DATA_DIR, 'webhook_idempotency.json'),
      SECURITY_AUDIT_FILE: path.join(DATA_DIR, 'security_audit.jsonl'),
      CONFIG_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
      ADMIN_ENABLED: '0', PANEL_ENABLED: '0', REGINA_ENABLED: '0', PORTUGAL_ENABLED: '0', FELIPE_ENABLED: '0', ANA_ENABLED: '0',
      WEBJS_ENABLED: '0', WEBJS_AUTO_START: '0',
      CRM_INTEGRATION_ENABLED: '0',
      WA_CLOUD_ENABLED: '0',
      PUBLIC_LEAD_FORM_ENABLED: '0',
      ACTIVECAMPAIGN_WEBHOOK_ENABLED: '0',
      CUSTOM_WEBHOOK_REQUIRE_SIGNATURE: '1',
    };

    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child);
    evidence.checks.health = 200;
    evidence.checks.loopbackConnect = await tcpConnect('127.0.0.1', port);
    assert.equal(evidence.checks.loopbackConnect, true);

    const externalAddress = nonLoopbackAddress();
    if (externalAddress) {
      const exposed = await tcpConnect(externalAddress, port);
      evidence.checks.externalAddress = externalAddress.replace(/\d+$/, 'x');
      evidence.checks.externalPortReachable = exposed;
      assert.equal(exposed, false, 'A porta Node respondeu no endereço não-loopback.');
    } else {
      evidence.warnings.push('Nenhum IPv4 não-loopback disponível para prova de exposição da porta.');
    }

    assert.match(stdout, new RegExp(`Rodando em http://127\\.0\\.0\\.1:${port}`));
    evidence.checks.bindLog = '127.0.0.1';

    child.kill('SIGTERM');
    const exitCode = await waitForExit(child);
    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /Interrompendo novas conexões/);
    evidence.checks.gracefulShutdown = true;

    const infra = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-infrastructure.js')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(infra.status, 0, `${infra.stdout}\n${infra.stderr}`);
    evidence.checks.infrastructureValidation = true;

    console.log(JSON.stringify({ ok: true, ...evidence }, null, 2));
  } catch (error) {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    console.error(JSON.stringify({ ok: false, ...evidence, error: error.message, stdout, stderr }, null, 2));
    process.exit(1);
  } finally {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})();
