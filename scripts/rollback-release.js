#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { rollbackRelease } = require('../src/releaseManager');

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

(async () => {
  const currentLink = path.resolve(arg('current-link', '/opt/zape/current'));
  const previousLink = path.resolve(arg('previous-link', '/opt/zape/previous'));
  const stateFile = path.resolve(arg('state-file', '/var/lib/zape/deployment-state.json'));
  if (!process.argv.includes('--apply')) {
    console.log(
      JSON.stringify(
        { ok: true, mode: 'dry-run', currentLink, previousLink, stateFile, databaseRollback: false },
        null,
        2
      )
    );
    return;
  }
  if (arg('confirm') !== 'ROLLBACK_RELEASE') throw new Error('Rollback exige --confirm=ROLLBACK_RELEASE.');
  if (process.argv.some((value) => value.includes('rollback-database'))) {
    throw new Error(
      'Rollback automático de banco é proibido. Use forward fix ou plano aprovado por migration.'
    );
  }
  const state = rollbackRelease({ currentLink, previousLink, stateFile });
  console.log(JSON.stringify({ ok: true, mode: 'apply', state, databaseRollback: false }, null, 2));
})().catch((error) => {
  console.error(
    JSON.stringify({ ok: false, code: error.code || 'ROLLBACK_FAILED', message: error.message }, null, 2)
  );
  process.exit(1);
});
