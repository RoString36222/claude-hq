#!/bin/sh
set -e
# Migrate before serving; Fly runs one machine, so there is no migration race.
uv run --no-dev alembic upgrade head
exec uv run --no-dev uvicorn app.main:app --host :: --port 8080 --proxy-headers --forwarded-allow-ips '*'
