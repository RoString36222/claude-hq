#!/usr/bin/env bash
# Run Claude HQ fully on this machine: a local Arena (backend/) on 127.0.0.1 with
# the dev login and world preview on, and a dashboard paired to it.
#
#   tools/local_arena.sh build            cargo build --release (backend/ and dashboard-rs/)
#   tools/local_arena.sh start            (re)start the local Arena on 127.0.0.1:$ARENA_PORT
#   tools/local_arena.sh stop             stop it (pid file, or the LaunchAgent)
#   tools/local_arena.sh dashboard        restart the owner's launchd dashboard
#   tools/local_arena.sh dashboard-tmp <root> <port>
#                                         a preview dashboard on <port> serving <root>
#   tools/local_arena.sh stop-tmp <port>  stop that preview dashboard
#   tools/local_arena.sh pair [port] [handle]
#                                         pair the dashboard on [port] to the local Arena
#   tools/local_arena.sh pair2            a second dashboard on $HQ2_PORT as user dev2 (C5)
#   tools/local_arena.sh stop2            stop it and remove its root
#   tools/local_arena.sh status           what runs where, paired to what
#   tools/local_arena.sh restore [port]   put back the production config + link
#   tools/local_arena.sh install-agent | uninstall-agent
#                                         keep the local Arena running across logins
#
# Never deploys anything, never calls /api/arena/unpair (it deletes the link).
# Environment (overridable, e.g. by tests/test_local_arena.py):
#   HQ_ROOT (~/claude-hq)  REPO (this script's repo)  ARENA_DEV_DATA (~/.local/share/claude-hq-dev-arena)
#   ARENA_PORT (8080)  HQ_PORT (8765)  HQ2_PORT (8766)  LAUNCH_AGENTS (~/Library/LaunchAgents)
#   PROD_ARENA_URL (https://arena.heshdev.tech)
set -euo pipefail

HQ_ROOT="${HQ_ROOT:-$HOME/claude-hq}"
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA="${ARENA_DEV_DATA:-$HOME/.local/share/claude-hq-dev-arena}"
ARENA_PORT="${ARENA_PORT:-8080}"
HQ_PORT="${HQ_PORT:-8765}"
HQ2_PORT="${HQ2_PORT:-8766}"
LAUNCH_AGENTS="${LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"
PROD_ARENA_URL="${PROD_ARENA_URL:-https://arena.heshdev.tech}"
CARGO="${CARGO:-$HOME/.cargo/bin/cargo}"
AGENT=com.claudehq.devarena
AGENT_PLIST="$LAUNCH_AGENTS/$AGENT.plist"
DASH_AGENT=com.claudehq.dashboard
ARENA_URL="http://127.0.0.1:$ARENA_PORT"
WORLD=claude-hq@1

