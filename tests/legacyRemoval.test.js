'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const removedFiles = [
  'src/leadsStore.js',
  'src/tagsStore.js',
  'src/leadTagsStore.js',
  'src/messageStatusStore.js',
  'src/whatsapp.js',
  'public/admin.html',
  'public/panel.html',
  'public/regina.html',
  'public/index.html',
];

test('arquivos legados comprovadamente sem uso foram removidos', () => {
  for (const relative of removedFiles) {
    assert.equal(fs.existsSync(path.join(root, relative)), false, relative);
  }
});

test('Vite gera somente a interface unificada', () => {
  const source = fs.readFileSync(path.join(root, 'vite.config.js'), 'utf8');
  assert.match(source, /public\/app\.html/);
  assert.doesNotMatch(source, /public\/admin\.html/);
  assert.doesNotMatch(source, /public\/panel\.html/);
  assert.doesNotMatch(source, /public\/index\.html/);
});

test('server.js usa um único registrador tenant-aware', () => {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.equal((source.match(/registerTenantPanelRoutes\(app/g) || []).length, 1);
  assert.equal(source.includes('app.get("/api/admin/leads"'), false);
  assert.equal(source.includes('app.get("/api/panel/leads"'), false);
});
