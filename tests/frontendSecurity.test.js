'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(ROOT, 'public', 'security-bootstrap.js'), 'utf8');
const loginHtmlSource = fs.readFileSync(path.join(ROOT, 'src', 'basicAuthFactory.js'), 'utf8');

test('painel não possui scripts ou folhas de estilo inline', () => {
  assert.equal(/<style(?:\s|>)/i.test(html), false);
  assert.equal(/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(html), false);
  assert.match(html, /\/vendor\/dompurify\.min\.js/);
  assert.match(html, /\/security-bootstrap\.js/);
  assert.match(html, /\/app\.js/);
  assert.ok(html.indexOf('/security-bootstrap.js') < html.indexOf('/app.js'));
});

test('frontend elimina sinks executáveis legados e ativa sanitização central', () => {
  assert.equal(/\bdocument\.write\s*\(/.test(appJs), false);
  assert.equal(/\binsertAdjacentHTML\s*\(/.test(appJs), false);
  assert.equal(/\beval\s*\(/.test(appJs), false);
  assert.equal(/\bnew\s+Function\s*\(/.test(appJs), false);
  assert.match(bootstrap, /DOMPurify/);
  assert.match(bootstrap, /trustedTypes\.createPolicy\('default'/);
  assert.match(bootstrap, /FORBID_TAGS/);
  assert.match(bootstrap, /X-Zape-CSRF-Token/);
  assert.match(bootstrap, /Protocolo de requisição bloqueado/);
});

test('detalhes do lead usam textContent e URLs dinâmicas passam por validação', () => {
  assert.match(appJs, /value\.textContent = String\(v == null/);
  assert.match(appJs, /setSafeElementUrl\(document\.getElementById\("qrBig"\)/);
  assert.match(appJs, /setSafeElementUrl\(csv, "href"/);
  assert.match(appJs, /safeCssColor\(t\.color/);
});

test('página de login não contém script ou CSS inline', () => {
  const renderPart = loginHtmlSource.slice(loginHtmlSource.indexOf('function renderLoginPage()'), loginHtmlSource.indexOf('function registerAuthRoutes'));
  assert.equal(/<style(?:\s|>)/i.test(renderPart), false);
  assert.equal(/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(renderPart), false);
  assert.match(renderPart, /\/login\.css/);
  assert.match(renderPart, /\/login\.js/);
});
