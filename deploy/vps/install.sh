#!/usr/bin/env bash
# Puts Deskwisp's servers on one Ubuntu server (an Oracle Cloud VM, say), as root, next to whatever
# else runs there. Safe to run again: after `git pull`, run it once more to update. docs/DEPLOY.md
# has the whole setup.
#
#   sudo git clone <the repo> /opt/deskwisp
#   sudo bash /opt/deskwisp/deploy/vps/install.sh
#
# What it does, and what it leaves alone:
# - Node 24 (the official build, checksum checked; x64 or arm64) in a folder of its own,
#   /usr/local/lib/deskwisp-node. The machine's own node, if any, isn't touched.
# - Caddy: the one already on the server, or one it installs (its apt repository). Deskwisp's sites
#   (deploy/vps/deskwisp.caddy: deskwisp.com, app.deskwisp.com, cloud.deskwisp.com/api) go in
#   /etc/caddy/deskwisp.caddy, and /etc/caddy/Caddyfile gets one line, `import /etc/caddy/deskwisp.caddy`.
#   Every other site there stays as it is. If Caddy then won't take its settings, the Caddyfile is put
#   back as it was and nothing is reloaded.
# - The deskwisp user, /etc/deskwisp/{cloud,dcloud}.env (from the examples, only if missing), the two
#   servers' packages, and deskwisp-cloud and deskwisp-dcloud as systemd services (ports 8790, 8791 on
#   127.0.0.1 only).
# - Ports 80 and 443 open in this machine's firewall, if they aren't already. Oracle's own Security
#   List in its console has to allow them too: this can't do that part.
# A service starts only once its settings file has what it can't run without.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Run it as root: sudo bash $0" >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
[ "$repo" = /opt/deskwisp ] || { echo "The repo has to be at /opt/deskwisp (it's at $repo): sudo git clone <the repo> /opt/deskwisp" >&2; exit 1; }
NODE_MAJOR=24
NODE_DIR=/usr/local/lib/deskwisp-node
NODE="$NODE_DIR/bin/node"

