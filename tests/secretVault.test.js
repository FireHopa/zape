const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('crypto');
const { encryptSecret, decryptSecret, isEncryptedSecret } = require('../src/secretVault');

function key() { return crypto.randomBytes(32).toString('base64'); }

test('secretVault criptografa sem persistir texto puro', () => {
  const secret = 'synthetic-secret-value-123456';
  const encrypted = encryptSecret(secret, key());
  assert.equal(isEncryptedSecret(encrypted), true);
  assert.equal(JSON.stringify(encrypted).includes(secret), false);
});

test('secretVault faz round-trip com a mesma chave', () => {
  const encryptionKey = key();
  const secret = 'synthetic-secret-value-abcdef';
  const encrypted = encryptSecret(secret, encryptionKey);
  assert.equal(decryptSecret(encrypted, encryptionKey), secret);
});

test('secretVault rejeita chave incorreta', () => {
  const encrypted = encryptSecret('synthetic-secret-value', key());
  assert.throws(() => decryptSecret(encrypted, key()), { code: 'SECRET_DECRYPT_FAILED' });
});
