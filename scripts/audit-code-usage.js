'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ignoredDirectories = new Set(['node_modules', '.git', 'dist', 'data', 'reports', 'backups', 'exports']);
const legacyCandidates = [
  'src/leadsStore.js',
  'src/tagsStore.js',
  'src/leadTagsStore.js',
  'src/messageStatusStore.js',
  'src/whatsapp.js',
  'public/admin.html',
  'public/panel.html',
  'public/regina.html',
  'public/index.html',
];

function walk(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, output);
    else output.push(absolute);
  }
  return output;
}

function normalizedRelative(absolute) {
  return path.relative(root, absolute).replaceAll(path.sep, '/');
}

function codeFiles() {
  return walk(root).filter((absolute) => /\.(?:js|cjs|mjs|html)$/.test(absolute));
}

function findReferences(candidate, files) {
  const relativeWithoutExtension = candidate.replace(/\.js$/, '');
  const basename = path.posix.basename(relativeWithoutExtension);
  const references = [];
  for (const absolute of files) {
    const relative = normalizedRelative(absolute);
    if (relative === candidate) continue;
    let source;
    try {
      source = fs.readFileSync(absolute, 'utf8');
    } catch (_) {
      continue;
    }
    if (candidate.endsWith('.js')) {
      const requirePattern = new RegExp(
        String.raw`(?:require\(|from\s+)["'][^"']*${basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.js)?["']`
      );
      if (requirePattern.test(source)) references.push(relative);
    } else if (source.includes(path.posix.basename(candidate))) {
      references.push(relative);
    }
  }
  return references.sort();
}

function main() {
  const files = codeFiles();
  const items = legacyCandidates.map((candidate) => {
    const exists = fs.existsSync(path.join(root, candidate));
    return {
      path: candidate,
      exists,
      references: exists ? findReferences(candidate, files) : [],
    };
  });
  const report = {
    generatedAt: new Date().toISOString(),
    scannedFiles: files.length,
    candidates: items,
    removable: items.filter((item) => item.exists && item.references.length === 0).map((item) => item.path),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
