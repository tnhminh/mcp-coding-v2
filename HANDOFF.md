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
- Project domain aggregate + async repository abstraction
- SQLite adapter with versioned transactional migrations and tested persistence semantics
- registry-aware canonical path resolver with nested-project exclusions
- traversal, junction/symlink and Windows unsafe-path adversarial coverage
- localhost Control Center at `/control-center`
- persistent SQLite-backed Project Registry CRUD via Control Center API
- real Overview, MCP/tool status and effective runtime Settings panels; unfinished modules are explicitly disabled

## Current task
P2.5-T02: implement P2-T03 capability/temporary permission sessions and expose them through the Control Center.

## Next task
P2-T04 global/project policy persistence and deterministic enforcement hooks, wired into the same Control Center shell.

## Run/test/build
`npm install`; `npm run dev:stdio`; `npm run dev:http`; `npm run check`.

## Environment names
`MCP_HOST`, `MCP_PORT`, `LOG_LEVEL`, `MCP_DATABASE_PATH`. No secrets required yet. `MCP_HOST` is intentionally limited to loopback values until remote authentication is implemented.

## Known defects/blockers
No external blocker. Feature coverage is intentionally incomplete.

## Production readiness
FAIL / incomplete. See `PRODUCTION_READINESS_REPORT.md`.
