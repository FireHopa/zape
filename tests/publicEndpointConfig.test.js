'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { validatePublicEndpointConfiguration } = require('../src/publicEndpointConfig');
const { customWebhookSignatureRequired } = require('../src/webhookSecurity');

test('produção exige tokens fortes para formulário e ActiveCampaign habilitados', () => {
  const result = validatePublicEndpointConfiguration({
    mode: 'production',
    env: {
      NODE_ENV: 'production',
      PUBLIC_LEAD_FORM_ENABLED: '1',
      PUBLIC_LEAD_FORM_TOKEN: 'curto',
      ACTIVECAMPAIGN_WEBHOOK_ENABLED: '1',
      ACTIVECAMPAIGN_WEBHOOK_TOKEN: 'curto',
      CUSTOM_WEBHOOK_REQUIRE_SIGNATURE: '1',
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /PUBLIC_LEAD_FORM_TOKEN/);
  assert.match(result.errors.join(' '), /ACTIVECAMPAIGN_WEBHOOK_TOKEN/);
});

test('HMAC customizado não pode ser desligado em produção', () => {
  assert.equal(customWebhookSignatureRequired({ nodeEnv: 'production', configured: '0' }), true);
  assert.equal(customWebhookSignatureRequired({ nodeEnv: 'development', configured: '0' }), false);
  const result = validatePublicEndpointConfiguration({
    mode: 'production',
    env: { NODE_ENV: 'production', CUSTOM_WEBHOOK_REQUIRE_SIGNATURE: '0' },
  });
  assert.equal(result.customWebhookSignatureRequired, true);
  assert.match(result.info.join(' '), /ignorado em produção/i);
});

test('token em query e confiança em proxy geram alertas explícitos', () => {
  const result = validatePublicEndpointConfiguration({
    mode: 'development',
    env: {
      NODE_ENV: 'development',
      ACTIVECAMPAIGN_WEBHOOK_ENABLED: '0',
      PUBLIC_LEAD_FORM_ENABLED: '0',
      ALLOW_WEBHOOK_TOKEN_IN_QUERY: '1',
      PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS: '1',
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.warnings.join(' '), /tokens na URL/i);
  assert.match(result.warnings.join(' '), /proxy confiável/i);
});
