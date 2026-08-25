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
