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
- structured dependency/install/codegen command recipes through the same bounded process runner; no arbitrary caller shell surface
- coding_cycle bounded IMPLEMENT → TEST → REVIEW/FIX evidence orchestration
- Auto Task Discovery + Verification Router V2: workspace bootstrap auto-discovers task/preview profiles and publishes fast/release plans. Safe package aliases and Rust/Go/Python/Maven/Gradle/.NET conventions are recognized; static `index.html` projects receive built-in `check` integrity verification. Unavailable task IDs still fail as `VERIFICATION_UNAVAILABLE` before mutation/job-state advance.
- Agent Capability Enablement P4.5: `project_access_status`, `project_guidance`, `read_files`, nested/common agent instruction discovery, all existing safe-name package.json scripts through structured `package.script`, workspace capability manifest, and exact runtime tool-catalog parity regression.
- Project Readiness P4.6: `project_readiness` + `prepare_workspace` classify/repair missing dependency artifacts before coding, capture baseline task evidence, expose `failureKind`, and avoid adding legacy static verification when framework/package verifiers already exist.
- persistent SQLite AI Jobs with explicit transitions, CAS concurrency control, bounded evidence, restart recovery and no persisted permission-session IDs
- loopback static/recognized dev preview sessions with sensitive-path blocking, health/start/stop and process-tree cleanup
- browser_review using local Edge/Chrome with same-origin HTTP/WebSocket isolation and DOM/console/network/action/screenshot evidence
- read-only MCP resource `mcp://server/tool-catalog`; resources/list/read contract PASS for modern + legacy Streamable HTTP clients
- live compiled localhost restart/smoke PASS on port 7317: health live/ready ok, Control Center HTTP 200, 45 MCP tools visible, `kpi2` static preview/browser review/stop PASS and persistent AI Job create/status/cancel PASS without invoking a source-mutating coding cycle
- external ChatCode browser engine remains unavailable (`operational=false`) when retried after deploys; fallback Playwright + installed Edge performs live Control Center review automatically
- real AI Jobs + Workflow Runs Control Center panels backed by persistent SQLite job APIs
- real Browser / Preview Control Center panel with profile discovery, runtime preview list/start/status/stop and Browser Review DOM/network/screenshot evidence
- P12-T01/P12-T02 deployed on 7317 and live UI reviewed; favicon 404 and stopped-state display defects found by browser review were fixed and re-reviewed cleanly

- persistent Project Brain with bounded file/language/test/config metadata, TS/JS AST declarations/imports/references and incremental SHA reuse
- SQLite Brain snapshots survive runtime recreation and corrupted snapshots fail closed
- brain_build, brain_status, find_symbol, symbol_references, context_bundle and impact_analysis over MCP
- bounded weighted lexical+graph context retrieval and declaration/reference/importer/related-test impact analysis

## Current task
Phase 2 Skill Runtime V1 - turn discovered AGENTS/SKILL/rule files into an executable, scoped skill runtime before building the integrated Coding Harness.

## Next task
Skill Runtime V1: normalize skill manifests, activation/applicability rules, scope inheritance, tool requirements, composition/conflict behavior and verification hooks. Coding Harness follows after this phase; remote/deploy remain deferred.

## Run/test/build
`npm install`; `npm run dev:stdio`; `npm run dev:http`; `npm run check`.

## Environment names
`MCP_HOST`, `MCP_PORT`, `LOG_LEVEL`, `MCP_DATABASE_PATH`. No secrets required yet. `MCP_HOST` is intentionally limited to loopback values until remote authentication is implemented.

## Known defects/blockers
No external blocker. Feature coverage is intentionally incomplete.

## Production readiness
FAIL / incomplete. See `PRODUCTION_READINESS_REPORT.md`.
