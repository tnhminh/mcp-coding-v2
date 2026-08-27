# TASKS

Status legend: `[x]` verified, `[ ]` planned, `[~]` active.

## Product roadmap / epic mapping
- [x] **Phase 1 — Bridge / engineering control plane.** Primarily P0-P4.8 plus the core Project Brain, Context/Impact, AI Job, Browser/Preview and Control Center primitives needed for a useful bridge. Verified complete and subsequently hardened; current full gate is 25 files / 113 tests PASS.
- [~] **Phase 2 — Skill Runtime V1.** Convert discovered AGENTS/SKILL/prompt/rule files into normalized, scoped, activatable runtime behavior with tool requirements, composition/conflict rules and verification hooks. Tracked under P16 below.
- [ ] **Phase 3 — Integrated Coding Harness.** Compose existing primitives into task state, context selection, planning, multi-step execution, verification/retry and checkpoints. Tracked under P17.
- [ ] **Phase 4 — Autonomous Vibecode.** Higher-level goal execution built on the secured Bridge + Skill Runtime + Coding Harness. Tracked under P18.

The P-number epics are implementation workstreams; the Phase 1-4 roadmap describes product maturity. A completed primitive such as `coding_cycle` does not by itself mean the integrated Phase 3 Harness exists.

## EPIC P0 — Discovery and architecture
- [x] P0-T01 Inspect repository and detect zero-code baseline.
  - Acceptance: source/manifests/Git state recorded truthfully.
  - Evidence: initial ChatCode inspection reported 0 indexed files and no Git repo.
- [x] P0-T02 Establish protocol/runtime baseline.
  - Acceptance: MCP v2 package line and local Node/npm/Git versions verified.
- [x] P0-T03 Create mandatory planning/operations document baseline.
  - Acceptance: required docs exist and do not claim unimplemented capabilities.

## EPIC P1 — MCP Foundation
- [x] P1-T01 Bootstrap strict TypeScript project and dependency lockfile.
  - Verify: install succeeds without force/legacy peer overrides.
- [x] P1-T02 Implement server factory and `system_health` structured tool.
  - Verify: lint, strict typecheck, unit test, build pass.
- [x] P1-T03 Implement stdio entrypoint using SDK v2 `serveStdio`.
  - Security: reject legacy era by default for initial modern-only baseline.
- [x] P1-T04 Implement localhost Streamable HTTP entrypoint and live/ready endpoints.
  - Security: loopback bind + Host/Origin validation.
- [x] P1-T05 Add MCP protocol contract tests for initialize/tools/list/tools/call over stdio and HTTP.
  - Evidence: official v2 client pinned to 2026-07-28 passes stdio + HTTP negotiation, tools/list, tools/call, unknown-tool and strict-input validation contracts.
- [x] P1-T06 Structured error model, configuration schema, JSON logger, graceful lifecycle tests.
  - Evidence: secure loopback-only config validation, typed public error projection, structured/redacted JSON logs and idempotent HTTP shutdown tests; full `npm run check` PASS.

## EPIC P2 — Project Registry / Permissions / Rules
- [x] P2-T01 Project aggregate + repository interface + SQLite migration.
  - Evidence: versioned/idempotent migration, complete aggregate round-trip, async repository contract, uniqueness/update/delete and JSON metadata tests PASS.
- [x] P2-T02 Canonical root/path resolver and cross-project isolation tests.
  - Evidence: traversal, absolute escape, junction/symlink escape, nested-project exclusion, duplicate canonical-root conflict and Windows unsafe-path tests PASS through registry-aware resolver factory.
- [x] P2-T03 Capability model and temporary permission sessions.
  - Evidence: project-bound capability grants with 60s–150d finite TTL plus explicit no-expiry mode, revoke/expiry enforcement, inactive/wrong-project rejection and CMS issuance/revocation tests PASS.
- [x] P2-T04 Global/project policy persistence and deterministic enforcement hooks.
  - Evidence: SQLite-backed global/project policies; enabled deny rules override valid session grants; CMS create/update/delete controls and authorization tests PASS.

