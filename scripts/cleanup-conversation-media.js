#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function argValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

function safeTenant(value) {
  return /^[a-z0-9_-]{1,64}$/i.test(value);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function referencedFiles(conversations) {
  const refs = new Set();
  for (const messages of Object.values(conversations && typeof conversations === 'object' ? conversations : {})) {
    for (const message of Array.isArray(messages) ? messages : []) {
      const file = path.basename(String(message && message.mediaFile || ''));
      if (file) refs.add(file);
    }
  }
  return refs;
}

function moveFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.renameSync(source, target); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(source);
  }
}

function rollback(manifestFile) {
  const manifest = readJson(manifestFile, null);
  if (!manifest || !Array.isArray(manifest.moves)) throw new Error('Manifesto de rollback inválido.');
  const restored = [];
  const conflicts = [];
  for (const move of [...manifest.moves].reverse()) {
    const source = path.resolve(move.quarantinePath);
    const target = path.resolve(move.originalPath);
    if (!fs.existsSync(source)) continue;
    if (fs.existsSync(target)) { conflicts.push(target); continue; }
    moveFile(source, target);
    restored.push(target);
  }
  const result = { mode: 'rollback', manifest: path.resolve(manifestFile), restored: restored.length, conflicts };
  console.log(JSON.stringify(result, null, 2));
  if (conflicts.length) process.exitCode = 2;
}

function main() {
  const rollbackFile = argValue('rollback');
  if (rollbackFile) return rollback(rollbackFile);

  const dataDir = path.resolve(argValue('data-dir') || process.env.ZAPE_DATA_DIR || path.join(__dirname, '..', 'data'));
  const retentionDays = Math.max(1, Math.min(3650, Number(argValue('retention-days') || process.env.MEDIA_ORPHAN_RETENTION_DAYS || 30)));
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const apply = process.argv.includes('--apply');
  const confirmed = argValue('confirm') === 'QUARANTINE_ORPHAN_MEDIA';
  if (apply && !confirmed) throw new Error('Para aplicar, use --apply --confirm=QUARANTINE_ORPHAN_MEDIA.');

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(4).toString('hex')}`;
  const quarantineRoot = path.join(dataDir, '_media_quarantine', runId);
  const candidates = [];
  const retainedRecent = [];
  const referenced = [];

  if (!fs.existsSync(dataDir)) throw new Error(`Diretório de dados não encontrado: ${dataDir}`);
  const tenants = fs.readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && safeTenant(entry.name) && !entry.name.startsWith('_'))
    .map((entry) => entry.name);

  for (const tenant of tenants) {
    const tenantDir = path.join(dataDir, tenant);
    const mediaDir = path.join(tenantDir, 'conversation_media');
    if (!fs.existsSync(mediaDir)) continue;
    const refs = referencedFiles(readJson(path.join(tenantDir, 'conversations.json'), {}));
    for (const entry of fs.readdirSync(mediaDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(mediaDir, entry.name);
      const stat = fs.statSync(file);
      const item = { tenant, file: entry.name, path: file, size: stat.size, mtime: stat.mtime.toISOString() };
      if (refs.has(entry.name)) { referenced.push(item); continue; }
      if (stat.mtimeMs > cutoff) { retainedRecent.push(item); continue; }
      candidates.push(item);
    }
  }

  const moves = [];
  if (apply) {
    for (const item of candidates) {
      const target = path.join(quarantineRoot, item.tenant, item.file);
      moveFile(item.path, target);
      moves.push({ tenant: item.tenant, file: item.file, originalPath: item.path, quarantinePath: target, size: item.size });
    }
  }

  const report = {
    schemaVersion: 1,
    runId,
    mode: apply ? 'apply' : 'dry-run',
    dataDir,
    retentionDays,
    cutoff: new Date(cutoff).toISOString(),
    totals: {
      tenants: tenants.length,
      referenced: referenced.length,
      recentOrphansRetained: retainedRecent.length,
      oldOrphanCandidates: candidates.length,
      quarantined: moves.length,
      bytesCandidate: candidates.reduce((sum, item) => sum + item.size, 0),
    },
    candidates,
    moves,
  };

  if (apply) {
    fs.mkdirSync(quarantineRoot, { recursive: true });
    const manifest = path.join(quarantineRoot, 'manifest.json');
    fs.writeFileSync(manifest, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    report.manifest = manifest;
  }
  console.log(JSON.stringify(report, null, 2));
}

try { main(); }
catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code || 'MEDIA_CLEANUP_FAILED', error: error.message }, null, 2));
  process.exitCode = 1;
}
