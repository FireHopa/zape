#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-/home/deploy/lead-form/.env}"
DOMAIN="${2:-bobia.com.br}"
APP_DIR="${3:-/home/deploy/lead-form}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="${ENV_FILE}.backup-${TIMESTAMP}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERRO: arquivo não encontrado: $ENV_FILE" >&2
  exit 1
fi

cp -a "$ENV_FILE" "$BACKUP_FILE"
echo "Backup criado: $BACKUP_FILE"

export ENV_FILE DOMAIN APP_DIR TIMESTAMP
python3 <<'PY'
from __future__ import annotations
import base64
import os
import re
import secrets
import subprocess
from pathlib import Path

path = Path(os.environ['ENV_FILE'])
domain = os.environ['DOMAIN'].strip()
app_dir = Path(os.environ['APP_DIR']).resolve()
timestamp = os.environ['TIMESTAMP']

text = path.read_text(encoding='utf-8')
lines = text.splitlines()

# Mantém valores sensíveis já presentes e só gera os que estiverem ausentes.
def current_value(key: str) -> str:
    pattern = re.compile(rf'^\s*{re.escape(key)}\s*=\s*(.*)$')
    for line in lines:
        m = pattern.match(line)
        if m:
            value = m.group(1).strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            return value.strip()
    return ''

def hex_secret(bytes_len: int = 32) -> str:
    return secrets.token_hex(bytes_len)

def b64_secret(bytes_len: int = 32) -> str:
    return base64.b64encode(secrets.token_bytes(bytes_len)).decode('ascii')

try:
    release_commit = subprocess.check_output(
        ['git', '-C', str(app_dir), 'rev-parse', 'HEAD'],
        text=True,
        stderr=subprocess.DEVNULL,
    ).strip()
except Exception:
    release_commit = ''

session_secret = current_value('SESSION_SECRET') or hex_secret(64)
config_key = current_value('CONFIG_ENCRYPTION_KEY') or b64_secret(32)
backup_key = current_value('BACKUP_ENCRYPTION_KEY') or b64_secret(32)
public_form_token = current_value('PUBLIC_LEAD_FORM_TOKEN') or hex_secret(32)
activecampaign_token = current_value('ACTIVECAMPAIGN_WEBHOOK_TOKEN') or hex_secret(32)
release_id = current_value('RELEASE_ID')
if not release_id or release_id in {'development', 'replace-me'}:
    release_id = f'phase16-{timestamp}'

