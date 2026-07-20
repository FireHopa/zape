#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateRuntimeConfiguration } = require('../src/runtimeConfig');

const root = path.resolve(__dirname, '..');
const checks = [];
const warnings = [];

function ok(name, details = '') {
  checks.push({ name, ok: true, details });
}

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function commandExists(command) {
  const out = spawnSync('sh', ['-lc', `command -v ${command}`], { encoding: 'utf8' });
  return out.status === 0;
}

function assertMatch(text, pattern, label) {
  assert.match(text, pattern, label);
  ok(label);
}

function validateStaticFiles() {
  const nginxSite = read('nginx/casa-do-ads.conf');
  const nginxHttp = read('nginx/zape-http.conf');
  const proxy = read('nginx/snippets/zape-proxy-common.conf');
  const streamProxy = read('nginx/snippets/zape-proxy-stream.conf');
  const pm2 = require(path.join(root, 'ecosystem.config.cjs'));

  assertMatch(nginxSite, /return 301 https:\/\/\$host\$request_uri;/, 'HTTP redireciona para HTTPS');
  assertMatch(nginxSite, /listen 443 ssl;/, 'Nginx escuta HTTPS');
  assertMatch(nginxSite, /Strict-Transport-Security/, 'HSTS configurado');
  assertMatch(nginxSite, /ssl_protocols TLSv1\.2 TLSv1\.3;/, 'TLS 1.2 e 1.3 configurados');
  assertMatch(nginxSite, /client_max_body_size 16m;/, 'Limite autenticado geral reduzido');
  assertMatch(nginxSite, /client_max_body_size 26m;/, 'Limite específico para mídia em streaming');
  assertMatch(nginxSite, /zape-proxy-stream\.conf/, 'Uploads usam proxy sem buffering');
  assertMatch(nginxSite, /limit_req zone=zape_meta/, 'Rate limit adicional no webhook Meta');
  assertMatch(nginxHttp, /limit_conn_zone/, 'Limite de conexões configurado');
  assertMatch(nginxHttp, /\/webhooks\/\[redacted\]/, 'Log do Nginx mascara token de webhook');
  assertMatch(nginxSite, /return 444;/, 'Host desconhecido é rejeitado');
  assertMatch(proxy, /proxy_pass http:\/\/127\.0\.0\.1:3000;/, 'Proxy aponta apenas para loopback');
  assertMatch(proxy, /proxy_set_header X-Forwarded-For \$remote_addr;/, 'Nginx substitui X-Forwarded-For recebido');
  assert.doesNotMatch(proxy, /proxy_add_x_forwarded_for/, 'proxy_add_x_forwarded_for não deve ser usado com uma única camada');
  assert.doesNotMatch(proxy, /X-Forwarded-Host/i, 'X-Forwarded-Host não deve ser encaminhado');
  assert.match(streamProxy, /proxy_request_buffering off;/);
  assert.match(streamProxy, /proxy_buffering off;/);
  ok('Cabeçalhos encaminhados restritos');

  assert.equal(pm2.apps.length, 1);
  const app = pm2.apps[0];
  assert.equal(app.instances, 1);
  assert.equal(app.exec_mode, 'fork');
  assert.equal(app.env.HOST, '127.0.0.1');
  assert.equal(app.env.TRUST_PROXY_HOPS, 1);
  assert.ok(app.max_memory_restart);
  assert.ok(app.kill_timeout >= 30000);
  assert.equal(app.wait_ready, true);
  ok('PM2 limitado a uma instância fork com memória e shutdown controlados');

  for (const script of ['deploy/install-infrastructure.sh', 'deploy/configure-firewall.sh', 'deploy/issue-certificate.sh', 'deploy/verify-deploy.sh']) {
    const result = spawnSync('bash', ['-n', path.join(root, script)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  ok('Scripts de infraestrutura passam em bash -n');
}

function validateRuntime() {
  const env = {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: '3000',
    TRUST_PROXY_HOPS: '1',
    PUBLIC_BASE_URL: 'https://zape.example.invalid',
    AUTH_TRUST_PROXY_HEADERS: '1',
    PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS: '1',
  };
  const result = validateRuntimeConfiguration({ env, mode: 'production', uid: 1001 });
  assert.equal(result.ok, true, result.errors.join(' '));
  ok('Configuração runtime segura é aceita', `${result.host}:${result.port}; proxy=${result.trustProxyHops}`);
}

function nginxSyntaxTest() {
  if (!commandExists('nginx') || !commandExists('openssl')) {
    warnings.push('nginx ou openssl indisponível; teste de sintaxe real não foi executado.');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-nginx-test-'));
  try {
    const confDir = path.join(tmp, 'conf.d');
    const siteDir = path.join(tmp, 'sites-enabled');
    const snippetDir = path.join(tmp, 'snippets');
    const certDir = path.join(tmp, 'certs');
    fs.mkdirSync(confDir, { recursive: true });
    fs.mkdirSync(siteDir, { recursive: true });
    fs.mkdirSync(snippetDir, { recursive: true });
    fs.mkdirSync(certDir, { recursive: true });
    fs.copyFileSync(path.join(root, 'nginx', 'zape-http.conf'), path.join(confDir, 'zape-http.conf'));
    fs.copyFileSync(path.join(root, 'nginx', 'snippets', 'zape-proxy-common.conf'), path.join(snippetDir, 'zape-proxy-common.conf'));
    fs.copyFileSync(path.join(root, 'nginx', 'snippets', 'zape-proxy-stream.conf'), path.join(snippetDir, 'zape-proxy-stream.conf'));

    const cert = path.join(certDir, 'fullchain.pem');
    const key = path.join(certDir, 'privkey.pem');
    const openssl = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', `/CN=phase13-${crypto.randomBytes(4).toString('hex')}.invalid`,
      '-keyout', key, '-out', cert,
    ], { encoding: 'utf8' });
    assert.equal(openssl.status, 0, openssl.stderr);

    let site = read('nginx/casa-do-ads.conf')
      .replaceAll('/etc/nginx/snippets/zape-proxy-common.conf', path.join(snippetDir, 'zape-proxy-common.conf'))
      .replaceAll('/etc/nginx/snippets/zape-proxy-stream.conf', path.join(snippetDir, 'zape-proxy-stream.conf'))
      .replaceAll('/etc/letsencrypt/live/bobia.com.br/fullchain.pem', cert)
      .replaceAll('/etc/letsencrypt/live/bobia.com.br/privkey.pem', key)
      .replaceAll('/var/log/nginx/casa-do-ads.access.log', path.join(tmp, 'access.log'))
      .replaceAll('/var/log/nginx/casa-do-ads.error.log', path.join(tmp, 'error.log'))
      .replaceAll('/var/www/letsencrypt', path.join(tmp, 'acme'));
    fs.mkdirSync(path.join(tmp, 'acme'), { recursive: true });
    fs.writeFileSync(path.join(siteDir, 'site.conf'), site);

    const mimeTypes = fs.existsSync('/etc/nginx/mime.types') ? '/etc/nginx/mime.types' : '';
    const main = [
      `pid ${path.join(tmp, 'nginx.pid')};`,
      `error_log ${path.join(tmp, 'nginx-main-error.log')};`,
      'events { worker_connections 64; }',
      'http {',
      mimeTypes ? `  include ${mimeTypes};` : '',
      `  include ${path.join(confDir, '*.conf')};`,
      `  include ${path.join(siteDir, '*.conf')};`,
      '}',
    ].filter(Boolean).join('\n');
    const mainPath = path.join(tmp, 'nginx.conf');
    fs.writeFileSync(mainPath, main);
    const nginx = spawnSync('nginx', ['-t', '-p', tmp, '-c', mainPath], { encoding: 'utf8' });
    assert.equal(nginx.status, 0, `${nginx.stdout}\n${nginx.stderr}`);
    ok('nginx -t aprovado com certificado sintético');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  validateStaticFiles();
  validateRuntime();
  nginxSyntaxTest();
  console.log(JSON.stringify({ ok: true, checks, warnings }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, checks, warnings, error: error.message, stack: error.stack }, null, 2));
  process.exit(1);
}
