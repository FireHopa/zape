#!/usr/bin/env bash
set -euo pipefail
DOMAIN="${ZAPE_DOMAIN:-bobia.com.br}"

curl --fail --silent --show-error --max-time 10 "https://${DOMAIN}/health" >/dev/null
curl --fail --silent --show-error --head --max-time 10 "http://${DOMAIN}/" | grep -Eq '^HTTP/.* 30[18]'
curl --fail --silent --show-error --head --max-time 10 "https://${DOMAIN}/" | grep -qi '^strict-transport-security:'
ss -ltnp | grep -Eq '127\.0\.0\.1:3000|\[::1\]:3000'
if ss -ltnp | grep -Eq '0\.0\.0\.0:3000|\[::\]:3000'; then
  echo 'ERRO: porta 3000 exposta externamente.' >&2
  exit 1
fi

echo 'Deploy validado: HTTPS, HSTS, redirect e bind local ativos.'
