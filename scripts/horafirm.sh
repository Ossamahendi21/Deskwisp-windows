#!/usr/bin/env bash
# Thin Horafirm REST helper. Reads the key from the Horafirm CLI login so it never sits in the repo.
# Usage: scripts/horafirm.sh METHOD PATH [JSON_BODY]
set -euo pipefail
KEY="${HORAFIRM_API_KEY:-$(python3 -c "import json;print(json.load(open('$HOME/.horafirm/credentials.json'))['profiles']['default']['apiKey'])")}"
METHOD="$1"; PATH_="$2"; BODY="${3:-}"
if [[ -n "$BODY" ]]; then
  curl -sS -X "$METHOD" "https://app.deskwisp.com/api$PATH_" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$BODY"
else
  curl -sS -X "$METHOD" "https://app.deskwisp.com/api$PATH_" -H "Authorization: Bearer $KEY"
fi
