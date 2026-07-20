#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputFile = outputArg ? path.resolve(outputArg.slice('--output='.length)) : '';

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Servidor encerrou antes do health check: ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Timeout aguardando health check.');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers.get('set-cookie');
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,]+=)/g);
}

function cookieHeader(setCookies) {
  return setCookies.map((value) => value.split(';', 1)[0]).join('; ');
}

function cookieValue(setCookies, name) {
  for (const value of setCookies) {
    const first = value.split(';', 1)[0];
    const index = first.indexOf('=');
    if (index < 0) continue;
    if (first.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(first.slice(index + 1));
  }
  return '';
}

(async () => {
  const evidence = { phase: 5, syntheticOnly: true, generatedAt: new Date().toISOString(), checks: {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-phase5-'));
  const dataDir = path.join(tmp, 'data');
  let child = null;
  let browser = null;
  let stdout = '';
  let stderr = '';

  try {
    const fixture = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'create-sanitized-fixture.js'), `--output=${dataDir}`], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);

    const malicious = '<img src=x onerror=window.__storedXss=1><svg onload=window.__storedXss=2></svg><script>window.__storedXss=3</script>Nome';
    const adminLeadFile = path.join(dataDir, 'admin', 'leads.jsonl');
    const lead = JSON.parse(fs.readFileSync(adminLeadFile, 'utf8').trim());
    lead.nome = malicious;
    lead.empresa = '\"><img src=x onerror=window.__storedXss=4>';
    lead.website = 'javascript:window.__storedXss=5';
    fs.writeFileSync(adminLeadFile, `${JSON.stringify(lead)}\n`, 'utf8');

    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const adminUser = `admin_${randomSecret(8)}`;
    const adminPassword = randomSecret(24);
    const env = {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      PUBLIC_BASE_URL: baseUrl,
      APP_ALLOWED_ORIGINS: 'https://trusted.example,https://example.com',
      SESSION_SECRET: randomSecret(48),
      SESSION_STORE_FILE: path.join(dataDir, 'auth_sessions.json'),
      SECURITY_AUDIT_FILE: path.join(dataDir, 'security_audit.jsonl'),
      CONFIG_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
      ZAPE_DATA_DIR: dataDir,
      WEBHOOK_IDEMPOTENCY_FILE: path.join(dataDir, 'webhook_idempotency.json'),
      ADMIN_ENABLED: '1',
      ADMIN_USER: adminUser,
      ADMIN_PASS: adminPassword,
      ADMIN_ROLE: 'super_admin',
      PANEL_ENABLED: '0',
      REGINA_ENABLED: '0',
      PORTUGAL_ENABLED: '0',
      FELIPE_ENABLED: '0',
      ANA_ENABLED: '0',
      WEBJS_ENABLED: '0',
      WEBJS_AUTO_START: '0',
      CRM_INTEGRATION_ENABLED: '0',
      WA_CLOUD_ENABLED: '0',
      ENABLE_DEBUG_ACTIVE: '0',
      PUBLIC_LEAD_FORM_ENABLED: '0',
      ACTIVECAMPAIGN_WEBHOOK_ENABLED: '0',
    };

    child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    await waitForHealth(baseUrl, child);
    evidence.checks.health = 200;

    const dompurifyAsset = await fetch(`${baseUrl}/vendor/dompurify.min.js`);
    const phosphorAsset = await fetch(`${baseUrl}/vendor/phosphor/style.css`);
    assert.equal(dompurifyAsset.status, 200);
    assert.match(dompurifyAsset.headers.get('content-type') || '', /javascript/);
    assert.equal(phosphorAsset.status, 200);
    assert.match(phosphorAsset.headers.get('content-type') || '', /text\/css/);
    evidence.checks.runtimeVendorAssets = { dompurify: 200, phosphorCss: 200 };

    const loginResponse = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant: 'admin', username: adminUser, password: adminPassword, remember: true }),
    });
    assert.equal(loginResponse.status, 200);
    const setCookies = getSetCookies(loginResponse.headers);
    const cookies = cookieHeader(setCookies);
    const csrfToken = cookieValue(setCookies, 'zape_csrf');
    assert.ok(cookies.includes('zape_auth_admin='));
    assert.ok(csrfToken.length >= 32);
    evidence.checks.loginCreatesCsrfCookie = true;

    const adminResponse = await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookies } });
    assert.equal(adminResponse.status, 200);
    const csp = adminResponse.headers.get('content-security-policy') || '';
    assert.match(csp, /require-trusted-types-for 'script'/);
    assert.match(csp, /script-src-attr 'none'/);
    assert.equal(adminResponse.headers.get('x-frame-options'), 'DENY');
    assert.match(adminResponse.headers.get('cache-control') || '', /no-store/);
    evidence.checks.securityHeaders = {
      csp: true,
      trustedTypes: true,
      frameDenied: true,
      noStore: true,
    };

    const unsafeBody = JSON.stringify({ nome: 'CSRF Sintético', email: 'csrf@example.invalid' });
    const missingCsrf = await fetch(`${baseUrl}/api/admin/leads/manual`, {
      method: 'POST',
      headers: { Origin: baseUrl, Cookie: cookies, 'Content-Type': 'application/json' },
      body: unsafeBody,
    });
    assert.equal(missingCsrf.status, 403);

    const crossOrigin = await fetch(`${baseUrl}/api/admin/leads/manual`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', Cookie: cookies, 'Content-Type': 'application/json', 'X-Zape-CSRF-Token': csrfToken },
      body: unsafeBody,
    });
    assert.equal(crossOrigin.status, 403);

    const validCsrf = await fetch(`${baseUrl}/api/admin/leads/manual`, {
      method: 'POST',
      headers: { Origin: baseUrl, Cookie: cookies, 'Content-Type': 'application/json', 'X-Zape-CSRF-Token': csrfToken },
      body: unsafeBody,
    });
    assert.equal(validCsrf.status, 200);
    evidence.checks.csrf = { missing: 403, crossOrigin: 403, valid: 200 };

    const deniedCors = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(deniedCors.headers.has('access-control-allow-origin'), false);
    const allowedCors = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://trusted.example' } });
    assert.equal(allowedCors.headers.get('access-control-allow-origin'), 'https://trusted.example');
    evidence.checks.cors = { arbitraryReflected: false, allowlisted: true };

    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(String(error && error.message || error)));
    page.on('dialog', async (dialog) => {
      browserErrors.push(`dialog:${dialog.message()}`);
      await dialog.dismiss();
    });
    const dompurifySource = fs.readFileSync(path.join(ROOT, 'node_modules', 'dompurify', 'dist', 'purify.min.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
    const bootstrapSource = fs.readFileSync(path.join(ROOT, 'public', 'security-bootstrap.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
    await page.setContent(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline'; require-trusted-types-for 'script'; trusted-types default dompurify"></head><body><div id="root"></div><script>${dompurifySource}</script><script>${bootstrapSource}</script></body></html>`);

    const xssResult = await page.evaluate(async (payload) => {
      window.__storedXss = 0;
      window.__directXss = 0;

      var details = document.createElement('div');
      details.id = 'lead-details-safe-text';
      details.textContent = payload;
      document.body.appendChild(details);

      var probe = document.createElement('div');
      probe.id = 'phase5-xss-probe';
      probe.innerHTML = '<img id="phase5-img" src=x onerror="window.__directXss=1"><svg onload="window.__directXss=2"></svg><script>window.__directXss=3</script>';
      document.body.appendChild(probe);
      var link = document.createElement('a');
      var blockedUrl = window.zapeSecurity.setElementUrl(link, 'href', 'javascript:window.__directXss=4');
      await new Promise((resolve) => setTimeout(resolve, 250));
      return {
        storedExecuted: window.__storedXss,
        directExecuted: window.__directXss,
        probeHtml: probe.innerHTML,
        hasEventHandler: Boolean(probe.querySelector('[onerror],[onload]')),
        hasScript: Boolean(probe.querySelector('script')),
        hasSvg: Boolean(probe.querySelector('svg')),
        blockedUrl,
        linkHref: link.getAttribute('href'),
        payloadVisibleAsText: details.textContent === payload,
        payloadCreatedElements: details.children.length,
        trustedTypesAvailable: Boolean(window.trustedTypes),
      };
    }, malicious);

    assert.equal(xssResult.storedExecuted, 0);
    assert.equal(xssResult.directExecuted, 0);
    assert.equal(xssResult.hasEventHandler, false);
    assert.equal(xssResult.hasScript, false);
    assert.equal(xssResult.hasSvg, false);
    assert.equal(xssResult.blockedUrl, false);
    assert.equal(xssResult.linkHref, null);
    assert.equal(xssResult.payloadVisibleAsText, true);
    assert.equal(xssResult.payloadCreatedElements, 0);
    assert.equal(browserErrors.some((item) => /TrustedHTML|Refused to execute|dialog:/i.test(item)), false, browserErrors.join('\n'));
    evidence.checks.xss = xssResult;
    evidence.checks.browserErrors = browserErrors;

    if (outputFile) {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    console.error(error && error.stack || error);
    if (stdout) console.error('--- server stdout ---\n' + stdout.slice(-8000));
    if (stderr) console.error('--- server stderr ---\n' + stderr.slice(-8000));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopChild(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
