# CHANGELOG

## 2026-08-25
- Bootstrapped empty repository.
- Added official MCP TypeScript SDK v2 foundation.
- Resolved TypeScript 7 / typescript-eslint peer conflict by selecting TypeScript 6.0.3.
- Added strict TypeScript, ESLint, Vitest and build pipeline.
- Added `system_health`, stdio and localhost Streamable HTTP entrypoints.
- Fixed initial lint failures and achieved a passing `npm run check`.
- Added Phase 0/production planning and handoff documentation baseline.
- Added official MCP v2 client contract dependency and real stdio/HTTP protocol tests.
- Fixed HTTP modern-era negotiation by replacing direct transport wiring with SDK v2 createMcpHandler + Node adapter.
- Enforced strict empty input schema for system_health and verified invalid-argument behavior.
- Added typed runtime configuration with loopback-only HTTP exposure and bounded port/log-level validation.
- Added structured application errors and safe public HTTP error projection.
- Added JSON logger with reserved-field isolation and sensitive-key redaction.
- Extracted a testable HTTP runtime and verified idempotent graceful shutdown.
- Added Project aggregate and Promise-based repository abstraction for future PostgreSQL compatibility.
- Added pinned `better-sqlite3` persistence, versioned transactional schema migrations and Project Registry persistence tests.
- Raised Node engine floor to 22.13.0 to match the selected SQLite driver and current tooling support floor.
- Added registry-aware canonical project path resolution with sibling/nested project isolation and duplicate canonical-root rejection.
- Added traversal, junction/symlink and Windows alternate-stream/device-name/path-normalization adversarial tests.
- Added the first real Control Center at `/control-center` with a professional operations shell, Overview, Projects, MCP/Tools and Settings.
- Wired HTTP runtime to persistent SQLite via `MCP_DATABASE_PATH` and exposed validated localhost-only Project Registry CRUD APIs.
- Added Control Center integration tests for page/API contracts, project create/update/list/remove and invalid edit validation.
