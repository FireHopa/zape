'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createWebhookEventStore } = require('../src/webhookEventStore');

test('evento repetido retorna o mesmo resultado sem executar novamente', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-webhook-events-'));
  try {
    const file = path.join(root, 'events.json');
    const store = createWebhookEventStore({ file, retentionMs: 60_000 });
    const first = store.claim({ integration: 'custom:webhook-1', tenantId: 'panel', eventId: 'event-1', requestHash: 'a'.repeat(64) });
    assert.equal(first.claimed, true);
    assert.equal(store.complete({ integration: 'custom:webhook-1', tenantId: 'panel', eventId: 'event-1', statusCode: 200, responseBody: { ok: true, leadId: 'lead-1' } }), true);

    const duplicate = store.claim({ integration: 'custom:webhook-1', tenantId: 'panel', eventId: 'event-1', requestHash: 'a'.repeat(64) });
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.pending, false);
    assert.deepEqual(duplicate.responseBody, { ok: true, leadId: 'lead-1' });

    const persisted = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(persisted, /event-1|panel/);
    assert.match(persisted, /"state": "completed"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('idempotência é isolada por tenant e integração', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-webhook-events-'));
  try {
    const store = createWebhookEventStore({ file: path.join(root, 'events.json') });
    assert.equal(store.claim({ integration: 'custom:a', tenantId: 'panel', eventId: 'same' }).claimed, true);
    assert.equal(store.claim({ integration: 'custom:a', tenantId: 'admin', eventId: 'same' }).claimed, true);
    assert.equal(store.claim({ integration: 'custom:b', tenantId: 'panel', eventId: 'same' }).claimed, true);
    assert.equal(store.inspect().length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evento pendente expirado pode ser reivindicado novamente', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-webhook-events-'));
  let now = 10_000;
  try {
    const store = createWebhookEventStore({
      file: path.join(root, 'events.json'),
      pendingTimeoutMs: 1_000,
      retentionMs: 60_000,
      now: () => now,
    });
    assert.equal(store.claim({ integration: 'meta:1', tenantId: '1', eventId: 'evt' }).claimed, true);
    assert.equal(store.claim({ integration: 'meta:1', tenantId: '1', eventId: 'evt' }).pending, true);
    now = 11_001;
    assert.equal(store.claim({ integration: 'meta:1', tenantId: '1', eventId: 'evt' }).claimed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('mesma chave com outro payload retorna conflito sem sobrescrever resultado', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-webhook-events-'));
  try {
    const store = createWebhookEventStore({ file: path.join(root, 'events.json') });
    assert.equal(store.claim({ integration: 'custom:a', tenantId: 'panel', eventId: 'evt', requestHash: 'a'.repeat(64) }).claimed, true);
    store.complete({ integration: 'custom:a', tenantId: 'panel', eventId: 'evt', responseBody: { ok: true } });
    const conflict = store.claim({ integration: 'custom:a', tenantId: 'panel', eventId: 'evt', requestHash: 'b'.repeat(64) });
    assert.equal(conflict.claimed, false);
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.duplicate, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('arquivo de idempotência corrompido falha fechado', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zape-webhook-events-'));
  try {
    const file = path.join(root, 'events.json');
    fs.writeFileSync(file, '{invalido', 'utf8');
    const store = createWebhookEventStore({ file });
    assert.throws(() => store.claim({ integration: 'meta', tenantId: 'x', eventId: 'evt' }), (error) => error.code === 'WEBHOOK_IDEMPOTENCY_CORRUPT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
