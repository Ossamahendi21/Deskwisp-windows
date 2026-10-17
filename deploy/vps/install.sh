#!/usr/bin/env bash
# Puts Deskwisp's servers on one Ubuntu server (an Oracle Cloud VM, say), as root. Safe to run again:
# after `git pull`, run it once more to update. docs/DEPLOY.md has the whole setup.
#
#   sudo git clone <the repo> /opt/deskwisp
#   sudo ACME_EMAIL=you@example.com bash /opt/deskwisp/deploy/vps/install.sh
#
# What it does:
# - Node 24 (the official build, checksum checked; x64 or arm64) under /usr/local/lib/nodejs.
# - Caddy (its own apt repository), with deploy/vps/Caddyfile: deskwisp.com (the website),
#   app.deskwisp.com (dcloud/) and cloud.deskwisp.com/api (cloud/), HTTPS on its own.
# - The deskwisp user, /etc/deskwisp/{cloud,dcloud}.env (from the examples, only if missing),
#   the two servers' packages, and deskwisp-cloud and deskwisp-dcloud as systemd services.
# - Ports 80 and 443 open in this machine's firewall (Oracle's Ubuntu images block them). Oracle's
#   own Security List in its console has to allow them too: this can't do that part.
# A service starts only once its settings file has what it can't run without.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Run it as root: sudo bash $0" >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
[ "$repo" = /opt/deskwisp ] || { echo "The repo has to be at /opt/deskwisp (it's at $repo): sudo git clone <the repo> /opt/deskwisp" >&2; exit 1; }
NODE_MAJOR=24

# Node 24, the newest 24.x, checked against its published SHA-256.
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "No Node build for $(uname -m)" >&2; exit 1 ;;
esac
if ! /usr/local/bin/node --version 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(grep -o "node-v$NODE_MAJOR\.[0-9.]*-linux-$arch\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
  rm -rf /usr/local/lib/nodejs && mkdir -p /usr/local/lib/nodejs
  tar -xJf "$tmp/$file" -C /usr/local/lib/nodejs --strip-components=1
  ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node
  ln -sf /usr/local/lib/nodejs/bin/npm /usr/local/bin/npm
  rm -rf "$tmp"
fi
echo "Node $(/usr/local/bin/node --version)"

# Caddy, from its own apt repository (https://caddyserver.com/docs/install#debian-ubuntu-raspbian).
if ! command -v caddy >/dev/null; then
  apt-get update -q
  apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

# The user the servers run as, and their settings (root-owned, readable by the group only).
id deskwisp >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin deskwisp
install -d -m 0750 -o root -g deskwisp /etc/deskwisp
for s in cloud dcloud; do
  if [ ! -f "/etc/deskwisp/$s.env" ]; then
    install -m 0640 -o root -g deskwisp "$here/$s.env.example" "/etc/deskwisp/$s.env"
    echo "Made /etc/deskwisp/$s.env: fill in its keys (sudo nano /etc/deskwisp/$s.env)"
  fi
done

# Each server's own packages (pg, ws, e2b, postal-mime…), nothing of the app's.
for d in cloud dcloud; do
  (cd "$repo/$d" && npm install --omit=dev --no-package-lock --no-audit --no-fund --loglevel=error)
done
chmod -R a+rX "$repo"

# The website: what's in deploy/vps/site.
install -d -m 0755 /var/www/deskwisp
cp -a "$here/site/." /var/www/deskwisp/

# Caddy's settings, with the email Let's Encrypt writes to (or none).
caddyfile="$(mktemp)"
if [ -n "${ACME_EMAIL:-}" ]; then
  sed "s|^\temail ACME_EMAIL\$|\temail $ACME_EMAIL|" "$here/Caddyfile" >"$caddyfile"
else
  # Without an email: the global block goes (its three lines and the comment above them).
  awk 'BEGIN{skip=0} /^# Where Let.s Encrypt/{skip=4} skip>0{skip--; next} {print}' "$here/Caddyfile" >"$caddyfile"
fi
caddy validate --adapter caddyfile --config "$caddyfile" >/dev/null
[ -f /etc/caddy/Caddyfile ] && ! cmp -s "$caddyfile" /etc/caddy/Caddyfile && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-deskwisp.$(date +%s)"
install -m 0644 "$caddyfile" /etc/caddy/Caddyfile
rm -f "$caddyfile"
systemctl enable --now caddy >/dev/null
systemctl reload caddy

# Ports 80 and 443 (Oracle's Ubuntu images let only 22 in), kept across reboots.
for port in 80 443; do
  iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null ||
    iptables -I INPUT 1 -p tcp -m state --state NEW --dport "$port" -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1 || true; fi

# The two servers as services.
install -m 0644 "$here/deskwisp-cloud.service" "$here/deskwisp-dcloud.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable deskwisp-cloud deskwisp-dcloud >/dev/null

# A service starts (or restarts, after an update) only when what it needs is set.
filled() { grep -Eq "^$2=.+" "/etc/deskwisp/$1.env"; }
ready_cloud=1
for k in DESKWISP_DATABASE_URL DESKWISP_CLOUD_SECRET OPENAI_API_KEY; do filled cloud "$k" || { ready_cloud=0; echo "cloud.env needs $k"; }; done
ready_dcloud=1
for k in DATABASE_URL CLERK_SECRET_KEY CLERK_PUBLISHABLE_KEY E2B_API_KEY; do filled dcloud "$k" || { ready_dcloud=0; echo "dcloud.env needs $k"; }; done
[ "$ready_cloud" = 1 ] && systemctl restart deskwisp-cloud && echo "deskwisp-cloud: (re)started"
[ "$ready_dcloud" = 1 ] && systemctl restart deskwisp-dcloud && echo "deskwisp-dcloud: (re)started"

cat <<EOF

Done. Check them with:
  systemctl status deskwisp-cloud deskwisp-dcloud caddy
  journalctl -u deskwisp-cloud -f        (and -u deskwisp-dcloud)
  curl -s https://cloud.deskwisp.com/api/health
Once the keys are in, run this again (or: sudo systemctl restart deskwisp-cloud deskwisp-dcloud).
EOF
