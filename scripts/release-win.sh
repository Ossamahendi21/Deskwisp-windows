#!/usr/bin/env bash
# Builds Deskwisp for Windows (x64): the production server (Next standalone) packed with Electron into an
# NSIS installer, dist-win/Deskwisp-Setup-<version>-x64.exe. Runs on Windows (Git Bash), Linux or macOS.
# Personal build: unsigned, so Windows SmartScreen asks once ("More info" → "Run anyway").
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# 1. The server. Keys stay out of the app: .env files are never bundled.
NEXT_TELEMETRY_DISABLED=1 npx next build
rm -f .next/standalone/.env*
rm -rf .next/standalone/.data
[ -f .next/standalone/server.js ] || { echo "No .next/standalone/server.js" >&2; exit 1; }
# Only the built server ships (as in scripts/release.sh): everything else the tracer copied goes.
for f in .next/standalone/* .next/standalone/.[!.]*; do
  [ -e "$f" ] || continue
  case "$(basename "$f")" in
    .next | cloud | LICENSE | node_modules | package.json | public | server.js | slack | vm) ;;
    *) rm -rf "$f" ;;
  esac
done
# Next links a few packages it loads at run time (.next/node_modules/pg-<hash> → node_modules/pg).
# Links don't survive a Windows installer, so each becomes a real copy of what it points at.
find .next/standalone -type l | while IFS= read -r link; do
  target="$(realpath "$link")"
  rm "$link"
  cp -R "$target" "$link"
done
[ -z "$(find .next/standalone -type l)" ] || { echo "Links left in the server build" >&2; exit 1; }

# 2. Smoke test: the server starts on its own and serves the page and its state, with no keys.
smoke="$(mktemp -d)"
(cd .next/standalone && exec env DESKWISP_DATA_DIR="$smoke" PORT=3298 HOSTNAME=127.0.0.1 NODE_ENV=production DESKWISP_TELEMETRY=0 node server.js > "$smoke/server.log" 2>&1) &
smoke_pid=$!
ok=""
for _ in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:3298/api/health)" = 200 ]; then ok=1; break; fi
  sleep 1
done
if [ -n "$ok" ]; then
  for route in / /api/state; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://127.0.0.1:3298$route")"
    [ "$code" = 200 ] || { echo "$route answered $code without keys." >&2; ok=""; }
  done
fi
kill "$smoke_pid" 2>/dev/null || true
wait "$smoke_pid" 2>/dev/null || true
if [ -z "$ok" ] || grep -qE "Cannot find module|MODULE_NOT_FOUND" "$smoke/server.log"; then
  echo "The server failed its smoke test; its log:" >&2
  sed -n 1,40p "$smoke/server.log" >&2
  exit 1
fi
rm -rf "$smoke"
echo "Server smoke test passed."

# 3. The installer.
npx electron-builder --win --x64 --config electron-builder.win.json "$@"
ls -la dist-win/*.exe
