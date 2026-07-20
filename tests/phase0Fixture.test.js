'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

test('gera fixture sintética isolada sem mídia real', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-fixture-'));
  const output = path.join(root, 'data');
  const script = path.resolve(__dirname, '..', 'scripts', 'create-sanitized-fixture.js');
  const result = spawnSync(process.execPath, [script, `--output=${output}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, '_fixture_manifest.json'), 'utf8'));
  assert.equal(manifest.synthetic, true);
  assert.equal(manifest.containsRealData, false);
  assert.equal(manifest.containsMedia, false);
  assert.deepEqual(manifest.tenants, ['admin', 'panel', 'regina', 'portugal', 'felipe', 'ana']);
  const mediaFiles = manifest.tenants.flatMap((tenant) => {
    const dir = path.join(output, tenant, 'conversation_media');
    return fs.readdirSync(dir);
  });
  assert.equal(mediaFiles.length, 0);
  const allText = fs.readdirSync(output, { recursive: true })
    .filter((entry) => fs.statSync(path.join(output, entry)).isFile())
    .map((entry) => fs.readFileSync(path.join(output, entry), 'utf8'))
    .join('\n');
  assert.match(allText, /example\.invalid/);
  assert.doesNotMatch(allText, /@gmail\.com|@hotmail\.com|@outlook\.com/i);
  fs.rmSync(root, { recursive: true, force: true });
});
