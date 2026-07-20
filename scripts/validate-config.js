#!/usr/bin/env node
'use strict';

require('dotenv').config();

const strict = process.argv.includes('--strict');
const modeArg = process.argv.find((arg) => arg.startsWith('--mode='));
const mode = modeArg ? modeArg.split('=')[1] : process.env.NODE_ENV || 'development';
const errors = [];
const warnings = [];
const info = [];
const { parseKey } = require('../src/secretVault');
const { validateAuthConfiguration } = require('../src/authConfig');
const { validatePublicEndpointConfiguration } = require('../src/publicEndpointConfig');
const { validateRuntimeConfiguration } = require('../src/runtimeConfig');
const { validateDeploymentConfiguration } = require('../src/deploymentControl');
const { loadDatabaseConfig } = require('../src/database/config');

function present(name) {
  return String(process.env[name] || '').trim().length > 0;
}
function completeGroup(names, label, enabled) {
  const supplied = names.filter(present);
  if (enabled && supplied.length !== names.length) {
    errors.push(
      `${label}: configuração habilitada, mas faltam ${names.filter((n) => !present(n)).join(', ')}.`
    );
  } else if (supplied.length > 0 && supplied.length !== names.length) {
    warnings.push(
      `${label}: grupo parcialmente configurado; faltam ${names.filter((n) => !present(n)).join(', ')}.`
    );
  }
}

