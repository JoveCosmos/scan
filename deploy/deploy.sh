#!/usr/bin/env bash
#
# Pull, build and restart the explorer. Safe to run on a timer: it exits early
# when the remote has not moved, so a scheduled run costs one `git fetch`.
#
#   ./deploy.sh          # build only if origin/<branch> changed
#   ./deploy.sh --force  # always rebuild (use after changing env or nginx)
#
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/explorer}"
BRANCH="${BRANCH:-master}"
SERVICE="${SERVICE:-explorer}"
FORCE="${1:-}"

cd "$APP_DIR"

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

git fetch --quiet origin "$BRANCH"

local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse "origin/$BRANCH")

if [ "$local_sha" = "$remote_sha" ] && [ "$FORCE" != "--force" ]; then
  log "already at ${local_sha:0:8}, nothing to do"
  exit 0
fi

log "updating ${local_sha:0:8} -> ${remote_sha:0:8}"
git reset --hard "origin/$BRANCH"

# npm ci needs the lockfile to match package.json; it wipes node_modules, so it
# only runs when dependencies actually changed.
if ! git diff --quiet "$local_sha" "$remote_sha" -- package-lock.json package.json; then
  log "dependencies changed, running npm ci"
  npm ci --no-audit --no-fund
else
  log "dependencies unchanged"
fi

log "building"
npm run build

log "restarting $SERVICE"
sudo systemctl restart "$SERVICE"

# Give the service a moment, then confirm it is actually serving.
sleep 3
if systemctl is-active --quiet "$SERVICE"; then
  log "done, $SERVICE active at ${remote_sha:0:8}"
else
  log "ERROR: $SERVICE failed to start"
  systemctl status "$SERVICE" --no-pager --lines 20 || true
  exit 1
fi
