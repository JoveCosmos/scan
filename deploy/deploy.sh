#!/usr/bin/env bash
#
# Deploy the explorer, mirroring the gata-hub pipeline on the same box:
# release directories + atomic symlink swap + health check + auto-rollback.
#
# Release dirs are not ceremony: `next build` rewrites .next underneath the
# running server, so building in the live directory serves 404s until the
# restart lands. Build in a new directory, then swap.
#
#   ./deploy.sh          # deploy only if origin/<branch> moved
#   ./deploy.sh --force  # rebuild the current commit anyway
#
set -euo pipefail

ROOT="${ROOT:-/srv/explorer}"
REPO="$ROOT/repo"
RELEASES="$ROOT/releases"
SHARED="$ROOT/shared"
CURRENT="$ROOT/current"
BRANCH="${BRANCH:-master}"
SERVICE="${SERVICE:-explorer}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3200/}"
KEEP="${KEEP:-3}"
FORCE="${1:-}"

log() { printf '[deploy %s] %s\n' "$(date -u +%F' '%H:%M:%S)" "$*"; }
fail() { log "ERROR: $*"; exit 1; }

mkdir -p "$RELEASES" "$SHARED/valopers"

cd "$REPO"
git fetch --quiet origin "$BRANCH"

current_sha=$(readlink -f "$CURRENT" 2>/dev/null | xargs -r basename || echo "none")
target_sha=$(git rev-parse "origin/$BRANCH")
short="${target_sha:0:8}"

if [ "$current_sha" = "$target_sha" ] && [ "$FORCE" != "--force" ]; then
  log "already serving $short, nothing to do"
  exit 0
fi

release="$RELEASES/$target_sha"
log "building $short into $release"

# A half-built directory from a previous failed run must not be reused.
rm -rf "$release"
mkdir -p "$release"
git archive "$target_sha" | tar -x -C "$release"

cd "$release"

# Reuse the previous node_modules when dependencies are unchanged; npm ci wipes
# and reinstalls, which is the slowest step by far on a small box.
if [ -d "$CURRENT/node_modules" ] && \
   cmp -s "$CURRENT/package-lock.json" "$release/package-lock.json"; then
  log "dependencies unchanged, reusing node_modules"
  cp -al "$CURRENT/node_modules" "$release/node_modules" 2>/dev/null || \
    cp -a "$CURRENT/node_modules" "$release/node_modules"
else
  log "installing dependencies"
  npm ci --no-audit --no-fund || fail "npm ci failed"
fi

log "running next build"
npm run build || fail "build failed, current release untouched"

# Atomic swap: ln -sfn then mv -T replaces the symlink in one operation, so a
# request can never observe a missing 'current'.
previous_sha="$current_sha"
ln -sfn "$release" "$ROOT/.current.tmp"
mv -T "$ROOT/.current.tmp" "$CURRENT"
log "swapped current -> $short"

log "restarting $SERVICE"
sudo systemctl restart "$SERVICE"

# The startup warm makes ~96 gno realm calls, so allow a generous window before
# calling it unhealthy.
healthy=0
for _ in $(seq 1 30); do
  sleep 3
  if curl -fsS --max-time 5 -o /dev/null "$HEALTH_URL"; then healthy=1; break; fi
done

if [ "$healthy" -ne 1 ]; then
  log "health check failed"
  if [ "$previous_sha" != "none" ] && [ -d "$RELEASES/$previous_sha" ]; then
    log "rolling back to ${previous_sha:0:8}"
    ln -sfn "$RELEASES/$previous_sha" "$ROOT/.current.tmp"
    mv -T "$ROOT/.current.tmp" "$CURRENT"
    sudo systemctl restart "$SERVICE"
    fail "rolled back to ${previous_sha:0:8}"
  fi
  fail "unhealthy and no previous release to roll back to"
fi

log "healthy at $short"

# Keep the newest $KEEP releases plus whatever 'current' points at.
keep_path=$(readlink -f "$CURRENT")
ls -1dt "$RELEASES"/* 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "$(readlink -f "$old")" = "$keep_path" ] && continue
  log "pruning $(basename "$old" | cut -c1-8)"
  rm -rf "$old"
done

log "done"
