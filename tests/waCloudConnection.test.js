'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildConnectionId,
  connectionFromRuntimeConfig,
  assertWebhookMatchesConnection,
} = require('../src/waCloudConnection');

test('connectionId é estável e depende de Phone Number ID e WABA ID', () => {
  const first = buildConnectionId({ phoneNumberId: '100', wabaId: '200' });
  assert.match(first, /^conn_[a-f0-9]{24}$/);
  assert.equal(first, buildConnectionId({ phoneNumberId: '100', wabaId: '200' }));
  assert.notEqual(first, buildConnectionId({ phoneNumberId: '101', wabaId: '200' }));
});

test('webhook é aceito somente quando metadata e WABA pertencem à conexão configurada', () => {
  const config = { phoneNumberId: '100', wabaId: '200', graphVersion: 'v25.0' };
  const body = {
    entry: [{ id: '200', changes: [{ value: { metadata: { phone_number_id: '100' }, statuses: [] } }] }],
  };
  const connection = assertWebhookMatchesConnection(body, config);
  assert.equal(connection.phoneNumberId, '100');
  assert.equal(connection.wabaId, '200');
  assert.equal(connection.connectionId, connectionFromRuntimeConfig(config).connectionId);

  assert.throws(
    () => assertWebhookMatchesConnection({ entry: [{ id: '200', changes: [{ value: { metadata: { phone_number_id: '999' } } }] }] }, config),
    (error) => error.code === 'META_PHONE_NUMBER_MISMATCH',
  );
  assert.throws(
    () => assertWebhookMatchesConnection({ entry: [{ id: '999', changes: [{ value: { metadata: { phone_number_id: '100' } } }] }] }, config),
    (error) => error.code === 'META_WABA_MISMATCH',
  );
});

test('tenant proprietário da conexão aceita somente valores conhecidos', () => {
  const old = process.env.WA_CLOUD_CONNECTION_OWNER_TENANT;
  process.env.WA_CLOUD_CONNECTION_OWNER_TENANT = 'tenant-inexistente';
  try {
    assert.throws(() => connectionFromRuntimeConfig({ phoneNumberId: '100', wabaId: '200' }), (error) => error.code === 'WA_CLOUD_CONNECTION_OWNER_INVALID');
  } finally {
    if (old === undefined) delete process.env.WA_CLOUD_CONNECTION_OWNER_TENANT;
    else process.env.WA_CLOUD_CONNECTION_OWNER_TENANT = old;
  }
});
