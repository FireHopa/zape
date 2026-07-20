'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '..', 'scripts', 'cleanup-conversation-media.js');

function run(args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

test('limpeza é dry-run, respeita retenção, aplica quarentena e permite rollback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-media-cleanup-'));
  try {
    const tenant = path.join(root, 'panel');
    const media = path.join(tenant, 'conversation_media');
    fs.mkdirSync(media, { recursive: true });
    fs.writeFileSync(path.join(tenant, 'conversations.json'), JSON.stringify({ '5513999990000': [{ mediaFile: 'referenced.png' }] }));
    for (const name of ['referenced.png', 'old-orphan.png', 'recent-orphan.png']) fs.writeFileSync(path.join(media, name), name);
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(media, 'referenced.png'), old, old);
    fs.utimesSync(path.join(media, 'old-orphan.png'), old, old);

    const dry = run([`--data-dir=${root}`, '--retention-days=30']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(dry.json.mode, 'dry-run');
    assert.equal(dry.json.totals.oldOrphanCandidates, 1);
    assert.equal(fs.existsSync(path.join(media, 'old-orphan.png')), true);

    const denied = run([`--data-dir=${root}`, '--retention-days=30', '--apply']);
    assert.equal(denied.status, 1);
    assert.equal(fs.existsSync(path.join(media, 'old-orphan.png')), true);

    const applied = run([`--data-dir=${root}`, '--retention-days=30', '--apply', '--confirm=QUARANTINE_ORPHAN_MEDIA']);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.json.totals.quarantined, 1);
    assert.equal(fs.existsSync(path.join(media, 'old-orphan.png')), false);
    assert.equal(fs.existsSync(path.join(media, 'recent-orphan.png')), true);
    assert.equal(fs.existsSync(path.join(media, 'referenced.png')), true);
    assert.ok(applied.json.manifest);

    const rolledBack = run([`--rollback=${applied.json.manifest}`]);
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(rolledBack.json.restored, 1);
    assert.equal(fs.existsSync(path.join(media, 'old-orphan.png')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
