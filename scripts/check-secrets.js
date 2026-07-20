#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'data', 'dist', 'build', 'logs', 'backups', 'exports', 'tmp', 'temp', 'chrome', 'wwebjs_auth', 'wwebjs_cache', 'reports']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.rar', '.7z', '.mp3', '.mp4', '.wav', '.ogg', '.webm']);
const PLACEHOLDER = /(example\.invalid|example\.com|exemplo\.com|replace-with|fake[-_]|test[-_]|synthetic|dummy|changeme|000000000000000|your[-_]|seu[_-]?token)/i;
const PATTERNS = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['meta_access_token', /\bEAA[A-Za-z0-9]{20,}\b/g],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['slack_token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['sensitive_assignment', /\b(?:api[_-]?key|app[_-]?secret|client[_-]?secret|access[_-]?token|verify[_-]?token|session[_-]?secret|password|passwd)\b\s*[:=]\s*["']([^"'\r\n]{8,})["']/gi],
];

function parseArgs() {
  const args = process.argv.slice(2);
  return { staged: args.includes('--staged'), target: args.includes('--path') ? args[args.indexOf('--path') + 1] : ROOT };
}

function stagedFiles() {
  try {
    return childProcess.execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: ROOT, encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean).map((file) => path.join(ROOT, file));
  } catch { return []; }
}

function walk(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const out = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function main() {
  const args = parseArgs();
  const files = (args.staged ? stagedFiles() : walk(path.resolve(args.target))).filter((file) => fs.existsSync(file));
  const findings = [];
  for (const file of files) {
    if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    if (path.basename(file) === '.env.example') continue;
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (const [type, regex] of PATTERNS) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text))) {
        const value = match[1] || match[0];
        if (PLACEHOLDER.test(value) || /process\.env/.test(match[0])) continue;
        const line = text.slice(0, match.index).split(/\r?\n/).length;
        findings.push({ file: path.relative(ROOT, file), line, type, fingerprint: fingerprint(value) });
        if (match.index === regex.lastIndex) regex.lastIndex++;
      }
    }
  }
  const result = { ok: findings.length === 0, scannedFiles: files.length, findings };
  console.log(JSON.stringify(result, null, 2));
  if (findings.length) process.exitCode = 1;
}

try { main(); } catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
}
