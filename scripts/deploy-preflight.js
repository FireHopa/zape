#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyManifest, sha256File } = require('../src/releaseManager');
const { validateDeploymentConfiguration } = require('../src/deploymentControl');

function cleanTestBaseUrl(value) {
  const candidate = String(value || '').trim();
  return candidate || 'http://127.0.0.1:3000';
}

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseEnvFile(file) {
  const result = {};
  if (!file) return result;
  for (const line of fs.readFileSync(path.resolve(file), 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    result[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  return {
    command: [command, ...args].join(' '),
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').slice(-4000),
    stderr: String(result.stderr || '').slice(-4000),
  };
}

const root = path.resolve(__dirname, '..');
const envFile = arg('env');
const env = { ...process.env, ...parseEnvFile(envFile) };
const releaseDir = path.resolve(arg('release-dir', root));
const backupFile = arg('backup-file');
const restoreEvidenceFile = arg('restore-evidence');
const migrationEvidenceFile = arg('migration-evidence');
const executeChecks = process.argv.includes('--execute-checks');
const checks = [];
const errors = [];
const warnings = [];

try {
  const manifest = verifyManifest(releaseDir);
  checks.push({
    name: 'release_manifest',
    ok: manifest.ok,
    releaseId: manifest.manifest?.releaseId || '',
    errors: manifest.errors,
  });
  if (!manifest.ok) errors.push(...manifest.errors);
} catch (error) {
  checks.push({ name: 'release_manifest', ok: false, error: error.message });
  errors.push(error.message);
}

const deployment = validateDeploymentConfiguration(env);
checks.push({ name: 'deployment_configuration', ...deployment });
errors.push(...deployment.errors);
warnings.push(...deployment.warnings);

for (const required of ['SESSION_SECRET', 'CONFIG_ENCRYPTION_KEY', 'PUBLIC_BASE_URL', 'ZAPE_DATA_DIR']) {
  const ok = Boolean(String(env[required] || '').trim());
  checks.push({ name: `env_${required}`, ok });
  if (!ok) errors.push(`${required} ausente.`);
}

if (backupFile) {
  const absolute = path.resolve(backupFile);
  const ok = fs.existsSync(absolute) && fs.statSync(absolute).size > 0;
  checks.push({ name: 'backup_present', ok, file: absolute, sha256: ok ? sha256File(absolute) : null });
  if (!ok) errors.push('Backup obrigatório não encontrado.');
} else {
  warnings.push('Backup não informado no preflight.');
}

if (restoreEvidenceFile) {
  try {
    const evidence = readJson(restoreEvidenceFile);
    const ok = evidence.ok === true && Number(evidence.files || evidence.restoredFiles || 0) > 0;
    checks.push({ name: 'restore_validated', ok, files: evidence.files || evidence.restoredFiles || 0 });
    if (!ok) errors.push('Evidência de restore não comprova restauração válida.');
  } catch (error) {
    checks.push({ name: 'restore_validated', ok: false, error: error.message });
    errors.push('Evidência de restore inválida.');
  }
} else {
  warnings.push('Evidência de restore não informada.');
}

if (migrationEvidenceFile) {
  try {
    const evidence = readJson(migrationEvidenceFile);
    const ok = evidence.ok === true && evidence.rollbackPlanned !== false;
    checks.push({
      name: 'migration_plan',
      ok,
      mode: evidence.mode || '',
      forwardFix: Boolean(evidence.forwardFix),
    });
    if (!ok) errors.push('Plano de migration/forward fix inválido.');
  } catch (error) {
    checks.push({ name: 'migration_plan', ok: false, error: error.message });
    errors.push('Evidência de migration inválida.');
  }
}

if (executeChecks) {
  if (arg('confirm') !== 'RUN_PREDEPLOY_CHECKS')
    throw new Error('Execução exige --confirm=RUN_PREDEPLOY_CHECKS.');
  const checkEnv = {
    ...env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PUBLIC_BASE_URL: cleanTestBaseUrl(env.PREFLIGHT_TEST_BASE_URL),
    INFRA_ALLOW_ROOT_PROCESS: '1',
    PERSISTENCE_MODE: 'json',
    DATABASE_URL: '',
    WEBJS_ENABLED: '0',
    WEBJS_AUTO_START: '0',
    WA_CLOUD_ENABLED: '0',
    CRM_INTEGRATION_ENABLED: '0',
    PUBLIC_LEAD_FORM_ENABLED: '0',
    ACTIVECAMPAIGN_WEBHOOK_ENABLED: '0',
    DATA_INTEGRITY_VALIDATE_ON_BOOT: '0',
  };
  for (const [command, args] of [
    ['npm', ['run', 'check:syntax']],
    ['npm', ['run', 'quality']],
    ['npm', ['test', '--', '--test-force-exit']],
    ['npm', ['run', 'build:web']],
    ['npm', ['run', 'security:scan']],
    ['npm', ['run', 'audit:permissions']],
  ]) {
    const result = run(command, args, releaseDir, checkEnv);
    checks.push({ name: `command_${args.join('_')}`, ...result });
    if (!result.ok) errors.push(`Falha: ${result.command}`);
  }
}

const output = {
  ok: errors.length === 0,
  mode: executeChecks ? 'executed' : 'inspection',
  checkEnvironment: executeChecks ? 'isolated_test' : null,
  generatedAt: new Date().toISOString(),
  releaseDir,
  envFile: envFile ? path.resolve(envFile) : null,
  checks,
  warnings,
  errors,
};
console.log(JSON.stringify(output, null, 2));
process.exitCode = output.ok ? 0 : 1;