say() { printf 'local_arena: %s\n' "$*"; }
die() { printf 'local_arena: ERROR: %s\n' "$*" >&2; exit 1; }
rp() { python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$1"; }
# json_get <key> : read one top-level key of the JSON on stdin ("" when absent; bools as true/false)
json_get() {
  python3 -c '
import json,sys
try: v=json.load(sys.stdin).get(sys.argv[1], "")
except Exception: v=""
print(("true" if v else "false") if isinstance(v,bool) else v)' "$1"
}
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
pid_of_file() { [ -f "$1" ] && tr -dc '0-9' < "$1" || true; }
exe_of() { lsof -a -p "$1" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }
listeners() { lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }
agent_installed() { [ -f "$AGENT_PLIST" ]; }
# wait_for <seconds> <command...> : poll every 0.25 s
wait_for() {
  local n=$(( $1 * 4 )); shift
  while [ "$n" -gt 0 ]; do "$@" >/dev/null 2>&1 && return 0; sleep 0.25; n=$((n - 1)); done
  return 1
}
port_free() { [ -z "$(listeners "$1")" ]; }
# our_pid <pid file> <binary...> : the live pid in that file when it runs one of those
# binaries; otherwise prints nothing (a stale pid can belong to anything after a reboot)
our_pid() {
  local f="$1" pid exe b; shift
  pid=$(pid_of_file "$f")
  alive "$pid" || return 0
  exe=$(exe_of "$pid"); [ -n "$exe" ] && exe=$(rp "$exe")
  for b in "$@"; do [ -n "$exe" ] && [ "$exe" = "$(rp "$b")" ] && { echo "$pid"; return 0; }; done
  say "$f names pid $pid ($(ps -o command= -p "$pid" 2>/dev/null || echo '?')), not ours; killing nothing" >&2
}
ARENA_BINS=("$REPO/backend/target/release/arena" "$HQ_ROOT/backend/target/release/arena")
DASH_BINS=("$REPO/dashboard-rs/target/release/claudehq" "$HQ_ROOT/dashboard-rs/target/release/claudehq")
arena_healthy() { curl -fsS --max-time 2 "$ARENA_URL/health" >/dev/null; }
dash_up() { curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$1/"; }

mkdir -p "$DATA"
chmod 700 "$DATA"

# The dashboard root behind a port: the one dashboard-tmp recorded, else $HQ_ROOT for $HQ_PORT.
root_for_port() {
  if [ -f "$DATA/hq-$1.root" ]; then cat "$DATA/hq-$1.root"
  elif [ "$1" = "$HQ_PORT" ]; then printf '%s\n' "$HQ_ROOT"
  else die "no known dashboard root for port $1 (start it with dashboard-tmp)"; fi
}

arena_env() {
  [ -f "$DATA/secret_key" ] || (umask 077; openssl rand -hex 32 > "$DATA/secret_key")
  mkdir -p "$DATA/sounds"
  ENVV=(
    "ARENA_BIND_HOST=127.0.0.1" "ARENA_BIND_PORT=$ARENA_PORT" "ARENA_WORLD_PREVIEW=1" "ARENA_DEV_LOGIN=1"
    "ARENA_DATABASE_URL=sqlite:$DATA/arena.db" "ARENA_SOUNDS_DIR=$DATA/sounds"
    "ARENA_SECRET_KEY=$(cat "$DATA/secret_key")" "ARENA_PUBLIC_BASE_URL=$ARENA_URL"
  )
}

# Free $ARENA_PORT, killing only an arena binary built from $REPO or $HQ_ROOT.
stop_port_arena() {
  local pid exe ok mine1 mine2
  pid=$(our_pid "$DATA/arena.pid" "${ARENA_BINS[@]}")
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait_for 10 port_free "$ARENA_PORT" || true; fi
  rm -f "$DATA/arena.pid"
  port_free "$ARENA_PORT" && return 0
  mine1=$(rp "${ARENA_BINS[0]}"); mine2=$(rp "${ARENA_BINS[1]}")
  for pid in $(listeners "$ARENA_PORT"); do
    exe=$(exe_of "$pid"); ok=0
    if [ -n "$exe" ]; then exe=$(rp "$exe"); { [ "$exe" = "$mine1" ] || [ "$exe" = "$mine2" ]; } && ok=1; fi
    [ "$ok" = 1 ] || die "port $ARENA_PORT is held by pid $pid ($(ps -o command= -p "$pid" 2>/dev/null || echo '?')); not ours, killing nothing"
    say "stopping arena pid $pid ($exe)"
    kill "$pid" 2>/dev/null || true
  done
  wait_for 10 port_free "$ARENA_PORT" || die "port $ARENA_PORT still busy"
}

cmd_build() {
  "$CARGO" build --release --manifest-path "$REPO/backend/Cargo.toml"
  "$CARGO" build --release --manifest-path "$REPO/dashboard-rs/Cargo.toml"
  local plist="$LAUNCH_AGENTS/$DASH_AGENT.plist" want="$HQ_ROOT/dashboard-rs/target/release/claudehq" got
  if [ -f "$plist" ]; then
    got=$(plutil -extract ProgramArguments.0 raw "$plist" 2>/dev/null || echo '?')
    [ "$got" = "$want" ] || say "WARNING: the launchd dashboard runs $got, not $want"
  fi
  [ "$(rp "$REPO")" = "$(rp "$HQ_ROOT")" ] || say "WARNING: built $REPO, but the launchd dashboard runs the binary in $HQ_ROOT"
}

cmd_start() {
  local bin="$REPO/backend/target/release/arena"
  if agent_installed; then
    if launchctl print "gui/$(id -u)/$AGENT" >/dev/null 2>&1; then
      launchctl kickstart -k "gui/$(id -u)/$AGENT"
    else
      launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST"
    fi
  else
    [ -x "$bin" ] || die "$bin is missing; run: $0 build"
    stop_port_arena
    arena_env
    # A simple command in the background, so $! is the arena itself (env and nohup exec).
    cd "$REPO/backend"
    env "${ENVV[@]}" nohup ./target/release/arena >> "$DATA/arena.log" 2>&1 < /dev/null &
    echo $! > "$DATA/arena.pid"
    cd - >/dev/null
  fi
  wait_for 60 arena_healthy || die "the Arena did not get healthy on $ARENA_URL (see $DATA/arena.log)"
  [ -f "$DATA/arena.db" ] || die "$DATA/arena.db was not created"
  say "arena up on $ARENA_URL (pid $(listeners "$ARENA_PORT" | head -1))"
}

cmd_stop() {
  if agent_installed; then
    launchctl bootout "gui/$(id -u)/$AGENT" 2>/dev/null || true
    say "LaunchAgent $AGENT booted out (still installed; start brings it back)"
  fi
  local pid; pid=$(our_pid "$DATA/arena.pid" "${ARENA_BINS[@]}")
  if [ -n "$pid" ]; then kill "$pid"; wait_for 10 port_free "$ARENA_PORT" || true; say "stopped arena pid $pid"; fi
  rm -f "$DATA/arena.pid"
}

cmd_dashboard() {
  launchctl kickstart -k "gui/$(id -u)/$DASH_AGENT"
  wait_for 30 dash_up "$HQ_PORT" || die "the dashboard did not come up on 127.0.0.1:$HQ_PORT"
  say "dashboard up on http://127.0.0.1:$HQ_PORT/"
}

cmd_stop_tmp() {
  local port="${1:?usage: stop-tmp <port>}" pid
  pid=$(our_pid "$DATA/hq-$port.pid" "${DASH_BINS[@]}")
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait_for 10 port_free "$port" || true; fi
  rm -f "$DATA/hq-$port.pid" "$DATA/hq-$port.root"
}

cmd_dashboard_tmp() {
  local root="${1:?usage: dashboard-tmp <root> <port>}" port="${2:?usage: dashboard-tmp <root> <port>}"
  local bin="$REPO/dashboard-rs/target/release/claudehq"
  [ -x "$bin" ] || die "$bin is missing; run: $0 build"
  [ "$port" = "$HQ_PORT" ] && die "port $port is the launchd dashboard's; pick another"
  root=$(rp "$root")
  cmd_stop_tmp "$port"
  port_free "$port" || die "port $port is held by something else"
  nohup "$bin" --root "$root" --port "$port" --no-open >> "$DATA/hq-$port.log" 2>&1 < /dev/null &
  echo $! > "$DATA/hq-$port.pid"
  printf '%s\n' "$root" > "$DATA/hq-$port.root"
  wait_for 30 dash_up "$port" || die "the preview dashboard did not come up on 127.0.0.1:$port (see $DATA/hq-$port.log)"
  say "preview dashboard on http://127.0.0.1:$port/ serving $root"
}

cmd_pair() {
  local port="${1:-$HQ_PORT}" handle="${2:-dev}" root base st csrf cfg code resp etag
  [[ "$handle" =~ ^[a-z0-9-]{1,32}$ ]] || die "bad handle: $handle"
  root=$(root_for_port "$port")
  base="http://127.0.0.1:$port"
  st=$(curl -fsS "$base/api/arena/status") || die "no dashboard on $base"
  if [ "$(json_get paired <<<"$st")" = true ] && [ "$(json_get url <<<"$st")" = "$ARENA_URL" ]; then
    say "already paired: $base -> $ARENA_URL"; return 0
  fi
  # the backups hold the production device token: never next to files git would pick up
  if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    for f in config.json arena-link.json; do
      git -C "$root" check-ignore -q "$f.prod-bak" \
        || die "$root is a git checkout that does not ignore $f.prod-bak; add '*.prod-bak' to its .gitignore first"
    done
  fi
  arena_healthy || die "the local Arena is not running on $ARENA_URL (run: $0 start)"
  for f in config.json arena-link.json; do
    [ -e "$root/$f.prod-bak" ] || [ -e "$root/$f.absent.prod-bak" ] && continue
    # a missing original is recorded by an empty marker, so restore can delete what pairing created
    if [ -e "$root/$f" ]; then cp -p "$root/$f" "$root/$f.prod-bak"; say "backed up $root/$f"
    else : > "$root/$f.absent.prod-bak"; say "recorded that $root/$f did not exist"; fi
  done
  csrf=$(curl -fsS "$base/" | sed -n 's/.*name="hq-csrf" content="\([0-9a-f]*\)".*/\1/p' | head -1)
  [ -n "$csrf" ] || die "could not read the CSRF token from $base/"
  cfg=$(curl -fsS "$base/api/config" | python3 -c 'import json,sys;c=json.load(sys.stdin);c["arenaUrl"]=sys.argv[1];print(json.dumps(c))' "$ARENA_URL")
  curl -fsS -o /dev/null -X POST -H 'Content-Type: application/json' -H "X-HQ-Token: $csrf" -H "Origin: $base" \
    -d "$cfg" "$base/api/config" || die "could not set arenaUrl on $base"
  code=$(curl -fsS -X POST -H 'Content-Type: application/json' -d "{\"handle\":\"$handle\"}" "$ARENA_URL/v1/auth/dev-login" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["code"])') || die "dev-login failed (is ARENA_DEV_LOGIN=1 on a 127.0.0.1 Arena?)"
  resp=$(curl -sS -X POST -H 'Content-Type: application/json' -H "X-HQ-Token: $csrf" -H "Origin: $base" \
    -d "{\"code\":\"$code\",\"label\":\"local-dev\"}" "$base/api/arena/pair")
  [ -z "$(json_get error <<<"$resp")" ] || die "pairing failed: $resp"
  st=$(curl -fsS "$base/api/arena/status")
  [ "$(json_get paired <<<"$st")" = true ] && [ "$(json_get url <<<"$st")" = "$ARENA_URL" ] || die "status after pairing: $st"
  etag=$(curl -sS --max-time 120 -o /dev/null -D - "$base/api/arena/world/$WORLD" \
    | awk 'NR==1{code=$2} tolower($1)=="etag:"{sub(/\r$/,"");$1="";sub(/^ /,"");tag=$0} END{if(code==200)print tag}')
  [ -n "$etag" ] || die "GET /api/arena/world/$WORLD did not answer 200 with an ETag"
  [ "$(curl -sS -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "$base/api/arena/world/$WORLD")" = 304 ] \
    || die "GET /api/arena/world/$WORLD with If-None-Match did not answer 304"
  say "paired $base -> $ARENA_URL as $handle (world 200 + 304 ok)"
}

cmd_pair2() {
  local hq2="$DATA/hq2" n
  mkdir -p "$hq2"
  cp -p "$REPO/index.html" "$hq2/index.html"
  rsync -a --delete "$REPO/ui/" "$hq2/ui/"
  rsync -a --delete "$REPO/games/" "$hq2/games/"
  [ -f "$hq2/config.json" ] || (umask 077; echo '{}' > "$hq2/config.json")
  cmd_dashboard_tmp "$hq2" "$HQ2_PORT"
  cmd_pair "$HQ2_PORT" dev2
  n=$(sqlite3 "$DATA/arena.db" "SELECT COUNT(DISTINCT id) FROM users WHERE handle IN ('dev','dev2')")
  [ "$n" = 2 ] || die "expected two Arena users dev and dev2, found $n (pair the first dashboard as dev first)"
  say "second browser: open http://127.0.0.1:$HQ2_PORT/ (user dev2)"
}

cmd_stop2() {
  cmd_stop_tmp "$HQ2_PORT"
  rm -rf "$DATA/hq2"
  say "stopped the $HQ2_PORT dashboard and removed $DATA/hq2"
}

cmd_status() {
  local pid exe st paired url port
  echo "arena:      $ARENA_URL"
  pid=$(listeners "$ARENA_PORT" | head -1)
  if [ -n "$pid" ]; then exe=$(exe_of "$pid"); echo "  port held by pid $pid (${exe:-?})"; else echo "  nothing listening on $ARENA_PORT"; fi
  echo "  pid file:  $(pid_of_file "$DATA/arena.pid" || true)"
  if arena_healthy; then echo "  health:    ok"; else echo "  health:    DOWN"; fi
  if agent_installed; then echo "  agent:     $AGENT installed"; else echo "  agent:     not installed"; fi
  for port in "$HQ_PORT" $(ls "$DATA" 2>/dev/null | sed -n 's/^hq-\([0-9]*\)\.root$/\1/p'); do
    echo "dashboard:  http://127.0.0.1:$port/"
    if ! st=$(curl -fsS --max-time 3 "http://127.0.0.1:$port/api/arena/status" 2>/dev/null); then echo "  DOWN"; continue; fi
    paired=$(json_get paired <<<"$st"); url=$(json_get url <<<"$st")
    echo "  arena url: ${url:-none}  paired: $paired"
    local root; root=$(root_for_port "$port")
    for f in config.json arena-link.json; do
      if [ -e "$root/$f.prod-bak" ]; then echo "  backup:    $root/$f.prod-bak"; else echo "  backup:    (no $f.prod-bak)"; fi
    done
    if [ "$url" = "$ARENA_URL" ] && ! arena_healthy; then
      echo "  !!! DASHBOARD PAIRED TO LOCAL BUT ARENA DOWN: run $0 start (or $0 restore) !!!"
    fi
  done
}

cmd_restore() {
  local port="${1:-$HQ_PORT}" root st
  root=$(root_for_port "$port")
  for f in config.json arena-link.json; do
    [ -e "$root/$f.prod-bak" ] || [ -e "$root/$f.absent.prod-bak" ] || die "no $root/$f.prod-bak; nothing restored"
  done
  for f in config.json arena-link.json; do
    if [ -e "$root/$f.prod-bak" ]; then mv "$root/$f.prod-bak" "$root/$f"; else rm -f "$root/$f" "$root/$f.absent.prod-bak"; fi
  done
  st=$(curl -fsS "http://127.0.0.1:$port/api/arena/status") || die "restored the files, but no dashboard answers on $port to verify"
  if [ ! -e "$root/arena-link.json" ]; then
    [ "$(json_get paired <<<"$st")" != true ] || die "restored the files, but status is: $st"
    say "restored $root: unpaired, as before (the local Arena keeps running; $0 stop stops it)"; return 0
  fi
  [ "$(json_get paired <<<"$st")" = true ] && [ "$(json_get url <<<"$st")" = "$PROD_ARENA_URL" ] \
    || die "restored the files, but status is: $st"
  say "restored $root: paired to $PROD_ARENA_URL (the local Arena keeps running; $0 stop stops it)"
}

cmd_install_agent() {
  local bin="$HQ_ROOT/backend/target/release/arena" k v
  [ -x "$bin" ] || die "$bin is missing; run: $0 build (from the live tree)"
  arena_env
  mkdir -p "$LAUNCH_AGENTS"
  ( umask 077   # the plist holds ARENA_SECRET_KEY: created 0600, never readable by others
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
      '<plist version="1.0"><dict>' \
      "<key>Label</key><string>$AGENT</string>" \
      "<key>ProgramArguments</key><array><string>$bin</string></array>" \
      "<key>WorkingDirectory</key><string>$HQ_ROOT/backend</string>" \
      '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>' \
      "<key>StandardOutPath</key><string>$DATA/arena.log</string>" \
      "<key>StandardErrorPath</key><string>$DATA/arena.log</string>" \
      '<key>EnvironmentVariables</key><dict>'
    for kv in "${ENVV[@]}"; do k=${kv%%=*}; v=${kv#*=}; printf '<key>%s</key><string>%s</string>\n' "$k" "$v"; done
    printf '%s\n' '</dict></dict></plist>'
  } > "$AGENT_PLIST.tmp" )
  chmod 600 "$AGENT_PLIST.tmp"
  plutil -lint "$AGENT_PLIST.tmp" >/dev/null || die "generated plist is invalid"
  mv "$AGENT_PLIST.tmp" "$AGENT_PLIST"
  launchctl bootout "gui/$(id -u)/$AGENT" 2>/dev/null || true
  stop_port_arena
  launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST"
  wait_for 60 arena_healthy || die "the LaunchAgent Arena did not get healthy (see $DATA/arena.log)"
  say "installed $AGENT_PLIST; the local Arena now survives logout and reboot"
}

cmd_uninstall_agent() {
  launchctl bootout "gui/$(id -u)/$AGENT" 2>/dev/null || true
  rm -f "$AGENT_PLIST"
  say "removed $AGENT_PLIST"
}

sub="${1:-}"; [ $# -gt 0 ] && shift
# Subcommands without arguments chain: `local_arena.sh build start`.
case "$sub" in
  build|start|stop|dashboard|pair2|stop2|status|install-agent|uninstall-agent)
    if [ $# -gt 0 ]; then "$0" "$sub"; exec "$0" "$@"; fi ;;
esac
case "$sub" in
  build) cmd_build ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  dashboard) cmd_dashboard ;;
  dashboard-tmp) cmd_dashboard_tmp "$@" ;;
  stop-tmp) cmd_stop_tmp "$@" ;;
  pair) cmd_pair "$@" ;;
  pair2) cmd_pair2 ;;
  stop2) cmd_stop2 ;;
  status) cmd_status ;;
  restore) cmd_restore "$@" ;;
  install-agent) cmd_install_agent ;;
  uninstall-agent) cmd_uninstall_agent ;;
  *) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; [ -z "$sub" ] || exit 2 ;;
esac
