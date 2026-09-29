#!/usr/bin/env bash
#
# Arena backend manager — day-to-day lifecycle control for a self-hosted
# Claude HQ Arena server.
#
# The wizards do first-time SETUP; this manages the server AFTER that:
# status, start/stop/restart, logs, health, migrate, update.
#
#   ops/arena-manager.sh status
#   ops/arena-manager.sh restart
#   ops/arena-manager.sh logs arena       # or: tunnel | panel (docker)
#   ops/arena-manager.sh update           # git pull --ff-only, migrate, restart, verify
#
# It auto-detects how the backend runs:
#   * mac    — the launchd agents that selfhost-wizard.sh installs
#   * docker — the docker-compose project (any VM, incl. the deploy panel)
# and reports "not installed" when neither is present, so it is safe to run on
# a fresh clone.
#
# Standard tools only (launchctl / docker / git / curl / uv / python3) — no new
# dependencies, matching the rest of the repo.

# NOTE: added as part of the backend-manager work — a single-entry lifecycle CLI
# so `arena-manager update` handles the whole pull → build → verify → rollback dance.

set -euo pipefail

# ── looks ───────────────────────────────────────────────────────────────────
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
info() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }
head() { printf '\n%s%s%s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"; }
row()  { printf '  %-14s %s\n' "$1" "$2"; }

# ── locations / constants (mirror selfhost-wizard.sh) ───────────────────────
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$REPO/backend"
ENV_FILE="$BACKEND/.env"
PORT="${ARENA_BIND_PORT:-8080}"
LOCAL_HEALTH="http://127.0.0.1:${PORT}/health"

ARENA_LABEL="com.claudehq.arena"
TUNNEL_LABEL="com.claudehq.arena-tunnel"
AGENTS="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs"
ARENA_PLIST="$AGENTS/$ARENA_LABEL.plist"
BRANCH="${ARENA_BRANCH:-main}"

# Public URL is read from the env file at runtime, so no secrets are baked in.
public_url() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E '^ARENA_PUBLIC_BASE_URL=' "$ENV_FILE" | tail -n1) || return 1
  local url="${line#*=}"; url="${url%\"}"; url="${url#\"}"
  [[ -n "$url" ]] && printf '%s' "$url"
}

# ── mode detection ──────────────────────────────────────────────────────────
# mac    : launchd agent installed
# docker : compose file + docker CLI + the app service defined
# none   : neither
detect_mode() {
  if [[ -f "$ARENA_PLIST" ]]; then echo mac; return; fi
  if [[ -f "$BACKEND/docker-compose.yml" ]] && command -v docker >/dev/null 2>&1 \
     && docker compose version >/dev/null 2>&1; then echo docker; return; fi
  echo none
}
MODE="${ARENA_MANAGER_MODE:-$(detect_mode)}"

dc() { ( cd "$BACKEND" && docker compose "$@" ); }

# ── health ──────────────────────────────────────────────────────────────────
curl_health() { curl -fsS --max-time 5 "$1" 2>/dev/null || true; }

# ── git status (works in either mode) ───────────────────────────────────────
git_line() {
  local local_sha remote_sha behind
  local_sha=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo "?")
  git -C "$REPO" fetch origin "$BRANCH" --quiet 2>/dev/null || true
  remote_sha=$(git -C "$REPO" rev-parse --short "origin/$BRANCH" 2>/dev/null || echo "?")
  behind=$(git -C "$REPO" rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)
  if [[ "$behind" != "0" ]]; then
    printf '%s → %s (%s%s commit(s) behind%s)' "$local_sha" "$remote_sha" "$YELLOW" "$behind" "$RESET"
  else
    printf '%s (up to date)' "$local_sha"
  fi
}

# ── commands ────────────────────────────────────────────────────────────────
cmd_status() {
  head "Arena backend — status"
  row "mode" "$MODE"
  row "repo" "$REPO"
  row "revision" "$(git_line)"

  # service health
  local lh; lh=$(curl_health "$LOCAL_HEALTH")
  if [[ -n "$lh" ]]; then ok "local:  $lh"; else bad "local:  not responding on $LOCAL_HEALTH"; fi
  local url; if url=$(public_url); then
    local ph; ph=$(curl_health "$url/health")
    if [[ -n "$ph" ]]; then ok "public: $ph  ($url)"; else warn "public: no response ($url/health)"; fi
  fi

  case "$MODE" in
    mac)
      printf '\n'; info "launchd agents:"
      for l in "$ARENA_LABEL" "$TUNNEL_LABEL"; do
        if launchctl print "gui/$(id -u)/$l" >/dev/null 2>&1; then ok "$l  (loaded)"; else bad "$l  (not loaded)"; fi
      done ;;
    docker)
      printf '\n'; info "containers:"; dc ps 2>/dev/null || true ;;
    none)
      printf '\n'; warn "No Arena backend is installed on this machine."
      info "Set one up:  ./selfhost-wizard.sh   (this Mac)   |   ./deploy-wizard.sh   (Fly.io)"
      info "Or on a VM:  ARENA_DOMAIN=... docker compose -f backend/docker-compose.yml up -d" ;;
  esac
  printf '\n'
}

_need_installed() {
  [[ "$MODE" == "none" ]] && { warn "Nothing installed to manage. Run a setup wizard first."; exit 1; }
}

