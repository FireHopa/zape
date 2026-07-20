'use strict';

const { envBool, positiveInt, customWebhookSignatureRequired } = require('./webhookSecurity');

function clean(value) {
  return String(value ?? '').trim();
}

function validatePublicEndpointConfiguration({ env = process.env, mode = env.NODE_ENV || 'development' } = {}) {
  const errors = [];
  const warnings = [];
  const info = [];
  const normalizedMode = clean(mode).toLowerCase() || 'development';
  const production = normalizedMode === 'production';

  const publicFormEnabled = envBool(env.PUBLIC_LEAD_FORM_ENABLED, !production);
  const publicFormToken = clean(env.PUBLIC_LEAD_FORM_TOKEN);
  if (publicFormEnabled && production && publicFormToken.length < 32) {
    errors.push('PUBLIC_LEAD_FORM_ENABLED exige PUBLIC_LEAD_FORM_TOKEN com pelo menos 32 caracteres em produção.');
  } else if (publicFormEnabled && publicFormToken && publicFormToken.length < 32) {
    warnings.push('PUBLIC_LEAD_FORM_TOKEN possui menos de 32 caracteres.');
  }

  const activeEnabled = envBool(env.ACTIVECAMPAIGN_WEBHOOK_ENABLED, !production);
  const activeToken = clean(env.ACTIVECAMPAIGN_WEBHOOK_TOKEN);
  if (activeEnabled && activeToken.length < 32) {
    errors.push('ACTIVECAMPAIGN_WEBHOOK_ENABLED exige ACTIVECAMPAIGN_WEBHOOK_TOKEN com pelo menos 32 caracteres.');
  }

  if (!customWebhookSignatureRequired({ nodeEnv: normalizedMode, configured: env.CUSTOM_WEBHOOK_REQUIRE_SIGNATURE })) {
    warnings.push('Assinatura HMAC dos webhooks customizados está desativada fora de produção.');
  }
  if (production && clean(env.CUSTOM_WEBHOOK_REQUIRE_SIGNATURE) && !envBool(env.CUSTOM_WEBHOOK_REQUIRE_SIGNATURE, true)) {
    info.push('CUSTOM_WEBHOOK_REQUIRE_SIGNATURE=0 é ignorado em produção; HMAC permanece obrigatório.');
  }

  const tolerance = positiveInt(env.CUSTOM_WEBHOOK_CLOCK_TOLERANCE_SECONDS, 300, { min: 30, max: 3600 });
  if (clean(env.CUSTOM_WEBHOOK_CLOCK_TOLERANCE_SECONDS) && tolerance !== Number.parseInt(clean(env.CUSTOM_WEBHOOK_CLOCK_TOLERANCE_SECONDS), 10)) {
    warnings.push('CUSTOM_WEBHOOK_CLOCK_TOLERANCE_SECONDS foi ajustado para o intervalo seguro de 30 a 3600 segundos.');
  }

  if (envBool(env.ALLOW_WEBHOOK_TOKEN_IN_QUERY, false)) {
    warnings.push('ALLOW_WEBHOOK_TOKEN_IN_QUERY está ativo; tokens na URL podem aparecer em logs de proxy e histórico. Prefira header ou Bearer.');
  }
  if (envBool(env.PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS, false)) {
    warnings.push('PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS está ativo. Use somente atrás de proxy confiável e com rede restrita.');
  }

  const cloudEnabled = envBool(env.WA_CLOUD_ENABLED, false);
  const appSecretPresent = [env.WA_EMBEDDED_APP_SECRET, env.META_APP_SECRET, env.FACEBOOK_APP_SECRET]
    .some((value) => clean(value));
  const verifyToken = clean(env.WA_CLOUD_WEBHOOK_VERIFY_TOKEN);
  if (cloudEnabled && !appSecretPresent) {
    warnings.push('Cloud API habilitada sem App Secret no ambiente. O App Secret pode estar no cofre local; o webhook falhará fechado se não estiver disponível em runtime.');
  }
  if (cloudEnabled && verifyToken.length < 24) {
    warnings.push('WA_CLOUD_WEBHOOK_VERIFY_TOKEN ausente ou curto com Cloud API habilitada.');
  }

  const rateSettings = [
    ['PUBLIC_RATE_LIMIT_WINDOW_MS', 60_000],
    ['PUBLIC_FORM_RATE_LIMIT_MAX', 20],
    ['ACTIVECAMPAIGN_RATE_LIMIT_MAX', 120],
    ['CUSTOM_WEBHOOK_RATE_LIMIT_MAX', 120],
    ['META_WEBHOOK_RATE_LIMIT_MAX', 600],
  ];
  for (const [name, fallback] of rateSettings) {
    const raw = clean(env[name]);
    if (raw && (!/^\d+$/.test(raw) || Number(raw) <= 0)) {
      errors.push(`${name} deve ser um número inteiro positivo.`);
    } else if (!raw) {
      info.push(`${name} usará o padrão ${fallback}.`);
    }
  }

  return {
    ok: errors.length === 0,
    mode: normalizedMode,
    errors,
    warnings,
    info,
    publicFormEnabled,
    activeCampaignEnabled: activeEnabled,
    customWebhookSignatureRequired: customWebhookSignatureRequired({ nodeEnv: normalizedMode, configured: env.CUSTOM_WEBHOOK_REQUIRE_SIGNATURE }),
  };
}

module.exports = { validatePublicEndpointConfiguration };
