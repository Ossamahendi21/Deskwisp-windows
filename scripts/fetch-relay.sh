#!/usr/bin/env bash
# Fetches the relay agent (horafirm-relay) that routes the bots' computers through this Mac
# (lib/server/relay.ts), checks it against the release's SHA256SUMS, and puts it at
# vendor/horafirm-relay/horafirm-relay, where the dev server finds it. The packaged app bundles this copy
# and points DESKWISP_RELAY_BIN at it.
#
# The version is pinned: keep it at what Horafirm's HORAFIRM_RELAY_VERSION expects (horafirm-web
# envs/<env>/web-public.env). The repo is private for now, so this needs `gh` signed in to GitHub
# with access to horafirm/horafirm-relay.
#
# Usage: scripts/fetch-relay.sh [version] [arch]     e.g. scripts/fetch-relay.sh v0.0.3 arm64
set -euo pipefail

version="${1:-${DESKWISP_RELAY_VERSION:-v0.0.3}}"
arch="${2:-$(uname -m)}"
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=amd64 ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac
asset="horafirm-relay-darwin-$arch"

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/vendor/horafirm-relay"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

gh release download "$version" -R horafirm/horafirm-relay -p "$asset" -p SHA256SUMS -D "$tmp"

want="$(awk -v f="$asset" '$2 == f || $2 == "*"f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$want" ] || { echo "$asset isn't in the release's SHA256SUMS" >&2; exit 1; }
got="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
[ "$want" = "$got" ] || { echo "checksum mismatch for $asset: want $want, got $got" >&2; exit 1; }

mkdir -p "$dest"
install -m 0755 "$tmp/$asset" "$dest/horafirm-relay"
echo "$version" > "$dest/VERSION"
echo "horafirm-relay $version ($arch) -> vendor/horafirm-relay/horafirm-relay (sha256 $got)"
