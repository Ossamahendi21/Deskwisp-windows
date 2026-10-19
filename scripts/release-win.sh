#!/usr/bin/env bash
# Builds Deskwisp for Windows (x64) and puts it on deskwisp.com, where every installed Deskwisp finds it
# within the hour and updates itself (desktop/win-update.cjs). Runs on Windows (Git Bash), Linux or macOS.
#
#   bash scripts/release-win.sh 0.1.0              # this version: build, publish, then commit and tag it
#   bash scripts/release-win.sh --no-publish       # only build dist-win/, at package.json's version
#
# What's new in a version: the "- " lines of docs/releases/v<version>.md (up to five show in the app).
# Publishing needs SSH to the server, set in .env.release at the repo's root (never committed):
#   DESKWISP_SSH=ubuntu@84.8.217.42
#   DESKWISP_SSH_KEY=D:\Downloads\your-key.key
# On the server it goes in /var/www/deskwisp/download/: win/latest.json and win/<installer> for the
# updater (the newest three are kept), and Deskwisp-Setup.exe, always the newest, for the website.
#
# Unsigned, so Windows SmartScreen asks once on the first install from a browser ("More info" → "Run
# anyway"). Updates don't ask: they come down through the app, not a browser.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

version=""
publish=1
for a in "$@"; do
  case "$a" in
    --no-publish) publish=0 ;;
    [0-9]*.[0-9]*.[0-9]*) version="$a" ;;
    *) echo "What's $a? Usage: bash scripts/release-win.sh [<version>] [--no-publish]" >&2; exit 1 ;;
  esac
done
current="$(node -p 'require("./package.json").version')"
newer() { node -e 'const p=(v)=>v.split(".").map(Number);const [a,b]=[p(process.argv[1]),p(process.argv[2])];for(let i=0;i<3;i++)if(a[i]!==b[i])process.exit(a[i]>b[i]?0:1);process.exit(1)' "$1" "$2"; }
if [ -n "$version" ]; then
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "A version is three numbers, like 0.1.0." >&2; exit 1; }
  [ "$version" = "$current" ] || newer "$version" "$current" || { echo "$version isn't newer than package.json's $current." >&2; exit 1; }
else
  version="$current"
fi
exe="Deskwisp-Setup-$version-x64.exe"

# Publishing: the server, and nothing about to be released that isn't committed.
ssh_run=() scp_run=()
if [ "$publish" = 1 ]; then
  [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Commit (or put away) your changes first: a release is what's committed." >&2; git status --short --untracked-files=no >&2; exit 1; }
  # .env.release, read as plain lines (a Windows path's backslashes stay as they are).
  if [ -f .env.release ]; then
    while IFS='=' read -r k v || [ -n "$k" ]; do
      v="${v%$'\r'}"; v="${v#\"}"; v="${v%\"}"
      case "$k" in DESKWISP_SSH) DESKWISP_SSH="${DESKWISP_SSH:-$v}" ;; DESKWISP_SSH_KEY) DESKWISP_SSH_KEY="${DESKWISP_SSH_KEY:-$v}" ;; esac
    done < .env.release
  fi
  : "${DESKWISP_SSH:?set DESKWISP_SSH (like ubuntu@84.8.217.42) in .env.release}"
  # Windows' own ssh when there is one (what you sign in to the server with), else this system's.
  if [ -x /c/Windows/System32/OpenSSH/ssh.exe ]; then
    ssh_run=(/c/Windows/System32/OpenSSH/ssh.exe -F NUL) scp_run=(/c/Windows/System32/OpenSSH/scp.exe -F NUL)
  else
    ssh_run=(ssh -F /dev/null) scp_run=(scp -F /dev/null)
  fi
  opts=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
  [ -n "${DESKWISP_SSH_KEY:-}" ] && opts+=(-o IdentitiesOnly=yes -i "$DESKWISP_SSH_KEY")
  ssh_run+=("${opts[@]}") scp_run+=("${opts[@]}")
  "${ssh_run[@]}" "$DESKWISP_SSH" true || { echo "Can't sign in to $DESKWISP_SSH: check .env.release." >&2; exit 1; }
  online="$(curl -fsS --max-time 15 https://deskwisp.com/download/win/latest.json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version||"")}catch{console.log("")}})' || true)"
  if [ -n "$online" ] && ! newer "$version" "$online"; then
    echo "deskwisp.com already has $online: give a newer version (bash scripts/release-win.sh <version>)." >&2
    exit 1
  fi
fi

# The version, in package.json and package-lock.json, put back if anything below fails.
if [ "$version" != "$current" ]; then
  kept="$(mktemp -d)"
  cp package.json "$kept/"
  [ -f package-lock.json ] && cp package-lock.json "$kept/"
  restore() {
    cp -f "$kept/package.json" package.json 2>/dev/null || true
    [ -f "$kept/package-lock.json" ] && cp -f "$kept/package-lock.json" package-lock.json
    echo "Stopped: package.json is back at $current." >&2
  }
  trap restore ERR
  node -e '
    const fs = require("fs");
    const [from, to] = process.argv.slice(1);
    const set = (f, n) => {
      if (!fs.existsSync(f)) return;
      let s = fs.readFileSync(f, "utf8"), left = n;
      s = s.replace(new RegExp(`"version": "${from.replace(/\./g, "\\.")}"`, "g"), (m) => (left-- > 0 ? `"version": "${to}"` : m));
      fs.writeFileSync(f, s);
    };
    set("package.json", 1);
    set("package-lock.json", 2);
  ' "$current" "$version"
