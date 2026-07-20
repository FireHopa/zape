'use strict';

const net = require('net');

function clean(value) {
  return String(value ?? '').trim();
}

function envBool(value, defaultValue = false) {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function isProduction(mode) {
  return clean(mode).toLowerCase() === 'production';
}

function normalizeHost(value) {
  return clean(value) || '127.0.0.1';
}

function isLoopbackHost(host) {
  const normalized = clean(host).toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (net.isIP(normalized) === 4) return normalized.startsWith('127.');
  return false;
}

function parsePort(value, fallback = 3000) {
  const raw = clean(value);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function parseTrustProxyHops(value, fallback) {
  const raw = clean(value);
  if (!raw) return fallback;
  if (/^(true|false|yes|no|on|off)$/i.test(raw)) return null;
  if (!/^\d+$/.test(raw)) return null;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) return null;
  return hops;
}

function parsePublicBaseUrl(value) {
  const raw = clean(value);
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function validateRuntimeConfiguration({
  env = process.env,
  mode = env.NODE_ENV || 'development',
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const errors = [];
  const warnings = [];
  const info = [];
  const production = isProduction(mode);
  const host = normalizeHost(env.HOST || env.BIND_HOST);
  const port = parsePort(env.PORT, 3000);
  const trustProxyHops = parseTrustProxyHops(env.TRUST_PROXY_HOPS, production ? 1 : 0);
  const publicBaseRaw = clean(env.PUBLIC_BASE_URL || env.APP_BASE_URL);
  const publicBaseUrl = parsePublicBaseUrl(publicBaseRaw);
  const allowRoot = envBool(env.INFRA_ALLOW_ROOT_PROCESS, false);
  const allowHttpForTests = envBool(env.INFRA_ALLOW_HTTP_FOR_TESTS, false);

  if (port === null) errors.push('PORT deve ser um inteiro entre 1 e 65535.');

  if (production && !isLoopbackHost(host)) {
    errors.push('HOST deve apontar para loopback em produção; use 127.0.0.1 atrás do Nginx.');
  } else if (!isLoopbackHost(host)) {
    warnings.push('HOST não está em loopback. Use somente em desenvolvimento isolado.');
  }

  if (trustProxyHops === null) {
    errors.push('TRUST_PROXY_HOPS deve ser um número inteiro entre 0 e 5; valores booleanos e trust proxy irrestrito não são aceitos.');
  } else if (production && trustProxyHops < 1) {
    errors.push('TRUST_PROXY_HOPS deve ser 1 em produção com o Nginx fornecido.');
  } else if (trustProxyHops > 1) {
    warnings.push('TRUST_PROXY_HOPS acima de 1 exige uma cadeia de proxies conhecida e documentada.');
  }

  if (publicBaseRaw && !publicBaseUrl) {
    errors.push('PUBLIC_BASE_URL/APP_BASE_URL deve ser uma URL absoluta válida.');
  }
  if (production) {
    if (!publicBaseUrl) {
      errors.push('PUBLIC_BASE_URL é obrigatória em produção.');
    } else if (publicBaseUrl.protocol !== 'https:') {
      const localHttpException = allowHttpForTests && isLoopbackHost(publicBaseUrl.hostname);
      if (!localHttpException) errors.push('PUBLIC_BASE_URL deve usar HTTPS em produção.');
      else warnings.push('HTTP em produção foi permitido somente para teste local por INFRA_ALLOW_HTTP_FOR_TESTS=1.');
    }
  }

  if (production && uid === 0 && !allowRoot) {
    errors.push('O processo Node não pode executar como root em produção. Inicie o PM2 com o usuário zape.');
  } else if (production && uid === 0 && allowRoot) {
    warnings.push('Execução como root liberada explicitamente por INFRA_ALLOW_ROOT_PROCESS=1; use somente em teste controlado.');
  }

  const authTrust = envBool(env.AUTH_TRUST_PROXY_HEADERS, false);
  const publicTrust = envBool(env.PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS, false);
  if ((authTrust || publicTrust) && trustProxyHops === 0) {
    errors.push('Cabeçalhos de proxy não podem ser confiados quando TRUST_PROXY_HOPS=0.');
  }
  if (production && trustProxyHops >= 1 && !authTrust) {
    warnings.push('AUTH_TRUST_PROXY_HEADERS está desativado; todos os logins atrás do Nginx podem compartilhar o IP de loopback no rate limit.');
  }
  if (production && trustProxyHops >= 1 && !publicTrust) {
    warnings.push('PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS está desativado; webhooks atrás do Nginx podem compartilhar o IP de loopback no rate limit.');
  }

  if (production && envBool(env.WEBJS_NO_SANDBOX, false)) {
    warnings.push('WEBJS_NO_SANDBOX está ativo. O usuário não-root deve usar o sandbox do Chromium sempre que o ambiente permitir.');
  }

  info.push(`Bind HTTP: ${host}:${port || 'inválida'}.`);
  info.push(`Trust proxy: ${trustProxyHops === null ? 'inválido' : `${trustProxyHops} salto(s)`}.`);
  info.push(`Execução: ${uid === null ? 'UID indisponível' : `UID ${uid}`}.`);

  return {
    ok: errors.length === 0,
    mode: clean(mode).toLowerCase() || 'development',
    production,
    host,
    port,
    trustProxyHops,
    publicBaseUrl: publicBaseUrl ? publicBaseUrl.toString() : '',
    errors,
    warnings,
    info,
  };
}

function assertRuntimeConfiguration(options = {}) {
  const result = validateRuntimeConfiguration(options);
  if (!result.ok) {
    const error = new Error(`Configuração de infraestrutura inválida: ${result.errors.join(' ')}`);
    error.code = 'INFRA_CONFIGURATION_INVALID';
    error.details = result.errors.slice();
    throw error;
  }
  return result;
}

function applyTrustProxy(app, trustProxyHops) {
  if (!app || typeof app.set !== 'function' || typeof app.disable !== 'function') {
    throw new TypeError('Express app inválido.');
  }
  const hops = Number(trustProxyHops || 0);
  if (hops > 0) app.set('trust proxy', hops);
  else app.disable('trust proxy');
}

module.exports = {
  clean,
  envBool,
  isLoopbackHost,
  parsePort,
  parseTrustProxyHops,
  validateRuntimeConfiguration,
  assertRuntimeConfiguration,
  applyTrustProxy,
};
