#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ignored = new Set(['node_modules', '.git', 'dist', 'data', 'reports', 'backups', 'exports']);

function walk(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, output);
    else if (!['package.json', 'package-lock.json', 'SANITIZED_EXPORT_MANIFEST.json'].includes(entry.name)) output.push(absolute);
  }
  return output;
}

const files = walk(root);
const contents = files.map((absolute) => {
  let source = '';
  try {
    source = fs.readFileSync(absolute, 'utf8');
  } catch (_) {}
  return { path: path.relative(root, absolute).replaceAll(path.sep, '/'), source };
});

const customPatterns = {
  '@phosphor-icons/web': [/node_modules["',\s]+["']@phosphor-icons["'],[\s]+["']web/, /vendor\/phosphor/],
  dompurify: [/node_modules["',\s]+["']dompurify/, /vendor\/dompurify/],
  nodemon: [/"dev"\s*:\s*"nodemon /],
  vite: [/vite\.config\.js/, /vite (?:build|preview|--config)/],
  eslint: [/eslint\.config\.cjs/, /"lint"\s*:\s*"eslint /],
  prettier: [/\.prettierrc\.json/, /"format:check"\s*:\s*"prettier /],
  typescript: [/tsconfig\.phase14\.json/, /"typecheck"\s*:\s*"tsc /],
  '@types/express': [/import\(['"]express['"]\)/],
  '@types/node': [/"types"\s*:\s*\["node"\]/],
};

function patternsFor(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`require\\(["']${escaped}["']\\)`),
    new RegExp(`from\\s+["']${escaped}["']`),
    ...(customPatterns[name] || []),
  ];
}

function evidenceFor(name) {
  const patterns = patternsFor(name);
  const evidence = contents
    .filter((item) => patterns.some((pattern) => pattern.test(item.source)))
    .map((item) => item.path);
  const configEvidence = {
    eslint: ['eslint.config.cjs'],
    prettier: ['.prettierrc.json'],
    typescript: ['tsconfig.phase14.json'],
    vite: ['vite.config.js'],
  };
  for (const candidate of configEvidence[name] || []) {
    if (fs.existsSync(path.join(root, candidate))) evidence.push(candidate);
  }
  const scriptsText = JSON.stringify(packageJson.scripts || {});
  if (name === 'nodemon' && /nodemon/.test(scriptsText)) evidence.push('package.json#scripts.dev');
  if (name === 'eslint' && /eslint/.test(scriptsText)) evidence.push('package.json#scripts.lint');
  if (name === 'prettier' && /prettier/.test(scriptsText)) evidence.push('package.json#scripts.format:check');
  if (name === 'typescript' && /tsc /.test(scriptsText)) evidence.push('package.json#scripts.typecheck');
  return [...new Set(evidence)].slice(0, 20);
}

const sections = [
  ['dependencies', packageJson.dependencies || {}],
  ['devDependencies', packageJson.devDependencies || {}],
];
const report = { generatedAt: new Date().toISOString(), scannedFiles: files.length, sections: {}, unused: [] };
for (const [section, dependencies] of sections) {
  report.sections[section] = {};
  for (const name of Object.keys(dependencies).sort()) {
    const evidence = evidenceFor(name);
    report.sections[section][name] = { version: dependencies[name], evidence };
    if (evidence.length === 0) report.unused.push({ section, name });
  }
}
report.ok = report.unused.length === 0;
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
