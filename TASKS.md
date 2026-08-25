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
- [~] P2-T03 Capability model and temporary permission sessions.
- [ ] P2-T04 Global/project policy persistence and deterministic enforcement hooks.

## EPIC P3 — Secure Filesystem
- [ ] P3-T01 Safe read/stat/list/search primitives.
- [ ] P3-T02 Atomic create/write/append with size/binary/secret restrictions.
- [ ] P3-T03 Patch/batch patch + diff + optimistic SHA-256 concurrency.
- [ ] P3-T04 copy/move/delete with backup and symlink/traversal adversarial tests.

## EPIC P4 — Command/Test Runner
- [ ] P4-T01 Structured task profiles.
- [ ] P4-T02 Process timeout/cancel/tree cleanup/output limits.
- [ ] P4-T03 command policy + env allowlist + redaction + dangerous-command tests.

## EPIC P5 — Project Brain
- [ ] Incremental file/language/symbol/import/reference/test/config/Git index.
- [ ] TS/JS AST parser and graph edges.
- [ ] brain status/build/refresh/summary and graph query tools.

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

## EPIC P12 — Control Center
- [ ] professional operations UI over real APIs: Overview, Projects, Brain, Jobs, Tasks, Workflows, Tool Calls, Permissions, Policies, Git, Browser, Previews, Remote, Deployments, Audit, Security, Health, Settings.

## EPIC P13 — Security hardening
- [ ] threat-model test suite: traversal, symlink escape, injection, prompt/repo abuse, secrets, SSRF/browser abuse, cross-project/tenant, auth bypass, replay, DoS/output limits, archive/supply-chain.

## EPIC P14 — Observability + Operations
- [ ] JSON logs, metrics, OpenTelemetry trace context, alerts, backup/restore/runbooks.

## EPIC P15 — Production qualification
- [ ] execute every gate in `PRODUCTION_READINESS_REPORT.md`; no subjective READY declaration.
