'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sessionStore = require('./sessionStore');
const { ensureTenantDir, tenantDir } = require('./tenantPaths');

const ENV_KEY = 'ZAPE_DYNAMIC_TENANTS_B64';
const REGISTRY_VERSION = 1;
const MAX_DYNAMIC_TENANTS = 100;
const RESERVED_TENANT_IDS = new Set([
  'admin', 'panel', 'regina', 'portugal', 'felipe', 'ana',
  'api', 'auth', 'login', 'health', 'metrics', 'public', 'assets',
  'modules', 'vendor', 'favicon', 'robots', 'webhooks', 'callback', 'debug',
  'wa-cloud', 'business', 'leads',
]);

let writeQueue = Promise.resolve();
let revision = 0;

function clean(value) {
  return String(value ?? '').trim();
}

function booleanValue(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = clean(value).toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  return defaultValue;
}

function canonicalUsername(value) {
  return clean(value).normalize('NFKC').toLocaleLowerCase('pt-BR');
}

function createRegistryError(code, message, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function validateTenantId(value) {
  const tenantId = clean(value).toLowerCase();
  if (tenantId.length < 3 || tenantId.length > 32) {
    throw createRegistryError('TENANT_ID_INVALID', 'O identificador deve possuir entre 3 e 32 caracteres.', 400);
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(tenantId)) {
    throw createRegistryError('TENANT_ID_INVALID', 'Use apenas letras minúsculas, números e hífen, sem hífen no início ou no fim.', 400);
  }
  if (tenantId.includes('--')) {
    throw createRegistryError('TENANT_ID_INVALID', 'O identificador não pode conter hífens consecutivos.', 400);
  }
  if (RESERVED_TENANT_IDS.has(tenantId)) {
    throw createRegistryError('TENANT_ID_RESERVED', 'Este identificador é reservado pelo sistema.', 409);
  }
  return tenantId;
}

function validateDisplayName(value) {
  const displayName = clean(value).normalize('NFKC');
  if (displayName.length < 2 || displayName.length > 80) {
    throw createRegistryError('TENANT_NAME_INVALID', 'O nome do painel deve possuir entre 2 e 80 caracteres.', 400);
  }
  if (/\p{C}/u.test(displayName)) {
    throw createRegistryError('TENANT_NAME_INVALID', 'O nome do painel contém caracteres inválidos.', 400);
  }
  return displayName;
}

function validateUsername(value) {
  const username = clean(value).normalize('NFKC');
  if (username.length < 3 || username.length > 80) {
    throw createRegistryError('TENANT_USER_INVALID', 'O usuário deve possuir entre 3 e 80 caracteres.', 400);
  }
  if (/^[.\- _]|[.\- _]$/.test(username)) {
    throw createRegistryError('TENANT_USER_INVALID', 'O usuário não pode começar ou terminar com espaço, ponto, hífen ou sublinhado.', 400);
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._@-]*$/u.test(username)) {
    throw createRegistryError('TENANT_USER_INVALID', 'O usuário contém caracteres não permitidos.', 400);
  }
  return username;
}

