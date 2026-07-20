'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');

const {
  validateMetaSignature,
  buildCustomWebhookSignedPayload,
  validateCustomWebhookSignature,
  validatePublicLeadPayload,
  validateMetaWebhookPayload,
  deriveMetaEventKey,
  InMemoryRateLimiter,
} = require('../src/webhookSecurity');

test('assinatura X-Hub-Signature-256 válida é aceita e assinatura forjada é rejeitada', () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const rawBody = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  assert.equal(validateMetaSignature(rawBody, signature, secret), true);
  assert.equal(validateMetaSignature(rawBody, `sha256=${'0'.repeat(64)}`, secret), false);
  assert.equal(validateMetaSignature(rawBody, '', secret), false);
});

test('webhook customizado exige HMAC, timestamp recente e event ID válido', () => {
  const secret = crypto.randomBytes(32).toString('base64url');
  const rawBody = Buffer.from(JSON.stringify({ nome: 'Contato Teste', whatsapp: '5511999999999' }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const eventId = `evt_${crypto.randomBytes(8).toString('hex')}`;
  const signature = `sha256=${crypto.createHmac('sha256', secret)
    .update(buildCustomWebhookSignedPayload({ timestamp, eventId, rawBody }))
    .digest('hex')}`;

  assert.equal(validateCustomWebhookSignature({ rawBody, signatureHeader: signature, timestampHeader: timestamp, eventIdHeader: eventId, secret }).ok, true);
  assert.equal(validateCustomWebhookSignature({ rawBody, signatureHeader: '', timestampHeader: timestamp, eventIdHeader: eventId, secret }).code, 'WEBHOOK_SIGNATURE_MISSING');
  assert.equal(validateCustomWebhookSignature({ rawBody, signatureHeader: `sha256=${'0'.repeat(64)}`, timestampHeader: timestamp, eventIdHeader: eventId, secret }).code, 'WEBHOOK_SIGNATURE_INVALID');
  assert.equal(validateCustomWebhookSignature({ rawBody, signatureHeader: signature, timestampHeader: String(Math.floor(Date.now() / 1000) - 10000), eventIdHeader: eventId, secret }).code, 'WEBHOOK_TIMESTAMP_EXPIRED');
  assert.equal(validateCustomWebhookSignature({ rawBody, signatureHeader: signature, timestampHeader: timestamp, eventIdHeader: 'evento com espaço', secret }).code, 'WEBHOOK_EVENT_ID_INVALID');
});

test('formulário público rejeita campos desconhecidos e texto excessivo', () => {
  assert.deepEqual(validatePublicLeadPayload({ nome: 'Teste', whatsapp: '5511999999999' }), {
    nome: 'Teste', empresa: '', jaAnuncia: '', website: '', email: '', whatsapp: '5511999999999',
  });
  assert.throws(() => validatePublicLeadPayload({ nome: 'Teste', admin: true }), (error) => error.code === 'UNKNOWN_FIELDS');
  assert.throws(() => validatePublicLeadPayload({ nome: 'x'.repeat(201) }), (error) => error.code === 'FIELD_TOO_LONG');
});

test('payload Meta requer objeto e entry válidos e produz chave estável', () => {
  const body = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { metadata: { phone_number_id: '123' }, messages: [{ id: 'wamid.1', from: '5511999999999' }] } }] }],
  };
  const raw = Buffer.from(JSON.stringify(body));
  assert.equal(validateMetaWebhookPayload(body), body);
  assert.equal(deriveMetaEventKey(body, raw), deriveMetaEventKey(body, raw));
  assert.throws(() => validateMetaWebhookPayload({ object: 'other', entry: [] }), (error) => error.code === 'INVALID_META_PAYLOAD');
});

test('rate limiter bloqueia alta frequência e informa retry', () => {
  let now = 1_000;
  const limiter = new InMemoryRateLimiter({ now: () => now });
  assert.equal(limiter.consume('route:ip', { max: 2, windowMs: 1000 }).allowed, true);
  assert.equal(limiter.consume('route:ip', { max: 2, windowMs: 1000 }).allowed, true);
  const blocked = limiter.consume('route:ip', { max: 2, windowMs: 1000 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 1);
  now = 2_001;
  assert.equal(limiter.consume('route:ip', { max: 2, windowMs: 1000 }).allowed, true);
});
