#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['node_modules', 'data', 'dist', '.git', 'reports']);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
}

walk(root);
let failures = 0;
for (const file of files.sort()) {
  const relative = path.relative(root, file);
  let result;
  if (relative === 'vite.config.js') {
    result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: fs.readFileSync(file),
      encoding: 'utf8',
    });
  } else {
    result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  }
  if (result.status !== 0) {
    failures += 1;
    console.error(`FAIL ${relative}`);
    if (result.stderr) console.error(result.stderr.trim());
  }
}

if (failures) {
  console.error(`Syntax check failed: ${failures} file(s).`);
  process.exit(1);
}
console.log(`Syntax check passed: ${files.length} JavaScript file(s).`);
