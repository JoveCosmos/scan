#!/usr/bin/env bash
# Rename the live deployment from "explorer" to "scan", in place.
#
#   sudo /srv/explorer/repo/deploy/migrate-to-scan.sh
#
# SPENT — this ran on 2026-08-13 and is kept as a record of what moved. Do not
# run it again; /srv/explorer no longer exists. The notes below describe the box
# as it was at that moment, so two of them have since been overtaken: the GitHub
# repo was renamed to JoveCosmos/scan, and the deploy key was split into a
# read-only production key plus a separate write key in the dev tree (see
# setup-dev.sh). The hostname is still explorer.gatahub.zone.
#
# Every step checks whether it has already been done, so a run that fails
# halfway can be fixed and re-run rather than unpicked. Nothing here touches the
# indexer: it is a separate account with its own database credentials, and the
# backfill may well be running.
#
# What deliberately does NOT change:
#   - the GitHub repo, still JoveCosmos/explorer
#   - the public hostname, still explorer.gatahub.zone
# Both need action outside this box (a GitHub setting, a DNS record), so they
# are left for later. Everything internal is renamed now.
#
# The Postgres role is renamed rather than recreated. That is only safe because
# the cluster uses scram-sha-256, whose verifier does not include the user name
# — under the older md5 scheme the stored hash covers user+password, and a
# rename would silently invalidate the password. Checked below rather than
# assumed.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

say() { printf '\n== %s\n' "$*"; }
skip() { printf '   (already done) %s\n' "$*"; }

# ── 1. Stop what is running under the old name ────────────────────────────────
say "stopping services"
for u in explorer-deploy.timer explorer-deploy.service explorer.service; do
  systemctl stop "$u" 2>/dev/null || true
  systemctl disable "$u" 2>/dev/null || true
done

# ── 2. User and group ─────────────────────────────────────────────────────────
say "renaming user and group"
if id explorer >/dev/null 2>&1; then
  # usermod refuses while any process of that user is alive.
  pkill -u explorer 2>/dev/null || true
  sleep 1
  usermod -l scan explorer
  groupmod -n scan explorer
  echo "   explorer -> scan"
else
  skip "user is already scan"
fi

# ── 3. Home directory ─────────────────────────────────────────────────────────
say "moving /srv/explorer -> /srv/scan"
if [ -d /srv/explorer ] && [ ! -e /srv/scan ]; then
  mv /srv/explorer /srv/scan
else
  skip "/srv/scan"
fi
usermod -d /srv/scan scan
chown -R scan:scan /srv/scan
chmod 750 /srv/scan

# The release symlink and the git config both embed the old absolute path.
say "repointing paths inside the tree"
if [ -L /srv/scan/current ]; then
  target="$(readlink /srv/scan/current | sed 's#/srv/explorer#/srv/scan#')"
  ln -sfn "$target" /srv/scan/current.tmp && mv -Tf /srv/scan/current.tmp /srv/scan/current
  echo "   current -> $target"
fi

if [ -f /srv/scan/.ssh/explorer_deploy ]; then
  mv /srv/scan/.ssh/explorer_deploy     /srv/scan/.ssh/scan_deploy
  mv /srv/scan/.ssh/explorer_deploy.pub /srv/scan/.ssh/scan_deploy.pub
  echo "   deploy key renamed"
else
  skip "deploy key"
fi
chown -R scan:scan /srv/scan/.ssh
chmod 700 /srv/scan/.ssh
chmod 600 /srv/scan/.ssh/scan_deploy

# core.sshCommand is stored in the repo config and still names the old path.
KEY="ssh -i /srv/scan/.ssh/scan_deploy -o IdentitiesOnly=yes -o UserKnownHostsFile=/srv/scan/.ssh/known_hosts"
sudo -u scan git -C /srv/scan/repo config core.sshCommand "$KEY"
echo "   git sshCommand updated"

# ── 4. /opt and the environment file ──────────────────────────────────────────
say "moving /opt/explorer -> /opt/scan"
if [ -d /opt/explorer ] && [ ! -e /opt/scan ]; then
  mv /opt/explorer /opt/scan
else
  skip "/opt/scan"
fi
mkdir -p /opt/scan
chown -R scan:scan /opt/scan

say "moving /etc/gata/explorer.env -> /etc/gata/scan.env"
if [ -f /etc/gata/explorer.env ] && [ ! -e /etc/gata/scan.env ]; then
  mv /etc/gata/explorer.env /etc/gata/scan.env
else
  skip "/etc/gata/scan.env"
fi
if [ -f /etc/gata/scan.env ]; then
  chown root:scan /etc/gata/scan.env
  chmod 640 /etc/gata/scan.env
fi

