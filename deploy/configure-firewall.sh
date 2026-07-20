#!/usr/bin/env bash
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1
SSH_PORT="${SSH_PORT:-22}"
SSH_ALLOWED_CIDR="${SSH_ALLOWED_CIDR:-}"

run() {
  printf '+ '
  printf '%q ' "$@"
  printf '\n'
  if [[ "$APPLY" == "1" ]]; then "$@"; fi
}

if [[ "$APPLY" == "1" && -z "$SSH_ALLOWED_CIDR" ]]; then
  echo "ERRO: defina SSH_ALLOWED_CIDR antes de aplicar para não perder o acesso SSH." >&2
  exit 1
fi

CIDR="${SSH_ALLOWED_CIDR:-SEU_IP_OU_REDE/32}"
run ufw --force reset
run ufw default deny incoming
run ufw default allow outgoing
run ufw allow from "$CIDR" to any port "$SSH_PORT" proto tcp comment 'SSH restrito'
run ufw allow 80/tcp comment 'HTTP ACME e redirecionamento'
run ufw allow 443/tcp comment 'HTTPS Zape'
run ufw deny 3000/tcp comment 'Node privado'
run ufw deny 3306/tcp comment 'MySQL privado'
run ufw deny 5432/tcp comment 'PostgreSQL privado'
run ufw deny 6379/tcp comment 'Redis privado'
run ufw logging medium
run ufw --force enable
run ufw status verbose

if [[ "$APPLY" == "0" ]]; then
  echo "DRY-RUN concluído. Revise os comandos e execute novamente com --apply." >&2
fi
