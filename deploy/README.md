# Deploying to explorer.gatahub.zone

Runs on the gata box (`37.27.63.150`), the same host that serves
`reward.gatahub.zone`, and deliberately mirrors that pipeline: release
directories, atomic symlink swap, health check, auto-rollback.

```
/srv/scan/repo               clone, only ever fetched
/srv/scan/releases/<sha>/    one built copy per deployed commit
/srv/scan/current -> releases/<sha>
/srv/scan/shared/valopers/   gno realm index, survives releases
/opt/scan/deploy.sh
```

The app listens on `127.0.0.1:3200`; nginx is the only thing that reaches it.

> **Never build in the live directory.** `next build` rewrites `.next`
> underneath the running server, so an in-place build serves 404s until the
> restart lands. That is why releases exist - same reason as `gata-hub`.

## 0. DNS - do this first

`explorer.gatahub.zone` does not resolve yet (NXDOMAIN). Certbot cannot issue a
certificate until it does. In GoDaddy DNS for `gatahub.zone`, add:

| Type | Name       | Value          | TTL |
| ---- | ---------- | -------------- | --- |
| A    | `scan` | `37.27.63.150` | 600 |

```bash
dig +short explorer.gatahub.zone   # expect 37.27.63.150
```

## 1. Layout and clone

Runs as its own `scan` system account - **not** `gata`. The gata account
can read `/etc/gata/app.env` (`root:gata 0640`), so running a public-facing
service as gata would put gata-hub's secrets one compromise away.

```bash
sudo useradd --system --home-dir /srv/scan --shell /usr/sbin/nologin scan
sudo mkdir -p /srv/scan/{repo,releases,shared/valopers,shared/.npm} /opt/scan
sudo chown -R scan:scan /srv/scan /opt/scan
sudo chmod 750 /srv/scan
```

The repo is private, so the box gets its own **read-only deploy key** - a
separate one from gata-hub's, so neither service can pull the other's code.

**Production's key is read-only, and that is the point.** A push to `master` is
a deploy (§4), so a write key here would let anything owning the app account
ship its own code to production. The write key lives only in the dev tree, at
`/srv/scan-dev/.ssh/scan_deploy` - see `setup-dev.sh`. Two keys, one per role.

The key is referenced by **absolute path**, not through an ssh config alias:
sudo and systemd disagree about `HOME`, so an alias only resolves when ssh
happens to find the right config.

```bash
sudo -u scan mkdir -p /srv/scan/.ssh
sudo -u scan chmod 700 /srv/scan/.ssh
sudo -u scan ssh-keygen -t ed25519 -f /srv/scan/.ssh/scan_prod_ro -N '' -C 'scan-prod-ro@gata-box'
sudo -u scan cat /srv/scan/.ssh/scan_prod_ro.pub
# Add at https://github.com/JoveCosmos/scan/settings/keys - leave write access OFF
```

A GitHub deploy key cannot be attached to more than one repository, so each
product needs its own pair.

Clone with that key, then persist it into the repo config so every later fetch
uses it regardless of environment:

```bash
KEY='ssh -i /srv/scan/.ssh/scan_prod_ro -o IdentitiesOnly=yes -o UserKnownHostsFile=/srv/scan/.ssh/known_hosts -o StrictHostKeyChecking=accept-new'

sudo -u scan git -c core.sshCommand="$KEY" clone git@github.com:JoveCosmos/scan.git /srv/scan/repo
sudo -u scan git -C /srv/scan/repo config core.sshCommand "$KEY"
sudo -u scan git -C /srv/scan/repo fetch --dry-run origin master   # must succeed

sudo install -o scan -g scan -m 755 /srv/scan/repo/deploy/deploy.sh /opt/scan/deploy.sh
```

## 2. systemd

```bash
sudo cp /srv/scan/repo/deploy/scan.service /etc/systemd/system/
sudo cp /srv/scan/repo/deploy/scan-deploy.service /etc/systemd/system/
sudo cp /srv/scan/repo/deploy/scan-deploy.timer   /etc/systemd/system/
sudo systemctl daemon-reload
```

