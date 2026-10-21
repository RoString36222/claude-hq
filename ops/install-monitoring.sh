#!/usr/bin/env bash
#
# Put the Arena's Grafana on its own domain, behind Caddy (HTTPS, automatic
# certificate), and start the monitoring profile (Prometheus, node-exporter,
# Grafana).
#
#   sudo GRAFANA_DOMAIN=grafana.example.com ARENA_DOMAIN=arena.example.com \
#        bash ops/install-monitoring.sh
#
# Before you run it: an A record GRAFANA_DOMAIN -> this server (Caddy needs it
# to get the certificate). Grafana's own login protects the site; this script
# generates a strong admin password the first time and prints it once.
# Re-running is safe: it keeps the password and the Caddy block it already wrote.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

DIR="${ARENA_DIR:-/root/claude-hq}"
GRAFANA_DOMAIN="${GRAFANA_DOMAIN:?set GRAFANA_DOMAIN, e.g. grafana.example.com}"
ARENA_DOMAIN="${ARENA_DOMAIN:?set ARENA_DOMAIN}"
[[ "$GRAFANA_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "bad GRAFANA_DOMAIN: $GRAFANA_DOMAIN"; exit 1; }

cd "$DIR/backend"
touch .env
setenv() {   # key value: set or replace a line in .env
  grep -q "^$1=" .env && sed -i "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env
}
setenv GRAFANA_DOMAIN "$GRAFANA_DOMAIN"
# Every later `docker compose` (and ops/release.sh) keeps the monitoring services.
grep -q '^COMPOSE_PROFILES=' .env || echo "COMPOSE_PROFILES=monitoring" >> .env
NEWPW=""
if ! grep -q '^GRAFANA_ADMIN_PASSWORD=.\+' .env; then
  NEWPW=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-28)
  setenv GRAFANA_ADMIN_PASSWORD "$NEWPW"
  chmod 600 .env
fi

# The Caddyfile Caddy actually reads: a docker-compose.override.yml may mount another
# one (e.g. /etc/caddy-local/Caddyfile shared with other sites) over the repo's copy.
CADDY="$DIR/backend/Caddyfile"
CID=$(docker compose ps -q caddy 2>/dev/null | head -1 || true)
if [ -n "$CID" ]; then
  SRC=$(docker inspect "$CID" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')
  [ -n "$SRC" ] && [ -f "$SRC" ] && CADDY="$SRC"
fi
echo "  Caddyfile: $CADDY"
if ! grep -qE 'GRAFANA_DOMAIN|^'"$GRAFANA_DOMAIN"' ' "$CADDY"; then
  cp -p "$CADDY" "$CADDY.bak-$(date +%s)"
  cat >> "$CADDY" <<CADDYCFG

# >>> grafana >>>
$GRAFANA_DOMAIN {
	encode zstd gzip
	reverse_proxy grafana:3000
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
	}
}
# <<< grafana <<<
CADDYCFG
  echo "  appended the Grafana block to the Caddyfile"
else
  echo "  Caddyfile already has the Grafana block"
fi

# Validate before restarting: an invalid config must not take the Arena down. Inside
# the running Caddy when there is one (its environment has every site's variables).
if [ -n "$CID" ]; then
  VALID() { docker exec "$CID" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; }
else
  PANEL_DOMAIN=$(grep -E '^PANEL_DOMAIN=' .env | cut -d= -f2- || true)
  PANEL_UPSTREAM=$(grep -E '^PANEL_UPSTREAM=' .env | cut -d= -f2- || true)
  VALID() { docker run --rm -v "$CADDY":/cfg/Caddyfile:ro \
     -e ARENA_DOMAIN="$ARENA_DOMAIN" -e GRAFANA_DOMAIN="$GRAFANA_DOMAIN" \
     -e PANEL_DOMAIN="$PANEL_DOMAIN" -e PANEL_UPSTREAM="$PANEL_UPSTREAM" caddy:2-alpine \
     caddy validate --config /cfg/Caddyfile --adapter caddyfile >/dev/null 2>&1; }
fi
if ! VALID; then
  echo "  ERROR: the Caddyfile is not valid; not restarting Caddy. Arena stays up."
  echo "  Inspect: $CADDY"; exit 1
fi

# Named services, and --no-deps: Caddy depends on `app`, and without --no-deps compose
# recreates `app` too -- from the compose default image (claude-hq-arena:local) instead
# of the release ops/release.sh records in .release.env. `app` is not this script's
# business. The release file is passed anyway so the project's config matches a release.
ENVS=(--env-file .env)
[ -f .release.env ] && ENVS+=(--env-file .release.env)
docker compose "${ENVS[@]}" --profile monitoring up -d --no-deps prometheus node-exporter grafana caddy
# `up` leaves an unchanged Caddy running on its old config: reload it in place.
docker compose "${ENVS[@]}" exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
sleep 6
docker compose "${ENVS[@]}" --profile monitoring ps

echo
echo "  Open https://$GRAFANA_DOMAIN  (user: admin)"
if [ -n "$NEWPW" ]; then
  echo "  admin password (saved in $DIR/backend/.env as GRAFANA_ADMIN_PASSWORD): $NEWPW"
else
  echo "  admin password: GRAFANA_ADMIN_PASSWORD in $DIR/backend/.env"
fi
echo "  logs: docker compose -f $DIR/backend/docker-compose.yml --profile monitoring logs -f grafana"
