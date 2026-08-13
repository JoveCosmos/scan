#!/usr/bin/env bash
# Create the dev-on-server tree for GATA SCAN.
#
#   sudo /srv/scan/current/deploy/setup-dev.sh
#
# Mirrors gata-hub's arrangement: one account for both the deployed app and the
# development clone, a separate working tree, and the agent's HOME kept out of
# the deploy tree. Run after migrate-to-scan.sh.
#
# Re-runnable.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

DEV=/srv/scan-dev
CLONE=$DEV/scan

say() { printf '\n== %s\n' "$*"; }

say "creating $DEV"
mkdir -p "$DEV"
chown scan:scan "$DEV"
chmod 750 "$DEV"

# Two keys, one per role. Dev holds the WRITE key; production holds a read-only
# one (/srv/scan/.ssh/scan_prod_ro) and can only pull.
#
# This used to be a symlink to /srv/scan/.ssh so a single key served both. That
# was wrong: pushing to master is a deploy, so a write key reachable from the
# production tree lets anything owning the app account ship its own code to
# production. Do not re-link these directories.
say "setting up the dev ssh key"
if [ -L "$DEV/.ssh" ]; then
  echo "ABORT: $DEV/.ssh is a symlink into the production tree." >&2
  echo "Remove it and re-run; dev needs its own key directory." >&2
  exit 1
fi
mkdir -p "$DEV/.ssh"
chmod 700 "$DEV/.ssh"
if [ ! -f "$DEV/.ssh/scan_deploy" ]; then
  sudo -u scan ssh-keygen -t ed25519 -N '' -C 'scan-dev@gata-box' \
       -f "$DEV/.ssh/scan_deploy"
  NEW_KEY=1
else
  printf '   (key already present)\n'
fi
# known_hosts is copied, not shared, so the directories stay independent.
[ -f "$DEV/.ssh/known_hosts" ] || \
  cp -p /srv/scan/.ssh/known_hosts "$DEV/.ssh/known_hosts" 2>/dev/null || true

# Cloned from the local deploy repo rather than GitHub: it is already on disk,
# and the remote is repointed immediately afterwards.
#
# Never develop in /srv/scan/repo itself. The deploy poll owns that tree and
# checks out detached SHAs into release directories from it; an agent editing it
# would be fighting the pipeline. Its local branch is usually stale for the same
# reason, which is why the clone is reset to origin below rather than trusted.
say "cloning to $CLONE"
#
# --no-hardlinks matters: a local clone hardlinks its objects to the source, so
# the dev tree and /srv/scan/repo would share inodes. chown follows the inode,
# not the path, so any later `chown -R` on the dev tree would silently re-own
# objects inside the production repo. Costs a few MB of disk to avoid.
if [ ! -d "$CLONE/.git" ]; then
  sudo -u scan git clone --no-hardlinks /srv/scan/repo "$CLONE"
else
  printf '   (already cloned)\n'
fi

KEY="ssh -i $DEV/.ssh/scan_deploy -o IdentitiesOnly=yes -o UserKnownHostsFile=$DEV/.ssh/known_hosts"
sudo -u scan git -C "$CLONE" remote set-url origin git@github.com:JoveCosmos/scan.git
sudo -u scan git -C "$CLONE" config core.sshCommand "$KEY"
sudo -u scan git -C "$CLONE" config user.name  "JoveCosmos"
sudo -u scan git -C "$CLONE" config user.email "jovecosmos@gmail.com"

say "fetching and checking out master"
sudo -u scan HOME="$DEV" git -C "$CLONE" fetch origin
sudo -u scan HOME="$DEV" git -C "$CLONE" checkout -B master origin/master

say "installing dependencies"
sudo -u scan HOME="$DEV" npm --prefix "$CLONE" ci --no-audit --no-fund

say "installing the entry script and dev unit"
install -m 755 /srv/scan/current/deploy/scan-dev /usr/local/bin/scan-dev
install -m 644 /srv/scan/current/deploy/scan-dev.service /etc/systemd/system/
systemctl daemon-reload

chown -R scan:scan "$DEV"

cat <<'EOF'

Done.

  scan-dev                      attach the tmux session (from a root login)
  systemctl enable --now scan-dev   start the dev server on 127.0.0.1:3006

The dev server is loopback-only and deliberately has no nginx block. Reach it
over an SSH tunnel:

  ssh -N -L 3006:127.0.0.1:3006 root@37.27.63.150

then open http://127.0.0.1:3006 locally.

Pushing needs THIS key (the dev one) to have write access, at
https://github.com/JoveCosmos/scan/settings/keys with "Allow write access"
ticked. GitHub cannot switch a key's access after it is created — delete and
re-add it instead.

Production keeps a separate read-only key (/srv/scan/.ssh/scan_prod_ro) and can
only pull. Never point the production repo at the key below.

EOF
cat "$DEV/.ssh/scan_deploy.pub"
