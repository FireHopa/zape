'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Nginx força HTTPS, HSTS, TLS moderno e proxy local sem spoofing de XFF', () => {
  const site = read('nginx/casa-do-ads.conf');
  const proxy = read('nginx/snippets/zape-proxy-common.conf');
  assert.match(site, /return 301 https:\/\/\$host\$request_uri;/);
  assert.match(site, /Strict-Transport-Security/);
  assert.match(site, /ssl_protocols TLSv1\.2 TLSv1\.3/);
  assert.match(site, /limit_req zone=zape_meta/);
  assert.match(site, /client_max_body_size 16m/);
  assert.match(site, /client_max_body_size 26m/);
  assert.match(site, /zape-proxy-stream\.conf/);
  const streamProxy = read('nginx/snippets/zape-proxy-stream.conf');
  assert.match(streamProxy, /proxy_request_buffering off/);
  assert.match(streamProxy, /proxy_buffering off/);
  assert.match(site, /return 444/);
  assert.match(read('nginx/zape-http.conf'), /\/webhooks\/\[redacted\]/);
  assert.match(proxy, /127\.0\.0\.1:3000/);
  assert.match(proxy, /X-Forwarded-For \$remote_addr/);
  assert.doesNotMatch(proxy, /proxy_add_x_forwarded_for/);
  assert.doesNotMatch(proxy, /X-Forwarded-Host/i);
});

test('PM2 mantém uma instância, fork, limite de memória, logs e shutdown', () => {
  delete require.cache[require.resolve('../ecosystem.config.cjs')];
  const config = require('../ecosystem.config.cjs');
  assert.equal(config.apps.length, 1);
  const app = config.apps[0];
  assert.equal(app.instances, 1);
  assert.equal(app.exec_mode, 'fork');
  assert.equal(app.env.HOST, '127.0.0.1');
  assert.equal(app.env.TRUST_PROXY_HOPS, 1);
  assert.equal(app.wait_ready, true);
  assert.ok(app.kill_timeout >= 30000);
  assert.ok(app.max_memory_restart);
  assert.match(app.out_file, /\/var\/log\/zape/);
});

test('scripts de firewall e instalação são dry-run por padrão', () => {
  for (const script of ['deploy/configure-firewall.sh', 'deploy/install-infrastructure.sh', 'deploy/issue-certificate.sh']) {
    const text = read(script);
    assert.match(text, /APPLY=0/);
    assert.match(text, /--apply/);
    const syntax = spawnSync('bash', ['-n', path.join(root, script)], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});
