const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const VERSION = 1;

function parseKey(rawValue = process.env.CONFIG_ENCRYPTION_KEY) {
  const raw = String(rawValue || '').trim();
  if (!raw) return null;

  if (/^[a-f0-9]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  } catch {
    // handled below
  }

  const error = new Error('CONFIG_ENCRYPTION_KEY deve conter 32 bytes em Base64 ou 64 caracteres hexadecimais.');
  error.code = 'INVALID_CONFIG_ENCRYPTION_KEY';
  throw error;
}

function requireKey(rawValue) {
  const key = parseKey(rawValue);
  if (key) return key;
  const error = new Error('CONFIG_ENCRYPTION_KEY é obrigatório para armazenar segredos persistentes.');
  error.code = 'CONFIG_ENCRYPTION_KEY_REQUIRED';
  throw error;
}

function isEncryptedSecret(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.v === VERSION &&
    value.alg === ALGORITHM &&
    typeof value.iv === 'string' &&
    typeof value.tag === 'string' &&
    typeof value.ciphertext === 'string'
  );
}

function encryptSecret(plaintext, rawKey) {
  const text = String(plaintext || '');
  if (!text) return null;

  const key = requireKey(rawKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: VERSION,
    alg: ALGORITHM,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptSecret(payload, rawKey) {
  if (!payload) return '';
  if (!isEncryptedSecret(payload)) {
    const error = new Error('Formato de segredo criptografado inválido.');
    error.code = 'INVALID_ENCRYPTED_SECRET';
    throw error;
  }

  const key = requireKey(rawKey);
  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(payload.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    const error = new Error('Não foi possível descriptografar o segredo persistido. Verifique CONFIG_ENCRYPTION_KEY.');
    error.code = 'SECRET_DECRYPT_FAILED';
    throw error;
  }
}

function encryptionKeyConfigured() {
  return Boolean(parseKey());
}

module.exports = {
  ALGORITHM,
  VERSION,
  parseKey,
  requireKey,
  isEncryptedSecret,
  encryptSecret,
  decryptSecret,
  encryptionKeyConfigured,
};