fi
echo "Deskwisp $version for Windows"

# 1. The server. Keys stay out of the app: .env files are never bundled.
NEXT_TELEMETRY_DISABLED=1 npx next build
rm -f .next/standalone/.env*
rm -rf .next/standalone/.data
[ -f .next/standalone/server.js ] || { echo "No .next/standalone/server.js" >&2; false; }
# Only the built server ships (as in scripts/release.sh): everything else the tracer copied goes.
for f in .next/standalone/* .next/standalone/.[!.]*; do
  [ -e "$f" ] || continue
  case "$(basename "$f")" in
    .next | cloud | node_modules | package.json | public | server.js | slack | vm) ;;
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
[ -z "$(find .next/standalone -type l)" ] || { echo "Links left in the server build" >&2; false; }

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
  false
fi
rm -rf "$smoke"
echo "Server smoke test passed."

# 3. The installer.
rm -f "dist-win/$exe"
npx electron-builder --win --x64 --config electron-builder.win.json --publish never
[ -f "dist-win/$exe" ] || { echo "No dist-win/$exe" >&2; false; }

# 4. latest.json, what the app reads: the version, the installer, its size and SHA-512, what's new.
node -e '
  const fs = require("fs"), crypto = require("crypto");
  const [version, exe] = process.argv.slice(1);
  const bytes = fs.readFileSync(`dist-win/${exe}`);
  let notes = [];
  try {
    notes = fs.readFileSync(`docs/releases/v${version}.md`, "utf8").split(/\r?\n/).filter((l) => /^-\s+/.test(l)).map((l) => l.replace(/^-\s+/, "").trim()).filter(Boolean);
  } catch {}
  if (!notes.length) console.error(`(No docs/releases/v${version}.md: the app shows no "What\u2019s new" for it.)`);
  const latest = { version, file: exe, sha512: crypto.createHash("sha512").update(bytes).digest("base64"), size: bytes.length, released: new Date().toISOString(), ...(notes.length ? { notes } : {}) };
  fs.writeFileSync("dist-win/latest.json", JSON.stringify(latest, null, 2) + "\n");
' "$version" "$exe"
ls -la "dist-win/$exe" dist-win/latest.json

if [ "$publish" = 0 ]; then
  trap - ERR
  # Only a release moves package.json on: this build alone doesn't.
  if [ "$version" != "$current" ]; then
    cp -f "$kept/package.json" package.json
    [ -f "$kept/package-lock.json" ] && cp -f "$kept/package-lock.json" package-lock.json
  fi
  echo "Built (not published). To publish it: bash scripts/release-win.sh <a newer version>"
  exit 0
fi

# 5. Onto the server: the installer first, latest.json last, so no app is ever pointed at a file that isn't there.
echo "Uploading to $DESKWISP_SSH…"
"${ssh_run[@]}" "$DESKWISP_SSH" "rm -rf /tmp/deskwisp-release && mkdir -p /tmp/deskwisp-release"
"${scp_run[@]}" "dist-win/$exe" dist-win/latest.json "$DESKWISP_SSH:/tmp/deskwisp-release/"
"${ssh_run[@]}" "$DESKWISP_SSH" "sudo bash -s -- '$exe'" <<'REMOTE'
set -euo pipefail
exe="$1"
up=/tmp/deskwisp-release
dl=/var/www/deskwisp/download
install -d -m 0755 "$dl" "$dl/win"
install -m 0644 "$up/$exe" "$dl/win/$exe"
install -m 0644 "$up/$exe" "$dl/.Deskwisp-Setup.exe.new" && mv -f "$dl/.Deskwisp-Setup.exe.new" "$dl/Deskwisp-Setup.exe"
install -m 0644 "$up/latest.json" "$dl/win/.latest.json.new" && mv -f "$dl/win/.latest.json.new" "$dl/win/latest.json"
# The newest three installers stay (an app mid-download keeps its file).
ls -1t "$dl/win"/Deskwisp-Setup-*-x64.exe | tail -n +4 | xargs -r rm -f
rm -rf "$up"
REMOTE

# 6. What deskwisp.com now serves is what was built.
size="$(node -p 'require("./dist-win/latest.json").size')"
got_version="$(curl -fsS --max-time 15 "https://deskwisp.com/download/win/latest.json?$(date +%s)" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
got_size="$(curl -fsSI --max-time 15 "https://deskwisp.com/download/win/$exe" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}')"
if [ "$got_version" != "$version" ] || [ "$got_size" != "$size" ]; then
  echo "deskwisp.com serves version $got_version, $got_size bytes: expected $version, $size bytes." >&2
  false
fi
echo "deskwisp.com has Deskwisp $version: installed apps update within the hour."

# 7. The release, in git: the version bump, committed and tagged (push it yourself).
trap - ERR
if [ "$version" != "$current" ]; then
  git add package.json $( [ -f package-lock.json ] && echo package-lock.json )
  git commit -q -m "Deskwisp $version for Windows"
fi
git tag -a "v$version" -m "Deskwisp $version for Windows" 2>/dev/null || echo "(The tag v$version was already there.)"
echo "Committed and tagged v$version. Then: git push && git push --tags"
