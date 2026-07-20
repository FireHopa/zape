'use strict';

const crypto = require('node:crypto');

const FEATURES = Object.freeze({
  AUTH_V2: 'auth_v2',
  DATABASE_PERSISTENCE: 'database_persistence',
  CLOUD_QUEUE: 'cloud_queue',
  SECURE_MEDIA: 'secure_media',
  CLOUD_API_V2: 'cloud_api_v2',
  LEAD_PAGINATION: 'lead_pagination',
  FRONTEND_V2: 'frontend_v2',
});

const FEATURE_ENV = Object.freeze({
  [FEATURES.AUTH_V2]: 'FEATURE_AUTH_V2',
  [FEATURES.DATABASE_PERSISTENCE]: 'FEATURE_DATABASE_PERSISTENCE',
  [FEATURES.CLOUD_QUEUE]: 'FEATURE_CLOUD_QUEUE',
  [FEATURES.SECURE_MEDIA]: 'FEATURE_SECURE_MEDIA',
  [FEATURES.CLOUD_API_V2]: 'FEATURE_CLOUD_API_V2',
  [FEATURES.LEAD_PAGINATION]: 'FEATURE_LEAD_PAGINATION',
  [FEATURES.FRONTEND_V2]: 'FEATURE_FRONTEND_V2',
});

const ALLOWED_TENANTS = Object.freeze(['admin', 'panel', 'regina', 'portugal', 'felipe', 'ana']);

function clean(value) {
  return String(value ?? '').trim();
}

function envBool(value, fallback = true) {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePercent(value, fallback = 100) {
  const raw = clean(value);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 0 || number > 100) return null;
  return number;
}

function parseTenants(value) {
  const values = clean(value)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(values));
}

function featureEnvName(feature) {
  const name = FEATURE_ENV[feature];
  if (!name) throw new Error(`Feature desconhecida: ${feature}`);
  return name;
}

function tenantBucket(feature, tenantId, seed = '') {
  const digest = crypto
    .createHash('sha256')
    .update(`${clean(seed)}:${feature}:${clean(tenantId).toLowerCase()}`)
    .digest();
  return digest.readUInt32BE(0) % 100;
}

function resolveFeature(feature, tenantId, env = process.env) {
  const baseName = featureEnvName(feature);
  const tenant = clean(tenantId).toLowerCase();
  const globallyEnabled = envBool(env[baseName], true);
  const tenants = parseTenants(env[`${baseName}_TENANTS`]);
  const percent = parsePercent(env[`${baseName}_ROLLOUT_PERCENT`], 100);
  const seed = clean(env.DEPLOYMENT_ROLLOUT_SEED || env.RELEASE_ID || 'zape');

  if (!globallyEnabled) {
    return {
      feature,
      tenantId: tenant,
      enabled: false,
      reason: 'global_disabled',
      percent: percent ?? 0,
      tenants,
    };
  }
  if (tenant && tenants.length && !tenants.includes(tenant)) {
    return {
      feature,
      tenantId: tenant,
      enabled: false,
      reason: 'tenant_not_selected',
      percent: percent ?? 100,
      tenants,
    };
  }
  if (tenant && percent !== null && percent < 100 && tenantBucket(feature, tenant, seed) >= percent) {
    return {
      feature,
      tenantId: tenant,
      enabled: false,
      reason: 'outside_rollout_percentage',
      percent,
      tenants,
    };
  }
  return { feature, tenantId: tenant, enabled: true, reason: 'enabled', percent: percent ?? 100, tenants };
}

/**
 * @param {string} feature
 * @param {{ tenantResolver?: (req: any) => string }=} options
 */
function requireFeature(feature, options = {}) {
  const { tenantResolver } = options;
  return function deploymentFeatureMiddleware(req, res, next) {
    const tenantId = tenantResolver
      ? tenantResolver(req)
      : req?.auth?.tenantId || req?.params?.tenantId || '';
    const state = resolveFeature(feature, tenantId);
    req.featureFlags = req.featureFlags || {};
    req.featureFlags[feature] = state;
    if (!state.enabled) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json({
        ok: false,
        code: 'FEATURE_DISABLED',
        feature,
        error: 'Recurso temporariamente indisponível durante o rollout controlado.',
      });
    }
    return next();
  };
}

function releaseMetadata(env = process.env) {
  return {
    releaseId: clean(env.RELEASE_ID || 'development'),
    releaseCommit: clean(env.RELEASE_COMMIT || ''),
    releaseBuiltAt: clean(env.RELEASE_BUILT_AT || ''),
    environment: clean(env.DEPLOYMENT_ENVIRONMENT || env.NODE_ENV || 'development'),
    rolloutSeedHash: crypto
      .createHash('sha256')
      .update(clean(env.DEPLOYMENT_ROLLOUT_SEED || env.RELEASE_ID || 'zape'))
      .digest('hex')
      .slice(0, 16),
  };
}

function featureSnapshot(tenants = ALLOWED_TENANTS, env = process.env) {
  return Object.fromEntries(
    Object.values(FEATURES).map((feature) => [
      feature,
      Object.fromEntries(tenants.map((tenantId) => [tenantId, resolveFeature(feature, tenantId, env)])),
    ])
  );
}

function validateDeploymentConfiguration(env = process.env) {
  const errors = [];
  const warnings = [];
  for (const feature of Object.values(FEATURES)) {
    const baseName = featureEnvName(feature);
    const percent = parsePercent(env[`${baseName}_ROLLOUT_PERCENT`], 100);
    if (percent === null) errors.push(`${baseName}_ROLLOUT_PERCENT deve ser um inteiro entre 0 e 100.`);
    for (const tenant of parseTenants(env[`${baseName}_TENANTS`])) {
      if (!ALLOWED_TENANTS.includes(tenant))
        errors.push(`${baseName}_TENANTS contém tenant inválido: ${tenant}.`);
    }
  }
  const production = clean(env.NODE_ENV).toLowerCase() === 'production';
  const authFeature = envBool(env.FEATURE_AUTH_V2, true);
  if (production && !authFeature) {
    errors.push(
      'FEATURE_AUTH_V2 não pode ser desativada em produção porque não existe fallback seguro para a autenticação legada.'
    );
  }
  const persistenceMode = clean(env.PERSISTENCE_MODE || 'json').toLowerCase();
  const databaseFeature = envBool(env.FEATURE_DATABASE_PERSISTENCE, true);
  if (persistenceMode !== 'json' && !databaseFeature) {
    errors.push('FEATURE_DATABASE_PERSISTENCE não pode estar desativada quando PERSISTENCE_MODE não é json.');
  }
  if (production && !clean(env.RELEASE_ID)) {
    warnings.push('RELEASE_ID não definido; a identificação operacional do deploy ficará incompleta.');
  }
  return { ok: errors.length === 0, errors, warnings, release: releaseMetadata(env) };
}

function assertDeploymentConfiguration(env = process.env) {
  const result = validateDeploymentConfiguration(env);
  if (!result.ok) {
    throw Object.assign(new Error(result.errors.join(' ')), {
      code: 'DEPLOYMENT_CONFIGURATION_INVALID',
      details: result,
    });
  }
  return result;
}

module.exports = {
  FEATURES,
  FEATURE_ENV,
  ALLOWED_TENANTS,
  envBool,
  parsePercent,
  parseTenants,
  tenantBucket,
  resolveFeature,
  requireFeature,
  releaseMetadata,
  featureSnapshot,
  validateDeploymentConfiguration,
  assertDeploymentConfiguration,
};
