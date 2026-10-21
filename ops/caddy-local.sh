# Server-local Caddy sites (sourced by ops/install-panel.sh and ops/install-monitoring.sh).
#
# The deploy panel and Grafana are per-server: they live in backend/caddy.d/<name>.caddy, which git
# ignores and backend/Caddyfile imports (`import caddy.d/*.caddy`; no match is fine). Writing them into
# the tracked Caddyfile left the server's checkout dirty, and ops/release.sh (so autodeploy) refuses to
# pull over local changes.
#
#   caddy_site DIR panel|grafana    write that site's file (idempotent)
#   caddy_migrate DIR               move blocks an older installer appended to backend/Caddyfile into
#                                   caddy.d/, then restore the tracked Caddyfile -- only when every local
#                                   change to it is an added line, so nothing hand-edited is thrown away

caddy_block() {
  case "$1" in
    panel) cat <<'CADDYCFG'
{$PANEL_DOMAIN} {
	encode zstd gzip
	reverse_proxy {$PANEL_UPSTREAM}
}
CADDYCFG
    ;;
    grafana) cat <<'CADDYCFG'
{$GRAFANA_DOMAIN} {
	encode zstd gzip
	reverse_proxy grafana:3000
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
	}
}
CADDYCFG
    ;;
    *) echo "caddy_block: unknown site $1" >&2; return 1 ;;
  esac
}

caddy_site() {
  local dir="$1" name="$2" f
  mkdir -p "$dir/backend/caddy.d"
  f="$dir/backend/caddy.d/$name.caddy"
  caddy_block "$name" > "$f.tmp" && mv "$f.tmp" "$f"
  echo "  wrote backend/caddy.d/$name.caddy"
}

caddy_migrate() {
  local dir="$1" cf="$1/backend/Caddyfile"
  git -C "$dir" diff --quiet -- backend/Caddyfile 2>/dev/null && return 0   # already clean
  grep -q 'PANEL_UPSTREAM' "$cf" && [ ! -f "$dir/backend/caddy.d/panel.caddy" ] && caddy_site "$dir" panel
  grep -q 'GRAFANA_DOMAIN' "$cf" && [ ! -f "$dir/backend/caddy.d/grafana.caddy" ] && caddy_site "$dir" grafana
  if [ -z "$(git -C "$dir" diff -U0 -- backend/Caddyfile | grep -E '^-[^-]')" ]; then
    git -C "$dir" checkout -- backend/Caddyfile
    echo "  restored the tracked Caddyfile (its extra sites now live in backend/caddy.d/)"
  else
    echo "  NOTE: backend/Caddyfile has hand edits beyond appended sites; left as it is."
    echo "        Move them into backend/caddy.d/*.caddy, then: git -C $dir checkout -- backend/Caddyfile"
  fi
}
