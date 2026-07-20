#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { validateMediaBuffer } = require('../src/mediaSecurity');
const {
  createFixture,
  appendSyntheticLeads,
  credentialsForTenants,
  buildEnv,
  freePort,
  startApplication,
  stopApplication,
  login,
  jsonRequest,
  startFakeMetaServer,
  makeTempRoot,
  sleep,
} = require('../tests/helpers/phase15Harness');

const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputFile = outputArg ? path.resolve(outputArg.slice('--output='.length)) : '';

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] || 0;
}

async function pollJob(baseUrl, auth, jobId, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const out = await jsonRequest(baseUrl, `/api/wa-cloud/jobs/${jobId}`, { auth });
    assert.equal(out.status, 200, out.text);
    const state = out.payload.job.state;
    if (['completed', 'completed_with_errors', 'failed', 'canceled'].includes(state)) return out.payload.job;
    await sleep(50);
  }
  throw new Error('Timeout aguardando job de carga.');
}

function sign(secret, timestamp, eventId, rawBody) {
  return `sha256=${crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${eventId}.`)
    .update(rawBody)
    .digest('hex')}`;
}

(async () => {
  const root = makeTempRoot('zape-phase15-load-');
  const dataDir = path.join(root, 'data');
  createFixture(dataDir);
  appendSyntheticLeads(dataDir, 'panel', 9999, { offset: 1 });
  const credentials = credentialsForTenants();
  const panelOnly = { panel: credentials.panel };
  const appPort = await freePort();
  const meta = await startFakeMetaServer();
  const { env, baseUrl } = buildEnv(root, appPort, panelOnly, {
    CUSTOM_WEBHOOK_REQUIRE_SIGNATURE: '1',
    CUSTOM_WEBHOOK_RATE_LIMIT_MAX: '5000',
    PUBLIC_ENDPOINT_RATE_LIMIT_MAX: '5000',
    WA_CLOUD_ENABLED: '1',
    WA_CLOUD_FORCE_ENV: '1',
    WA_CLOUD_TOKEN: 'synthetic-phase15-token',
    WA_CLOUD_PHONE_NUMBER_ID: '1500',
    WA_CLOUD_WABA_ID: '2500',
    WA_CLOUD_GRAPH_VERSION: 'v25.0',
    WA_CLOUD_GRAPH_BASE_URL: meta.baseUrl,
    WA_CLOUD_CONNECTION_OWNER_TENANT: 'admin',
    WA_CLOUD_QUEUE_POLL_MS: '20',
    WA_CLOUD_QUEUE_MAX_ATTEMPTS: '3',
    WA_CLOUD_QUEUE_RETRY_BASE_MS: '20',
    WA_CLOUD_QUEUE_RETRY_MAX_MS: '100',
  });
  let app;
  const evidence = {
    phase: 15,
    suite: 'load',
    syntheticOnly: true,
    generatedAt: new Date().toISOString(),
    checks: {},
  };
  try {
    app = await startApplication(env, baseUrl);
    const auth = await login(baseUrl, 'panel', panelOnly);

    const pageTimes = [];
    const ids = new Set();
    let total = 0;
    let totalPages = 0;
    for (let page = 1; ; page += 1) {
      const started = performance.now();
      const out = await jsonRequest(baseUrl, `/api/panel/leads?page=${page}&pageSize=500&sortBy=createdAt&sortDir=asc`, { auth });
      pageTimes.push(performance.now() - started);
      assert.equal(out.status, 200, out.text);
      total = out.payload.total;
      totalPages = out.payload.totalPages;
      for (const lead of out.payload.items) ids.add(lead.id);
      if (!out.payload.hasNext) break;
    }
    assert.equal(total, 10000);
    assert.equal(ids.size, 10000);
    assert.equal(totalPages, 20);
    evidence.checks.leads = {
      total,
      totalPages,
      uniqueIds: ids.size,
      p50Ms: Math.round(percentile(pageTimes, 0.5)),
      p95Ms: Math.round(percentile(pageTimes, 0.95)),
      maxMs: Math.round(Math.max(...pageTimes)),
    };

    const webhookCreate = await jsonRequest(baseUrl, '/api/panel/webhooks', {
      method: 'POST', mutating: true, auth, body: { name: 'Carga Fase 15' },
    });
    assert.equal(webhookCreate.status, 200, webhookCreate.text);
    const webhookPath = new URL(webhookCreate.payload.url).pathname;
    const secret = webhookPath.split('/').filter(Boolean).pop();
    const webhookStarted = performance.now();
    const webhookResults = [];
    for (let batch = 0; batch < 5; batch += 1) {
      const requests = Array.from({ length: 20 }, (_, index) => {
        const ordinal = batch * 20 + index + 1;
        const rawBody = Buffer.from(JSON.stringify({
          nome: `Burst ${ordinal}`,
          email: `burst-${ordinal}@example.invalid`,
          whatsapp: `+55 13 9${String(70000000 + ordinal).slice(-8)}`,
        }));
        const timestamp = String(Math.floor(Date.now() / 1000));
        const eventId = `phase15-burst-${ordinal}`;
        return jsonRequest(baseUrl, webhookPath, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Zape-Timestamp': timestamp,
            'X-Zape-Event-Id': eventId,
            'X-Zape-Signature': sign(secret, timestamp, eventId, rawBody),
          },
          body: rawBody,
          rawBody: true,
        });
      });
      webhookResults.push(...await Promise.all(requests));
    }
    assert.equal(webhookResults.every((item) => item.status === 200), true, JSON.stringify(webhookResults.map((item) => item.status)));
    const burstList = await jsonRequest(baseUrl, '/api/panel/leads?origin=webhook&pageSize=500', { auth });
    assert.equal(burstList.status, 200, burstList.text);
    assert.equal(burstList.payload.items.filter((item) => String(item.email || '').startsWith('burst-')).length, 100);
    evidence.checks.webhookBurst = {
      events: 100,
      accepted: webhookResults.length,
      elapsedMs: Math.round(performance.now() - webhookStarted),
    };

    const contacts = Array.from({ length: 100 }, (_, index) => ({
      to: `55118${String(10000000 + index).slice(-8)}`,
      vars: [`Contato ${index + 1}`],
    }));
    const campaignStarted = performance.now();
    const campaign = await jsonRequest(baseUrl, '/api/wa-cloud/send-template-batch', {
      method: 'POST', mutating: true, auth,
      headers: { 'Idempotency-Key': 'phase15-load-campaign' },
      body: { templateName: 'synthetic_template', languageCode: 'pt_BR', campaignName: 'Carga Fase 15', throttleMs: 0, contacts },
    });
    assert.equal(campaign.status, 202, campaign.text);
    const job = await pollJob(baseUrl, auth, campaign.payload.job.id);
    assert.equal(job.state, 'completed');
    assert.equal(job.progress.sent, 100);
    assert.equal(meta.state.requests.filter((request) => /\/messages$/.test(request.url)).length, 100);
    evidence.checks.campaign = {
      contacts: 100,
      sent: job.progress.sent,
      failed: job.progress.failed,
      elapsedMs: Math.round(performance.now() - campaignStarted),
    };

    const pdf = Buffer.alloc(5 * 1024 * 1024, 0x20);
    Buffer.from('%PDF-1.4\n').copy(pdf, 0);
    Buffer.from('\n%%EOF').copy(pdf, pdf.length - 6);
    const mediaStarted = performance.now();
    const media = validateMediaBuffer(pdf, { declaredMime: 'application/pdf', filename: 'phase15-load.pdf' });
    assert.equal(media.kind, 'pdf');
    evidence.checks.media = {
      bytes: pdf.length,
      kind: media.kind,
      elapsedMs: Math.round(performance.now() - mediaStarted),
    };

    if (outputFile) {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await stopApplication(app?.child);
    await meta.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
