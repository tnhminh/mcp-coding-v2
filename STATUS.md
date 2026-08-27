# STATUS

Updated: 2026-08-26

## Overall
`IN DEVELOPMENT` — not production ready.

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
- `npm run check`: lint + strict typecheck + 93 tests across 22 files + production build PASS; Audit/Usage, Control Center, tunnel, Auto Task Discovery + Verification Router V2, Agent Capability Enablement, Project Readiness Preflight and real MCP/browser regressions are covered.
- Project aggregate and async repository interface designed for SQLite/PostgreSQL interchangeability.
- SQLite persistence via `better-sqlite3` 13.0.3 with versioned transactional migration `001_projects`, foreign keys, busy timeout and WAL for file databases.
- Project persistence verifies complete aggregate round-trip, case-insensitive alias uniqueness, update/delete behavior and JSON-only metadata.
- Registry-aware canonical path resolver blocks lexical/absolute escape, realpath junction/symlink escape, nested registered-project access and duplicate canonical roots.
- Windows path hardening rejects alternate data streams, reserved device names, control/illegal characters and trailing dot/space ambiguity.
- Control Center is live at `/control-center` with operational Overview, real SQLite-backed Project Registry CRUD, MCP/tool status, Permissions/Policies, persistent AI Jobs, Workflow Runs, Browser/Preview QA, Secure MCP Tunnel, persistent Audit Log, Usage accounting and effective runtime Settings.
- Persistent Audit/Usage migration `005_audit_usage` records MCP tool calls and mutating localhost Control Center APIs without storing request bodies, prompts, file contents, API keys or permission-session bearer values. The Usage ledger records actual/estimated provider token metadata when supplied; ChatGPT-Web-via-MCP token counts remain explicitly `unavailable` because they are not exposed to the MCP server.
- Control Center APIs are localhost Host/Origin guarded; request JSON is bounded and validated; unavailable modules are displayed as pending rather than simulated.
- Capability model includes `filesystem.read`, `filesystem.write`, `command.run`, `git.read`, `git.write`; grants require project-bound temporary permission sessions (maximum 24h) and support immediate revoke.
- Global/project authorization policies persist in SQLite; enabled deny policies override session grants deterministically.
- Permissions and Policies Control Center modules now create/revoke sessions and create/update/delete policies using real APIs.
- Secure Filesystem MCP surface is live over both HTTP and stdio: read/stat/list/search, atomic write/append, diff, exact/batch patch, copy/move/delete.
- Filesystem tools require project-bound permission sessions and deterministic policy evaluation; existing writes use SHA-256 optimistic concurrency.
- Sensitive paths/private-key material, binary files, oversized files, traversal and junction/symlink escapes are denied; delete requires persistent backup storage.
- End-to-end contract proves Control Center session grant → MCP read/write → project deny policy immediately blocks the next write.
- Project/workspace bootstrap MCP tools are live: list_projects, project_info, workspace_bootstrap, list_task_profiles, list_skills and read_skill.
- Structured task runner supports test/lint/typecheck/check/build/bench with command.run authorization, bounded env/output/time, output redaction and Windows process-tree cleanup.
- apply_and_verify applies bounded changes, runs structured verification tasks and rolls back automatically on failure by default; unit and real HTTP MCP E2E contracts PASS.
- Command Runner V2 adds project-aware structured dependency/install/codegen recipes (`list_command_recipes`, `run_command_recipe`) without exposing arbitrary caller shell input; package specs/script names are validated and execution reuses the bounded/redacted process runner.
- `coding_cycle` now orchestrates one bounded IMPLEMENT → TEST → REVIEW step using Project Brain/Context/Impact plus ApplyVerify evidence, with retry/stop guidance and iteration limits.
- Auto Task Discovery + Verification Router V2 is live: `workspace_bootstrap` returns auto-discovered task profiles plus `fastTaskIds` / `releaseTaskIds` and preview strategy. Safe package-script aliases and Rust/Go/Python/Maven/Gradle/.NET conventions are recognized; root static HTML receives a built-in `check` that validates `index.html` and local asset references without falsely claiming build/typecheck. Missing task IDs still fail before mutation/job-state advance.
- Persistent SQLite AI Jobs are live: create/list/status/cycle/complete/cancel, explicit state transitions, optimistic compare-and-set concurrency, bounded persisted evidence, restart recovery and no persisted permission-session identifiers.
- Local Preview/Browser QA is live: static + recognized framework dev previews bind loopback, preview lifecycle cleans process trees, sensitive static paths are denied, and `browser_review` uses local Edge/Chrome with same-origin HTTP/WebSocket isolation plus DOM/console/network/action/screenshot evidence.
- MCP resources/list + resources/read now expose only the read-only `mcp://server/tool-catalog` resource, avoiding unsupported-resource probe errors without exposing project files as resources.
- Live compiled localhost smoke after restart on `127.0.0.1:7317` PASS: live/ready health `ok`, Control Center HTTP 200, modern MCP exposes 45 tools, tool-catalog resource lists/reads successfully, and registered project `kpi2` (`E:\\kpitest`) completed static preview start → browser_review (HTTP 200, no page errors) → stop plus persistent AI Job create → status → cancel without source-file mutation.
- External ChatCode browser capability is retried after each deployment and currently reports `operational=false`; automatic fallback live review uses Playwright + installed Edge. P12-T01/P12-T02 live UI reviews on port 7317 passed with zero page errors, console errors or HTTP >=400. Browser review caught and fixed a favicon 404 and a stopped-preview state rendered as `planned`.

- Project Brain is live with bounded file/language/test/config indexing, TS/JS AST declarations/imports/references, SHA-based incremental refresh and SQLite-persisted snapshots.
- Brain snapshot state survives runtime recreation; corrupt snapshots are deleted and fail closed to `not_indexed`.
- `brain_build`, `brain_status`, `find_symbol`, `symbol_references`, `context_bundle` and `impact_analysis` are exposed over stdio + HTTP MCP and covered by real HTTP E2E.
- Context retrieval is bounded weighted lexical+graph ranking; impact analysis traces declarations/references/importers/related tests/configs. This is not claimed to be BM25 or Git-aware yet.
- Agent Capability Enablement (P4.5) is verified: MCP exposes `project_access_status`, bounded `project_guidance`, multi-file `read_files`, expanded common coding-agent instruction/skill discovery, every existing safe-name package.json script through structured `package.script`, and a workspace capability manifest. Runtime `tools/list` is regression-locked to the tool catalog.

## Active
Agent Harness V1 — build the professional coding-agent harness over the verified local vibecode capability surface: execution context → planning/task decomposition → tool routing → autonomous implement/verify/review/fix loop → completion gate → persistent resume.

## Known gaps
Production identity/authentication and multi-user RBAC remain incomplete. Audit/Usage core is implemented, but richer actor identity, retention policy, metrics/traces/alerts, BM25/Git/task-aware retrieval, remaining Control Center Brain/Tasks/Git/Remote/Deploy surfaces and remote/deploy engines remain incomplete. Browser routing blocks client-side cross-origin HTTP/WebSocket egress, but a repository dev server explicitly authorized with `command.run` is still trusted host code and is not contained by an OS-level network sandbox. Git integration is deferred while local-project coding completeness is prioritized.