## EPIC P2.5 — Control Center Foundation
- [x] P2.5-T01 Operations shell + real Overview/Projects/MCP/Settings APIs.
  - Evidence: localhost `/control-center`, persistent SQLite Project CRUD, effective runtime settings, exposed-tool/module state, API validation tests; full gate PASS.
- [x] P2.5-T02 Wire capability sessions and policy controls as P2-T03/P2-T04 land.
  - Evidence: Control Center issues/revokes temporary sessions and manages global/project policies over real localhost APIs.
- [x] P2.5-T03 Add audit/activity stream and operational diagnostics.
  - Evidence: SQLite-backed `audit_events` + `usage_events`; all MCP tool calls auto-instrumented at registration layer; mutating localhost Control Center APIs audited without request bodies/secrets; filterable Audit Log + Usage dashboard live.

## EPIC P3 — Secure Filesystem
- [x] P3-T01 Safe read/stat/list/search primitives.
  - Evidence: authorized MCP read/stat/list/search tools, bounded traversal and text search; sensitive/binary/path-isolation tests PASS.
- [x] P3-T02 Atomic create/write/append with size/binary/secret restrictions.
  - Evidence: 1 MiB text bound, private-key/sensitive-path rejection, temp-file + rename writes and optimistic SHA-256 checks PASS.
- [x] P3-T03 Patch/batch patch + diff + optimistic SHA-256 concurrency.
  - Evidence: diff preview, exact patch and 1–20 change prevalidated batch patch with rollback attempt; concurrency/match-count tests PASS.
- [x] P3-T04 copy/move/delete with backup and symlink/traversal adversarial tests.
  - Evidence: copy/move destination guards, SHA-256 protected move/delete, persistent delete backup and junction/symlink escape rejection PASS.

## EPIC P4 — Command/Test Runner
- [x] P4-T01 Structured task profiles.
  - Evidence: package.json/Cargo/go/custom `.mcp/tasks.json` discovery; task kinds are limited to test/lint/typecheck/check/build/bench.
- [x] P4-T02 Process timeout/cancel/tree cleanup/output limits.
  - Evidence: bounded timeout/output, Windows process-tree cleanup and orphan-prevention tests PASS.
- [x] P4-T03 command policy + env allowlist + redaction + dangerous-command tests.
  - Evidence: command.run permission required; no caller-provided raw shell; custom executable allowlist, sanitized environment and output redaction tests PASS.
- [x] P4-T04 workspace/skill bootstrap + apply-and-verify orchestration.
  - Evidence: list_projects/project_info/workspace_bootstrap/list_skills/read_skill/run_task/apply_and_verify are live over MCP; failed verification rolls changes back by default; HTTP E2E PASS.
- [x] P4-T05 Auto Task Discovery + Verification Router V2.
  - Evidence: safe package-script aliases plus Rust/Go/Python/Maven/Gradle/.NET conventions auto-generate structured verifier profiles; static root `index.html` receives a built-in local-asset integrity `check`; bootstrap publishes fast/release task plans. Live `kpi3` changed from zero task profiles to `check`, and check + preview + browser review PASS without source mutation.
- [x] P4.5 Agent Capability Enablement gate before Agent Harness V1.
  - Evidence: `project_access_status`, `project_guidance`, `read_files`, expanded nested/common agent instruction discovery, all existing safe-name package.json scripts through structured `package.script`, bootstrap capability manifest/project script inventory, and exact runtime tools/list == tool catalog regression.
- [x] P4.6 Project Readiness Preflight before Agent Harness V1.
  - Evidence: `project_readiness` separates missing dependencies/configuration from source failures; `prepare_workspace` installs missing declared dependencies and captures baseline verification; task results expose `failureKind`; legacy static `check` is suppressed when package/ecosystem verifiers already exist.
- [x] P4.7 Phase 1 Bridge Finalization.
  - Evidence: native local Git status/diff/log/branch/stage/unstage/commit/restore tools; runtime-owned long-running process profiles/list/start/status/stop; Git + Processes Control Center panels/APIs; shutdown cleanup; machine-verifiable Phase 1 tool/capability gate. Full gate 25 files / 101 tests PASS.
