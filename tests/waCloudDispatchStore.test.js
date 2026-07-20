'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

function freshStore(dataDir) {
  process.env.ZAPE_DATA_DIR = dataDir;
  delete require.cache[require.resolve('../src/waCloudDispatchStore')];
  return require('../src/waCloudDispatchStore');
}

test('status progride sem regressão e mantém histórico de transições', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-cloud-state-'));
  const store = freshStore(dir);
  const event = store.recordEvent({
    tenantId: 'panel', connectionId: 'conn_a', phoneNumberId: '100', wabaId: '200',
    recipientId: '5511999999999', status: 'queued',
  });
  store.updateEvent(event.id, { status: 'submitted', messageId: 'wamid.1' }, { source: 'meta_api' });
  store.updateByMessageId('wamid.1', { status: 'delivered', deliveryState: 'delivered' }, { connectionId: 'conn_a', recipientId: '5511999999999', source: 'meta_webhook' });
  store.updateByMessageId('wamid.1', { status: 'sent', deliveryState: 'sent' }, { connectionId: 'conn_a', recipientId: '5511999999999', source: 'meta_webhook' });
  store.updateByMessageId('wamid.1', { status: 'read', deliveryState: 'read' }, { connectionId: 'conn_a', recipientId: '5511999999999', source: 'meta_webhook' });
  store.updateByMessageId('wamid.1', { status: 'failed', deliveryState: 'failed', error: { code: 999 } }, { connectionId: 'conn_a', recipientId: '5511999999999', source: 'meta_webhook' });

  const updated = store.findByMessageId({ connectionId: 'conn_a', messageId: 'wamid.1' });
  assert.equal(updated.status, 'read');
  assert.equal(updated.deliveryState, 'read');
  assert.equal(updated.error, null);
  assert.deepEqual(updated.statusHistory.map((row) => row.state), ['queued', 'submitted', 'delivered', 'read']);
});

test('Meta message ID é único por conexão e eventos ficam isolados por tenant', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-cloud-index-'));
  const store = freshStore(dir);
  const panel = store.recordEvent({ tenantId: 'panel', connectionId: 'conn_a', recipientId: '5511', status: 'queued' });
  const admin = store.recordEvent({ tenantId: 'admin', connectionId: 'conn_b', recipientId: '5511', status: 'queued' });
  store.updateEvent(panel.id, { status: 'submitted', messageId: 'wamid.same' });
  store.updateEvent(admin.id, { status: 'submitted', messageId: 'wamid.same' });
  assert.equal(store.listEvents('panel').length, 1);
  assert.equal(store.listEvents('admin').length, 1);

  const duplicate = store.recordEvent({ tenantId: 'panel', connectionId: 'conn_a', recipientId: '5522', status: 'queued' });
  assert.throws(() => store.updateEvent(duplicate.id, { messageId: 'wamid.same' }), (error) => error.code === 'META_MESSAGE_ID_CONFLICT');
});

test('resposta usa context.id exato e nunca telefone mais janela de tempo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-cloud-reply-'));
  const store = freshStore(dir);
  const first = store.recordEvent({ tenantId: 'panel', connectionId: 'conn_a', campaignId: 'camp_1', recipientId: '5511999999999', status: 'queued' });
  const second = store.recordEvent({ tenantId: 'admin', connectionId: 'conn_a', campaignId: 'camp_2', recipientId: '5511999999999', status: 'queued' });
  store.updateEvent(first.id, { status: 'submitted', messageId: 'wamid.panel' });
  store.updateEvent(second.id, { status: 'submitted', messageId: 'wamid.admin' });

  const exact = store.correlateInbound({
    connectionId: 'conn_a', phoneNumberId: '100', wabaId: '200', recipientId: '5511999999999',
    messageId: 'wamid.in.1', contextMessageId: 'wamid.panel', inbound: { id: 'wamid.in.1', type: 'text' },
  });
  assert.equal(exact.matched, true);
  assert.equal(exact.event.tenantId, 'panel');
  assert.equal(exact.event.campaignId, 'camp_1');
  assert.equal(exact.event.status, 'replied');

  const withoutContext = store.correlateInbound({
    connectionId: 'conn_a', phoneNumberId: '100', wabaId: '200', recipientId: '5511999999999',
    messageId: 'wamid.in.2', contextMessageId: '', inbound: { id: 'wamid.in.2', type: 'text' },
  });
  assert.equal(withoutContext.matched, false);
  assert.equal(store.findByMessageId({ connectionId: 'conn_a', messageId: 'wamid.admin' }).status, 'submitted');
});

test('status com recipient diferente não altera o disparo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-cloud-recipient-'));
  const store = freshStore(dir);
  const event = store.recordEvent({ tenantId: 'panel', connectionId: 'conn_a', recipientId: '5511', status: 'queued' });
  store.updateEvent(event.id, { status: 'submitted', messageId: 'wamid.1' });
  const result = store.updateByMessageId('wamid.1', { status: 'delivered', deliveryState: 'delivered' }, { connectionId: 'conn_a', recipientId: '5522' });
  assert.equal(result, null);
  assert.equal(store.findByMessageId({ connectionId: 'conn_a', messageId: 'wamid.1' }).status, 'submitted');
});
