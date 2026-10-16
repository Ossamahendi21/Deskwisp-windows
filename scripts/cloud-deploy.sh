#!/usr/bin/env bash
# Deploys Deskwisp Cloud to its box (horafirm-web's production box, where it runs next to horafirm-web): the code
# (cloud/, db/), its settings, and the horafirm-relay rendezvous; then restarts both and checks the cloud
# answers. The box is set up once with cloud/deploy/install.sh. Run from the repo:
#   scripts/cloud-deploy.sh
# Needs: Horafirm's private Ossamahendi21/deskwisp-secrets next to this repo (DESKWISP_SECRETS points elsewhere) and sops,
# which decrypts its prod/deskwisp-secrets.env; gh (fetches horafirm-relay from its private releases); and SSH
# to the box as root (default key: z-legacy-fleet's id_ed25519; DESKWISP_CLOUD_SSH_KEY picks another).
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
# Horafirm's prod settings and secrets sit next to the main checkout (this may be a worktree elsewhere).
main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
prod="${DESKWISP_SECRETS:-$main/../deskwisp-secrets}/prod"
[ -f "$prod/deskwisp-public.env" ] || { echo "No $prod/deskwisp-public.env: clone Ossamahendi21/deskwisp-secrets next to $main, or set DESKWISP_SECRETS." >&2; exit 1; }
set -a
. "$prod/deskwisp-public.env"
set +a
[ -f "$prod/deskwisp-secrets.env" ] || { echo "No $prod/deskwisp-secrets.env." >&2; exit 1; }
: "${DESKWISP_CLOUD_BOX:?set DESKWISP_CLOUD_BOX (root@<address>) in deskwisp-secrets prod/deskwisp-public.env}"

ssh_opts=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
key="${DESKWISP_CLOUD_SSH_KEY:-$root/../z-legacy-fleet/.ssh/id_ed25519}"
[ -f "$key" ] && ssh_opts+=(-i "$key" -o IdentitiesOnly=yes)
box() { ssh "${ssh_opts[@]}" "$DESKWISP_CLOUD_BOX" "$@"; }

if [ -n "$(git status --porcelain -- cloud db)" ]; then
  echo "cloud/ or db/ has uncommitted changes: commit them first, so the box runs a known version." >&2
  exit 1
fi
rev="$(git rev-parse --short HEAD)"

# Only what the cloud uses: the public settings above, and of the secrets only the provider keys,
# Slack's signing secret, the database and the sealing key (not Stripe, Latitude or the Horafirm admin token).
# Both are read before anything on the box changes, so a decrypt that fails stops here.
public_settings="$(grep -E '^(DESKWISP_CLOUD_PUBLIC_URL|DESKWISP_CLOUD_PORT|DESKWISP_HORAFIRM_ORIGIN|OPENAI_SIP_URI|DESKWISP_VERIFY_EMAIL|DESKWISP_SLACK_APP_ID|DESKWISP_COMPOSIO_AUTH_CONFIGS|DESKWISP_AI_CREDITS|DESKWISP_PLAN_LIMITS|DESKWISP_MAIL_DOMAIN|DESKWISP_PHONE_AREA|DESKWISP_TELEMETRY)=' "$prod/deskwisp-public.env")"
secret_settings="$(sops -d "$prod/deskwisp-secrets.env" | grep -E '^(DESKWISP_DATABASE_URL|DESKWISP_CLOUD_SECRET|OPENAI_API_KEY|OPENAI_EXECUTOR_API_KEY|OPENAI_WEBHOOK_SECRET|DEEPINFRA_API_KEY|AGENTPHONE_API_KEY|AGENTMAIL_API_KEY|HONCHO_API_KEY|COMPOSIO_API_KEY|TYPESAFE_API_KEY|TREG_TOKEN|DESKWISP_SLACK_SIGNING_SECRET|DESKWISP_CLOUD_PLAN_SECRET|TWILIO_[A-Z_]+)=')"
grep -q '^DESKWISP_DATABASE_URL=' <<<"$secret_settings" || { echo "No DESKWISP_DATABASE_URL in $prod/deskwisp-secrets.env: the box's settings stay as they are." >&2; exit 1; }

echo "1/4 code ($rev)"
rsync -az --delete -e "ssh ${ssh_opts[*]}" --exclude node_modules --exclude test cloud db "$DESKWISP_CLOUD_BOX:/opt/deskwisp/"
echo "$rev" | box 'cat > /opt/deskwisp/REVISION'
box 'cd /opt/deskwisp/cloud && npm install --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error >/dev/null'

echo "2/4 settings"
printf '%s\n%s\n' "$public_settings" "$secret_settings" | box 'install -m 0640 -o root -g deskwisp /dev/stdin /etc/deskwisp-cloud/env'
unset secret_settings

echo "3/4 relay ($HORAFIRM_RELAY_VERSION)"
scripts/relay-deploy.sh

echo "4/4 restart and check"
box 'systemctl restart deskwisp-cloud.service && sleep 3 && systemctl is-active deskwisp-cloud.service'
curl -fsS --retry 5 --retry-delay 2 --retry-all-errors "$DESKWISP_CLOUD_PUBLIC_URL/health"
echo
echo "Deskwisp Cloud $rev is live at $DESKWISP_CLOUD_PUBLIC_URL"
