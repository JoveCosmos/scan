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

# One key, one known_hosts, one place to rotate them. A second copy of a deploy
# key is a second thing to forget about when revoking it.
say "linking ssh"
if [ ! -e "$DEV/.ssh" ]; then
  ln -s /srv/scan/.ssh "$DEV/.ssh"
  chown -h scan:scan "$DEV/.ssh"
else
  printf '   (already linked)\n'
fi

# Cloned from the local deploy repo rather than GitHub: it is already on disk,
# and the remote is repointed immediately afterwards.
#
# Never develop in /srv/scan/repo itself. The deploy poll owns that tree and
# checks out detached SHAs into release directories from it; an agent editing it
# would be fighting the pipeline. Its local branch is usually stale for the same
# reason, which is why the clone is reset to origin below rather than trusted.
say "cloning to $CLONE"
if [ ! -d "$CLONE/.git" ]; then
  sudo -u scan git clone /srv/scan/repo "$CLONE"
else
  printf '   (already cloned)\n'
fi

KEY="ssh -i /srv/scan/.ssh/scan_deploy -o IdentitiesOnly=yes -o UserKnownHostsFile=/srv/scan/.ssh/known_hosts"
sudo -u scan git -C "$CLONE" remote set-url origin git@github.com:JoveCosmos/explorer.git
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

Pushing needs the deploy key to have write access. GitHub cannot switch a key
from read-only after it is created: delete the entry at
https://github.com/JoveCosmos/explorer/settings/keys and re-add this same
public key with "Allow write access" ticked.

EOF
cat /srv/scan/.ssh/scan_deploy.pub