cmd_start() {
  _need_installed
  if [[ "$MODE" == mac ]]; then
    for l in "$ARENA_LABEL" "$TUNNEL_LABEL"; do
      [[ -f "$AGENTS/$l.plist" ]] || continue
      launchctl bootstrap "gui/$(id -u)" "$AGENTS/$l.plist" 2>/dev/null \
        || launchctl kickstart -k "gui/$(id -u)/$l" 2>/dev/null || true
      ok "started $l"
    done
  else
    dc up -d && ok "compose up -d"
  fi
}

cmd_stop() {
  _need_installed
  if [[ "$MODE" == mac ]]; then
    for l in "$TUNNEL_LABEL" "$ARENA_LABEL"; do
      launchctl bootout "gui/$(id -u)/$l" 2>/dev/null && ok "stopped $l" || info "$l already stopped"
    done
  else
    dc stop && ok "compose stop"
  fi
}

cmd_restart() {
  _need_installed
  if [[ "$MODE" == mac ]]; then
    for l in "$ARENA_LABEL" "$TUNNEL_LABEL"; do
      [[ -f "$AGENTS/$l.plist" ]] || continue
      launchctl kickstart -k "gui/$(id -u)/$l" 2>/dev/null && ok "restarted $l" \
        || { launchctl bootstrap "gui/$(id -u)" "$AGENTS/$l.plist" 2>/dev/null && ok "started $l"; }
    done
  else
    dc up -d --build && ok "compose up -d --build"
  fi
}

cmd_logs() {
  _need_installed
  local which="${1:-arena}"
  if [[ "$MODE" == mac ]]; then
    local label="$ARENA_LABEL"; [[ "$which" == tunnel ]] && label="$TUNNEL_LABEL"
    local f="$LOG_DIR/$label.err.log"
    [[ -f "$f" ]] || f="$LOG_DIR/$label.log"
    [[ -f "$f" ]] || { warn "no log file yet at $LOG_DIR/$label.*"; exit 1; }
    info "tailing $f  (Ctrl-C to stop)"; exec tail -f "$f"
  else
    local svc="app"; [[ "$which" == panel ]] && svc="panel"
    exec bash -c "cd '$BACKEND' && docker compose ${which:+--profile panel} logs -f $svc"
  fi
}

cmd_migrate() {
  _need_installed
  if [[ "$MODE" == mac ]]; then
    command -v uv >/dev/null 2>&1 || { bad "uv not found on PATH"; exit 1; }
    ( cd "$BACKEND" && uv run --no-dev alembic upgrade head ) && ok "migrations applied"
  else
    info "docker mode runs migrations automatically on boot (entrypoint.sh)."
    info "Force now:  docker compose -f $BACKEND/docker-compose.yml run --rm app uv run --no-dev alembic upgrade head"
  fi
}

cmd_update() {
  _need_installed
  head "Arena backend — update"
  local before; before=$(git -C "$REPO" rev-parse --short HEAD)
  git -C "$REPO" fetch origin "$BRANCH" --quiet
  if [[ "$(git -C "$REPO" rev-parse HEAD)" == "$(git -C "$REPO" rev-parse "origin/$BRANCH")" ]]; then
    ok "already on the latest $BRANCH ($before) — nothing to do"; return
  fi
  git -C "$REPO" merge --ff-only "origin/$BRANCH" --quiet \
    || { bad "not a fast-forward — resolve manually (local commits on $BRANCH?)"; exit 1; }
  ok "updated $before → $(git -C "$REPO" rev-parse --short HEAD)"
  [[ "$MODE" == mac ]] && cmd_migrate
  cmd_restart
  printf '\n'; info "verifying health…"
  for _ in 1 2 3 4 5 6; do
    sleep 4
    [[ -n "$(curl_health "$LOCAL_HEALTH")" ]] && { ok "healthy after update"; return; }
  done
  warn "still not healthy — check:  $0 logs   (or roll back: git -C $REPO reset --hard $before && $0 restart)"
  exit 1
}

usage() {
  cat <<EOF
${BOLD}Arena backend manager${RESET}  (mode: ${MODE})

  ${BOLD}$0${RESET} <command>

  status              health, revision, and service/agent state
  start               start the backend (+ tunnel, on macOS)
  stop                stop it
  restart             restart it
  logs [arena|tunnel|panel]   tail logs (default: arena)
  health              print local + public /health
  migrate             apply database migrations (alembic upgrade head)
  update              git pull --ff-only, migrate, restart, verify health

Detected mode: ${BOLD}${MODE}${RESET}  (override with ARENA_MANAGER_MODE=mac|docker)
EOF
}

case "${1:-status}" in
  status)  cmd_status ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  logs)    cmd_logs "${2:-arena}" ;;
  health)
    lh=$(curl_health "$LOCAL_HEALTH"); [[ -n "$lh" ]] && ok "local:  $lh" || bad "local:  no response"
    if url=$(public_url); then ph=$(curl_health "$url/health"); [[ -n "$ph" ]] && ok "public: $ph" || warn "public: no response"; fi ;;
  migrate) cmd_migrate ;;
  update)  cmd_update ;;
  -h|--help|help) usage ;;
  *) warn "unknown command: $1"; usage; exit 1 ;;
esac
