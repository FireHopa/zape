#!/usr/bin/env bash
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="${ZAPE_APP_USER:-zape}"
APP_GROUP="${ZAPE_APP_GROUP:-zape}"
APP_ROOT="${ZAPE_APP_ROOT:-/opt/zape}"
APP_DIR="${ZAPE_APP_DIR:-${APP_ROOT}/current}"
DATA_DIR="${ZAPE_DATA_DIR:-/var/lib/zape/data}"
LOG_DIR="${ZAPE_LOG_DIR:-/var/log/zape}"
BACKUP_DIR="${ZAPE_BACKUP_DIR:-/var/backups/zape}"
DOMAIN="${ZAPE_DOMAIN:-bobia.com.br}"
CERT_READY="${ZAPE_CERTIFICATE_READY:-0}"
CERT_PATH="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"

run() {
  printf '+ '
  printf '%q ' "$@"
  printf '\n'
  if [[ "$APPLY" == "1" ]]; then "$@"; fi
}

copy_file() {
  local mode="$1" src="$2" dst="$3"
  run install -D -o root -g root -m "$mode" "$src" "$dst"
}

if [[ "$APPLY" == "1" && "${EUID}" -ne 0 ]]; then
  echo "ERRO: execute com root apenas para instalar a infraestrutura; o Node continuará como usuário sem privilégio." >&2
  exit 1
fi

run getent group "$APP_GROUP" || run groupadd --system "$APP_GROUP"
run id -u "$APP_USER" || run useradd --system --gid "$APP_GROUP" --home-dir /var/lib/zape --shell /usr/sbin/nologin "$APP_USER"
run install -d -o "$APP_USER" -g "$APP_GROUP" -m 0750 "$APP_ROOT" "$DATA_DIR" "$LOG_DIR" "$BACKUP_DIR"
run install -d -o root -g root -m 0755 /var/www/letsencrypt /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled

copy_file 0644 "$ROOT_DIR/nginx/zape-http.conf" /etc/nginx/conf.d/zape-http.conf
copy_file 0644 "$ROOT_DIR/nginx/snippets/zape-proxy-common.conf" /etc/nginx/snippets/zape-proxy-common.conf
copy_file 0644 "$ROOT_DIR/nginx/snippets/zape-proxy-stream.conf" /etc/nginx/snippets/zape-proxy-stream.conf
if [[ "$CERT_READY" == "1" || -f "$CERT_PATH" ]]; then
  copy_file 0644 "$ROOT_DIR/nginx/casa-do-ads.conf" /etc/nginx/sites-available/casa-do-ads.conf
else
  copy_file 0644 "$ROOT_DIR/nginx/casa-do-ads-bootstrap.conf" /etc/nginx/sites-available/casa-do-ads.conf
  echo "INFO: certificado ainda não confirmado; instalando configuração bootstrap HTTP." >&2
fi
copy_file 0644 "$ROOT_DIR/deploy/logrotate-zape" /etc/logrotate.d/zape
run ln -sfn /etc/nginx/sites-available/casa-do-ads.conf /etc/nginx/sites-enabled/casa-do-ads.conf
run rm -f /etc/nginx/sites-enabled/default

run chown -R "$APP_USER:$APP_GROUP" "$DATA_DIR" "$LOG_DIR" "$BACKUP_DIR"
run chmod 0750 "$DATA_DIR" "$LOG_DIR" "$BACKUP_DIR"

if [[ -f "$APP_DIR/.env" ]]; then
  run chown "$APP_USER:$APP_GROUP" "$APP_DIR/.env"
  run chmod 0600 "$APP_DIR/.env"
fi

run nginx -t
run systemctl reload nginx
run sudo -u "$APP_USER" -H env ZAPE_APP_DIR="$APP_DIR" ZAPE_LOG_DIR="$LOG_DIR" pm2 start "$APP_DIR/ecosystem.config.cjs" --update-env
run sudo -u "$APP_USER" -H pm2 save

if [[ "$APPLY" == "0" ]]; then
  echo "DRY-RUN concluído. Nenhum comando foi executado. Use --apply somente após backup, certificado válido e revisão do domínio." >&2
fi
