'use strict';

const { ALLOWED_ROLES, ROLES, roleEnvName, resolveRoleForTenant } = require('./authorization');
const {
  listDynamicTenants,
  getDynamicTenant,
  isDynamicTenantEnabled,
} = require('./tenantRegistry');

const STATIC_TENANT_CONFIGS = Object.freeze({
  admin: Object.freeze({ tenantId: 'admin', userEnv: 'ADMIN_USER', passEnv: 'ADMIN_PASS', enabledEnv: 'ADMIN_ENABLED', roleEnv: 'ADMIN_ROLE', realm: 'Admin', displayName: 'Admin', path: '/admin', credentialSource: 'env' }),
  panel: Object.freeze({ tenantId: 'panel', userEnv: 'PANEL_USER', passEnv: 'PANEL_PASS', enabledEnv: 'PANEL_ENABLED', roleEnv: 'PANEL_ROLE', realm: 'Panel', displayName: 'Painel', path: '/panel', credentialSource: 'env' }),
  regina: Object.freeze({ tenantId: 'regina', userEnv: 'REGINA_USER', passEnv: 'REGINA_PASS', enabledEnv: 'REGINA_ENABLED', roleEnv: 'REGINA_ROLE', realm: 'Painel da Regina', displayName: 'Regina', path: '/regina', credentialSource: 'env' }),
  portugal: Object.freeze({ tenantId: 'portugal', userEnv: 'PORTUGAL_USER', passEnv: 'PORTUGAL_PASS', enabledEnv: 'PORTUGAL_ENABLED', roleEnv: 'PORTUGAL_ROLE', realm: 'Painel Portugal', displayName: 'Portugal', path: '/portugal', credentialSource: 'env' }),
  felipe: Object.freeze({ tenantId: 'felipe', userEnv: 'FELIPE_USER', passEnv: 'FELIPE_PASS', enabledEnv: 'FELIPE_ENABLED', roleEnv: 'FELIPE_ROLE', realm: 'Painel Felipe', displayName: 'Felipe', path: '/felipe', credentialSource: 'env' }),
  ana: Object.freeze({ tenantId: 'ana', userEnv: 'ANA_USER', passEnv: 'ANA_PASS', enabledEnv: 'ANA_ENABLED', roleEnv: 'ANA_ROLE', realm: 'Painel Ana Salomão', displayName: 'Ana Salomão', path: '/ana', credentialSource: 'env' }),
});

// Mantém a mesma referência para compatibilidade com módulos antigos que importam TENANT_CONFIGS.
const TENANT_CONFIGS = { ...STATIC_TENANT_CONFIGS };

function clean(value) {
  return String(value ?? '').trim();
}

