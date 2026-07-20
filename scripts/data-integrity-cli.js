'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('../src/dataIntegrity');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const raw = token.slice(2);
    const index = raw.indexOf('=');
    if (index < 0) args[raw] = true;
    else args[raw.slice(0, index)] = raw.slice(index + 1);
  }
  return args;
}

function resolveDataDir(args) {
  const value = String(args['data-dir'] || process.env.ZAPE_DATA_DIR || '').trim();
  if (!value) throw new Error('Informe --data-dir=<diretorio> ou ZAPE_DATA_DIR.');
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('Diretório de dados inexistente.');
  return resolved;
}

function resolveOutputPath(args, defaultName) {
  const explicit = String(args.output || '').trim();
  if (explicit) return path.resolve(explicit);
  const outputDir = path.resolve(String(args['output-dir'] || path.join(process.cwd(), 'reports', 'data-integrity')));
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  return path.join(outputDir, defaultName);
}

function writeReport(outputPath, report) {
  atomicWriteJson(outputPath, report);
  process.stdout.write(`${JSON.stringify({ ok: true, output: outputPath, summary: report.summary || null }, null, 2)}\n`);
}

module.exports = { parseArgs, resolveDataDir, resolveOutputPath, writeReport };
