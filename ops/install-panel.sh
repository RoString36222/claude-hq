#!/usr/bin/env bash
#
# Install the Arena deploy panel.
#
#   sudo PANEL_DOMAIN=deploy.heshdev.tech \
#        PANEL_ALLOWED_USERS=hetnxik,shashwat \
#        bash ops/install-panel.sh
#
# You need a SECOND GitHub OAuth app (the Arena one has a different callback):
#   Homepage:  https://<PANEL_DOMAIN>
#   Callback:  https://<PANEL_DOMAIN>/auth/callback
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

DIR="${ARENA_DIR:-/root/claude-hq}"
PANEL_DOMAIN="${PANEL_DOMAIN:?set PANEL_DOMAIN}"
ALLOWED="${PANEL_ALLOWED_USERS:?set PANEL_ALLOWED_USERS, e.g. hetnxik,shashwat}"
ARENA_DOMAIN="${ARENA_DOMAIN:-}"
ENVFILE=/etc/arena-panel.env
# Containers cannot reach the host's loopback; the bridge gateway they can.
BRIDGE=$(ip -4 addr show docker0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1)
BRIDGE="${BRIDGE:-172.17.0.1}"
echo "  docker bridge: $BRIDGE"

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
ARENA_DIR=$DIR
ARENA_DOMAIN=$ARENA_DOMAIN
PANEL_BIND=$BRIDGE
VARS
  chmod 600 "$ENVFILE"
  echo "  wrote $ENVFILE (0600)"
else
  echo "  $ENVFILE exists, keeping it (edit by hand to change the allowlist)"
fi

cat > /etc/systemd/system/arena-panel.service <<UNIT
[Unit]
Description=Arena deploy panel
After=docker.service

[Service]
EnvironmentFile=$ENVFILE
ExecStart=/usr/bin/python3 $DIR/ops/deploy_panel.py
Restart=always
RestartSec=5
# It drives git and docker, so it cannot be meaningfully sandboxed --
# but it never listens on a public interface and takes no command input.
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now arena-panel
sleep 2
systemctl is-active arena-panel >/dev/null && echo "  panel running on $BRIDGE:8090 (not publicly reachable)" || {
  echo "  FAILED — journalctl -u arena-panel -n 30"; exit 1; }

# Caddy fronts it; the panel itself is never exposed directly.
CADDY="$DIR/backend/Caddyfile"
if ! grep -q "$PANEL_DOMAIN" "$CADDY"; then
  cat >> "$CADDY" <<CADDYCFG

{\$PANEL_DOMAIN} {
	encode zstd gzip
	reverse_proxy {\$PANEL_UPSTREAM}
}
CADDYCFG
  echo "  appended $PANEL_DOMAIN to Caddyfile"
fi

grep -q PANEL_DOMAIN "$DIR/backend/.env" || echo "PANEL_DOMAIN=$PANEL_DOMAIN" >> "$DIR/backend/.env"
grep -q PANEL_UPSTREAM "$DIR/backend/.env" || echo "PANEL_UPSTREAM=$BRIDGE:8090" >> "$DIR/backend/.env"
cd "$DIR/backend" && docker compose up -d --force-recreate caddy

echo
echo "  1. DNS: A record  $PANEL_DOMAIN  ->  this server"
echo "  2. Open https://$PANEL_DOMAIN"
echo "  allowlist: $ALLOWED   (edit $ENVFILE, then: systemctl restart arena-panel)"