function parseBoolean(value, defaultValue = false) {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function refreshTenantConfigs() {
  for (const [tenantId, cfg] of Object.entries(TENANT_CONFIGS)) {
    if (cfg?.credentialSource === 'dynamic') delete TENANT_CONFIGS[tenantId];
  }
  for (const record of listDynamicTenants()) {
    TENANT_CONFIGS[record.tenantId] = Object.freeze({
      tenantId: record.tenantId,
      userEnv: null,
      passEnv: null,
      enabledEnv: null,
      roleEnv: null,
      realm: `Painel ${record.displayName}`,
      displayName: record.displayName,
      path: `/${record.tenantId}`,
      credentialSource: 'dynamic',
    });
  }
  return TENANT_CONFIGS;
}

function listTenantConfigs({ includeDisabled = true } = {}) {
  refreshTenantConfigs();
  const configs = Object.values(TENANT_CONFIGS);
  return includeDisabled ? configs.slice() : configs.filter((cfg) => isTenantEnabled(cfg.tenantId));
}

function getTenantConfig(tenantId) {
  refreshTenantConfigs();
  return TENANT_CONFIGS[clean(tenantId).toLowerCase()] || null;
}

function isTenantEnabled(tenantId, env = process.env) {
  const cfg = getTenantConfig(tenantId);
  if (!cfg) return false;
  if (cfg.credentialSource === 'dynamic') return isDynamicTenantEnabled(cfg.tenantId);

  const explicit = clean(env[cfg.enabledEnv]);
  if (explicit) return parseBoolean(explicit, false);

  // Compatibilidade segura: credenciais completas ou parciais indicam intenção de habilitar.
  // Par parcial será rejeitado pela validação, nunca liberado.
  return Boolean(clean(env[cfg.userEnv]) || clean(env[cfg.passEnv]));
}

function shannonEntropyPerCharacter(value) {
  const text = String(value || '');
  if (!text.length) return 0;
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function validateSessionSecret(secret, tenantPasswords = []) {
  const value = clean(secret);
  const errors = [];
  const warnings = [];

  if (!value) {
    errors.push('SESSION_SECRET é obrigatório quando houver tenant habilitado.');
    return { errors, warnings };
  }

  if (value.length < 32) errors.push('SESSION_SECRET deve possuir no mínimo 32 caracteres.');
  if (/replace[-_ ]?with|changeme|default|secret|password|senha|example|test-only/i.test(value)) {
    errors.push('SESSION_SECRET contém um padrão previsível ou de exemplo.');
  }

  const entropy = shannonEntropyPerCharacter(value);
  if (value.length >= 32 && entropy < 3) {
    errors.push('SESSION_SECRET possui baixa diversidade de caracteres; gere um valor criptograficamente aleatório.');
  }

  if (tenantPasswords.some((password) => clean(password) && clean(password) === value)) {
    errors.push('SESSION_SECRET deve ser independente das senhas dos tenants.');
  }

  if (value.length < 43) warnings.push('Recomenda-se SESSION_SECRET com pelo menos 32 bytes aleatórios codificados em base64/base64url.');
  return { errors, warnings };
}

function validateAuthConfiguration({ env = process.env, mode = env.NODE_ENV || 'development' } = {}) {
  const errors = [];
  const warnings = [];
  const enabledTenants = [];
  const disabledTenants = [];
  const tenantPasswords = [];

  let configs;
  try {
    configs = listTenantConfigs();
  } catch (error) {
    errors.push(error.message || 'Não foi possível carregar os tenants dinâmicos.');
    configs = Object.values(STATIC_TENANT_CONFIGS);
  }

  for (const cfg of configs) {
    const enabled = isTenantEnabled(cfg.tenantId, env);

    if (cfg.credentialSource === 'dynamic') {
      const record = getDynamicTenant(cfg.tenantId);
      if (enabled) {
        enabledTenants.push(cfg.tenantId);
        if (!record?.username || !record?.passwordHash) {
          errors.push(`Tenant ${cfg.tenantId} habilitado sem credenciais dinâmicas completas.`);
        }
        const role = record?.role || resolveRoleForTenant(cfg.tenantId, env);
        if (!role || !ALLOWED_ROLES.includes(role) || role === ROLES.SUPER_ADMIN) {
          errors.push(`Tenant ${cfg.tenantId}: role dinâmica inválida.`);
        }
      } else {
        disabledTenants.push(cfg.tenantId);
      }
      continue;
    }

    const user = clean(env[cfg.userEnv]);
    const pass = clean(env[cfg.passEnv]);

    if (enabled) {
      enabledTenants.push(cfg.tenantId);
      const configuredRole = clean(env[cfg.roleEnv || roleEnvName(cfg.tenantId)]).toLowerCase();
      const resolvedRole = resolveRoleForTenant(cfg.tenantId, env);
      if (configuredRole && !ALLOWED_ROLES.includes(configuredRole)) {
        errors.push(`Tenant ${cfg.tenantId}: role inválida em ${cfg.roleEnv || roleEnvName(cfg.tenantId)}.`);
      } else if (!resolvedRole) {
        errors.push(`Tenant ${cfg.tenantId}: role não permitida para este tenant.`);
      } else if (resolvedRole === ROLES.SUPER_ADMIN && cfg.tenantId !== 'admin') {
        errors.push(`Tenant ${cfg.tenantId}: super_admin é reservado ao tenant admin.`);
      }
      if (!user || !pass) {
        errors.push(`Tenant ${cfg.tenantId} habilitado sem o par completo ${cfg.userEnv}/${cfg.passEnv}.`);
      }
      if (pass) tenantPasswords.push(pass);
      if (pass && pass.length < 12) warnings.push(`Tenant ${cfg.tenantId}: senha curta; recomenda-se pelo menos 12 caracteres.`);
    } else {
      disabledTenants.push(cfg.tenantId);
      if (user || pass) warnings.push(`Tenant ${cfg.tenantId} está desabilitado, mas possui credencial configurada.`);
    }
  }

  if (enabledTenants.length) {
    const secretResult = validateSessionSecret(env.SESSION_SECRET, tenantPasswords);
    errors.push(...secretResult.errors);
    warnings.push(...secretResult.warnings);
  } else {
    warnings.push('Nenhum tenant está habilitado; todas as rotas protegidas responderão de forma fechada.');
  }

  if (clean(env.AUTH_SECRET)) warnings.push('AUTH_SECRET é legado e não é mais aceito. Configure somente SESSION_SECRET.');

  const normalizedMode = clean(mode).toLowerCase() || 'development';
  if (normalizedMode === 'production' && enabledTenants.length === 0) {
    warnings.push('Produção iniciada sem tenant habilitado; o sistema ficará inacessível até configuração explícita.');
  }

  return {
    ok: errors.length === 0,
    mode: normalizedMode,
    errors,
    warnings,
    enabledTenants,
    disabledTenants,
  };
}

function assertAuthConfiguration(options = {}) {
  const result = validateAuthConfiguration(options);
  if (!result.ok) {
    const error = new Error(`Configuração de autenticação inválida: ${result.errors.join(' ')}`);
    error.code = 'AUTH_CONFIGURATION_INVALID';
    error.details = result.errors.slice();
    throw error;
  }
  return result;
}

refreshTenantConfigs();

module.exports = {
  STATIC_TENANT_CONFIGS,
  TENANT_CONFIGS,
  clean,
  parseBoolean,
  refreshTenantConfigs,
  listTenantConfigs,
  getTenantConfig,
  isTenantEnabled,
  validateSessionSecret,
  validateAuthConfiguration,
  assertAuthConfiguration,
};