### Connecting the indexer (optional)

Scan reads proposal votes from the indexer's Postgres when it can, and
falls back to querying nodes directly when it cannot - so this step can be
skipped entirely, and skipping it changes nothing about how the site behaves.

Give the read-only role a password, then hand Scan a connection string
for it. Interactively, so the secret reaches neither a file in the repo nor your
shell history:

```bash
sudo docker exec -it gata-indexer-db psql -U indexer -d gata_indexer -c '\password scan_ro'
sudo install -o root -g scan -m 640 /dev/null /etc/gata/scan.env
sudo -e /etc/gata/scan.env
```

One line, with the password you just set:

```
INDEXER_DATABASE_URL=postgres://scan_ro:PASSWORD@127.0.0.1:5433/gata_indexer
```

`scan_ro` holds `SELECT` and nothing else (`indexer/sql/003_readonly_role.sql`),
which is the point of running the indexer under its own account: the
internet-facing process cannot write to the historical record even if it is
compromised.

Then `sudo systemctl restart scan`. Confirm it took by reading the running
process's own environment - `systemctl show -p Environment` reports only the
inline `Environment=` directives and will not show anything loaded from a file,
so it cannot answer this. Counting rather than printing keeps the password off
the terminal:

```bash
sudo tr '\0' '\n' < /proc/$(systemctl show scan -p MainPID --value)/environ | grep -c INDEXER_DATABASE_URL
```

`1` means Scan has it. `0` means the file is missing, unreadable by the
`scan` group, or the unit was copied to `/etc/systemd/system/` without a
`daemon-reload` - and because the `-` prefix makes the file optional, all three
fail silently.

`deploy.sh` restarts the app, so the `scan` user needs exactly that and nothing more:

```bash
echo 'scan ALL=(root) NOPASSWD: /usr/bin/systemctl restart scan' | \
  sudo tee /etc/sudoers.d/scan-deploy
sudo chmod 440 /etc/sudoers.d/scan-deploy
```

First deploy builds the release and creates `current`:

```bash
sudo -u scan /opt/scan/deploy.sh
sudo systemctl enable --now scan
curl -sI http://127.0.0.1:3200/ | head -1     # expect HTTP/1.1 200
```

## 3. nginx

```bash
sudo cp /srv/scan/repo/deploy/nginx-scan.conf /etc/nginx/sites-available/scan
sudo ln -sf /etc/nginx/sites-available/scan /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d explorer.gatahub.zone --redirect
```

## 4. Auto-pull

```bash
sudo systemctl enable --now scan-deploy.timer
systemctl list-timers scan-deploy --no-pager
```

Checks every 5 minutes; a run with no new commits is one `git fetch` and exits.
On a new commit it builds a fresh release, swaps the symlink, restarts, health
checks, and **rolls back automatically** if the new release does not answer.

## Operating it

```bash
journalctl -u scan -f                    # app logs
journalctl -u scan-deploy -n 80          # last deploy run
sudo systemctl start scan-deploy         # deploy now, do not wait
sudo -u scan /opt/scan/deploy.sh --force # rebuild the same commit
readlink -f /srv/scan/current            # which sha is live
```

After changing `deploy.sh` itself, reinstall it - the timer runs the copy in
`/opt/scan`, not the one in the checkout:

```bash
sudo install -o scan -g scan -m 755 /srv/scan/repo/deploy/deploy.sh /opt/scan/deploy.sh
```

## Notes

- **Port 3200**, clear of gata-hub on 3000.
- **First boot is slow by design.** `instrumentation.ts` warms the gno realm
  index (~96 serialised realm calls, ~25s). `TimeoutStartSec=120` stops systemd
  mistaking that for a hung boot, and the cache in `shared/` means only the
  first deploy on the box pays it.
- **No build-time env vars.** Unlike gata-hub there are no `NEXT_PUBLIC_*` to
  source before building; every endpoint is in `config/chains/*.json`.