updates = {
    # Runtime e proxy
    'NODE_ENV': 'production',
    'HOST': '127.0.0.1',
    'PORT': current_value('PORT') or '3000',
    'TRUST_PROXY_HOPS': '1',
    'DEBUG': '0',
    'DEBUG_AUTH': '0',
    'AUDIO_DEBUG': '0',
    'PUBLIC_BASE_URL': f'https://{domain}',
    'APP_ALLOWED_ORIGINS': f'https://{domain},https://www.{domain}',
    'INFRA_ALLOW_ROOT_PROCESS': '0',
    'INFRA_ALLOW_HTTP_FOR_TESTS': '0',
    'ZAPE_DATA_DIR': str(app_dir / 'data'),
    'ZAPE_LOG_DIR': str(app_dir / 'logs'),
    'ZAPE_BACKUP_DIR': str(app_dir / 'backups'),
    'ZAPE_APP_DIR': str(app_dir),
    'ZAPE_MAX_MEMORY': '1G',

    # Sessão e login
    'SESSION_SECRET': session_secret,
    'SESSION_STORE_FILE': str(app_dir / 'data' / 'auth_sessions.json'),
    'AUTH_RATE_LIMIT_WINDOW_MS': '900000',
    'AUTH_RATE_LIMIT_BLOCK_MS': '900000',
    'AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS': '12',
    'AUTH_RATE_LIMIT_TENANT_IP_MAX_ATTEMPTS': '6',
    'AUTH_RATE_LIMIT_TENANT_MAX_ATTEMPTS': '120',
    'AUTH_TRUST_PROXY_HEADERS': '1',

    # Papéis
    'ADMIN_ROLE': 'super_admin',
    'PANEL_ROLE': current_value('PANEL_ROLE') or 'tenant_admin',
    'REGINA_ROLE': current_value('REGINA_ROLE') or 'tenant_admin',
    'PORTUGAL_ROLE': current_value('PORTUGAL_ROLE') or 'tenant_admin',
    'FELIPE_ROLE': current_value('FELIPE_ROLE') or 'tenant_admin',
    'ANA_ROLE': current_value('ANA_ROLE') or 'tenant_admin',
    'FELIPE_USER': (current_value('FELIPE_USER') or 'felipe').strip(),

    # Endpoints públicos e webhooks
    'PUBLIC_LEAD_FORM_ENABLED': '0',
    'PUBLIC_LEAD_FORM_TOKEN': public_form_token,
    'ACTIVECAMPAIGN_WEBHOOK_ENABLED': '0',
    'ACTIVECAMPAIGN_WEBHOOK_TOKEN': activecampaign_token,
    'CUSTOM_WEBHOOK_REQUIRE_SIGNATURE': '1',
    'CUSTOM_WEBHOOK_CLOCK_TOLERANCE_SECONDS': '300',
    'ALLOW_WEBHOOK_TOKEN_IN_QUERY': '0',
    'PUBLIC_ENDPOINT_TRUST_PROXY_HEADERS': '1',
    'PUBLIC_FORM_BODY_LIMIT': '250kb',
    'PUBLIC_WEBHOOK_BODY_LIMIT': '500kb',
    'META_WEBHOOK_BODY_LIMIT': '1mb',
    'PUBLIC_RATE_LIMIT_WINDOW_MS': '60000',
    'PUBLIC_FORM_RATE_LIMIT_MAX': '20',
    'ACTIVECAMPAIGN_RATE_LIMIT_MAX': '120',
    'CUSTOM_WEBHOOK_RATE_LIMIT_MAX': '120',
    'META_WEBHOOK_RATE_LIMIT_MAX': '600',
    'WEBHOOK_IDEMPOTENCY_FILE': str(app_dir / 'data' / 'webhook_idempotency.json'),
    'WEBHOOK_IDEMPOTENCY_RETENTION_MS': '604800000',
    'WEBHOOK_IDEMPOTENCY_PENDING_TIMEOUT_MS': '900000',
    'ENABLE_DEBUG_ACTIVE': '0',

    # WhatsApp Web
    'WEBJS_ENABLED': current_value('WEBJS_ENABLED') or '1',
    'WEBJS_AUTO_START': '1',
    'WEBJS_AUTO_START_TENANTS': 'admin,panel,regina,portugal,felipe,ana',
    'WEBJS_HEADLESS': current_value('WEBJS_HEADLESS') or '1',
    'WEBJS_NO_SANDBOX': current_value('WEBJS_NO_SANDBOX') or '1',
    'WEBJS_WEB_VERSION': '',
    'WEBJS_REMOTE_CACHE': '0',
    'WEBJS_REMOTE_PATH': '',
    'WEBJS_REMOTE_STRICT': '0',
    'WEBJS_DEFAULT_TEMPLATE_TEXT': 'Mensagem de teste',
    'CHROME_EXECUTABLE_PATH': current_value('CHROME_EXECUTABLE_PATH') or str(app_dir / 'chrome' / 'chrome-linux' / 'chrome'),
    'FFMPEG_PATH': '/usr/bin/ffmpeg',
    'WA_READY_TIMEOUT_MS': '60000',
    'WA_AUTH_WATCHDOG_MS': '60000',
    'WA_AUTH_WATCHDOG_INTERVAL_MS': '2000',

    # CRM
    'CRM_INTEGRATION_ENABLED': current_value('CRM_INTEGRATION_ENABLED') or '1',
    'EXTERNAL_CRM_QUEUE_FILE': str(app_dir / 'data' / 'external_crm_queue.json'),
    'CRM_INTEGRATION_TIMEOUT_MS': current_value('CRM_INTEGRATION_TIMEOUT_MS') or '15000',
    'CRM_INTEGRATION_MAX_ATTEMPTS': current_value('CRM_INTEGRATION_MAX_ATTEMPTS') or '6',
    'CRM_INTEGRATION_WORKER_INTERVAL_MS': current_value('CRM_INTEGRATION_WORKER_INTERVAL_MS') or '30000',
    'CRM_INTEGRATION_ACTIVE_CAMPAIGN_TO_CRM_ENABLED': current_value('CRM_INTEGRATION_ACTIVE_CAMPAIGN_TO_CRM_ENABLED') or '1',
    'CRM_INTEGRATION_ACTIVE_CAMPAIGN_PIPELINE_ID': current_value('CRM_INTEGRATION_ACTIVE_CAMPAIGN_PIPELINE_ID'),
    'CRM_INTEGRATION_ACTIVE_CAMPAIGN_STAGE_ID': current_value('CRM_INTEGRATION_ACTIVE_CAMPAIGN_STAGE_ID'),
    'CRM_INTEGRATION_ACTIVE_CAMPAIGN_SOURCE': current_value('CRM_INTEGRATION_ACTIVE_CAMPAIGN_SOURCE') or 'WhatsApp',

    # Cloud API
    'WA_CLOUD_ENABLED': current_value('WA_CLOUD_ENABLED') or '1',
    'WA_CLOUD_GRAPH_VERSION': 'v25.0',
    'WA_CLOUD_FORCE_ENV': '1',
    'WA_CLOUD_CONNECTION_OWNER_TENANT': 'admin',
    'WA_CLOUD_QUEUE_POLL_MS': '250',
    'WA_CLOUD_QUEUE_MAX_ATTEMPTS': '5',
    'WA_CLOUD_QUEUE_RETRY_BASE_MS': '1000',
    'WA_CLOUD_QUEUE_RETRY_MAX_MS': '60000',
    'WA_CLOUD_CAMPAIGN_MAX_CONTACTS': '10000',
    'WA_EMBEDDED_APP_ID': current_value('WA_EMBEDDED_APP_ID'),
    'WA_EMBEDDED_APP_SECRET': current_value('WA_EMBEDDED_APP_SECRET'),
    'WA_EMBEDDED_CONFIG_ID': current_value('WA_EMBEDDED_CONFIG_ID'),
    'WA_EMBEDDED_REDIRECT_URI': f'https://{domain}/admin',

    # Cofre
    'CONFIG_ENCRYPTION_KEY': config_key,
    # Temporário para compatibilidade com os JSONs antigos; desative após executar a migração de segredos.
    'ALLOW_LEGACY_PLAINTEXT_SECRETS': '1',

    # Mídias
    'AUTHENTICATED_BODY_LIMIT': '16mb',
    'MEDIA_ABSOLUTE_MAX_BYTES': '26214400',
    'MEDIA_AUDIO_MAX_BYTES': '10485760',
    'MEDIA_IMAGE_MAX_BYTES': '12582912',
    'MEDIA_VIDEO_MAX_BYTES': '26214400',
    'MEDIA_PDF_MAX_BYTES': '20971520',
    'MEDIA_DOCUMENT_MAX_BYTES': '20971520',
    'MEDIA_SPREADSHEET_MAX_BYTES': '20971520',
    'MEDIA_PRESENTATION_MAX_BYTES': '20971520',
    'MEDIA_ARCHIVE_MAX_BYTES': '15728640',
    'MEDIA_TEXT_MAX_BYTES': '2097152',
    'MEDIA_SCANNER_COMMAND_JSON': current_value('MEDIA_SCANNER_COMMAND_JSON'),
    'MEDIA_SCANNER_REQUIRED': '0',
    'MEDIA_SCANNER_TIMEOUT_MS': '30000',
    'MEDIA_ORPHAN_RETENTION_DAYS': '30',

    # Integridade e banco
    'DATA_INTEGRITY_VALIDATE_ON_BOOT': '1',
    'DATA_INTEGRITY_STRICT_BOOT': '0',
    'LEADS_INVALID_LINE_QUARANTINE': '1',
    'PERSISTENCE_MODE': 'json',
    'DATABASE_SSL': 'require',
    'DATABASE_POOL_MAX': '10',
    'DATABASE_STATEMENT_TIMEOUT_MS': '15000',
    'DATABASE_IDLE_TIMEOUT_MS': '30000',
    'DATABASE_CONNECTION_TIMEOUT_MS': '5000',

    # Observabilidade, backup e LGPD
    'LOG_LEVEL': 'info',
    'STRUCTURED_LOG_FILE': str(app_dir / 'logs' / 'application.jsonl'),
    'STRUCTURED_LOG_MAX_BYTES': '10485760',
    'STRUCTURED_LOG_MAX_FILES': '10',
    'SECURITY_AUDIT_FILE': str(app_dir / 'data' / 'audit' / 'security_audit.jsonl'),
    'MONITOR_INTERVAL_MS': '300000',
    'ALERT_COOLDOWN_MS': '900000',
    'ALERT_WEBHOOK_URL': current_value('ALERT_WEBHOOK_URL'),
    'ALERT_WEBHOOK_TOKEN': current_value('ALERT_WEBHOOK_TOKEN'),
    'ALERT_STATE_FILE': str(app_dir / 'data' / 'monitoring' / 'alerts_state.json'),
    'ALERT_DISK_USED_PERCENT': '85',
    'ALERT_QUEUE_STALLED_MS': '900000',
    'ALERT_BACKUP_MAX_AGE_MS': '93600000',
    'BACKUP_DIRECTORY': str(app_dir / 'backups' / 'local'),
    # Temporário: idealmente substitua por volume/disco/storage realmente externo.
    'BACKUP_REMOTE_DIRECTORY': str(app_dir / 'backups' / 'offsite'),
    'BACKUP_ENCRYPTION_KEY': backup_key,
    'RETENTION_LOGS_DAYS': '30',
    'RETENTION_AUDIT_DAYS': '365',
    'RETENTION_EXPORTS_DAYS': '7',
    'RETENTION_BACKUPS_DAYS': '30',
    'RETENTION_WEBHOOK_EVENTS_DAYS': '30',
    'RETENTION_MESSAGE_STATUSES_DAYS': '180',
    'RETENTION_CLOUD_EVENTS_DAYS': '180',
    'RETENTION_MEDIA_DAYS': '365',
    'RETENTION_JOBS_DAYS': '30',
    'EXPORT_DIRECTORY': str(app_dir / 'exports'),

    # Release e feature flags
    'RELEASE_ID': release_id,
    'RELEASE_COMMIT': release_commit,
    'RELEASE_BUILT_AT': timestamp,
    'DEPLOYMENT_ENVIRONMENT': 'production',
    'DEPLOYMENT_ROLLOUT_SEED': release_id,
    'DEPLOY_HEALTH_URL': f'https://{domain}/health',
    'DEPLOY_STATE_FILE': str(app_dir / 'data' / 'deployment-state.json'),
    'FEATURE_AUTH_V2': '1',
    'FEATURE_DATABASE_PERSISTENCE': '1',
    'FEATURE_CLOUD_QUEUE': '1',
    'FEATURE_SECURE_MEDIA': '1',
    'FEATURE_CLOUD_API_V2': '1',
    'FEATURE_LEAD_PAGINATION': '1',
    'FEATURE_FRONTEND_V2': '1',
}

