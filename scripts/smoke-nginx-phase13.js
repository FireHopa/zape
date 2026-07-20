#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function commandExists(command) {
  return spawnSync('sh', ['-lc', `command -v ${command}`]).status === 0;
}

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

function request({ protocol = 'http:', port, path: pathname = '/', hostHeader = 'bobia.com.br', headers = {}, method = 'GET' }) {
  const client = protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request({
      protocol,
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      servername: 'bobia.com.br',
      rejectUnauthorized: false,
      headers: { Host: hostHeader, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForPort(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(200);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Nginx não abriu a porta ${port}.`);
}

(async () => {
  if (!commandExists('nginx') || !commandExists('openssl')) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'nginx ou openssl indisponível' }, null, 2));
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-phase13-nginx-'));
  let nginx;
  let upstream;
  let lastHeaders = null;
  const evidence = { phase: 13, dynamicNginx: true, checks: {} };
  try {
    const httpPort = await availablePort();
    const httpsPort = await availablePort();
    const upstreamPort = await availablePort();

    upstream = http.createServer((req, res) => {
      lastHeaders = req.headers;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise((resolve, reject) => {
      upstream.listen(upstreamPort, '127.0.0.1', resolve);
      upstream.once('error', reject);
    });

    const certDir = path.join(tmp, 'certs');
    const confDir = path.join(tmp, 'conf.d');
    const siteDir = path.join(tmp, 'sites-enabled');
    const snippetDir = path.join(tmp, 'snippets');
    const acmeDir = path.join(tmp, 'acme');
    for (const dir of [certDir, confDir, siteDir, snippetDir, acmeDir]) fs.mkdirSync(dir, { recursive: true });
    const cert = path.join(certDir, 'fullchain.pem');
    const key = path.join(certDir, 'privkey.pem');
    const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=bobia.com.br', '-keyout', key, '-out', cert], { encoding: 'utf8' });
    assert.equal(openssl.status, 0, openssl.stderr);

    fs.copyFileSync(path.join(ROOT, 'nginx', 'zape-http.conf'), path.join(confDir, 'zape-http.conf'));
    let proxy = fs.readFileSync(path.join(ROOT, 'nginx', 'snippets', 'zape-proxy-common.conf'), 'utf8')
      .replace('http://127.0.0.1:3000', `http://127.0.0.1:${upstreamPort}`);
    fs.writeFileSync(path.join(snippetDir, 'zape-proxy-common.conf'), proxy);
    let streamProxy = fs.readFileSync(path.join(ROOT, 'nginx', 'snippets', 'zape-proxy-stream.conf'), 'utf8')
      .replace('http://127.0.0.1:3000', `http://127.0.0.1:${upstreamPort}`);
    fs.writeFileSync(path.join(snippetDir, 'zape-proxy-stream.conf'), streamProxy);

    let site = fs.readFileSync(path.join(ROOT, 'nginx', 'casa-do-ads.conf'), 'utf8')
      .replace('listen 80;', `listen 127.0.0.1:${httpPort};`)
      .replace('listen [::]:80;', '')
      .replace('listen 443 ssl;', `listen 127.0.0.1:${httpsPort} ssl;`)
      .replace('listen [::]:443 ssl;', '')
      .replaceAll('/etc/nginx/snippets/zape-proxy-common.conf', path.join(snippetDir, 'zape-proxy-common.conf'))
      .replaceAll('/etc/nginx/snippets/zape-proxy-stream.conf', path.join(snippetDir, 'zape-proxy-stream.conf'))
      .replaceAll('/etc/letsencrypt/live/bobia.com.br/fullchain.pem', cert)
      .replaceAll('/etc/letsencrypt/live/bobia.com.br/privkey.pem', key)
      .replaceAll('/var/log/nginx/casa-do-ads.access.log', path.join(tmp, 'access.log'))
      .replaceAll('/var/log/nginx/casa-do-ads.error.log', path.join(tmp, 'error.log'))
      .replaceAll('/var/log/nginx/casa-do-ads.webhooks.error.log', path.join(tmp, 'webhooks-error.log'))
      .replaceAll('/var/www/letsencrypt', acmeDir);
    fs.writeFileSync(path.join(siteDir, 'site.conf'), site);

    const mime = fs.existsSync('/etc/nginx/mime.types') ? `include /etc/nginx/mime.types;` : '';
    const main = `pid ${path.join(tmp, 'nginx.pid')};\nerror_log ${path.join(tmp, 'main-error.log')};\nevents { worker_connections 64; }\nhttp { ${mime} include ${path.join(confDir, '*.conf')}; include ${path.join(siteDir, '*.conf')}; }\n`;
    const mainPath = path.join(tmp, 'nginx.conf');
    fs.writeFileSync(mainPath, main);

    nginx = spawn('nginx', ['-p', tmp, '-c', mainPath, '-g', 'daemon off;'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let nginxErr = '';
    nginx.stderr.on('data', (chunk) => { nginxErr += chunk.toString(); });
    await waitForPort(httpPort);
    await waitForPort(httpsPort);

    const redirect = await request({ port: httpPort });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, 'https://bobia.com.br/');
    evidence.checks.httpRedirect = redirect.status;

    const secure = await request({ protocol: 'https:', port: httpsPort, path: '/health', headers: { 'X-Forwarded-For': '198.51.100.99' } });
    assert.equal(secure.status, 200, secure.body);
    assert.match(String(secure.headers['strict-transport-security'] || ''), /max-age=31536000/);
    assert.equal(lastHeaders['x-forwarded-for'], '127.0.0.1');
    assert.equal(lastHeaders['x-forwarded-proto'], 'https');
    assert.equal(lastHeaders['x-forwarded-host'], undefined);
    evidence.checks.httpsHealth = secure.status;
    evidence.checks.hsts = true;
    evidence.checks.spoofedForwardedForReplaced = true;

    const token = 'token-that-must-not-appear-in-nginx-log';
    const webhook = await request({ protocol: 'https:', port: httpsPort, path: `/webhooks/${token}`, method: 'POST' });
    assert.equal(webhook.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const accessLog = fs.readFileSync(path.join(tmp, 'access.log'), 'utf8');
    assert.doesNotMatch(accessLog, new RegExp(token));
    assert.match(accessLog, /\/webhooks\/\[redacted\]/);
    evidence.checks.webhookTokenRedactedInAccessLog = true;

    let unknownRejected = false;
    try {
      const unknown = await request({ port: httpPort, hostHeader: 'attacker.invalid' });
      unknownRejected = unknown.status === 444;
    } catch {
      unknownRejected = true;
    }
    assert.equal(unknownRejected, true);
    evidence.checks.unknownHostRejected = true;

    nginx.kill('SIGTERM');
    await new Promise((resolve) => nginx.once('exit', resolve));
    assert.equal(nginx.exitCode, 0, nginxErr);
    console.log(JSON.stringify({ ok: true, ...evidence }, null, 2));
  } catch (error) {
    if (nginx && nginx.exitCode === null) nginx.kill('SIGKILL');
    console.error(JSON.stringify({ ok: false, ...evidence, error: error.message }, null, 2));
    process.exitCode = 1;
  } finally {
    if (upstream) await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
