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
- typed loopback-only runtime config (`MCP_HOST`, `MCP_PORT`, `LOG_LEVEL`)
- typed error model + safe HTTP error projection
- structured JSON logger with sensitive-key redaction
- testable HTTP runtime with idempotent graceful close

## Current task
P2-T01 Project aggregate + repository interface + SQLite migration.

## Next task
P2-T02 canonical root/path resolver and cross-project isolation after P2-T01 passes.

## Run/test/build
`npm install`; `npm run dev:stdio`; `npm run dev:http`; `npm run check`.

## Environment names
`MCP_HOST`, `MCP_PORT`, `LOG_LEVEL`. No secrets required yet. `MCP_HOST` is intentionally limited to loopback values until remote authentication is implemented.

## Known defects/blockers
No external blocker. Feature coverage is intentionally incomplete.

## Production readiness
FAIL / incomplete. See `PRODUCTION_READINESS_REPORT.md`.
