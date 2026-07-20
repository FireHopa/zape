#!/usr/bin/env node
'use strict';

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const healthUrl = arg('health-url', process.env.DEPLOY_HEALTH_URL || '');
const expectedRelease = arg('release-id', process.env.RELEASE_ID || '');
const iterations = Math.max(1, Math.min(120, Number(arg('iterations', '3')) || 3));
const intervalMs = Math.max(0, Math.min(300000, Number(arg('interval-ms', '1000')) || 1000));
const maxFailures = Math.max(0, Math.min(iterations, Number(arg('max-failures', '0')) || 0));
if (!healthUrl) throw new Error('Use --health-url=https://dominio/health.');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const samples = [];
  let failures = 0;
  for (let index = 0; index < iterations; index += 1) {
    const started = Date.now();
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(Number(arg('timeout-ms', '10000'))),
      });
      const body = await response.json().catch(() => ({}));
      const releaseId = body?.release?.releaseId || '';
      const ok = response.ok && body.ok === true && (!expectedRelease || releaseId === expectedRelease);
      if (!ok) failures += 1;
      samples.push({
        index: index + 1,
        ok,
        status: response.status,
        latencyMs: Date.now() - started,
        releaseId,
        databaseOk: body?.database?.ok !== false,
      });
    } catch (error) {
      failures += 1;
      samples.push({ index: index + 1, ok: false, latencyMs: Date.now() - started, error: error.message });
    }
    if (index + 1 < iterations && intervalMs) await sleep(intervalMs);
  }
  const output = {
    ok: failures <= maxFailures,
    healthUrl,
    expectedRelease: expectedRelease || null,
    failures,
    maxFailures,
    samples,
  };
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = output.ok ? 0 : 1;
})().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error.message }, null, 2));
  process.exit(1);
});