# Remove apenas variáveis legadas que causam confusão. ADMIN_KEY é mantida por compatibilidade externa.
remove_keys = {'ACTIVE_CAMPAIGN_SECRET', 'AUTH_SECRET', 'CORS_ALLOWED_ORIGINS', 'APP_BASE_URL'}

out = []
written = set()
for line in lines:
    m = re.match(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=.*$', line)
    if not m:
        out.append(line)
        continue
    key = m.group(1)
    if key in remove_keys:
        continue
    if key in updates:
        if key not in written:
            value = str(updates[key])
            # Aspas simples são seguras para espaços e caracteres UTF-8 em dotenv.
            if re.search(r'[\s#"\']', value):
                value = "'" + value.replace("'", "\\'") + "'"
            out.append(f'{key}={value}')
            written.add(key)
        continue
    out.append(line)

out.append('')
out.append('# =========================')
out.append('# Configurações adicionadas pela Fase 16')
out.append('# =========================')
for key, value in updates.items():
    if key in written:
        continue
    value = str(value)
    if re.search(r'[\s#"\']', value):
        value = "'" + value.replace("'", "\\'") + "'"
    out.append(f'{key}={value}')
    written.add(key)

path.write_text('\n'.join(out).rstrip() + '\n', encoding='utf-8')

required_existing = [
    'ADMIN_USER', 'ADMIN_PASS',
    'PANEL_USER', 'PANEL_PASS',
    'REGINA_USER', 'REGINA_PASS',
    'PORTUGAL_USER', 'PORTUGAL_PASS',
    'FELIPE_USER', 'FELIPE_PASS',
    'ANA_USER', 'ANA_PASS',
]
cloud_existing = ['WA_CLOUD_TOKEN', 'WA_CLOUD_PHONE_NUMBER_ID', 'WA_CLOUD_WABA_ID', 'WA_CLOUD_WEBHOOK_VERIFY_TOKEN']
crm_existing = ['CRM_INTEGRATION_URL', 'CRM_INTEGRATION_KEY']
missing = [key for key in required_existing + cloud_existing + crm_existing if not current_value(key)]
if missing:
    print('ATENÇÃO: variáveis que ainda precisam ser preenchidas:', ', '.join(missing))
else:
    print('Credenciais existentes foram preservadas.')

if not current_value('WA_EMBEDDED_APP_SECRET'):
    print('ATENÇÃO: WA_EMBEDDED_APP_SECRET não está configurado. O envio Cloud pode funcionar, mas a validação de assinatura do webhook Meta depende do App Secret salvo no cofre/JSON ou nesta variável.')
PY

mkdir -p \
  "$APP_DIR/data/audit" \
  "$APP_DIR/data/monitoring" \
  "$APP_DIR/logs" \
  "$APP_DIR/backups/local" \
  "$APP_DIR/backups/offsite" \
  "$APP_DIR/exports"

chmod 600 "$ENV_FILE"
chmod 700 "$APP_DIR/data/audit" "$APP_DIR/data/monitoring" "$APP_DIR/backups/local" "$APP_DIR/backups/offsite" 2>/dev/null || true

echo
echo "Arquivo atualizado: $ENV_FILE"
echo "Agora execute:"
echo "  cd $APP_DIR"
echo "  npm run validate:config -- --mode=production --strict"
echo "  pm2 restart bobia --update-env"
echo "  pm2 logs bobia --lines 120"
