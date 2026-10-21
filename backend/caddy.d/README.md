# Server-local Caddy sites

`backend/Caddyfile` ends with `import caddy.d/*.caddy`. The deploy panel and Grafana installers
(`ops/install-panel.sh`, `ops/install-monitoring.sh`, via `ops/caddy-local.sh`) write their sites here as
`panel.caddy` and `grafana.caddy`. `*.caddy` is git-ignored, so a server's checkout stays clean and
`ops/release.sh` (autodeploy) can pull. This README keeps the folder in git so the compose mount exists.
