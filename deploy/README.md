# Deploying to explorer.gatahub.zone

Runs on the gata box (`37.27.63.150`), the same host that serves
`reward.gatahub.zone`, and deliberately mirrors that pipeline: release
directories, atomic symlink swap, health check, auto-rollback.

```
/srv/explorer/repo               clone, only ever fetched
/srv/explorer/releases/<sha>/    one built copy per deployed commit
/srv/explorer/current -> releases/<sha>
/srv/explorer/shared/valopers/   gno realm index, survives releases
/opt/explorer/deploy.sh
```

The app listens on `127.0.0.1:3200`; nginx is the only thing that reaches it.

> **Never build in the live directory.** `next build` rewrites `.next`
> underneath the running server, so an in-place build serves 404s until the
> restart lands. That is why releases exist — same reason as `gata-hub`.

## 0. DNS — do this first

`explorer.gatahub.zone` does not resolve yet (NXDOMAIN). Certbot cannot issue a
certificate until it does. In GoDaddy DNS for `gatahub.zone`, add:

| Type | Name       | Value          | TTL |
| ---- | ---------- | -------------- | --- |
| A    | `explorer` | `37.27.63.150` | 600 |

```bash
dig +short explorer.gatahub.zone   # expect 37.27.63.150
```

## 1. Layout and clone

Runs as the existing `gata` user, same as gata-hub.

```bash
sudo mkdir -p /srv/explorer/{repo,releases,shared/valopers} /opt/explorer
sudo chown -R gata:gata /srv/explorer /opt/explorer
```

The repo is private, so give the box a **read-only deploy key** rather than a
personal token. If the existing gata-hub deploy key cannot be reused, make one:

The key is referenced by **absolute path**, not through an ssh config alias.
`gata` is a system account whose home is `/srv/gata-hub`, and sudo and systemd
disagree about `HOME` — an alias only resolves when ssh happens to find the
right config, which it did not.

```bash
sudo -u gata mkdir -p /srv/explorer/shared/.ssh
sudo -u gata chmod 700 /srv/explorer/shared/.ssh
sudo -u gata ssh-keygen -t ed25519 -f /srv/explorer/shared/.ssh/explorer_deploy -N '' -C 'explorer-deploy@gata-box'
sudo -u gata cat /srv/explorer/shared/.ssh/explorer_deploy.pub
# Add at https://github.com/JoveCosmos/explorer/settings/keys — leave write access OFF
```

Clone with that key, then persist it into the repo config so every later fetch
uses it regardless of environment:

```bash
KEY='ssh -i /srv/explorer/shared/.ssh/explorer_deploy -o IdentitiesOnly=yes -o UserKnownHostsFile=/srv/explorer/shared/.ssh/known_hosts -o StrictHostKeyChecking=accept-new'

sudo -u gata git -c core.sshCommand="$KEY" clone git@github.com:JoveCosmos/explorer.git /srv/explorer/repo
sudo -u gata git -C /srv/explorer/repo config core.sshCommand "$KEY"
sudo -u gata git -C /srv/explorer/repo fetch --dry-run origin master   # must succeed

sudo install -o gata -g gata -m 755 /srv/explorer/repo/deploy/deploy.sh /opt/explorer/deploy.sh
```

## 2. systemd

```bash
sudo cp /srv/explorer/repo/deploy/explorer.service /etc/systemd/system/
sudo cp /srv/explorer/repo/deploy/explorer-deploy.service /etc/systemd/system/
sudo cp /srv/explorer/repo/deploy/explorer-deploy.timer   /etc/systemd/system/
sudo systemctl daemon-reload
```

`deploy.sh` restarts the app, so `gata` needs exactly that one sudo right:

```bash
echo 'gata ALL=(root) NOPASSWD: /usr/bin/systemctl restart explorer' | \
  sudo tee /etc/sudoers.d/explorer-deploy
sudo chmod 440 /etc/sudoers.d/explorer-deploy
```

First deploy builds the release and creates `current`:

```bash
sudo -u gata /opt/explorer/deploy.sh
sudo systemctl enable --now explorer
curl -sI http://127.0.0.1:3200/ | head -1     # expect HTTP/1.1 200
```

## 3. nginx

```bash
sudo cp /srv/explorer/repo/deploy/nginx-explorer.conf /etc/nginx/sites-available/explorer
sudo ln -sf /etc/nginx/sites-available/explorer /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d explorer.gatahub.zone --redirect
```

## 4. Auto-pull

```bash
sudo systemctl enable --now explorer-deploy.timer
systemctl list-timers explorer-deploy --no-pager
```

Checks every 5 minutes; a run with no new commits is one `git fetch` and exits.
On a new commit it builds a fresh release, swaps the symlink, restarts, health
checks, and **rolls back automatically** if the new release does not answer.

## Operating it

```bash
journalctl -u explorer -f                    # app logs
journalctl -u explorer-deploy -n 80          # last deploy run
sudo systemctl start explorer-deploy         # deploy now, do not wait
sudo -u gata /opt/explorer/deploy.sh --force # rebuild the same commit
readlink -f /srv/explorer/current            # which sha is live
```

After changing `deploy.sh` itself, reinstall it — the timer runs the copy in
`/opt/explorer`, not the one in the checkout:

```bash
sudo install -o gata -g gata -m 755 /srv/explorer/repo/deploy/deploy.sh /opt/explorer/deploy.sh
```

## Notes

- **Port 3200**, clear of gata-hub on 3000.
- **First boot is slow by design.** `instrumentation.ts` warms the gno realm
  index (~96 serialised realm calls, ~25s). `TimeoutStartSec=120` stops systemd
  mistaking that for a hung boot, and the cache in `shared/` means only the
  first deploy on the box pays it.
- **No build-time env vars.** Unlike gata-hub there are no `NEXT_PUBLIC_*` to
  source before building; every endpoint is in `config/chains/*.json`.
