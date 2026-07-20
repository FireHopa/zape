#!/usr/bin/env bash
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1
DOMAIN="${ZAPE_DOMAIN:-bobia.com.br}"
WWW_DOMAIN="${ZAPE_WWW_DOMAIN:-www.${DOMAIN}}"
EMAIL="${LETSENCRYPT_EMAIL:-}"

run() {
  printf '+ '
  printf '%q ' "$@"
  printf '\n'
  if [[ "$APPLY" == "1" ]]; then "$@"; fi
}

if [[ "$APPLY" == "1" && -z "$EMAIL" ]]; then
  echo "ERRO: defina LETSENCRYPT_EMAIL antes de emitir o certificado." >&2
  exit 1
fi

run install -d -o www-data -g www-data -m 0755 /var/www/letsencrypt
run certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" -d "$WWW_DOMAIN" --email "${EMAIL:-seu-email@exemplo.com}" --agree-tos --no-eff-email
run nginx -t
run systemctl reload nginx

if [[ "$APPLY" == "0" ]]; then
  echo "DRY-RUN concluído. Instale primeiro a configuração bootstrap do Nginx." >&2
fi
