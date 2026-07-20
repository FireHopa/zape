'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  createFixture,
  credentialsForTenants,
  buildEnv,
  freePort,
  startApplication,
  stopApplication,
  login,
  jsonRequest,
  makeTempRoot,
} = require('./helpers/phase15Harness');

test('Fase 16: release metadata, admin rollout endpoint and tenant feature gates', async () => {
  const root = makeTempRoot('zape-phase16-api-');
  createFixture(path.join(root, 'data'));
  const allCredentials = credentialsForTenants();
  const credentials = { admin: allCredentials.admin, panel: allCredentials.panel };
  const port = await freePort();
  const { env, baseUrl } = buildEnv(root, port, credentials, {
    RELEASE_ID: 'phase16-release-test',
    RELEASE_COMMIT: '0123456789abcdef',
    RELEASE_BUILT_AT: '2026-07-14T00:00:00.000Z',
    DEPLOYMENT_ENVIRONMENT: 'test',
    FEATURE_FRONTEND_V2: '1',
    FEATURE_FRONTEND_V2_TENANTS: 'admin,panel',
    FEATURE_LEAD_PAGINATION: '1',
    FEATURE_LEAD_PAGINATION_TENANTS: 'admin',
    FEATURE_CLOUD_API_V2: '0',
  });
  let app;
  try {
    app = await startApplication(env, baseUrl);
    const admin = await login(baseUrl, 'admin', credentials);
    const panel = await login(baseUrl, 'panel', credentials);

    const health = await jsonRequest(baseUrl, '/health');
    assert.equal(health.status, 200);
    assert.equal(health.payload.release.releaseId, 'phase16-release-test');
    assert.equal(health.payload.release.releaseCommit, '0123456789abcdef');

    const deployment = await jsonRequest(baseUrl, '/api/admin/deployment', { auth: admin });
    assert.equal(deployment.status, 200, deployment.text);
    assert.equal(deployment.payload.release.releaseId, 'phase16-release-test');
    assert.equal(deployment.payload.features.lead_pagination.admin.enabled, true);
    assert.equal(deployment.payload.features.lead_pagination.panel.enabled, false);

    const forbidden = await jsonRequest(baseUrl, '/api/admin/deployment', { auth: panel });
    assert.ok([401, 403].includes(forbidden.status));

    const adminLeads = await jsonRequest(baseUrl, '/api/admin/leads?pageSize=10', { auth: admin });
    assert.equal(adminLeads.status, 200, adminLeads.text);
    const panelLeads = await jsonRequest(baseUrl, '/api/panel/leads?pageSize=10', { auth: panel });
    assert.equal(panelLeads.status, 503, panelLeads.text);
    assert.equal(panelLeads.payload.code, 'FEATURE_DISABLED');

    const panelUi = await fetch(`${baseUrl}/panel`, { headers: { Cookie: panel.cookie } });
    assert.equal(panelUi.status, 200);

    const cloud = await jsonRequest(baseUrl, '/api/wa-cloud/templates', { auth: admin });
    assert.equal(cloud.status, 503, cloud.text);
    assert.equal(cloud.payload.code, 'FEATURE_DISABLED');

    const webhookVerification = await fetch(
      `${baseUrl}/webhooks/wa-cloud?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`
    );
    assert.equal(webhookVerification.status, 503);
  } finally {
    await stopApplication(app?.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
