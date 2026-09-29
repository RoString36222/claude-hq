#!/usr/bin/env bash
#
# Pull-based continuous deployment for a self-hosted Arena.
#
# Checks the tracked branch for new commits; if there are any, rebuilds and
# restarts, then verifies health. A deploy that fails its health check is
# rolled back to the previous commit automatically, because an unattended
# deploy that takes the board down and leaves it down is worse than no
# automation at all.
#
# Install with ops/install-autodeploy.sh. Logs to /var/log/arena-deploy.log.
set -euo pipefail

DIR="${ARENA_DIR:-/root/claude-hq}"
BRANCH="${ARENA_BRANCH:-main}"
DOMAIN="${ARENA_DOMAIN:-}"
LOG="${ARENA_DEPLOY_LOG:-/var/log/arena-deploy.log}"

log() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >> "$LOG"; }

cd "$DIR"

git fetch origin "$BRANCH" --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

[ "$LOCAL" = "$REMOTE" ] && exit 0   # nothing to do; stay quiet

log "new commits ${LOCAL:0:7} -> ${REMOTE:0:7}"
git log --oneline "$LOCAL..$REMOTE" | head -10 | while read -r line; do log "    $line"; done

PREV="$LOCAL"
git merge --ff-only "origin/$BRANCH" --quiet || { log "ERROR: not a fast-forward, skipping"; exit 1; }

# Health, asked the way the compose healthcheck asks it: from inside the app
# container.
#
# The app is `expose`d and never published, so it has no host port -- and this
# script runs either from cron on the host or inside the deploy panel's own
# container, where 127.0.0.1:8080 is the panel itself. A loopback probe cannot
# succeed in either layout, so it reported every healthy deploy as a failure and
# rolled it straight back. ops/deploy_panel.py's status() documents the same trap.
healthy() {
  ( cd "$DIR/backend" \
    && docker compose exec -T app \
         python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/health')" \
  ) >/dev/null 2>&1
}

# Put the previous commit back and rebuild from it.
#
# A rollback only restores the CODE. entrypoint.sh upgrades the database on
# boot, so by this point a migration has usually already run against the volume,
# and the older code can meet a database stamped at a revision it has never
# heard of -- `alembic upgrade head` then fails and the container crash-loops,
# which is worse than the deploy being undone. Verify, and if that is where we
# ended up, say so with the way out rather than leaving an operator to read it
# out of a restart loop.
rollback() {
  log "rolling back to ${PREV:0:7}"
  cd "$DIR" && git reset --hard "$PREV" --quiet
  cd "$DIR/backend" && docker compose up -d --build >>"$LOG" 2>&1 || true
  for _ in $(seq 1 6); do
    sleep 5
    if healthy; then log "  rolled back OK"; return; fi
  done
  log "  ERROR: still unhealthy AFTER the rollback -- the database is probably"
  log "  ahead of the code (a migration ran before the rollback). Roll FORWARD:"
  log "    cd $DIR && git merge --ff-only origin/$BRANCH \\"
  log "      && cd backend && docker compose up -d --build"
}

cd "$DIR/backend"
if ! docker compose up -d --build >>"$LOG" 2>&1; then
  log "ERROR: build failed"
  rollback
  exit 1
fi

# Give migrations and startup a moment before judging health.
HEALTHY=0
for _ in $(seq 1 12); do
  sleep 5
  if healthy; then HEALTHY=1; break; fi
done

if [ "$HEALTHY" -eq 1 ]; then
  log "deployed ${REMOTE:0:7} OK"
  [ -n "$DOMAIN" ] && curl -fsS --max-time 10 "https://$DOMAIN/health" >/dev/null 2>&1 \
    && log "  public endpoint healthy" || true
else
  log "ERROR: unhealthy after deploy"
  rollback
  exit 1
fi
