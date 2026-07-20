'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createManifest,
  verifyManifest,
  activateRelease,
  rollbackRelease,
  readLinkTarget,
} = require('../src/releaseManager');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-release-test-'));
  const releases = path.join(root, 'releases');
  fs.mkdirSync(releases, { recursive: true });
  const make = (id, content) => {
    const dir = path.join(releases, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'server.js'), content);
    createManifest(dir, { releaseId: id, commit: `${id}-commit` });
    return dir;
  };
  return { root, make, current: path.join(root, 'current'), previous: path.join(root, 'previous'), state: path.join(root, 'state.json') };
}

test('manifest detects tampering', () => {
  const f = fixture();
  try {
    const release = f.make('release-001', 'one');
    assert.equal(verifyManifest(release).ok, true);
    fs.writeFileSync(path.join(release, 'server.js'), 'tampered');
    const verified = verifyManifest(release);
    assert.equal(verified.ok, false);
    assert.match(verified.errors.join(' '), /Checksum divergente/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('activation is atomic and rollback restores the previous release', () => {
  const f = fixture();
  try {
    const first = f.make('release-001', 'one');
    const second = f.make('release-002', 'two');
    activateRelease({ releaseDir: first, currentLink: f.current, previousLink: f.previous, stateFile: f.state, releaseId: 'release-001' });
    assert.equal(readLinkTarget(f.current), first);
    activateRelease({ releaseDir: second, currentLink: f.current, previousLink: f.previous, stateFile: f.state, releaseId: 'release-002' });
    assert.equal(readLinkTarget(f.current), second);
    assert.equal(readLinkTarget(f.previous), first);
    const rolled = rollbackRelease({ currentLink: f.current, previousLink: f.previous, stateFile: f.state });
    assert.equal(rolled.activeReleaseId, 'release-001');
    assert.equal(readLinkTarget(f.current), first);
    assert.equal(readLinkTarget(f.previous), second);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('rollback fails closed when no previous release exists', () => {
  const f = fixture();
  try {
    assert.throws(() => rollbackRelease({ currentLink: f.current, previousLink: f.previous, stateFile: f.state }), /não está disponível/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
