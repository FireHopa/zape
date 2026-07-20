#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertReleaseId, createManifest } = require('../src/releaseManager');

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const root = path.resolve(__dirname, '..');
const source = path.resolve(arg('source', root));
const releasesDir = path.resolve(arg('releases-dir', path.join(root, 'releases')));
const releaseId = assertReleaseId(arg('release-id', process.env.RELEASE_ID || `release-${Date.now()}`));
const target = path.join(releasesDir, releaseId);
const apply = process.argv.includes('--apply');
const confirmation = arg('confirm');
if (!apply) {
  console.log(JSON.stringify({ ok: true, mode: 'dry-run', source, target, releaseId }, null, 2));
  process.exit(0);
}
if (confirmation !== 'CREATE_RELEASE') throw new Error('Criação exige --confirm=CREATE_RELEASE.');
if (fs.existsSync(target)) throw new Error(`Release já existe: ${target}`);
fs.mkdirSync(target, { recursive: true, mode: 0o755 });
const excludes = new Set([
  '.git',
  'node_modules',
  'data',
  'tmp',
  'backups',
  'logs',
  'releases',
  'dist',
  '.env',
]);
for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
  if (excludes.has(entry.name) || entry.name.startsWith('.env.')) continue;
  fs.cpSync(path.join(source, entry.name), path.join(target, entry.name), {
    recursive: true,
    preserveTimestamps: true,
  });
}
let commit = arg('commit', process.env.RELEASE_COMMIT || '');
if (!commit && fs.existsSync(path.join(source, '.git'))) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' });
  if (result.status === 0) commit = result.stdout.trim();
}
const manifest = createManifest(target, { releaseId, commit, builtAt: new Date().toISOString() });
console.log(JSON.stringify({ ok: true, mode: 'apply', releaseDir: target, manifest }, null, 2));
