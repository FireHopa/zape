#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DENY_DIRS = new Set(['.git', 'node_modules', 'data', 'dist', 'build', 'logs', 'backups', 'exports', 'tmp', 'temp', 'chrome', 'wwebjs_auth', 'wwebjs_cache', 'reports', 'coverage']);
const DENY_NAMES = new Set(['.env', '.npmrc', 'wa_cloud_config.json', 'webhooks.json']);
const DENY_EXT = new Set(['.log', '.zip', '.rar', '.7z', '.gz', '.pem', '.key', '.p12', '.sqlite', '.db']);

function copyTree(source, target, manifest) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && DENY_DIRS.has(entry.name)) continue;
    if (DENY_NAMES.has(entry.name) || (entry.name.startsWith('.env') && entry.name !== '.env.example')) continue;
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyTree(src, dst, manifest);
      continue;
    }
    if (DENY_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    const data = fs.readFileSync(dst);
    manifest.files.push({ path: path.relative(target, dst), bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
  }
}

function main() {
  const outputArg = process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : '';
  const zipRequested = process.argv.includes('--zip');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.resolve(outputArg || path.join(ROOT, 'exports', `zape-sanitized-${stamp}`));
  if (output === ROOT || ROOT.startsWith(`${output}${path.sep}`)) throw new Error('Diretório de saída inválido.');
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const manifest = { createdAt: new Date().toISOString(), source: 'sanitized-project-export', exclusions: [...DENY_DIRS], files: [] };
  copyTree(ROOT, output, manifest);
  manifest.files.sort((a, b) => a.path.localeCompare(b.path));
  fs.writeFileSync(path.join(output, 'SANITIZED_EXPORT_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  childProcess.execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-secrets.js'), '--path', output], { cwd: ROOT, stdio: 'inherit' });
  let zipFile = '';
  if (zipRequested) {
    zipFile = `${output}.zip`;
    fs.rmSync(zipFile, { force: true });
    childProcess.execFileSync('zip', ['-qr', zipFile, path.basename(output)], { cwd: path.dirname(output) });
  }
  console.log(JSON.stringify({ ok: true, output, zipFile: zipFile || null, files: manifest.files.length }, null, 2));
}

try { main(); } catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
}
