#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(root, arg('data', 'data'));
const output = path.resolve(root, arg('output', 'reports/private/data-checksums.redacted.json'));
const rows = walk(dataDir).sort().map((file) => {
  const relative = path.relative(dataDir, file).replace(/\\/g, '/');
  const content = fs.readFileSync(file);
  return {
    pathHash: sha256(relative),
    contentSha256: sha256(content),
    bytes: content.length,
  };
});
const aggregate = sha256(rows.map((r) => `${r.pathHash}:${r.contentSha256}:${r.bytes}`).join('\n'));
const manifest = {
  version: 1,
  createdAt: new Date().toISOString(),
  dataDirectory: path.basename(dataDir),
  fileCount: rows.length,
  totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
  aggregateSha256: aggregate,
  files: rows,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ output, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, aggregateSha256: aggregate }, null, 2));