function positiveIntegerSetting(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!present(name)) return fallback;
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name} deve ser inteiro entre ${min} e ${max}.`);
    return fallback;
  }
  return value;
}

function enabled(name, defaultValue = false) {
  if (!present(name)) return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(process.env[name]).trim());
}

const auth = validateAuthConfiguration({ mode });
errors.push(...auth.errors);
warnings.push(...auth.warnings);
info.push(`Tenants habilitados: ${auth.enabledTenants.length ? auth.enabledTenants.join(', ') : 'nenhum'}.`);

const targetUidRaw = String(process.env.VALIDATE_RUNTIME_UID || '').trim();
const targetUid =
  targetUidRaw && /^\d+$/.test(targetUidRaw)
    ? Number(targetUidRaw)
    : mode === 'production'
      ? 1001
      : typeof process.getuid === 'function'
        ? process.getuid()
        : null;
const runtime = validateRuntimeConfiguration({ mode, uid: targetUid });
errors.push(...runtime.errors);
warnings.push(...runtime.warnings);
info.push(...runtime.info);

const deployment = validateDeploymentConfiguration({ ...process.env, NODE_ENV: mode });
errors.push(...deployment.errors);
warnings.push(...deployment.warnings);
info.push(`Release: ${deployment.release.releaseId}.`);

try {
  const database = loadDatabaseConfig({ ...process.env, NODE_ENV: mode });
  info.push(`Persistência: ${database.mode}${database.url ? ` (${database.dialect})` : ''}.`);
  if (mode === 'production' && database.mode === 'json')
    warnings.push('Produção ainda usa JSON como fonte principal. Planeje o cutover para PostgreSQL.');
  if (database.mode === 'shadow')
    warnings.push(`Modo shadow temporário ativo até ${process.env.PERSISTENCE_SHADOW_UNTIL}.`);
} catch (error) {
  errors.push(`Persistência relacional: ${error.message}`);
}

const publicEndpoints = validatePublicEndpointConfiguration({ mode });
errors.push(...publicEndpoints.errors);
warnings.push(...publicEndpoints.warnings);
info.push(...publicEndpoints.info);
info.push(`Formulário público: ${publicEndpoints.publicFormEnabled ? 'habilitado' : 'desabilitado'}.`);
info.push(
  `Webhook ActiveCampaign: ${publicEndpoints.activeCampaignEnabled ? 'habilitado' : 'desabilitado'}.`
);
info.push(
  `HMAC de webhooks customizados: ${publicEndpoints.customWebhookSignatureRequired ? 'obrigatório' : 'desativado'}.`
);

if (!present('CONFIG_ENCRYPTION_KEY')) {
  warnings.push(
    'CONFIG_ENCRYPTION_KEY ausente; não será possível persistir App Secret, token Cloud ou novos tokens de webhook.'
  );
} else {
  try {
    parseKey(process.env.CONFIG_ENCRYPTION_KEY);
  } catch (error) {
    errors.push(`CONFIG_ENCRYPTION_KEY inválida: ${error.message}`);
  }
}

if (mode === 'production' && !present('BACKUP_REMOTE_DIRECTORY')) {
  errors.push(
    'BACKUP_REMOTE_DIRECTORY é obrigatório em produção para manter cópia fora do servidor principal.'
  );
}
if (!present('BACKUP_ENCRYPTION_KEY') && !present('CONFIG_ENCRYPTION_KEY')) {
  errors.push('BACKUP_ENCRYPTION_KEY ou CONFIG_ENCRYPTION_KEY é obrigatória para backups criptografados.');
} else if (present('BACKUP_ENCRYPTION_KEY')) {
  try {
    parseKey(process.env.BACKUP_ENCRYPTION_KEY);
  } catch (error) {
    errors.push(`BACKUP_ENCRYPTION_KEY inválida: ${error.message}`);
  }
}
for (const name of [
  'RETENTION_LOGS_DAYS',
  'RETENTION_AUDIT_DAYS',
  'RETENTION_EXPORTS_DAYS',
  'RETENTION_BACKUPS_DAYS',
  'RETENTION_WEBHOOK_EVENTS_DAYS',
  'RETENTION_MESSAGE_STATUSES_DAYS',
  'RETENTION_CLOUD_EVENTS_DAYS',
  'RETENTION_MEDIA_DAYS',
  'RETENTION_JOBS_DAYS',
]) {
  if (present(name)) positiveIntegerSetting(name, 1, { min: 0, max: 3650 });
}
positiveIntegerSetting('MONITOR_INTERVAL_MS', 300000, { min: 10000, max: 86400000 });

if (enabled('ALLOW_LEGACY_PLAINTEXT_SECRETS', false)) {
  warnings.push(
    'ALLOW_LEGACY_PLAINTEXT_SECRETS está ativo. Use apenas durante migração controlada e desative em seguida.'
  );
}

if (mode === 'production' && !present('PUBLIC_BASE_URL') && !present('APP_BASE_URL')) {
  warnings.push(
    'PUBLIC_BASE_URL ausente em produção; URLs podem depender de cabeçalhos encaminhados pelo proxy.'
  );
}

const crmEnabled = enabled('CRM_INTEGRATION_ENABLED', true);
completeGroup(['CRM_INTEGRATION_URL', 'CRM_INTEGRATION_KEY'], 'CRM externo', crmEnabled);

const cloudEnabled = enabled('WA_CLOUD_ENABLED', false);
const primaryCloud = ['WA_CLOUD_TOKEN', 'WA_CLOUD_PHONE_NUMBER_ID', 'WA_CLOUD_WABA_ID'];
const aliasCloud = ['META_WA_ACCESS_TOKEN', 'META_WA_PHONE_NUMBER_ID', 'META_WA_WABA_ID'];
const primaryCount = primaryCloud.filter(present).length;
const aliasCount = aliasCloud.filter(present).length;
if (primaryCount && aliasCount)
  warnings.push('Cloud API: variáveis primárias e aliases META estão configurados simultaneamente.');
if (primaryCount) completeGroup(primaryCloud, 'Cloud API', cloudEnabled);
else completeGroup(aliasCloud, 'Cloud API via aliases META', cloudEnabled);

if (enabled('WEBJS_ENABLED', false) && enabled('WEBJS_AUTO_START', true)) {
  info.push(
    'WhatsApp Web está habilitado para inicialização automática. Use apenas dados e sessões de teste fora de produção.'
  );
}

if (!present('WA_CLOUD_WEBHOOK_VERIFY_TOKEN') && cloudEnabled) {
  warnings.push('WA_CLOUD_WEBHOOK_VERIFY_TOKEN ausente com Cloud API habilitada.');
}

positiveIntegerSetting('WA_CLOUD_QUEUE_POLL_MS', 250, { min: 50, max: 60000 });
positiveIntegerSetting('WA_CLOUD_QUEUE_MAX_ATTEMPTS', 5, { min: 1, max: 20 });
positiveIntegerSetting('WA_CLOUD_QUEUE_RETRY_BASE_MS', 1000, { min: 50, max: 3600000 });
positiveIntegerSetting('WA_CLOUD_QUEUE_RETRY_MAX_MS', 60000, { min: 50, max: 86400000 });
positiveIntegerSetting('WA_CLOUD_CAMPAIGN_MAX_CONTACTS', 10000, { min: 1, max: 100000 });

if (strict && warnings.some((warning) => /ausente|curta|legado|desabilitado/i.test(warning))) {
  warnings.push('Modo estrito ativo: revise os avisos antes do deploy.');
}

const result = {
  ok: errors.length === 0,
  mode,
  strict,
  errors,
  warnings,
  info,
};
console.log(JSON.stringify(result, null, 2));
process.exit(errors.length ? 1 : 0);