- [x] P4.8 Phase 1.5 Vibecode Hardening — Critical / High / Medium false-negative reduction.
  - Evidence: process output truncation no longer kills successful verifiers; safe toolchain/public frontend env inheritance without forced `CI=1`; adaptive context + Brain freshness; explicit scan truncation; scoped nested guidance; expanded task/process discovery/timeouts; baseline-aware/deferred verification without false DONE; same-file multi-patch; 16 MiB ranged text read/edit primitives; TS alias resolution + structural/lexical coverage honesty; monorepo read-only Git scope; deterministic same-principal permission dominance; richer preview assets/browser discovery with trusted-local network allowlist; multi-toolchain readiness; access-aware Control Center startup. Final gate 25 files / 113 tests PASS, npm audit 0, diff check PASS, localhost health/control-center HTTP 200 and browser review 0 page/console/HTTP errors.

## EPIC P5 — Project Brain
- [x] P5-T01 Incremental file/language/symbol/import/reference/test/config index.
  - Evidence: bounded Secure Filesystem scan, language/category metadata, SHA-based incremental TS/JS reuse and SQLite snapshot persistence across runtime recreation.
- [x] P5-T02 TS/JS AST parser and graph edges.
  - Evidence: TypeScript compiler API extracts declarations, identifier references and import/export/require edges with relative plus bounded `tsconfig.json` `baseUrl`/`paths` alias resolution; Brain summary states TS/JS structural vs other-language lexical-only coverage.
- [x] P5-T03 brain status/build/refresh/summary and graph query tools.
  - Evidence: brain_build, brain_status, find_symbol and symbol_references MCP tools; corrupted persisted snapshots fail closed to not_indexed.

## EPIC P6 — Context + Impact
- [x] P6-T01 bounded weighted lexical + graph context ranking.
  - Evidence: context_bundle combines exact/partial symbol, identifier reference, import/path and Secure Filesystem literal-text evidence.
- [ ] P6-T02 richer BM25 + Git/task-aware ranking.
  - Note: richer BM25 + Git/task-aware ranking remains deferred; the local Git runtime is already implemented, but current weighted lexical+graph retrieval does not yet consume Git/task signals and is not claimed as BM25.
- [x] P6-T03 bounded context bundle + blast-radius/related-test analysis.
  - Evidence: context_bundle enforces adaptive file/character budgets with stopword filtering; impact_analysis traces file/symbol declarations, references, importers, second-wave importers, related tests and nearby configs. Brain-backed queries auto-refresh stale snapshots before use.

## EPIC P7 — Workflow + Tasks + AI Jobs
- [x] P7-T00 autonomous IMPLEMENT/TEST/REVIEW/FIX coding-cycle orchestration over Brain/Context/Impact + ApplyVerify.
  - Evidence: `coding_cycle` returns verification, before/after review evidence and bounded fix/review/stop guidance; retry limits are tested.
- [x] P7-T01 persistent AI Job state machine with invalid-transition rejection and restart recovery.
  - Evidence: SQLite migration/repository + create/list/status/cycle/complete/cancel; fail→fix→review→complete survives runtime recreation.
- [x] P7-T02 completion evidence gates, bounded persistence and optimistic CAS.
  - Evidence: completion only from `awaiting_review`; stale state overwrite rejected; last 20 evidence records persisted with task streams clipped; permission session IDs are never persisted.
- [x] P7-T02A project-aware verification routing and unavailable-profile fail-fast.
  - Evidence: `workspace_bootstrap` returns task/preview profiles plus explicit verification strategy; unavailable task IDs return `VERIFICATION_UNAVAILABLE` before ApplyVerify mutation or AI Job state/iteration advance; live `kpi2` smoke reports only `lint/typecheck/build` as task-verification choices and rejects invented `test`.
- [ ] P7-T03 task dependency graph / multi-step workflow DAG and richer stable job accounting.

## EPIC P8 — Git/GitHub
- [x] safe project-scoped local Git read/write operations.
  - Evidence: Phase 1 P4.7/P4.8 provides status/diff/log/branches/stage/unstage/create/switch/commit/restore with project-scoped read-only support for monorepo subprojects, repository-root-only Git mutations and no implicit push.
- [ ] GitHub/remote publishing, secret scan/elevation before push and private-by-default repository creation.

