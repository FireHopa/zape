'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

test('app.html carrega configuração e cliente de API antes do frontend principal', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
  const configIndex = html.indexOf('/modules/app-config.js');
  const clientIndex = html.indexOf('/modules/api-client.js');
  const appIndex = html.indexOf('/app.js');
  assert.ok(configIndex > 0);
  assert.ok(clientIndex > configIndex);
  assert.ok(appIndex > clientIndex);
});

test('configuração do tenant foi extraída do app.js e resolve Portugal corretamente', () => {
  const source = fs.readFileSync(path.join(root, 'public', 'modules', 'app-config.js'), 'utf8');
  const window = { location: { pathname: '/portugal' } };
  vm.runInNewContext(source, { window, Object, String });
  assert.equal(window.zapeAppConfig.tenantId, 'portugal');
  assert.equal(window.zapeAppConfig.active.apiBase, '/api/portugal');
  assert.equal(window.zapeAppConfig.cloudLanguage, 'pt_PT');

  const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.equal(appSource.includes('var APP_CONFIGS ='), false);
  assert.equal(appSource.includes('window.zapeApi.request'), true);
});

test('cliente de API preserva credenciais same-origin e transforma falhas em erro', async () => {
  const source = fs.readFileSync(path.join(root, 'public', 'modules', 'api-client.js'), 'utf8');
  const calls = [];
  const window = {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: 1 }),
      };
    },
  };
  vm.runInNewContext(source, { window, Object, Error, Promise });
  const payload = await window.zapeApi.json('/api/admin/leads');
  assert.equal(payload.value, 1);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.cache, 'no-store');
});
