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
- temporary project-bound permission sessions with TTL/revoke and fixed capability catalog
- global/project authorization policies with deny override semantics
- real Permissions/Policies Control Center configuration
- authorized Secure Filesystem tools over stdio + HTTP: read/stat/list/search/write/append/diff/patch/batch-patch/copy/move/delete
- SHA-256 optimistic concurrency for destructive overwrites and exact patches
- sensitive-path/private-key/binary/oversize blocking plus delete backups
- end-to-end CMS permission/policy → MCP filesystem enforcement contract
- local project/workspace discovery: list_projects, project_info and workspace_bootstrap
- project skill/instruction discovery: list_skills and read_skill
- structured test/lint/typecheck/check/build/bench runner with command.run authorization, environment/output/time bounds, redaction and process-tree cleanup
- apply_and_verify orchestration with default rollback on failed verification; real HTTP MCP E2E PASS

## Current task
P5-T01 Project Brain file/language/symbol/import/reference/test/config indexing.

## Next task
P5-T02 TS/JS AST graph edges, then P6 bounded context retrieval + impact analysis. Git MCP features remain deferred.

## Run/test/build
`npm install`; `npm run dev:stdio`; `npm run dev:http`; `npm run check`.

## Environment names
`MCP_HOST`, `MCP_PORT`, `LOG_LEVEL`, `MCP_DATABASE_PATH`. No secrets required yet. `MCP_HOST` is intentionally limited to loopback values until remote authentication is implemented.

## Known defects/blockers
No external blocker. Feature coverage is intentionally incomplete.

## Production readiness
FAIL / incomplete. See `PRODUCTION_READINESS_REPORT.md`.
