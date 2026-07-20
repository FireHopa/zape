#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { activateRelease, rollbackRelease } = require('../src/releaseManager');

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function checkHealth(url, releaseId) {
  if (!url) return { skipped: true };
  const response = await fetch(url, { signal: AbortSignal.timeout(Number(arg('timeout-ms', '10000'))) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) throw new Error(`Smoke test falhou com HTTP ${response.status}.`);
  if (releaseId && body?.release?.releaseId !== releaseId) {
    throw new Error(
      `Release ativa divergente: esperado ${releaseId}, recebido ${body?.release?.releaseId || 'ausente'}.`
    );
  }
  return { status: response.status, releaseId: body?.release?.releaseId || '' };
}

(async () => {
  const releaseDir = path.resolve(arg('release-dir'));
  const currentLink = path.resolve(arg('current-link', '/opt/zape/current'));
  const previousLink = path.resolve(arg('previous-link', '/opt/zape/previous'));
  const stateFile = path.resolve(arg('state-file', '/var/lib/zape/deployment-state.json'));
  const releaseId = arg('release-id');
  const healthUrl = arg('health-url');
  if (!process.argv.includes('--apply')) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: 'dry-run',
          releaseDir,
          currentLink,
          previousLink,
          stateFile,
          releaseId,
          healthUrl: healthUrl || null,
        },
        null,
        2
      )
    );
    return;
  }
  if (arg('confirm') !== 'ACTIVATE_RELEASE') throw new Error('Ativação exige --confirm=ACTIVATE_RELEASE.');
  const state = activateRelease({ releaseDir, currentLink, previousLink, stateFile, releaseId });
  try {
    const health = await checkHealth(healthUrl, state.activeReleaseId);
    console.log(JSON.stringify({ ok: true, mode: 'apply', state, health }, null, 2));
  } catch (error) {
    let rollback = null;
    try {
      rollback = rollbackRelease({ currentLink, previousLink, stateFile });
    } catch {}
    error.message = `${error.message} Rollback automático: ${rollback ? 'aplicado' : 'indisponível'}.`;
    throw error;
  }
})().catch((error) => {
  console.error(
    JSON.stringify({ ok: false, code: error.code || 'ACTIVATION_FAILED', message: error.message }, null, 2)
  );
  process.exit(1);
});
