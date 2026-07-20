#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { createManifest, activateRelease, rollbackRelease, readLinkTarget } = require('../src/releaseManager');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-phase16-'));
const evidence = { ok: false, release: {}, monitor: {}, preflight: {} };

function run(script, args, env = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runAsync(script, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', script), ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

(async () => {
  let server;
  try {
    const releases = path.join(temp, 'releases');
    const makeRelease = (id, content) => {
      const dir = path.join(releases, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'server.js'), content);
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: id, private: true }));
      createManifest(dir, { releaseId: id, commit: `${id}-commit` });
      return dir;
    };
    const one = makeRelease('release-001', 'one');
    const two = makeRelease('release-002', 'two');
    const current = path.join(temp, 'current');
    const previous = path.join(temp, 'previous');
    const state = path.join(temp, 'deployment-state.json');
    activateRelease({
      releaseDir: one,
      currentLink: current,
      previousLink: previous,
      stateFile: state,
      releaseId: 'release-001',
    });
    activateRelease({
      releaseDir: two,
      currentLink: current,
      previousLink: previous,
      stateFile: state,
      releaseId: 'release-002',
    });
    const rolled = rollbackRelease({ currentLink: current, previousLink: previous, stateFile: state });
    evidence.release = {
      activeAfterRollback: rolled.activeReleaseId,
      currentTarget: readLinkTarget(current),
      previousTarget: readLinkTarget(previous),
      atomicRollback: rolled.activeReleaseId === 'release-001' && readLinkTarget(current) === one,
    };

    server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ ok: true, database: { ok: true }, release: { releaseId: 'release-monitor' } })
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const monitor = await runAsync('post-deploy-monitor.js', [
      `--health-url=http://127.0.0.1:${port}/health`,
      '--release-id=release-monitor',
      '--iterations=3',
      '--interval-ms=10',
    ]);
    const monitorBad = await runAsync('post-deploy-monitor.js', [
      `--health-url=http://127.0.0.1:${port}/health`,
      '--release-id=wrong-release',
      '--iterations=1',
    ]);
    evidence.monitor = {
      correctReleaseAccepted: monitor.status === 0,
      wrongReleaseRejected: monitorBad.status !== 0,
      result: monitor.status === 0 ? JSON.parse(monitor.stdout) : { stderr: monitor.stderr },
    };

    const envFile = path.join(temp, 'production.env');
    fs.writeFileSync(
      envFile,
      [
        'NODE_ENV=production',
        'SESSION_SECRET=synthetic-session-secret-with-more-than-32-characters',
        'CONFIG_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        'PUBLIC_BASE_URL=https://example.invalid',
        `ZAPE_DATA_DIR=${path.join(temp, 'data')}`,
        'PERSISTENCE_MODE=json',
        'RELEASE_ID=release-001',
        'FEATURE_FRONTEND_V2=1',
      ].join('\n') + '\n',
      { mode: 0o600 }
    );
    fs.mkdirSync(path.join(temp, 'data'), { recursive: true });
    const backup = path.join(temp, 'backup.enc');
    fs.writeFileSync(backup, 'synthetic encrypted backup');
    const restoreEvidence = path.join(temp, 'restore.json');
    fs.writeFileSync(restoreEvidence, JSON.stringify({ ok: true, files: 12 }));
    const migrationEvidence = path.join(temp, 'migration.json');
    fs.writeFileSync(
      migrationEvidence,
      JSON.stringify({ ok: true, mode: 'none', rollbackPlanned: true, forwardFix: true })
    );
    const preflight = run('deploy-preflight.js', [
      `--env=${envFile}`,
      `--release-dir=${one}`,
      `--backup-file=${backup}`,
      `--restore-evidence=${restoreEvidence}`,
      `--migration-evidence=${migrationEvidence}`,
    ]);
    evidence.preflight = {
      accepted: preflight.status === 0,
      result: preflight.stdout ? JSON.parse(preflight.stdout) : { stderr: preflight.stderr },
    };

    evidence.ok =
      evidence.release.atomicRollback &&
      evidence.monitor.correctReleaseAccepted &&
      evidence.monitor.wrongReleaseRejected &&
      evidence.preflight.accepted;
    console.log(JSON.stringify(evidence, null, 2));
    process.exitCode = evidence.ok ? 0 : 1;
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
