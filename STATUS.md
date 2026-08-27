# STATUS

Updated: 2026-08-27

## Overall
`IN DEVELOPMENT` — not production ready.

## Current snapshot
- Product phase: **Phase 2 — Skill Runtime V1 (ACTIVE)**.
- Phase 1 Bridge: **VERIFIED COMPLETE**.
- Next product phase: **Phase 3 — Integrated Coding Harness**.
- Last committed repository checkpoint: `069fa5f` (`docs: harden AI handoff and permission session lifetime`); current Phase 1.5 hardening is verified in the working tree and not yet committed.
- Current verified full gate: lint + strict typecheck + **113 tests across 25 files** + production build PASS; `npm audit --omit=dev` reports 0 vulnerabilities and `git diff --check` PASS.
- Local runtime default: `127.0.0.1:7317`; Control Center: `/control-center`; MCP: `/mcp`.
- Production readiness: **FAIL / incomplete**; use `PRODUCTION_READINESS_REPORT.md` rather than inferring readiness from Phase 1 completion.
- AI contributors must start from `AGENTS.md` and `HANDOFF.md` and inspect Git status before editing.

## Verified complete
- Empty-repository discovery.
- Node 24.14.0, npm 11.9.0, Git 2.51.0 environment observed.
- MCP official v2 packages installed (`@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/node` 2.0.0).
- Strict TypeScript foundation.
- `system_health` MCP tool.
- stdio bootstrap.
- localhost Streamable HTTP bootstrap with `/health/live` and `/health/ready`.
- MCP 2026-07-28 contract suite PASS over real stdio and HTTP clients, including tools/list, tools/call, unknown-tool and strict input validation.
- HTTP serving corrected to SDK v2 `createMcpHandler` per-request modern architecture.
- Typed configuration with loopback-only HTTP host validation, bounded port and log-level schema.
- Structured application error model with safe public projection.
- JSON logging with reserved-field isolation and sensitive-key redaction; generic internal error messages are not emitted raw.
- Graceful/idempotent HTTP runtime close verified.
- `npm run check`: lint + strict typecheck + **113 tests across 25 files** + production build PASS; Phase 1 Bridge + Phase 1.5 hardening regressions, native Git runtime, managed process runtime, Audit/Usage, Control Center, tunnel, readiness and real MCP/browser contracts are covered.
- Project aggregate and async repository interface designed for SQLite/PostgreSQL interchangeability.
- SQLite persistence via `better-sqlite3` 13.0.3 with versioned transactional migration `001_projects`, foreign keys, busy timeout and WAL for file databases.
- Project persistence verifies complete aggregate round-trip, case-insensitive alias uniqueness, update/delete behavior and JSON-only metadata.
- Registry-aware canonical path resolver blocks lexical/absolute escape, realpath junction/symlink escape, nested registered-project access and duplicate canonical roots.
- Windows path hardening rejects alternate data streams, reserved device names, control/illegal characters and trailing dot/space ambiguity.
- Control Center is live at `/control-center` with operational Overview, real SQLite-backed Project Registry CRUD, MCP/tool status, Permissions/Policies, persistent AI Jobs, Workflow Runs, Browser/Preview QA, Secure MCP Tunnel, persistent Audit Log, Usage accounting and effective runtime Settings.
- Persistent Audit/Usage migration `005_audit_usage` records MCP tool calls and mutating localhost Control Center APIs without storing request bodies, prompts, file contents, API keys or permission-session bearer values. The Usage ledger records actual/estimated provider token metadata when supplied; ChatGPT-Web-via-MCP token counts remain explicitly `unavailable` because they are not exposed to the MCP server.
- Control Center APIs are localhost Host/Origin guarded; request JSON is bounded and validated; unavailable modules are displayed as pending rather than simulated.
- Capability model includes `filesystem.read`, `filesystem.write`, `command.run`, `git.read`, `git.write`; grants require project-bound permission sessions, support finite TTL from 60 seconds to 150 days or explicit trusted-local no-expiry mode, and always support immediate revoke.
- Global/project authorization policies persist in SQLite; enabled deny policies override session grants deterministically.
- Permissions and Policies Control Center modules now create/revoke sessions and create/update/delete policies using real APIs.
- Secure Filesystem MCP surface is live over both HTTP and stdio: read/stat/list/search, bounded large-file range reads, atomic write/append/line-range replacement, diff, exact/batch patch, copy/move/delete. Normal whole-file text reads remain bounded while `read_file_range` / `replace_file_lines` support authorized text files up to 16 MiB.
- Filesystem tools require project-bound permission sessions and deterministic policy evaluation; existing writes use SHA-256 optimistic concurrency.
- Sensitive paths/private-key material, binary files, oversized files, traversal and junction/symlink escapes are denied; delete requires persistent backup storage.
- End-to-end contract proves Control Center session grant → MCP read/write → project deny policy immediately blocks the next write.
- Project/workspace bootstrap MCP tools are live: list_projects, project_info, workspace_bootstrap, list_task_profiles, list_skills and read_skill.
- Structured task runner supports test/lint/typecheck/check/build/bench with command.run authorization, bounded env/output/time, output redaction and Windows process-tree cleanup.
- `apply_and_verify` applies bounded SHA-guarded changes and runs structured verification. New regressions roll back by default; unchanged pre-existing source failures can retain a no-new-regression patch as `baseline_accepted` while remaining `verified=false`; projects without structured verifier tasks can represent verification explicitly as deferred. Same-file sequential exact patches sharing one original SHA are supported.
- Command Runner V2 adds project-aware structured dependency/install/codegen recipes (`list_command_recipes`, `run_command_recipe`) without exposing arbitrary caller shell input; package specs/script names are validated and execution reuses the bounded/redacted process runner.
- `coding_cycle` orchestrates one bounded IMPLEMENT → TEST → REVIEW/FIX step using Project Brain/Context/Impact plus ApplyVerify evidence, with adaptive context, same-file multi-patch support, explicit passed/baseline-accepted/deferred/failed verification semantics, retry/stop guidance and iteration limits. A baseline-accepted red verifier can never advance an AI Job to DONE.
- Auto Task Discovery + Verification Router V2 is live: `workspace_bootstrap` returns auto-discovered task profiles plus `fastTaskIds` / `releaseTaskIds` and preview strategy. Safe package-script aliases and Rust/Go/Python/Maven/Gradle/.NET conventions are recognized; root static HTML receives a built-in `check` that validates `index.html` and local asset references without falsely claiming build/typecheck. Missing task IDs still fail before mutation/job-state advance.
- Persistent SQLite AI Jobs are live: create/list/status/cycle/complete/cancel, explicit state transitions, optimistic compare-and-set concurrency, bounded persisted evidence, restart recovery and no persisted permission-session identifiers.
- Local Preview/Browser QA is live: static + recognized framework dev previews bind loopback, preview lifecycle cleans process trees, sensitive static paths are denied, common media/model assets are served with bounded MIME handling, and `browser_review` uses local Edge/Chrome with DOM/console/network/action/screenshot evidence. Page-side external HTTP/WebSocket egress is denied by default; trusted-local explicit origins may be configured with `MCP_BROWSER_ALLOWED_ORIGINS`.
- MCP resources/list + resources/read now expose only the read-only `mcp://server/tool-catalog` resource, avoiding unsupported-resource probe errors without exposing project files as resources.
- Latest compiled localhost smoke after restart on `127.0.0.1:7317` PASS: live/ready/control-center HTTP 200; Control Center reports **64 MCP tools**. Fallback Playwright + installed Edge loaded the real Control Center with **0 page errors, 0 console errors and 0 HTTP >=400 responses** after access-aware UI startup was added.
- External ChatCode browser capability is retried after each deployment and currently reports `operational=false`; automatic fallback live review uses Playwright + installed Edge. P12-T01/P12-T02 live UI reviews on port 7317 passed with zero page errors, console errors or HTTP >=400. Browser review caught and fixed a favicon 404 and a stopped-preview state rendered as `planned`.

