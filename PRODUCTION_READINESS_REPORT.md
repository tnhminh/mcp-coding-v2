# PRODUCTION_READINESS_REPORT

Status: **FAIL — INCOMPLETE** (2026-08-26)

| Gate | State | Evidence / gap |
|---|---|---|
| MCP v2 dependency baseline | PASS | official v2 packages installed |
| stdio bootstrap | PASS | source builds |
| Streamable HTTP bootstrap | PASS | 2026-07-28 negotiation + tools/list/tools/call contract test passes |
| schema/invalid-request contract suite | PASS | unknown tool => ProtocolError -32602; strict tool input => isError validation result over stdio + HTTP |
| authentication/RBAC | FAIL | local project-bound temporary permission sessions + deny policies PASS; production identity/authentication and multi-user RBAC remain incomplete |
| project/path isolation | PASS | registry-aware canonical resolver; traversal, symlink/junction, nested-project and Windows unsafe-path adversarial tests PASS |
| secure filesystem coding surface | PASS | permission/policy-gated MCP read/write/search/diff/patch/copy/move/delete; SHA guards, limits, sensitive/binary blocking and E2E policy enforcement PASS |
| Project Brain / context / impact | PASS (core) | bounded persistent file/TS-JS graph, restart-safe snapshot, context budgets and related-test impact analysis PASS; richer BM25/Git/task ranking remains enhancement work |
| command/process policies | PASS | structured task/recipe/process profiles; command.run grant required; no caller raw shell; env/output/time bounds, redaction and process-tree cleanup tests PASS |
| secret redaction | FAIL | JSON logger + task output redaction PASS, but full secret-reference/scanning coverage is not implemented |
| workflow recovery | PASS (core) | persistent AI Job state machine, invalid transition guards, CAS concurrency, fail→fix→review→complete evidence and runtime restart recovery tests PASS; workflow DAG remains enhancement |
| browser/preview isolation | PASS (core) | loopback static/dev previews, sensitive static-path denial, preview_id confinement, client-side cross-origin HTTP/WebSocket blocking, Edge/Chrome DOM/console/network/screenshot E2E and process-tree cleanup PASS; OS-level dev-server network sandbox remains absent |
| full unit/integration/e2e/browser/deploy/rollback suites | FAIL | unit/integration/MCP/browser core PASS; remote deployment/rollback qualification remains incomplete |
| logs/metrics/traces/alerts | FAIL | structured JSON logs PASS; metrics/traces/alerts pending |
| backup/restore/runbook qualification | FAIL | incomplete |
| Control Center | PASS (Phase 1 core) | Overview, Project CRUD, Permissions/Policies, MCP/tools, Git, Processes, AI Jobs, Workflow Runs, Browser/Preview QA, Secure Tunnel, Audit/Usage and runtime Settings are real; future Remote/Deploy and richer Harness/Skill views remain later phases |
| docs/handoff baseline | PASS | current files present, explicitly mark gaps |

Production Ready may only be declared when every applicable row is PASS with machine-verifiable evidence.