# ── 5. Postgres role ──────────────────────────────────────────────────────────
say "renaming the read-only database role"
enc="$(docker exec gata-indexer-db psql -U indexer -d gata_indexer -tAc 'SHOW password_encryption' 2>/dev/null || true)"
if [ "$enc" != "scram-sha-256" ]; then
  echo "   password_encryption is '$enc', not scram-sha-256." >&2
  echo "   Renaming would invalidate the password under md5. Skipping;" >&2
  echo "   create scan_ro manually and update /etc/gata/scan.env." >&2
elif docker exec gata-indexer-db psql -U indexer -d gata_indexer -tAc \
       "SELECT 1 FROM pg_roles WHERE rolname='explorer_ro'" | grep -q 1; then
  docker exec gata-indexer-db psql -U indexer -d gata_indexer \
    -c "ALTER ROLE explorer_ro RENAME TO scan_ro"
  # The connection string still names the old role.
  sed -i 's#postgres://explorer_ro:#postgres://scan_ro:#' /etc/gata/scan.env
  echo "   explorer_ro -> scan_ro (password preserved)"
else
  skip "scan_ro"
fi

# ── 6. systemd units ──────────────────────────────────────────────────────────
say "installing units"
# The release, not /srv/scan/repo. That repo is only ever fetched into — its
# working tree stays on whatever commit it was cloned at, months behind, because
# releases are built with `git archive` from origin. Reading unit files from
# there would install stale ones that look plausible.
SRC=/srv/scan/current/deploy
[ -d "$SRC" ] || { echo "no deploy dir at $SRC" >&2; exit 1; }
for pair in "scan.service" "scan-deploy.service" "scan-deploy.timer"; do
  [ -f "$SRC/$pair" ] && install -m 644 "$SRC/$pair" "/etc/systemd/system/$pair"
done
rm -f /etc/systemd/system/explorer.service \
      /etc/systemd/system/explorer-deploy.service \
      /etc/systemd/system/explorer-deploy.timer
systemctl daemon-reload

# ── 7. sudoers ────────────────────────────────────────────────────────────────
say "sudoers"
printf 'scan ALL=(root) NOPASSWD: /usr/bin/systemctl restart scan\n' \
  > /etc/sudoers.d/scan-deploy
chmod 440 /etc/sudoers.d/scan-deploy
rm -f /etc/sudoers.d/explorer-deploy
visudo -c >/dev/null

# ── 8. nginx ──────────────────────────────────────────────────────────────────
# The hostname stays explorer.gatahub.zone; only the upstream's internal name
# changes, so no certificate is touched.
say "nginx"
if [ -f /etc/nginx/sites-available/explorer ]; then
  sed -i 's/explorer_upstream/scan_upstream/g' /etc/nginx/sites-available/explorer
  mv /etc/nginx/sites-available/explorer /etc/nginx/sites-available/scan
  rm -f /etc/nginx/sites-enabled/explorer
  ln -sfn /etc/nginx/sites-available/scan /etc/nginx/sites-enabled/scan
  nginx -t && systemctl reload nginx
  echo "   site renamed, server_name unchanged"
else
  skip "nginx site"
fi

# ── 9. Bring it back up ───────────────────────────────────────────────────────
say "starting"
install -o scan -g scan -m 755 "$SRC/deploy.sh" /opt/scan/deploy.sh
systemctl enable scan.service
systemctl enable --now scan-deploy.timer

# A forced rebuild rather than a restart of what was moved. `next build` bakes
# absolute paths into its output — the file-tracing manifests name them — so a
# release built at /srv/explorer/releases/<sha> and then moved is not reliably
# runnable from /srv/scan/releases/<sha>. It might start and fail later on a
# route that needs a traced file, which is the worst version of this.
#
# deploy.sh builds a fresh release at the new path, health-checks it, and rolls
# back on failure, so this is also the step that proves the rename worked.
say "rebuilding at the new path"
sudo -u scan /opt/scan/deploy.sh --force

say "verifying"
sleep 5
systemctl is-active scan.service
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3200/ || true)
echo "   local http: $code"
n=$(tr '\0' '\n' < "/proc/$(systemctl show scan -p MainPID --value)/environ" 2>/dev/null | grep -c INDEXER_DATABASE_URL || true)
echo "   INDEXER_DATABASE_URL present: $n"

cat <<'EOF'

Done. Left deliberately unchanged:
  - GitHub repo   JoveCosmos/explorer
  - hostname      explorer.gatahub.zone

Next, for write access from the dev clone: GitHub deploy keys cannot be
switched from read-only to read-write after creation. Delete the existing key
at https://github.com/JoveCosmos/explorer/settings/keys and add this same
public key again with "Allow write access" ticked:

EOF
cat /srv/scan/.ssh/scan_deploy.pub
