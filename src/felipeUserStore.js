'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sessionStore = require('./sessionStore');

const ENV_KEY = 'FELIPE_EXTRA_USERS_B64';
const ALLOWED_EXTRA_ROLES = Object.freeze(['tenant_admin', 'operator', 'viewer']);
const USERNAME_MAX_LENGTH = 80;
const MAX_EXTRA_USERS = 100;

let writeQueue = Promise.resolve();

function clean(value) {
  return String(value ?? '').trim();
}

function canonicalUsername(value) {
  return clean(value).normalize('NFKC').toLocaleLowerCase('pt-BR');
}

function booleanValue(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = clean(value).toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  return defaultValue;
}

function sanitizeRole(value) {
  const role = clean(value).toLowerCase();
  return ALLOWED_EXTRA_ROLES.includes(role) ? role : null;
}

function validateUsername(value) {
  const username = clean(value).normalize('NFKC');
  if (username.length < 3 || username.length > USERNAME_MAX_LENGTH) {
    throw createStoreError('FELIPE_USER_INVALID', `O usuário deve possuir entre 3 e ${USERNAME_MAX_LENGTH} caracteres.`, 400);
  }
  if (/^[.\- _]|[.\- _]$/.test(username)) {
    throw createStoreError('FELIPE_USER_INVALID', 'O usuário não pode começar ou terminar com espaço, ponto, hífen ou sublinhado.', 400);
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._@-]*$/u.test(username)) {
    throw createStoreError('FELIPE_USER_INVALID', 'O usuário contém caracteres não permitidos.', 400);
  }
  return username;
}

function validatePassword(value) {
  const password = String(value ?? '');
  if (password.length < 10) {
    throw createStoreError('FELIPE_PASSWORD_WEAK', 'A senha deve possuir pelo menos 10 caracteres.', 400);
  }
  if (password.length > 256) {
    throw createStoreError('FELIPE_PASSWORD_INVALID', 'A senha excede o limite permitido.', 400);
  }
  return password;
}

function createStoreError(code, message, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function decodeUsers(raw = process.env[ENV_KEY]) {
  const encoded = clean(raw);
  if (!encoded) return [];
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error('payload_not_array');
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id: clean(item.id),
        username: clean(item.username).normalize('NFKC'),
        usernameKey: canonicalUsername(item.usernameKey || item.username),
        passwordHash: clean(item.passwordHash),
        role: sanitizeRole(item.role) || 'operator',
        enabled: booleanValue(item.enabled, true),
        createdAt: clean(item.createdAt) || null,
        updatedAt: clean(item.updatedAt) || null,
      }))
      .filter((item) => item.id && item.username && item.usernameKey && item.passwordHash);
  } catch (cause) {
    const error = createStoreError('FELIPE_USERS_ENV_INVALID', `${ENV_KEY} possui conteúdo inválido.`, 500);
    error.cause = cause;
    throw error;
  }
}

