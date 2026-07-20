#!/usr/bin/env bash
set -euo pipefail
APPLY=0
for arg in "$@"; do [[ "$arg" == "--apply" ]] && APPLY=1; done
CURRENT_LINK="${CURRENT_LINK:-/opt/zape/current}"
PREVIOUS_LINK="${PREVIOUS_LINK:-/opt/zape/previous}"
STATE_FILE="${DEPLOY_STATE_FILE:-/var/lib/zape/deployment-state.json}"
if [[ "$APPLY" -ne 1 ]]; then
  printf 'DRY-RUN: reverteria %s para %s sem alterar banco.\n' "$CURRENT_LINK" "$PREVIOUS_LINK"
  exit 0
fi
node "$CURRENT_LINK/scripts/rollback-release.js" --current-link="$CURRENT_LINK" --previous-link="$PREVIOUS_LINK" --state-file="$STATE_FILE" --apply --confirm=ROLLBACK_RELEASE
sudo -u zape -H pm2 startOrReload "$CURRENT_LINK/ecosystem.config.cjs" --update-env
