# Deploying to explorer.gatahub.zone

Target: `37.27.63.150` (the host `gatahub.zone` already resolves to).
The app listens on `127.0.0.1:3200`; nginx is the only thing that reaches it.

## 0. DNS — do this first

`explorer.gatahub.zone` does not resolve yet (NXDOMAIN). Certbot cannot issue a
certificate until it does. In GoDaddy DNS for `gatahub.zone`, add:

| Type | Name       | Value          | TTL |
| ---- | ---------- | -------------- | --- |
| A    | `explorer` | `37.27.63.150` | 600 |

Verify before continuing:

```bash
dig +short explorer.gatahub.zone   # expect 37.27.63.150
```

## 1. One-time server setup

Run as a user with sudo.

```bash
# Node 22 LTS, if not already present
node -v || curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs

# Service account that owns the checkout
sudo useradd --system --create-home --home-dir /var/lib/explorer --shell /usr/sbin/nologin explorer
sudo mkdir -p /srv/explorer /var/lib/explorer/valopers
sudo chown -R explorer:explorer /srv/explorer /var/lib/explorer
```

Clone the repo. It is private, so give the box a **read-only deploy key**
rather than a personal token:

```bash
sudo -u explorer ssh-keygen -t ed25519 -f /var/lib/explorer/.ssh/id_ed25519 -N ''
sudo -u explorer cat /var/lib/explorer/.ssh/id_ed25519.pub
# Add that key at:
#   https://github.com/JoveCosmos/explorer/settings/keys  (Add deploy key, leave write access OFF)

sudo -u explorer git clone git@github.com:JoveCosmos/explorer.git /srv/explorer
```

## 2. Build and run

```bash
cd /srv/explorer
sudo -u explorer npm ci --no-audit --no-fund
sudo -u explorer npm run build

sudo cp deploy/explorer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now explorer
sudo systemctl status explorer --no-pager

# Should return HTML
curl -sI http://127.0.0.1:3200/ | head -1
```

## 3. nginx

```bash
sudo cp deploy/nginx-explorer.conf /etc/nginx/sites-available/explorer.gatahub.zone
sudo ln -sf /etc/nginx/sites-available/explorer.gatahub.zone /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Then issue the certificate (needs step 0 done):

```bash
sudo certbot --nginx -d explorer.gatahub.zone --redirect
```

Certbot rewrites the file in place to add the TLS block and the HTTP redirect.

## 4. Auto-pull

A timer checks the remote every 5 minutes and rebuilds only when the branch
has actually moved — a run with no new commits is one `git fetch`.

```bash
sudo chmod +x /srv/explorer/deploy/deploy.sh
sudo cp deploy/explorer-deploy.service deploy/explorer-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now explorer-deploy.timer
systemctl list-timers explorer-deploy --no-pager
```

`deploy.sh` restarts the service, so the `explorer` user needs exactly that one
sudo right and nothing else:

```bash
echo 'explorer ALL=(root) NOPASSWD: /bin/systemctl restart explorer' | \
  sudo tee /etc/sudoers.d/explorer-deploy
sudo chmod 440 /etc/sudoers.d/explorer-deploy
```

## Operating it

```bash
journalctl -u explorer -f              # app logs
journalctl -u explorer-deploy -n 50    # last deploy run
sudo systemctl start explorer-deploy   # deploy right now, do not wait for the timer
cd /srv/explorer && sudo -u explorer ./deploy/deploy.sh --force   # rebuild unchanged code
```

## Notes

- **Cache location.** `VALOPER_CACHE_DIR=/var/lib/explorer/valopers` keeps the
  gno.land realm index outside the checkout, so a deploy never discards it. It
  costs ~25s of serialised realm calls to rebuild and only the first boot on a
  machine should pay that.
- **First boot is slow by design.** `instrumentation.ts` warms that index at
  startup; `TimeoutStartSec=120` stops systemd mistaking it for a hung boot.
- **Port.** 3200, to stay clear of anything already on 3000/3001.