function encodeUsers(users) {
  return Buffer.from(JSON.stringify(users), 'utf8').toString('base64url');
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

function safeEqualText(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  const max = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(max);
  const pb = Buffer.alloc(max);
  a.copy(pa);
  b.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && a.length === b.length;
}

function primaryFelipeUser() {
  const username = clean(process.env.FELIPE_USER).normalize('NFKC');
  if (!username) return null;
  return {
    id: 'primary',
    username,
    usernameKey: canonicalUsername(username),
    role: clean(process.env.FELIPE_ROLE).toLowerCase() || 'tenant_admin',
    enabled: clean(process.env.FELIPE_ENABLED || '1') !== '0',
    primary: true,
    createdAt: null,
    updatedAt: null,
  };
}

function findFelipeUserByUsername(username) {
  const supplied = clean(username).normalize('NFKC');
  const key = canonicalUsername(supplied);
  if (!key) return null;

  const primary = primaryFelipeUser();
  if (primary && safeEqualText(supplied, primary.username)) return primary;

  const extra = decodeUsers().find((item) => item.usernameKey === key);
  return extra ? { ...extra, primary: false } : null;
}

function isFelipePrimaryUsername(username) {
  const primary = primaryFelipeUser();
  return Boolean(primary && safeEqualText(clean(username).normalize('NFKC'), primary.username));
}

function isFelipeUserActive(username) {
  const record = findFelipeUserByUsername(username);
  return Boolean(record && record.enabled);
}

function verifyFelipeCredentials(username, password) {
  const record = findFelipeUserByUsername(username);
  if (!record || !record.enabled) {
    return { ok: false, reason: record ? 'disabled' : 'mismatch', configured: true };
  }

  if (record.primary) {
    const passOk = safeEqualText(String(password ?? ''), clean(process.env.FELIPE_PASS));
    return {
      ok: passOk,
      reason: passOk ? 'ok' : 'mismatch',
      configured: Boolean(clean(process.env.FELIPE_PASS)),
      username: record.username,
      role: record.role,
      primary: true,
    };
  }

  const passOk = verifyPassword(password, record.passwordHash);
  return {
    ok: passOk,
    reason: passOk ? 'ok' : 'mismatch',
    configured: true,
    username: record.username,
    role: record.role,
    primary: false,
  };
}

function publicRecord(record) {
  return {
    id: record.id,
    username: record.username,
    role: record.role,
    enabled: record.enabled !== false,
    primary: Boolean(record.primary),
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
  };
}

function listFelipeUsers() {
  const rows = [];
  const primary = primaryFelipeUser();
  if (primary) rows.push(publicRecord(primary));
  rows.push(...decodeUsers().map((item) => publicRecord({ ...item, primary: false })));
  return rows;
}

function configuredEnvPath() {
  const configured = clean(process.env.ZAPE_ENV_FILE);
  const candidate = configured ? path.resolve(configured) : path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(candidate)) {
    throw createStoreError('ENV_FILE_NOT_FOUND', `Arquivo .env não encontrado em ${candidate}.`, 500);
  }
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isSymbolicLink() ? fs.realpathSync(candidate) : candidate;
  } catch (cause) {
    const error = createStoreError('ENV_FILE_UNAVAILABLE', 'Não foi possível acessar o arquivo .env.', 500);
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
    next.push('', '# Usuários adicionais do painel Felipe. Gerenciado pelo próprio painel.', `${key}=${value}`, '');
  }
  return next.join(newline);
}

function pruneBackups(envPath) {
  try {
    const dir = path.dirname(envPath);
    const base = path.basename(envPath);
    const prefix = `${base}.users-backup.`;
    const backups = fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    backups.slice(10).forEach((item) => {
      try { fs.rmSync(path.join(dir, item.name), { force: true }); } catch {}
    });
  } catch {}
}

function persistUsersSync(users) {
  const envPath = configuredEnvPath();
  fs.accessSync(envPath, fs.constants.R_OK | fs.constants.W_OK);
  const stat = fs.statSync(envPath);
  const current = fs.readFileSync(envPath, 'utf8');
  const encoded = encodeUsers(users);
  const updated = updateEnvLine(current, ENV_KEY, encoded);
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const backup = `${envPath}.users-backup.${timestamp}.${process.pid}`;
  fs.copyFileSync(envPath, backup, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(backup, stat.mode); } catch {}

  const temp = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, updated, { encoding: 'utf8', mode: stat.mode });
  try { fs.chownSync(temp, stat.uid, stat.gid); } catch {}
  fs.renameSync(temp, envPath);
  try { fs.chmodSync(envPath, stat.mode); } catch {}
  process.env[ENV_KEY] = encoded;
  pruneBackups(envPath);
  return { envPath, backup };
}

function serializeWrite(operation) {
  const next = writeQueue.then(operation, operation);
  writeQueue = next.catch(() => undefined);
  return next;
}

function assertCanManage(actorUsername) {
  if (!isFelipePrimaryUsername(actorUsername)) {
    throw createStoreError('FELIPE_USER_MANAGEMENT_FORBIDDEN', 'Somente o usuário principal do painel Felipe pode gerenciar usuários.', 403);
  }
}

