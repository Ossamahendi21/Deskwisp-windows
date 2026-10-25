#!/usr/bin/env bash
# Builds Deskwisp for the Microsoft Store: an MSIX package (dist-store/Deskwisp-<version>-x64.appx) of the
# version in package.json, to upload in Partner Center (Deskwisp → the submission → Packages). The Store
# signs it and keeps it up to date; that Deskwisp never runs the updater (desktop/win-main.cjs STORE).
#
#   bash scripts/release-win.sh 0.1.11     # first the release from deskwisp.com, as always
#   bash scripts/release-store.sh          # then its Store package
#
# It's a separate app beside the one from deskwisp.com (its own id, HorafirmLLC.Deskwisp, and its own data).
# Its identity, from Partner Center's Product identity page, is electron-builder.win.json's "appx"; its
# pictures are build/appx/ (scripts/render-store-assets.mjs). Runs on Windows only (Git Bash): electron-builder
# makes MSIX packages only there. Each package the Store gets must have a higher version than the last.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) ;;
  *) echo "The Store package is built on Windows (Git Bash): electron-builder makes MSIX packages only there." >&2; exit 1 ;;
esac
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Commit (or put away) your changes first: the Store gets what's committed." >&2; exit 1; }
version="$(node -p 'require("./package.json").version')"
pkg="dist-store/Deskwisp-$version-x64.appx"
echo "Deskwisp $version for the Microsoft Store"

# 1. The server and its smoke test, as for the installer (nothing is published). The last package's folder
#    goes first: it holds a copy of the server's sources, which the build would read as its own.
rm -rf dist-store
bash scripts/release-win.sh --no-publish

# 2. The MSIX package, from the same build.
npx electron-builder --win appx --x64 --config electron-builder.win.json --publish never -c.directories.output=dist-store
[ -f "$pkg" ] || { echo "No $pkg" >&2; exit 1; }
ls -la "$pkg"
echo
echo "Upload $pkg in Partner Center: Apps and games → Deskwisp → the submission → Packages."
