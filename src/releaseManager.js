'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function clean(value) {
  return String(value ?? '').trim();
}

function assertReleaseId(value) {
  const releaseId = clean(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$/.test(releaseId)) {
    throw Object.assign(
      new Error('RELEASE_ID inválido. Use 3 a 128 caracteres alfanuméricos, ponto, hífen ou underscore.'),
      { code: 'RELEASE_ID_INVALID' }
    );
  }
  return releaseId;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function atomicWriteJson(file, payload, mode = 0o600) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode });
  fs.renameSync(temp, target);
  try {
    fs.chmodSync(target, mode);
  } catch {}
}

function listFiles(root, relative = '') {
  const current = path.join(root, relative);
  const entries = fs.readdirSync(current, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) output.push(...listFiles(root, next));
    else if (entry.isFile()) output.push(next.replaceAll(path.sep, '/'));
  }
  return output.sort();
}

function createManifest(releaseDir, metadata = {}) {
  const root = path.resolve(releaseDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory())
    throw new Error(`Release não encontrada: ${root}`);
  const files = listFiles(root).filter((relative) => relative !== 'release-manifest.json');
  const fileEntries = files.map((relative) => {
    const absolute = path.join(root, relative);
    return { path: relative, bytes: fs.statSync(absolute).size, sha256: sha256File(absolute) };
  });
  const manifest = {
    schemaVersion: 1,
    releaseId: assertReleaseId(metadata.releaseId || path.basename(root)),
    commit: clean(metadata.commit),
    builtAt: clean(metadata.builtAt) || new Date().toISOString(),
    sourceHash: clean(metadata.sourceHash),
    files: fileEntries,
    fileCount: fileEntries.length,
    totalBytes: fileEntries.reduce((sum, item) => sum + item.bytes, 0),
  };
  const aggregate = crypto.createHash('sha256');
  for (const item of fileEntries) aggregate.update(`${item.path}\0${item.bytes}\0${item.sha256}\n`);
  manifest.aggregateSha256 = aggregate.digest('hex');
  atomicWriteJson(path.join(root, 'release-manifest.json'), manifest, 0o644);
  return manifest;
}

function verifyManifest(releaseDir) {
  const root = path.resolve(releaseDir);
  const manifestFile = path.join(root, 'release-manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`Manifesto ausente: ${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assertReleaseId(manifest.releaseId);
  const errors = [];
  for (const item of Array.isArray(manifest.files) ? manifest.files : []) {
    const relative = clean(item.path);
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`)) {
      errors.push(`Caminho fora da release: ${relative}`);
      continue;
    }
    if (!fs.existsSync(absolute)) {
      errors.push(`Arquivo ausente: ${relative}`);
      continue;
    }
    const actual = sha256File(absolute);
    if (actual !== item.sha256) errors.push(`Checksum divergente: ${relative}`);
  }
  return { ok: errors.length === 0, manifest, errors };
}

function readLinkTarget(link) {
  const absolute = path.resolve(link);
  try {
    if (!fs.lstatSync(absolute).isSymbolicLink()) return '';
    return path.resolve(path.dirname(absolute), fs.readlinkSync(absolute));
  } catch {
    return '';
  }
}

function atomicSymlink(target, link) {
  const absoluteLink = path.resolve(link);
  fs.mkdirSync(path.dirname(absoluteLink), { recursive: true, mode: 0o755 });
  const temp = `${absoluteLink}.next-${process.pid}-${Date.now()}`;
  try {
    fs.unlinkSync(temp);
  } catch {}
  fs.symlinkSync(path.resolve(target), temp, 'dir');
  fs.renameSync(temp, absoluteLink);
}

function activateRelease({ releaseDir, currentLink, previousLink, stateFile, releaseId }) {
  const release = path.resolve(releaseDir);
  const verification = verifyManifest(release);
  if (!verification.ok) {
    throw Object.assign(new Error(`Manifesto inválido: ${verification.errors.join('; ')}`), {
      code: 'RELEASE_MANIFEST_INVALID',
    });
  }
  const expected = assertReleaseId(releaseId || verification.manifest.releaseId);
  if (verification.manifest.releaseId !== expected)
    throw new Error('RELEASE_ID não corresponde ao manifesto.');
  const oldTarget = readLinkTarget(currentLink);
  if (oldTarget && path.resolve(oldTarget) !== release) atomicSymlink(oldTarget, previousLink);
  atomicSymlink(release, currentLink);
  const state = {
    schemaVersion: 1,
    activeReleaseId: expected,
    activeReleaseDir: release,
    previousReleaseDir: oldTarget || null,
    activatedAt: new Date().toISOString(),
    manifestSha256: sha256File(path.join(release, 'release-manifest.json')),
  };
  atomicWriteJson(stateFile, state);
  return state;
}

function rollbackRelease({ currentLink, previousLink, stateFile }) {
  const previous = readLinkTarget(previousLink);
  if (!previous || !fs.existsSync(previous)) {
    throw Object.assign(new Error('Release anterior não está disponível para rollback.'), {
      code: 'PREVIOUS_RELEASE_UNAVAILABLE',
    });
  }
  const current = readLinkTarget(currentLink);
  const verification = verifyManifest(previous);
  if (!verification.ok) throw new Error(`Release anterior inválida: ${verification.errors.join('; ')}`);
  atomicSymlink(previous, currentLink);
  if (current && fs.existsSync(current)) atomicSymlink(current, previousLink);
  const state = {
    schemaVersion: 1,
    activeReleaseId: verification.manifest.releaseId,
    activeReleaseDir: previous,
    previousReleaseDir: current || null,
    rolledBackAt: new Date().toISOString(),
    manifestSha256: sha256File(path.join(previous, 'release-manifest.json')),
  };
  atomicWriteJson(stateFile, state);
  return state;
}

module.exports = {
  assertReleaseId,
  sha256File,
  atomicWriteJson,
  listFiles,
  createManifest,
  verifyManifest,
  readLinkTarget,
  activateRelease,
  rollbackRelease,
};