async function createFelipeUser({ actorUsername, username, password, role = 'operator', enabled = true }) {
  return serializeWrite(() => {
    assertCanManage(actorUsername);
    const cleanUsername = validateUsername(username);
    const usernameKey = canonicalUsername(cleanUsername);
    const primary = primaryFelipeUser();
    const users = decodeUsers();
    if ((primary && primary.usernameKey === usernameKey) || users.some((item) => item.usernameKey === usernameKey)) {
      throw createStoreError('FELIPE_USER_EXISTS', 'Já existe um usuário com esse nome.', 409);
    }
    if (users.length >= MAX_EXTRA_USERS) {
      throw createStoreError('FELIPE_USER_LIMIT', `O limite de ${MAX_EXTRA_USERS} usuários adicionais foi atingido.`, 409);
    }
    const resolvedRole = sanitizeRole(role);
    if (!resolvedRole) throw createStoreError('FELIPE_ROLE_INVALID', 'Perfil de acesso inválido.', 400);
    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      username: cleanUsername,
      usernameKey,
      passwordHash: hashPassword(password),
      role: resolvedRole,
      enabled: booleanValue(enabled, true),
      createdAt: now,
      updatedAt: now,
    };
    users.push(record);
    const persisted = persistUsersSync(users);
    return { user: publicRecord({ ...record, primary: false }), ...persisted };
  });
}

async function updateFelipeUser({ actorUsername, userId, username, password, role, enabled }) {
  return serializeWrite(() => {
    assertCanManage(actorUsername);
    const id = clean(userId);
    const users = decodeUsers();
    const index = users.findIndex((item) => item.id === id);
    if (index < 0) throw createStoreError('FELIPE_USER_NOT_FOUND', 'Usuário não encontrado.', 404);
    const current = users[index];
    const nextUsername = username === undefined ? current.username : validateUsername(username);
    const nextKey = canonicalUsername(nextUsername);
    const primary = primaryFelipeUser();
    if ((primary && primary.usernameKey === nextKey) || users.some((item, idx) => idx !== index && item.usernameKey === nextKey)) {
      throw createStoreError('FELIPE_USER_EXISTS', 'Já existe um usuário com esse nome.', 409);
    }
    const nextRole = role === undefined ? current.role : sanitizeRole(role);
    if (!nextRole) throw createStoreError('FELIPE_ROLE_INVALID', 'Perfil de acesso inválido.', 400);
    const previousUsername = current.username;
    const updated = {
      ...current,
      username: nextUsername,
      usernameKey: nextKey,
      role: nextRole,
      enabled: enabled === undefined ? current.enabled : booleanValue(enabled, current.enabled),
      updatedAt: new Date().toISOString(),
    };
    if (password !== undefined && String(password) !== '') updated.passwordHash = hashPassword(password);
    users[index] = updated;
    const persisted = persistUsersSync(users);
    sessionStore.revokeAllForTenant('felipe', previousUsername);
    if (previousUsername !== updated.username) sessionStore.revokeAllForTenant('felipe', updated.username);
    return { user: publicRecord({ ...updated, primary: false }), ...persisted };
  });
}

async function deleteFelipeUser({ actorUsername, userId }) {
  return serializeWrite(() => {
    assertCanManage(actorUsername);
    const id = clean(userId);
    const users = decodeUsers();
    const index = users.findIndex((item) => item.id === id);
    if (index < 0) throw createStoreError('FELIPE_USER_NOT_FOUND', 'Usuário não encontrado.', 404);
    const [removed] = users.splice(index, 1);
    const persisted = persistUsersSync(users);
    sessionStore.revokeAllForTenant('felipe', removed.username);
    return { user: publicRecord({ ...removed, primary: false }), ...persisted };
  });
}

module.exports = {
  ENV_KEY,
  ALLOWED_EXTRA_ROLES,
  canonicalUsername,
  decodeUsers,
  encodeUsers,
  hashPassword,
  verifyPassword,
  primaryFelipeUser,
  findFelipeUserByUsername,
  isFelipePrimaryUsername,
  isFelipeUserActive,
  verifyFelipeCredentials,
  listFelipeUsers,
  createFelipeUser,
  updateFelipeUser,
  deleteFelipeUser,
  configuredEnvPath,
};