- Project Brain is live with bounded file/language/test/config indexing, TS/JS AST declarations/imports/references, SHA-based incremental refresh and SQLite-persisted snapshots.
- Brain snapshot state survives runtime recreation; corrupt snapshots are deleted and fail closed to `not_indexed`.
- `brain_build`, `brain_status`, `find_symbol`, `symbol_references`, `context_bundle` and `impact_analysis` are exposed over stdio + HTTP MCP and covered by real HTTP E2E.
- Context retrieval is bounded weighted lexical+graph ranking with stopword filtering and adaptive budgets; Brain-backed queries refresh stale snapshots before graph/context use. TS/JS graph extraction supports bounded `tsconfig.json` `baseUrl`/`paths` aliases and reports structural-vs-lexical-only language coverage honestly. This is not claimed to be BM25 or Git/task-aware yet.
- Agent Capability Enablement (P4.5 + P4.8 hardening) is verified: MCP exposes `project_access_status`, bounded/scoped `project_guidance`, multi-file and large-file ranged reads, expanded common coding-agent instruction/skill discovery with explicit truncation metadata, every existing safe-name package.json script through structured `package.script`, and a workspace capability manifest. Nested AGENTS guidance only activates for matching target paths. Runtime `tools/list` is regression-locked to the tool catalog.

## Active
Phase 1.5 Vibecode Hardening implementation/verification is complete in the current working tree and documentation sync is being finalized. The next implementation slice remains **Phase 2 / P16-T01 Skill Runtime V1 manifest + scope normalization**, followed by applicability/activation, requirements, composition/conflicts and verification hooks.

## Known gaps
Production identity/authentication and multi-user RBAC remain incomplete. Audit/Usage core is implemented, but richer actor identity, retention policy, metrics/traces/alerts, richer BM25/Git/task-aware retrieval, Remote/Deploy surfaces and remote/deploy engines remain incomplete. Browser routing denies page-side external traffic by default (with an explicit trusted-local allowlist), but authorized repository dev servers remain trusted host code without an OS-level network sandbox. Phase 1 intentionally exposes structured commands/process profiles rather than a caller-controlled raw shell.
