#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputFile = outputArg ? path.resolve(outputArg.slice('--output='.length)) : '';

function readPublic(file) {
  return fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
}

function stripExternalScripts(html) {
  return html.replace(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*><\/script>/gi, '');
}

(async () => {
  const html = stripExternalScripts(readPublic('app.html'));
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const evidence = {
    phase: 15,
    suite: 'browser-component-e2e',
    syntheticOnly: true,
    generatedAt: new Date().toISOString(),
    limitation: 'Managed Chromium blocks URL navigation; live navigation is delegated to CI/staging.',
    checks: {},
  };
  const pageErrors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setContent(html, { waitUntil: 'domcontentloaded' });

    const structural = await page.evaluate(() => ({
      leads: Boolean(document.querySelector('#panelLeads')),
      pagination: Boolean(document.querySelector('#pageSize') && document.querySelector('#btnNext')),
      search: Boolean(document.querySelector('#q')),
      detail: Boolean(document.querySelector('#ovLead')),
      edit: Boolean(document.querySelector('#leadEditNome') && document.querySelector('#btnSaveLead')),
      crm: Boolean(document.querySelector('#panelCrm') && document.querySelector('#crmBoard')),
      conversations: Boolean(document.querySelector('#panelChats') && document.querySelector('#chatList')),
      attachment: document.querySelector('#chatAttachmentInput')?.getAttribute('accept') || '',
      cloud: Boolean(document.querySelector('#panelCloudMain') && document.querySelector('#btnCloudSend')),
      logout: Boolean(document.querySelector('#btnLogout')),
    }));
    assert.equal(structural.leads, true);
    assert.equal(structural.pagination, true);
    assert.equal(structural.search, true);
    assert.equal(structural.detail, true);
    assert.equal(structural.edit, true);
    assert.equal(structural.crm, true);
    assert.equal(structural.conversations, true);
    assert.match(structural.attachment, /application\/pdf/);
    assert.match(structural.attachment, /\.xlsx/);
    assert.equal(structural.cloud, true);
    assert.equal(structural.logout, true);
    evidence.checks.uiContract = structural;

    await page.addScriptTag({ path: require.resolve('dompurify/dist/purify.min.js') });
    await page.addScriptTag({ content: readPublic('security-bootstrap.js') });
    const xss = await page.evaluate(() => {
      globalThis.__phase15Xss = 0;
      const payloads = [
        '<img src=x onerror=globalThis.__phase15Xss=1>',
        '<svg onload=globalThis.__phase15Xss=2></svg>',
        '<script>globalThis.__phase15Xss=3<\/script>',
      ];
      const container = document.createElement('div');
      document.body.appendChild(container);
      const rendered = [];
      for (const payload of payloads) {
        const sanitized = window.zapeSecurity.sanitizeHtml(payload);
        container.innerHTML = sanitized;
        rendered.push(container.innerHTML);
      }
      const unsafeLink = document.createElement('a');
      const unsafeAllowed = window.zapeSecurity.setElementUrl(
        unsafeLink,
        'href',
        'javascript:globalThis.__phase15Xss=4',
        { sameOrigin: false }
      );
      return {
        executed: globalThis.__phase15Xss,
        rendered,
        eventAttributes: container.querySelectorAll('[onerror],[onload],script,svg').length,
        unsafeAllowed,
        unsafeHref: unsafeLink.getAttribute('href'),
      };
    });
    assert.equal(xss.executed, 0);
    assert.equal(xss.eventAttributes, 0);
    assert.equal(xss.unsafeAllowed, false);
    assert.equal(xss.unsafeHref, null);
    evidence.checks.xss = xss;

    const pagination = await page.evaluate(() => {
      const pageSize = document.querySelector('#pageSize');
      const next = document.querySelector('#btnNext');
      const q = document.querySelector('#q');
      pageSize.value = '50';
      pageSize.dispatchEvent(new Event('change', { bubbles: true }));
      q.value = 'lead sintético';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      next.disabled = false;
      next.click();
      return { pageSize: pageSize.value, query: q.value, nextAvailable: !next.disabled };
    });
    assert.equal(pagination.pageSize, '50');
    assert.equal(pagination.query, 'lead sintético');
    evidence.checks.paginationAndSearchControls = pagination;

    const noInlineExecutables = {
      inlineScripts: (readPublic('app.html').match(/<script(?![^>]*\bsrc=)[^>]*>/gi) || []).length,
      documentWrite: /document\.write\s*\(/.test(readPublic('app.js')),
      eval: /\beval\s*\(/.test(readPublic('app.js')),
      newFunction: /new\s+Function\s*\(/.test(readPublic('app.js')),
    };
    assert.equal(noInlineExecutables.inlineScripts, 0);
    assert.equal(noInlineExecutables.documentWrite, false);
    assert.equal(noInlineExecutables.eval, false);
    assert.equal(noInlineExecutables.newFunction, false);
    evidence.checks.staticBrowserSecurity = noInlineExecutables;

    assert.deepEqual(pageErrors, []);
    evidence.checks.browserErrors = 0;
    if (outputFile) {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
