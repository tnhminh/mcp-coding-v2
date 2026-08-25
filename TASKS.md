# TASKS

Status legend: `[x]` verified, `[ ]` planned, `[~]` active.

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
  - Evidence: project-bound capability grants with 60s–24h TTL, revoke/expiry enforcement, inactive/wrong-project rejection and CMS issuance/revocation tests PASS.
- [x] P2-T04 Global/project policy persistence and deterministic enforcement hooks.
  - Evidence: SQLite-backed global/project policies; enabled deny rules override valid session grants; CMS create/update/delete controls and authorization tests PASS.

## EPIC P2.5 — Control Center Foundation
- [x] P2.5-T01 Operations shell + real Overview/Projects/MCP/Settings APIs.
  - Evidence: localhost `/control-center`, persistent SQLite Project CRUD, effective runtime settings, exposed-tool/module state, API validation tests; full gate PASS.
- [x] P2.5-T02 Wire capability sessions and policy controls as P2-T03/P2-T04 land.
  - Evidence: Control Center issues/revokes temporary sessions and manages global/project policies over real localhost APIs.
- [ ] P2.5-T03 Add audit/activity stream and operational diagnostics.

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

## EPIC P5 — Project Brain
- [~] P5-T01 Incremental file/language/symbol/import/reference/test/config index.
- [ ] P5-T02 TS/JS AST parser and graph edges.
- [ ] P5-T03 brain status/build/refresh/summary and graph query tools.

## EPIC P6 — Context + Impact
- [ ] lexical/BM25 + graph + Git/task-aware ranking.
- [ ] bounded token-budget context bundle.
- [ ] blast-radius/related-test analysis.

## EPIC P7 — Workflow + Tasks + AI Jobs
- [ ] persistent state machine with invalid-transition rejection.
- [ ] completion evidence gates and retry/fix loop.
- [ ] task dependency graph and stable job identity/accounting.

## EPIC P8 — Git/GitHub
- [ ] safe read/write Git operations.
- [ ] secret scan/elevation before remote push; private-by-default repository creation.

## EPIC P9 — Browser + Preview
- [ ] Playwright runtime sessions, DOM/screenshot/console/network evidence.
- [ ] preview discovery/registration/health without assuming port 3000.

## EPIC P10 — Remote SSH/SFTP
- [ ] project-bound server registry and secret references.
- [ ] controlled SSH execution and safe SFTP operations.

## EPIC P11 — Deployment
- [ ] preflight/build/test/package/backup/deploy/health/smoke/rollback/release state machine.

## EPIC P12 — Control Center Completion
- [ ] complete the professional operations UI over real APIs: Brain, Jobs, Tasks, Workflows, Tool Calls, Git, Browser, Previews, Remote, Deployments, Audit, Security and remaining Settings; foundation Overview/Projects/MCP shell is already delivered in P2.5.

## EPIC P13 — Security hardening
- [ ] threat-model test suite: traversal, symlink escape, injection, prompt/repo abuse, secrets, SSRF/browser abuse, cross-project/tenant, auth bypass, replay, DoS/output limits, archive/supply-chain.

## EPIC P14 — Observability + Operations
- [ ] JSON logs, metrics, OpenTelemetry trace context, alerts, backup/restore/runbooks.

## EPIC P15 — Production qualification
- [ ] execute every gate in `PRODUCTION_READINESS_REPORT.md`; no subjective READY declaration.
