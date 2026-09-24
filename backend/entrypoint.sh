#!/bin/sh
set -e
# Migrate before serving. Deployments run a single instance, so there is no
# migration race to guard against.
uv run --no-dev alembic upgrade head

# Bind IPv4-any by default. An IPv6-only bind ("::") is unreachable through
# Docker's IPv4 port forwarding, and Fly's public services expect 0.0.0.0 as
# well -- override only for an IPv6-only network.
exec uv run --no-dev uvicorn app.main:app \
  --host "${ARENA_BIND_HOST:-0.0.0.0}" \
  --port "${ARENA_BIND_PORT:-8080}" \
  --proxy-headers --forwarded-allow-ips '*'
