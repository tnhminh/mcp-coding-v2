# OPERATIONS

Current local operations only.
- stdio: `npm run dev:stdio`
- HTTP: `npm run dev:http`
- default HTTP bind: `127.0.0.1:7317`
- allowed HTTP hosts: `127.0.0.1`, `::1`, `localhost` only until remote auth exists
- `LOG_LEVEL`: `debug|info|warn|error` (default `info`)
- runtime logs: one JSON object per stderr line
- liveness/readiness: `/health/live`, `/health/ready`

Production metrics, tracing, alerts, persistence backup/recovery and multi-instance operations are pending.
