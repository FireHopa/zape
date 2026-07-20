#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const {
  createFixture,
  appendSyntheticLeads,
  credentialsForTenants,
  buildEnv,
  freePort,
  startApplication,
  stopApplication,
  makeTempRoot,
} = require('../tests/helpers/phase15Harness');

const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputFile = outputArg ? path.resolve(outputArg.slice('--output='.length)) : '';

async function waitText(page, selector, predicate, timeout = 15000) {
  await page.waitForFunction((sel, expected) => {
    const element = document.querySelector(sel);
    return element && String(element.textContent || '').includes(expected);
  }, { timeout }, selector, predicate);
}

(async () => {
  const root = makeTempRoot('zape-phase15-e2e-');
  const dataDir = path.join(root, 'data');
  createFixture(dataDir);
  appendSyntheticLeads(dataDir, 'panel', 250, { offset: 1, source: 'phase15_e2e' });
  const xssLead = {
    id: 'phase15-xss-lead',
    source: 'phase15_e2e',
    sourceDetail: 'XSS regression fixture',
    createdAt: '2026-01-02T12:00:00.000Z',
    nome: '<img src=x onerror=globalThis.__phase15Xss=1>',
    empresa: '<svg onload=globalThis.__phase15Xss=2>',
    email: 'xss15@example.invalid',
    website: 'javascript:alert(1)',
    whatsapp_raw: '+55 11 94444-1515',
    whatsapp_digits: '5511944441515',
  };
  fs.appendFileSync(path.join(dataDir, 'panel', 'leads.jsonl'), `${JSON.stringify(xssLead)}\n`);

  const credentials = credentialsForTenants();
  const panelOnly = { panel: credentials.panel };
  const port = await freePort();
  const { env, baseUrl } = buildEnv(root, port, panelOnly, {
    WA_CLOUD_ENABLED: '0',
    WEBJS_ENABLED: '0',
  });
  let app;
  let browser;
  const pageErrors = [];
  const evidence = {
    phase: 15,
    suite: 'e2e',
    syntheticOnly: true,
    generatedAt: new Date().toISOString(),
    checks: {},
  };
  try {
    app = await startApplication(env, baseUrl);
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (fs.existsSync(puppeteer.executablePath()) ? puppeteer.executablePath() : '/usr/bin/chromium'),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${baseUrl}/panel`, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.select('#tenant', 'panel');
    await page.type('#username', panelOnly.panel.username);
    await page.type('#password', panelOnly.panel.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }),
      page.click('#btn'),
    ]);
    assert.equal(new URL(page.url()).pathname, '/panel');
    await page.waitForSelector('#tbody tr', { timeout: 20000 });
    await waitText(page, '#pageInfo', 'Total de resultados: 252');
    evidence.checks.login = true;
    evidence.checks.list = { total: 252 };

    await page.select('#pageSize', '50');
    await waitText(page, '#pageInfo', 'Página 1 de 6');
    await page.click('#btnNext');
    await waitText(page, '#pageInfo', 'Página 2 de 6');
    evidence.checks.pagination = true;

    await page.evaluate(() => {
      const input = document.querySelector('#q');
      input.value = 'xss15@example.invalid';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitText(page, '#pageInfo', 'Total de resultados: 1');
    const xssState = await page.evaluate(() => ({
      executed: globalThis.__phase15Xss || 0,
      injectedImage: Boolean(document.querySelector('#tbody img[src="x"]')),
      text: document.querySelector('#tbody')?.textContent || '',
    }));
    assert.equal(xssState.executed, 0);
    assert.equal(xssState.injectedImage, false);
    assert.match(xssState.text, /<img src=x onerror=/);
    evidence.checks.xss = { executed: false, renderedAsText: true };

    await page.click('#tbody [data-avatar]');
    await page.waitForSelector('#ovLead.open, #ovLead[style*="display"]', { timeout: 10000 }).catch(() => {});
    await page.focus('#leadEditNome');
    await page.evaluate(() => { document.querySelector('#leadEditNome').value = 'Lead XSS Editado'; });
    await page.click('#btnSaveLead');
    await page.waitForFunction(() => !document.querySelector('#ovLead')?.classList.contains('open'), { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => {
      const input = document.querySelector('#q');
      input.value = 'Lead XSS Editado';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => (document.querySelector('#tbody')?.textContent || '').includes('Lead XSS Editado'), { timeout: 15000 });
    evidence.checks.edit = true;

    await page.click('#navCrm');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#panelCrm')).display !== 'none', { timeout: 15000 });
    await page.waitForSelector('#crmBoard');
    evidence.checks.crm = true;

    await page.click('#navChats');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#panelChats')).display !== 'none', { timeout: 15000 });
    await page.waitForSelector('#chatList');
    const attachmentAccept = await page.$eval('#chatAttachmentInput', (input) => input.accept);
    assert.match(attachmentAccept, /application\/pdf/);
    assert.match(attachmentAccept, /\.xlsx/);
    evidence.checks.conversations = true;
    evidence.checks.attachments = true;

    await page.click('#navCloud');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#panelCloudMain')).display !== 'none', { timeout: 15000 });
    await page.waitForSelector('#btnCloudSend');
    const cloudButton = await page.$eval('#btnCloudSend', (button) => Boolean(button));
    assert.equal(cloudButton, true);
    evidence.checks.cloudCampaignUi = true;

    assert.deepEqual(pageErrors, []);
    evidence.checks.browserErrors = 0;
    if (outputFile) {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    if (browser) await browser.close();
    await stopApplication(app?.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
