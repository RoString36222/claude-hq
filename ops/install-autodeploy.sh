#!/usr/bin/env bash
#
# Install the pull-based deploy timer.
#
#   sudo ARENA_DOMAIN=arena.example.com bash ops/install-autodeploy.sh
#
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

DIR="${ARENA_DIR:-/root/claude-hq}"
DOMAIN="${ARENA_DOMAIN:?set ARENA_DOMAIN}"
INTERVAL="${ARENA_DEPLOY_INTERVAL:-2min}"

cat > /etc/systemd/system/arena-deploy.service <<UNIT
[Unit]
Description=Deploy Arena when upstream main moves
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Environment=ARENA_DIR=$DIR
Environment=ARENA_DOMAIN=$DOMAIN
ExecStart=$DIR/ops/autodeploy.sh
UNIT

cat > /etc/systemd/system/arena-deploy.timer <<UNIT
[Unit]
Description=Check for Arena updates every $INTERVAL

[Timer]
OnBootSec=2min
OnUnitActiveSec=$INTERVAL
# Avoid every self-hosted instance hitting GitHub on the same tick.
RandomizedDelaySec=30
Persistent=true

[Install]
WantedBy=timers.target
UNIT

touch /var/log/arena-deploy.log
systemctl daemon-reload
systemctl enable --now arena-deploy.timer

echo "installed. next run:"
systemctl list-timers arena-deploy.timer --no-pager | head -3
echo
echo "  logs:       tail -f /var/log/arena-deploy.log"
echo "  run now:    systemctl start arena-deploy.service"
echo "  disable:    systemctl disable --now arena-deploy.timer"
