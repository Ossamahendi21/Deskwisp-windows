#!/usr/bin/env bash
# Deskwisp's nightly backup on the server (install.sh puts it at /usr/local/bin/deskwisp-backup and runs it
# every night from /etc/cron.d/deskwisp-backup). Run it by hand any time: sudo deskwisp-backup
#
# Into /var/backups/deskwisp/<date>/, readable by root only, the newest 14 days kept:
#   db.dump        the whole database (Neon), pg_dump's own format: pg_restore puts it back
#   settings.tgz   /etc/deskwisp (the keys: cloud.env's DESKWISP_CLOUD_SECRET opens what cloud/ sealed,
#                  so without it a restored database is no use) and dcloud's data folder
# Then it says how much room the disk has left.
#
# Putting a database back (docs/DEPLOY.md, "Backups"):
#   pg_restore --clean --if-exists --no-owner -d "<connection string>" /var/backups/deskwisp/<date>/db.dump
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run it with sudo." >&2; exit 1; }

KEEP_DAYS=14
dir=/var/backups/deskwisp
day="$(date -u +%Y-%m-%d)"
out="$dir/$day"
umask 077
install -d -m 0700 "$dir" "$out"

# The connection to back up from: cloud/'s (direct, not the pooler), else dcloud's with "-pooler" taken out.
setting() { sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -1 | tr -d '\r' | sed -e 's/^"//' -e 's/"$//'; }
url="$(setting /etc/deskwisp/cloud.env DESKWISP_DATABASE_URL)"
[ -n "$url" ] || url="$(setting /etc/deskwisp/dcloud.env DATABASE_URL | sed 's/-pooler\././')"

# The newest pg_dump on the server (it has to be as new as the database).
pgdump="$(ls -1d /usr/lib/postgresql/*/bin/pg_dump 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$pgdump" ] || pgdump="$(command -v pg_dump || true)"

ok=1
if [ -z "$url" ]; then
  echo "No database to back up: DESKWISP_DATABASE_URL in /etc/deskwisp/cloud.env is empty." >&2
  ok=0
elif [ -z "$pgdump" ]; then
  echo "No pg_dump here: run sudo bash deploy/vps/install.sh, which installs it." >&2
  ok=0
elif "$pgdump" --format=custom --compress=9 --no-owner --no-privileges --file="$out/db.dump.part" "$url"; then
  mv -f "$out/db.dump.part" "$out/db.dump"
  echo "Database: $out/db.dump ($(du -h "$out/db.dump" | cut -f1))"
else
  rm -f "$out/db.dump.part"
  echo "The database backup failed (above)." >&2
  ok=0
fi

tar -czf "$out/settings.tgz" -C / etc/deskwisp $( [ -d /var/lib/deskwisp/dcloud ] && echo var/lib/deskwisp/dcloud ) 2>/dev/null
echo "Settings: $out/settings.tgz ($(du -h "$out/settings.tgz" | cut -f1))"

# Older than KEEP_DAYS days: gone.
find "$dir" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' -mtime +"$KEEP_DAYS" -exec rm -rf {} +

used="$(df -P / | awk 'NR==2 {gsub("%",""); print $5}')"
echo "Disk: ${used}% used"
[ "$used" -lt 90 ] || echo "The disk is nearly full (${used}%): make room before it stops the services." >&2
[ "$ok" = 1 ]
