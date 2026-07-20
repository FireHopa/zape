#!/usr/bin/env bash
set -euo pipefail
APPLY=0
for arg in "$@"; do [[ "$arg" == "--apply" ]] && APPLY=1; done
RELEASE_DIR="${RELEASE_DIR:-}"
RELEASE_ID="${RELEASE_ID:-}"
CURRENT_LINK="${CURRENT_LINK:-/opt/zape/current}"
PREVIOUS_LINK="${PREVIOUS_LINK:-/opt/zape/previous}"
STATE_FILE="${DEPLOY_STATE_FILE:-/var/lib/zape/deployment-state.json}"
HEALTH_URL="${DEPLOY_HEALTH_URL:-https://bobia.com.br/health}"
if [[ -z "$RELEASE_DIR" || -z "$RELEASE_ID" ]]; then echo 'RELEASE_DIR e RELEASE_ID são obrigatórios.' >&2; exit 1; fi
if [[ "$APPLY" -ne 1 ]]; then
  printf 'DRY-RUN: ativaria %s em %s, reiniciaria PM2 e monitoraria %s\n' "$RELEASE_DIR" "$CURRENT_LINK" "$HEALTH_URL"
  exit 0
fi
node "$RELEASE_DIR/scripts/activate-release.js" --release-dir="$RELEASE_DIR" --release-id="$RELEASE_ID" --current-link="$CURRENT_LINK" --previous-link="$PREVIOUS_LINK" --state-file="$STATE_FILE" --apply --confirm=ACTIVATE_RELEASE
if ! sudo -u zape -H pm2 startOrReload "$CURRENT_LINK/ecosystem.config.cjs" --update-env; then
  node "$RELEASE_DIR/scripts/rollback-release.js" --current-link="$CURRENT_LINK" --previous-link="$PREVIOUS_LINK" --state-file="$STATE_FILE" --apply --confirm=ROLLBACK_RELEASE || true
  sudo -u zape -H pm2 startOrReload "$CURRENT_LINK/ecosystem.config.cjs" --update-env || true
  exit 1
fi
if ! node "$CURRENT_LINK/scripts/post-deploy-monitor.js" --health-url="$HEALTH_URL" --release-id="$RELEASE_ID" --iterations="${DEPLOY_MONITOR_ITERATIONS:-5}" --interval-ms="${DEPLOY_MONITOR_INTERVAL_MS:-5000}"; then
  node "$CURRENT_LINK/scripts/rollback-release.js" --current-link="$CURRENT_LINK" --previous-link="$PREVIOUS_LINK" --state-file="$STATE_FILE" --apply --confirm=ROLLBACK_RELEASE
  sudo -u zape -H pm2 startOrReload "$CURRENT_LINK/ecosystem.config.cjs" --update-env
  exit 1
fi
