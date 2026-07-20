'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FEATURES,
  resolveFeature,
  validateDeploymentConfiguration,
  featureSnapshot,
  requireFeature,
} = require('../src/deploymentControl');

test('feature flag is enabled by default and can be disabled globally', () => {
  assert.equal(resolveFeature(FEATURES.FRONTEND_V2, 'panel', {}).enabled, true);
  const disabled = resolveFeature(FEATURES.FRONTEND_V2, 'panel', { FEATURE_FRONTEND_V2: '0' });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.reason, 'global_disabled');
});

test('feature flag can target one tenant without trusting request input', () => {
  const env = { FEATURE_LEAD_PAGINATION: '1', FEATURE_LEAD_PAGINATION_TENANTS: 'admin,panel' };
  assert.equal(resolveFeature(FEATURES.LEAD_PAGINATION, 'panel', env).enabled, true);
  assert.equal(resolveFeature(FEATURES.LEAD_PAGINATION, 'regina', env).enabled, false);
});

test('rollout percentage is deterministic for a release seed', () => {
  const env = { FEATURE_SECURE_MEDIA_ROLLOUT_PERCENT: '50', DEPLOYMENT_ROLLOUT_SEED: 'release-a' };
  const first = resolveFeature(FEATURES.SECURE_MEDIA, 'portugal', env);
  const second = resolveFeature(FEATURES.SECURE_MEDIA, 'portugal', env);
  assert.deepEqual(first, second);
});

test('deployment configuration rejects invalid tenants and percentages', () => {
  const result = validateDeploymentConfiguration({
    FEATURE_CLOUD_QUEUE_ROLLOUT_PERCENT: '101',
    FEATURE_CLOUD_QUEUE_TENANTS: 'admin,unknown',
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /inteiro entre 0 e 100/);
  assert.match(result.errors.join(' '), /tenant inválido/);
});

test('secure authentication cannot be rolled back to legacy behavior in production', () => {
  const result = validateDeploymentConfiguration({
    NODE_ENV: 'production',
    FEATURE_AUTH_V2: '0',
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /não existe fallback seguro/);
});

test('database feature cannot be disabled while database persistence is active', () => {
  const result = validateDeploymentConfiguration({
    PERSISTENCE_MODE: 'database',
    FEATURE_DATABASE_PERSISTENCE: '0',
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /PERSISTENCE_MODE/);
});

test('feature middleware returns 503 with a stable error contract', () => {
  const previous = process.env.FEATURE_FRONTEND_V2;
  process.env.FEATURE_FRONTEND_V2 = '0';
  try {
    const middleware = requireFeature(FEATURES.FRONTEND_V2);
    const req = { auth: { tenantId: 'panel' } };
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    middleware(req, response, () => assert.fail('next must not be called'));
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'FEATURE_DISABLED');
  } finally {
    if (previous === undefined) delete process.env.FEATURE_FRONTEND_V2;
    else process.env.FEATURE_FRONTEND_V2 = previous;
  }
});

test('feature snapshot includes all tenants and rollout reasons', () => {
  const snapshot = featureSnapshot(['admin', 'panel'], { FEATURE_CLOUD_API_V2_TENANTS: 'admin' });
  assert.equal(snapshot.cloud_api_v2.admin.enabled, true);
  assert.equal(snapshot.cloud_api_v2.panel.reason, 'tenant_not_selected');
});
