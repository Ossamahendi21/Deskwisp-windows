#!/usr/bin/env bash
# Deploys the horafirm-relay rendezvous to horafirm-web's production box, where it runs next to Deskwisp Cloud.
# It's what Horafirm's "Use my device's IP" (and so Deskwisp' "Route through this Mac") connects through:
# Macs dial it and hold a connection, and bot computers' browsers go out through them. This puts the
# release named by HORAFIRM_RELAY_VERSION on the box with its secret and Caddy's certificate for
# RELAY_HOST, restarts it, and checks it answers at https://RELAY_HOST:8443. The box is set up once
# with cloud/deploy/install.sh; scripts/cloud-deploy.sh runs this too. Run from the repo:
#   scripts/relay-deploy.sh
# Needs: Horafirm's private Ossamahendi21/deskwisp-secrets next to this repo (DESKWISP_SECRETS points elsewhere) and sops,
# which decrypts its prod/deskwisp-secrets.env; gh (horafirm-relay's releases are private); and SSH to the box
# as root (default key: z-legacy-fleet's id_ed25519; DESKWISP_CLOUD_SSH_KEY picks another).
#
# HORAFIRM_RELAY_SECRET has to be the same value as in horafirm-web's envs/prod/web-secrets.env: horafirm-web
# makes every device's and computer's credential from it, and the rendezvous checks them with it.
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
: "${DESKWISP_CLOUD_BOX:?set DESKWISP_CLOUD_BOX (root@<address>) in deskwisp-secrets prod/deskwisp-public.env}"
: "${HORAFIRM_RELAY_VERSION:?set HORAFIRM_RELAY_VERSION (an horafirm-relay release, like v0.0.3) in deskwisp-secrets prod/deskwisp-public.env}"
: "${RELAY_HOST:?set RELAY_HOST (the name Caddy has a certificate for) in deskwisp-secrets prod/deskwisp-public.env}"

ssh_opts=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
key="${DESKWISP_CLOUD_SSH_KEY:-$root/../z-legacy-fleet/.ssh/id_ed25519}"
[ -f "$key" ] && ssh_opts+=(-i "$key" -o IdentitiesOnly=yes)
box() { ssh "${ssh_opts[@]}" "$DESKWISP_CLOUD_BOX" "$@"; }

secret="$(sops -d "$prod/deskwisp-secrets.env" | sed -n 's/^HORAFIRM_RELAY_SECRET=//p')"
if [ -z "$secret" ]; then
  echo "   no HORAFIRM_RELAY_SECRET in deskwisp-secrets.env yet: rendezvous left as it is"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gh release download "$HORAFIRM_RELAY_VERSION" -R horafirm/horafirm-relay -p horafirm-relay-linux-amd64 -p SHA256SUMS -D "$tmp" >/dev/null
(cd "$tmp" && grep ' horafirm-relay-linux-amd64$' SHA256SUMS | shasum -a 256 -c - >/dev/null)
rsync -az -e "ssh ${ssh_opts[*]}" "$tmp/horafirm-relay-linux-amd64" "$DESKWISP_CLOUD_BOX:/usr/local/bin/horafirm-relay.new"
box 'chmod 0755 /usr/local/bin/horafirm-relay.new && mv /usr/local/bin/horafirm-relay.new /usr/local/bin/horafirm-relay'
printf 'HORAFIRM_RELAY_SECRET=%s\nRELAY_HOST=%s\n' "$secret" "$RELAY_HOST" | box 'install -m 0640 -o root -g horafirm-relay /dev/stdin /etc/horafirm-relay/env'
# The certificate first (the rendezvous won't start without it), then the timer that picks up
# Caddy's renewals, then the rendezvous itself.
box 'systemctl start horafirm-relay-cert.service && systemctl enable --now horafirm-relay-cert.timer >/dev/null 2>&1 && test -s /etc/horafirm-relay/tls/cert.pem && systemctl restart horafirm-relay-rendezvous.service && sleep 2 && systemctl is-active horafirm-relay-rendezvous.service'

health="$(curl -fsS --retry 5 --retry-delay 2 --retry-all-errors "https://$RELAY_HOST:8443/healthz")"
case "$health" in
  *"\"version\":\"$HORAFIRM_RELAY_VERSION\""*) echo "   rendezvous $HORAFIRM_RELAY_VERSION answers at https://$RELAY_HOST:8443 ($health)" ;;
  *) echo "The rendezvous answered, but not as $HORAFIRM_RELAY_VERSION: $health" >&2; exit 1 ;;
esac