# Ports 8790 and 8791 must be free, or already Deskwisp's: held by a process of the deskwisp user (its
# services; Node may name itself MainThread there, so the user is what's checked, not the name).
for port in 8790 8791; do
  line="$(ss -tlnpH "( sport = :$port )" 2>/dev/null | head -1 || true)"
  [ -n "$line" ] || continue
  pid="$(printf '%s' "$line" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"
  if [ -n "$pid" ] && [ "$(ps -o user= -p "$pid" 2>/dev/null | tr -d ' ')" = deskwisp ]; then continue; fi
  holder="$(printf '%s' "$line" | grep -o 'users:(("[^"]*"' | head -1 | cut -d'"' -f2 || true)"
  echo "Port $port is taken by ${holder:-another program}${pid:+ (pid $pid)}: Deskwisp needs it free." >&2
  exit 1
done

# Node 24, the newest 24.x, checked against its published SHA-256, in its own folder.
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "No Node build for $(uname -m)" >&2; exit 1 ;;
esac
if ! "$NODE" --version 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(grep -o "node-v$NODE_MAJOR\.[0-9.]*-linux-$arch\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
fi
echo "Node $("$NODE" --version) in $NODE_DIR"

# Caddy, from its own apt repository (https://caddyserver.com/docs/install#debian-ubuntu-raspbian), when
# there's none yet. A fresh one's Caddyfile is its sample site: replaced, since nothing uses it.
fresh_caddy=0
if ! command -v caddy >/dev/null; then
  apt-get update -q
  apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
  fresh_caddy=1
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

# Each server's own packages (pg, ws, e2b, postal-mime…), nothing of the app's, with Deskwisp's Node.
for d in cloud dcloud; do
  (cd "$repo/$d" && PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/npm" install --omit=dev --no-package-lock --no-audit --no-fund --loglevel=error)
done
chmod -R a+rX "$repo"

# The website: what's in deploy/vps/site.
install -d -m 0755 /var/www/deskwisp
cp -a "$here/site/." /var/www/deskwisp/

# Deskwisp's sites in Caddy, next to the others. Only for a Caddy run by systemd on /etc/caddy/Caddyfile
# (how its package runs it): one started some other way is left alone, and this stops.
main=/etc/caddy/Caddyfile
if [ "$fresh_caddy" = 0 ]; then
  runs="$(systemctl show -p ExecStart --value caddy 2>/dev/null || true)"
  if ! printf '%s' "$runs" | grep -q -- "--config $main"; then
    echo "Caddy here isn't the caddy service on $main (it runs: ${runs:-not as a service}). Add deploy/vps/deskwisp.caddy to its settings by hand (docs/DEPLOY.md)." >&2
    exit 1
  fi
fi
backup="$(mktemp)"
had_main=0
[ -f "$main" ] && { cp -a "$main" "$backup"; had_main=1; }
install -m 0644 "$here/deskwisp.caddy" /etc/caddy/deskwisp.caddy
# The website's access log (deskwisp.caddy), written by Caddy's own user.
cuser="$(systemctl show -p User --value caddy 2>/dev/null || true)"
cuser="${cuser:-caddy}"
if id "$cuser" >/dev/null 2>&1; then
  install -d -m 0755 -o "$cuser" -g "$cuser" /var/log/caddy
  [ -e /var/log/caddy/deskwisp-site.log ] || install -m 0640 -o "$cuser" -g "$cuser" /dev/null /var/log/caddy/deskwisp-site.log
else
  install -d -m 0755 /var/log/caddy
fi
if [ "$fresh_caddy" = 1 ]; then
  printf '# Deskwisp (deploy/vps/install.sh). Other sites can go below.\nimport /etc/caddy/deskwisp.caddy\n' >"$main"
elif ! grep -Eq '^\s*import\s+(/etc/caddy/)?deskwisp\.caddy\s*$' "$main" 2>/dev/null; then
  printf '\n# Deskwisp (deploy/vps/install.sh)\nimport /etc/caddy/deskwisp.caddy\n' >>"$main"
fi
if ! (cd /etc/caddy && caddy validate --adapter caddyfile --config "$main" >/tmp/deskwisp-caddy-check.log 2>&1); then
  echo "Caddy won't take the settings with Deskwisp's sites in: putting its Caddyfile back as it was." >&2
  tail -5 /tmp/deskwisp-caddy-check.log >&2
  if [ "$had_main" = 1 ]; then cp -a "$backup" "$main"; fi
  rm -f /etc/caddy/deskwisp.caddy "$backup"
  exit 1
fi
rm -f "$backup"
systemctl enable caddy >/dev/null 2>&1 || true
if systemctl is-active --quiet caddy; then systemctl reload caddy; else systemctl start caddy; fi
echo "Caddy: Deskwisp's sites are in"

# Backups (backup.sh): pg_dump as new as Neon's Postgres, from the PostgreSQL project's apt repository,
# and a copy of the database and the settings every night at 03:17 UTC.
if ! ls /usr/lib/postgresql/18/bin/pg_dump >/dev/null 2>&1; then
  apt-get install -y -q postgresql-common >/dev/null
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
  apt-get install -y -q postgresql-client-18 >/dev/null
fi
install -m 0755 "$here/backup.sh" /usr/local/bin/deskwisp-backup
printf 'SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n17 3 * * * root /usr/local/bin/deskwisp-backup >/var/log/deskwisp-backup.log 2>&1\n' >/etc/cron.d/deskwisp-backup
chmod 0644 /etc/cron.d/deskwisp-backup
echo "Backups: every night (sudo deskwisp-backup for one now)"

# The website's own counts: sudo deskwisp-site-stats, and each day's totals kept by cron.
install -m 0755 "$here/site-stats.py" /usr/local/bin/deskwisp-site-stats
install -d -m 0755 /var/lib/deskwisp
printf '#!/bin/sh\n/usr/local/bin/deskwisp-site-stats --save\n' >/etc/cron.daily/deskwisp-site-stats
chmod 0755 /etc/cron.daily/deskwisp-site-stats

# Ports 80 and 443 (Oracle's Ubuntu images let only 22 in), kept across reboots.
opened=0
for port in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 1 -p tcp -m state --state NEW --dport "$port" -j ACCEPT
    opened=1
  fi
done
if [ "$opened" = 1 ] && command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1 || true; fi

# The two servers as services, on Deskwisp's Node.
for s in cloud dcloud; do
  sed "s#/usr/local/bin/node#$NODE#" "$here/deskwisp-$s.service" >"/etc/systemd/system/deskwisp-$s.service"
done
systemctl daemon-reload
systemctl enable deskwisp-cloud deskwisp-dcloud >/dev/null 2>&1

# A service starts (or restarts, after an update) only when what it needs is set.
filled() { grep -Eq "^$2=.+" "/etc/deskwisp/$1.env"; }
ready_cloud=1
for k in DESKWISP_DATABASE_URL DESKWISP_CLOUD_SECRET OPENAI_API_KEY; do filled cloud "$k" || { ready_cloud=0; echo "cloud.env needs $k"; }; done
ready_dcloud=1
for k in DATABASE_URL CLERK_SECRET_KEY CLERK_PUBLISHABLE_KEY E2B_API_KEY; do filled dcloud "$k" || { ready_dcloud=0; echo "dcloud.env needs $k"; }; done
if [ "$ready_cloud" = 1 ]; then systemctl restart deskwisp-cloud && echo "deskwisp-cloud: (re)started"; fi
if [ "$ready_dcloud" = 1 ]; then systemctl restart deskwisp-dcloud && echo "deskwisp-dcloud: (re)started"; fi

cat <<EOF

Done. Check:
  curl -sI https://deskwisp.com | head -1        (the website, as soon as Caddy has its certificate)
  systemctl status deskwisp-cloud deskwisp-dcloud
  journalctl -u deskwisp-cloud -f                (and -u deskwisp-dcloud)
  curl -s https://cloud.deskwisp.com/api/health
Once the keys are in, run this again (or: sudo systemctl restart deskwisp-cloud deskwisp-dcloud).
EOF