## EPIC P9 — Browser + Preview
- [x] P9-T01 Playwright browser review with DOM/screenshot/console/network/action evidence.
  - Evidence: local installed Edge/Chrome via `playwright-core`; browser only opens server-created `preview_id`; page egress is denied by default with optional explicit trusted-local `MCP_BROWSER_ALLOWED_ORIGINS`; interactive fixture + screenshot test PASS.
- [x] P9-T02 loopback static/dev preview discovery, lifecycle and health without assuming port 3000.
  - Evidence: dynamic loopback port allocation; static sensitive-path blocking; recognized framework dev profile start/health/log redaction/process-tree stop tests PASS.
- [ ] P9-T03 richer browser assertions, multi-page session persistence and optional stronger OS/network sandboxing.

## EPIC P10 — Remote SSH/SFTP
- [ ] project-bound server registry and secret references.
- [ ] controlled SSH execution and safe SFTP operations.

## EPIC P11 — Deployment
- [ ] preflight/build/test/package/backup/deploy/health/smoke/rollback/release state machine.

## EPIC P12 — Control Center Completion
- [x] P12-T01 AI Jobs + Workflow Runs operational panels over persistent job APIs.
  - Evidence: project-scoped create/list/status/cancel APIs, persistent state/evidence tables and workflow metrics; live localhost browser review PASS with zero page/console/network errors.
- [x] P12-T02 Browser + Preview operational panel over runtime-owned preview APIs.
  - Evidence: profile discovery, preview list/start/status/stop, browser-review evidence + screenshot; `kpi2` live UI Start → Review → Stop PASS after browser review caught/fixed favicon and stopped-state display defects.
- [~] P12-T03 Project Brain + Tasks / Commands operational panels over existing real services.
- [x] P12-T04 Tool Calls + Audit / Activity + Usage accounting.
  - Evidence: persistent Audit Log filters by project/status/category/search; Usage dashboard aggregates provider/model/day, actual/estimated token metadata, MCP tool calls and explicit token-visibility gaps. ChatGPT-via-MCP tokens are never fabricated when upstream does not expose them.
- [ ] P12-T05 Remote Git publishing, Remote, Deployments, Security and remaining Settings surfaces as their production backends land. Local Git and Processes surfaces are already live from Phase 1.

## EPIC P13 — Security hardening
- [ ] threat-model test suite: traversal, symlink escape, injection, prompt/repo abuse, secrets, SSRF/browser abuse, cross-project/tenant, auth bypass, replay, DoS/output limits, archive/supply-chain.

## EPIC P14 — Observability + Operations
- [ ] JSON logs, metrics, OpenTelemetry trace context, alerts, backup/restore/runbooks.

## EPIC P15 — Production qualification
- [ ] execute every gate in `PRODUCTION_READINESS_REPORT.md`; no subjective READY declaration.

## EPIC P16 — Phase 2 Skill Runtime
- [~] P16-T01 Skill Runtime V1 manifest and scope model.
  - Acceptance: discovered AGENTS/SKILL/prompt/rule inputs normalize into bounded typed runtime descriptors with source, scope, precedence/applicability metadata and validation failures represented explicitly.
- [ ] P16-T02 activation/applicability + scope inheritance.
- [ ] P16-T03 required tool/capability checks and unavailable-requirement behavior.
- [ ] P16-T04 deterministic composition/conflict precedence.
- [ ] P16-T05 verification hooks + workspace/coding lifecycle integration.
- [ ] P16-T06 Skill Runtime MCP/Control Center evidence and full regression gate.

## EPIC P17 — Phase 3 Integrated Coding Harness
- [ ] task state + repo/context selection + explicit plan model.
- [ ] multi-step execution loop using existing filesystem/commands/process/Git/browser primitives.
- [ ] verification routing, diagnosis/retry budgets and checkpoints.
- [ ] resumable handoff/evidence contract above the existing bounded `coding_cycle` primitive.

## EPIC P18 — Phase 4 Autonomous Vibecode
- [ ] goal-level execution contract built on Bridge + Skill Runtime + Coding Harness.
- [ ] bounded autonomy, stop/escalation policy, production trust-boundary enforcement and end-to-end qualification.