function validatePassword(value) {
  const password = String(value ?? '');
  if (password.length < 12) {
    throw createRegistryError('TENANT_PASSWORD_WEAK', 'A senha deve possuir pelo menos 12 caracteres.', 400);
  }
  if (password.length > 256) {
    throw createRegistryError('TENANT_PASSWORD_INVALID', 'A senha excede o limite permitido.', 400);
  }
  return password;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(validatePassword(password), salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function verifyPassword(password, encoded) {
  const parts = clean(encoded).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every(Number.isFinite) || N < 1024 || N > 1048576 || r < 1 || p < 1) return false;
  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    const actual = crypto.scryptSync(String(password ?? ''), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * 1024 * 1024,
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function normalizeRecord(item) {
  if (!item || typeof item !== 'object') return null;
  try {
    const tenantId = validateTenantId(item.tenantId);
    const displayName = validateDisplayName(item.displayName || tenantId);
    const username = validateUsername(item.username);
    const passwordHash = clean(item.passwordHash);
    if (!/^scrypt\$/.test(passwordHash)) return null;
    return {
      tenantId,
      displayName,
      username,
      usernameKey: canonicalUsername(item.usernameKey || username),
      passwordHash,
      role: 'tenant_admin',
      enabled: booleanValue(item.enabled, true),
      createdAt: clean(item.createdAt) || null,
      updatedAt: clean(item.updatedAt) || null,
    };
  } catch {
    return null;
  }
}

function decodeRegistry(raw = process.env[ENV_KEY]) {
  const encoded = clean(raw);
  if (!encoded) return { version: REGISTRY_VERSION, items: [] };
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const sourceItems = Array.isArray(parsed) ? parsed : parsed?.items;
    if (!Array.isArray(sourceItems)) throw new Error('items_not_array');
    const items = sourceItems.map(normalizeRecord).filter(Boolean);
    return { version: REGISTRY_VERSION, items };
  } catch (cause) {
    const error = createRegistryError('DYNAMIC_TENANTS_ENV_INVALID', `${ENV_KEY} possui conteúdo inválido.`, 500);
    error.cause = cause;
    throw error;
  }
}

function encodeRegistry(items) {
  const payload = { version: REGISTRY_VERSION, items };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function configuredEnvPath() {
  const configured = clean(process.env.ZAPE_ENV_FILE);
  const candidate = configured ? path.resolve(configured) : path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(candidate)) {
    throw createRegistryError('ENV_FILE_NOT_FOUND', `Arquivo .env não encontrado em ${candidate}.`, 500);
  }
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isSymbolicLink() ? fs.realpathSync(candidate) : candidate;
  } catch (cause) {
    const error = createRegistryError('ENV_FILE_UNAVAILABLE', 'Não foi possível acessar o arquivo .env.', 500);
    error.cause = cause;
    throw error;
  }
}

function updateEnvLine(content, key, value) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const prefix = `${key}=`;
  let replaced = false;
  const next = lines.map((line) => {
    if (line.startsWith(prefix)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    while (next.length && next[next.length - 1] === '') next.pop();
    next.push('', '# Painéis completos criados pelo painel Felipe. Gerenciado automaticamente.', `${key}=${value}`, '');
  }
  return `${next.join(newline).replace(new RegExp(`${newline}+$`), '')}${newline}`;
}

function persistRegistrySync(items) {
  const envPath = configuredEnvPath();
  const content = fs.readFileSync(envPath, 'utf8');
  const encoded = encodeRegistry(items);
  const updated = updateEnvLine(content, ENV_KEY, encoded);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // O backup fica fora de /etc para não exigir permissão de criação no diretório do arquivo real.
  const backupRoot = clean(process.env.ZAPE_ENV_BACKUP_DIR)
    ? path.resolve(process.env.ZAPE_ENV_BACKUP_DIR)
    : path.join(path.resolve(process.env.ZAPE_DATA_DIR || path.join(process.cwd(), 'data')), 'env-backups');
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backup = path.join(backupRoot, `${path.basename(envPath)}.tenants-backup.${timestamp}.${process.pid}`);
  fs.copyFileSync(envPath, backup);
  try { fs.chmodSync(backup, 0o600); } catch {}

  const temp = `${envPath}.tenants-tmp.${timestamp}.${process.pid}`;
  try {
    fs.writeFileSync(temp, updated, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, envPath);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    // Em /etc/zape o processo pode ter escrita no arquivo, mas não no diretório.
    // Nesse caso preserva o backup externo e atualiza o arquivo existente diretamente.
    if (!['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) throw error;
    fs.writeFileSync(envPath, updated, { encoding: 'utf8' });
  }
  try { fs.chmodSync(envPath, 0o600); } catch {}
  process.env[ENV_KEY] = encoded;
  revision += 1;
  return { envPath, backup, revision };
}

function enqueueWrite(operation) {
  const run = writeQueue.then(operation, operation);
  writeQueue = run.catch(() => {});
  return run;
}

function publicRecord(record) {
  return {
    tenantId: record.tenantId,
    displayName: record.displayName,
    username: record.username,
    role: record.role,
    enabled: record.enabled !== false,
    path: `/${record.tenantId}`,
    apiBase: `/api/${record.tenantId}`,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    dataDirectory: tenantDir(record.tenantId),
  };
}

function listDynamicTenants({ includeDisabled = true } = {}) {
  const items = decodeRegistry().items;
  return items
    .filter((item) => includeDisabled || item.enabled)
    .map((item) => ({ ...item }));
}

function listPublicDynamicTenants(options) {
  return listDynamicTenants(options).map(publicRecord);
}

function getDynamicTenant(tenantId) {
  const id = clean(tenantId).toLowerCase();
  if (!id) return null;
  return listDynamicTenants().find((item) => item.tenantId === id) || null;
}

function isDynamicTenantEnabled(tenantId) {
  const record = getDynamicTenant(tenantId);
  return Boolean(record && record.enabled);
}

function verifyDynamicTenantCredentials(tenantId, username, password) {
  const record = getDynamicTenant(tenantId);
  if (!record) return { ok: false, reason: 'invalid_tenant', configured: false };
  if (!record.enabled) return { ok: false, reason: 'disabled', configured: true };
  const suppliedKey = canonicalUsername(username);
  const userOk = suppliedKey && suppliedKey === record.usernameKey;
  const passOk = userOk && verifyPassword(password, record.passwordHash);
  return {
    ok: Boolean(userOk && passOk),
    reason: userOk && passOk ? 'ok' : 'mismatch',
    configured: true,
    username: record.username,
    role: record.role,
  };
}

function isDynamicTenantSessionUserActive(tenantId, username) {
  const record = getDynamicTenant(tenantId);
  return Boolean(record && record.enabled && canonicalUsername(username) === record.usernameKey);
}

async function createDynamicTenant({ tenantId, displayName, username, password, enabled = true }) {
  return enqueueWrite(async () => {
    const id = validateTenantId(tenantId);
    const name = validateDisplayName(displayName);
    const user = validateUsername(username);
    const registry = decodeRegistry();
    if (registry.items.length >= MAX_DYNAMIC_TENANTS) {
      throw createRegistryError('DYNAMIC_TENANT_LIMIT', `Limite de ${MAX_DYNAMIC_TENANTS} painéis dinâmicos atingido.`, 409);
    }
    if (registry.items.some((item) => item.tenantId === id)) {
      throw createRegistryError('TENANT_ID_EXISTS', 'Já existe um painel com este identificador.', 409);
    }
    const now = new Date().toISOString();
    const record = {
      tenantId: id,
      displayName: name,
      username: user,
      usernameKey: canonicalUsername(user),
      passwordHash: hashPassword(password),
      role: 'tenant_admin',
      enabled: booleanValue(enabled, true),
      createdAt: now,
      updatedAt: now,
    };
    registry.items.push(record);
    const persisted = persistRegistrySync(registry.items);
    ensureTenantDir(id);
    return { tenant: publicRecord(record), persisted };
  });
}

async function updateDynamicTenant({ tenantId, displayName, username, password, enabled }) {
  return enqueueWrite(async () => {
    const id = validateTenantId(tenantId);
    const registry = decodeRegistry();
    const index = registry.items.findIndex((item) => item.tenantId === id);
    if (index < 0) throw createRegistryError('TENANT_NOT_FOUND', 'Painel não encontrado.', 404);
    const current = registry.items[index];
    const updated = {
      ...current,
      displayName: displayName === undefined ? current.displayName : validateDisplayName(displayName),
      username: username === undefined ? current.username : validateUsername(username),
      enabled: enabled === undefined ? current.enabled : booleanValue(enabled, current.enabled),
      updatedAt: new Date().toISOString(),
    };
    updated.usernameKey = canonicalUsername(updated.username);
    if (password !== undefined && String(password) !== '') updated.passwordHash = hashPassword(password);
    registry.items[index] = updated;
    const persisted = persistRegistrySync(registry.items);
    sessionStore.revokeAllForTenant(id);
    return { tenant: publicRecord(updated), persisted };
  });
}

async function deleteDynamicTenant({ tenantId }) {
  return enqueueWrite(async () => {
    const id = validateTenantId(tenantId);
    const registry = decodeRegistry();
    const index = registry.items.findIndex((item) => item.tenantId === id);
    if (index < 0) throw createRegistryError('TENANT_NOT_FOUND', 'Painel não encontrado.', 404);
    const [removed] = registry.items.splice(index, 1);
    const persisted = persistRegistrySync(registry.items);
    sessionStore.revokeAllForTenant(id);
    return {
      tenant: publicRecord(removed),
      persisted,
      dataPreserved: true,
      dataDirectory: tenantDir(id),
    };
  });
}

function registryRevision() {
  return revision;
}

module.exports = {
  ENV_KEY,
  REGISTRY_VERSION,
  MAX_DYNAMIC_TENANTS,
  RESERVED_TENANT_IDS,
  validateTenantId,
  validateDisplayName,
  validateUsername,
  validatePassword,
  decodeRegistry,
  encodeRegistry,
  listDynamicTenants,
  listPublicDynamicTenants,
  getDynamicTenant,
  isDynamicTenantEnabled,
  verifyDynamicTenantCredentials,
  isDynamicTenantSessionUserActive,
  createDynamicTenant,
  updateDynamicTenant,
  deleteDynamicTenant,
  publicRecord,
  registryRevision,
};
