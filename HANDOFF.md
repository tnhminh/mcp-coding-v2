# HANDOFF

## Purpose
Build a production-grade AI software-engineering control plane exposed through MCP.

## Current architecture
Strict TypeScript / Node ESM. MCP composition lives in `src/app/create-mcp-server.ts`; stdio and HTTP transports are isolated under `src/entrypoints`.

## Verified capabilities
- install/build toolchain works
- MCP server factory and one read-only `system_health` tool
- stdio entrypoint via SDK v2 `serveStdio`
- Streamable HTTP endpoint `/mcp` bound to localhost by default with Host/Origin validation
- `/health/live` and `/health/ready`
- verified MCP 2026-07-28 stdio + Streamable HTTP contracts via official client SDK

## Current task
P1-T06 structured error model, configuration schema, JSON logger and graceful lifecycle tests.

## Next task
P2-T01 project registry persistence after P1-T06 passes.

## Run/test/build
`npm install`; `npm run dev:stdio`; `npm run dev:http`; `npm run check`.

## Environment names
`MCP_HOST`, `MCP_PORT`. No secrets required yet.

## Known defects/blockers
No external blocker. Feature coverage is intentionally incomplete.

## Production readiness
FAIL / incomplete. See `PRODUCTION_READINESS_REPORT.md`.
