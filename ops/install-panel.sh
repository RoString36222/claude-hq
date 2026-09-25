#!/usr/bin/env bash
#
# Install the Arena deploy panel as a container in the compose project.
#
#   sudo PANEL_DOMAIN=deploy.example.com \
#        PANEL_ALLOWED_USERS=alice,bob \
#        ARENA_DOMAIN=arena.example.com \
#        bash ops/install-panel.sh
#
# You need a SECOND GitHub OAuth app (the Arena one has a different callback):
#   Homepage:  https://<PANEL_DOMAIN>
#   Callback:  https://<PANEL_DOMAIN>/auth/callback
#
# The panel runs alongside Caddy on the compose network, so Caddy reaches it by
# service name. An earlier version ran it on the host and had Caddy dial a
# bridge gateway; that needed the right gateway detected, the right bind
# address, and a firewall exception, and got all three wrong at least once.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

DIR="${ARENA_DIR:-/root/claude-hq}"
PANEL_DOMAIN="${PANEL_DOMAIN:?set PANEL_DOMAIN}"
ALLOWED="${PANEL_ALLOWED_USERS:?set PANEL_ALLOWED_USERS, e.g. alice,bob}"
ARENA_DOMAIN="${ARENA_DOMAIN:?set ARENA_DOMAIN}"
ENVFILE=/etc/arena-panel.env

# The host-based predecessor, if it is still around.
if systemctl list-unit-files arena-panel.service >/dev/null 2>&1; then
  systemctl disable --now arena-panel 2>/dev/null || true
  rm -f /etc/systemd/system/arena-panel.service
  systemctl daemon-reload
  echo "  removed the old host-based panel service"
fi

if [ ! -f "$ENVFILE" ]; then
  echo "GitHub OAuth app for the PANEL (callback https://$PANEL_DOMAIN/auth/callback)"
  printf '  Client ID: '; read -r CID
  printf '  Client Secret: '; read -rs CSEC; echo
  cat > "$ENVFILE" <<VARS
PANEL_SECRET_KEY=$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')
PANEL_GITHUB_CLIENT_ID=$CID
PANEL_GITHUB_CLIENT_SECRET=$CSEC
PANEL_BASE_URL=https://$PANEL_DOMAIN
PANEL_ALLOWED_USERS=$ALLOWED
VARS
  chmod 600 "$ENVFILE"
  echo "  wrote $ENVFILE (0600)"
else
  # Reconcile rather than silently keeping a stale file: an allowlist that
  # ignores what the operator just asked for is a security surprise.
  sed -i "s|^PANEL_ALLOWED_USERS=.*|PANEL_ALLOWED_USERS=$ALLOWED|" "$ENVFILE"
  sed -i "s|^PANEL_BASE_URL=.*|PANEL_BASE_URL=https://$PANEL_DOMAIN|" "$ENVFILE"
  # Values from the host-based layout are meaningless in a container.
  sed -i '/^PANEL_BIND=/d;/^ARENA_DIR=/d;/^ARENA_DOMAIN=/d' "$ENVFILE"
  grep -q '^PANEL_GITHUB_CLIENT_ID=.\+' "$ENVFILE" || {
    echo "  ERROR: $ENVFILE has no PANEL_GITHUB_CLIENT_ID."
    echo "  Edit it, or delete it and re-run to be prompted."; exit 1; }
  echo "  reconciled $ENVFILE (allowlist: $ALLOWED)"
fi

cd "$DIR/backend"
grep -q '^PANEL_DOMAIN=' .env \
  && sed -i "s|^PANEL_DOMAIN=.*|PANEL_DOMAIN=$PANEL_DOMAIN|" .env \
  || echo "PANEL_DOMAIN=$PANEL_DOMAIN" >> .env
# Service name on the compose network -- no gateway, no bind address.
grep -q '^PANEL_UPSTREAM=' .env \
  && sed -i "s|^PANEL_UPSTREAM=.*|PANEL_UPSTREAM=panel:8090|" .env \
  || echo "PANEL_UPSTREAM=panel:8090" >> .env
grep -q '^ARENA_DIR=' .env \
  || echo "ARENA_DIR=$DIR" >> .env

CADDY="$DIR/backend/Caddyfile"
if ! grep -q 'PANEL_UPSTREAM' "$CADDY"; then
  cat >> "$CADDY" <<'CADDYCFG'

{$PANEL_DOMAIN} {
	encode zstd gzip
	reverse_proxy {$PANEL_UPSTREAM}
}
CADDYCFG
  echo "  appended the panel block to the Caddyfile"
else
  echo "  Caddyfile already has the panel block"
fi

# Validate before restarting: an invalid config must not take Arena down.
if ! docker run --rm -v "$DIR/backend":/cfg:ro \
     -e ARENA_DOMAIN="$ARENA_DOMAIN" -e PANEL_DOMAIN="$PANEL_DOMAIN" \
     -e PANEL_UPSTREAM="panel:8090" caddy:2-alpine \
     caddy validate --config /cfg/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  echo "  ERROR: the Caddyfile is not valid; not restarting Caddy. Arena stays up."
  echo "  Inspect: $CADDY"; exit 1
fi

docker compose --profile panel up -d --build
sleep 6
docker compose --profile panel ps

echo
echo "  1. DNS: A record  $PANEL_DOMAIN  ->  this server"
echo "  2. Open https://$PANEL_DOMAIN"
echo "  allowlist: $ALLOWED   (re-run with a new PANEL_ALLOWED_USERS to change)"
echo "  logs: docker compose -f $DIR/backend/docker-compose.yml --profile panel logs -f panel"
