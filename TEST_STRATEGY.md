# TEST_STRATEGY

Layers: unit, integration, MCP protocol contract, end-to-end, browser, deployment/rollback and adversarial security tests.

Every executable task must run targeted verification then full applicable checks. Current baseline command: `npm run check` = lint + strict typecheck + Vitest + production TypeScript build.

Verified: official MCP v2 client contract tests negotiate 2026-07-28 over spawned stdio and real localhost Streamable HTTP, then exercise tools/list, tools/call, unknown-tool handling and strict input-schema rejection.

Verified: config validation, safe public-error projection, JSON log redaction/reserved-field integrity and idempotent HTTP runtime shutdown are covered by `runtime-foundation.test.ts`.

Verified: Project Registry persistence covers migration idempotency, complete aggregate round-trip, async failure semantics, case-insensitive alias uniqueness, updates/removal and JSON-only metadata.

Verified: `project-path-resolver.test.ts` covers lexical/absolute traversal, missing/write targets, junction/symlink escape, safe internal links, sibling/nested project isolation, duplicate canonical roots, registry factory enforcement and Windows unsafe-path forms.

Verified: `control-center.test.ts` exercises the real dashboard route and Overview API plus Project Registry create/update/list/remove over HTTP, including invalid alias edit rejection. The Control Center exposes pending modules honestly instead of simulating backend availability.

Verified: `authorization.test.ts` covers granted/missing capability, wrong-project, expired, revoked and inactive-project sessions plus global/project deny overrides. `control-center.test.ts` covers human-facing session issuance/revoke and policy create/update/delete APIs.

Verified: `secure-filesystem.test.ts` covers read/stat/list/search, sensitive and binary blocking, traversal/junction isolation, atomic SHA-guarded writes, diff, exact/batch patch, copy/move/delete and backup behavior. `mcp-filesystem-contract.test.ts` proves a Control Center grant enables real MCP read/write and a subsequent deny policy blocks write immediately.

Verified: `task-runner.test.ts` covers structured profile discovery, no caller-controlled shell interpolation, environment isolation, output redaction/capping, timeout and Windows process-tree cleanup. `workspace-bootstrap.test.ts` covers project metadata, task and AGENTS/SKILL discovery. `apply-verify.test.ts` covers successful verification, rollback of existing/new files on failure and explicit no-rollback mode. The HTTP MCP E2E contract exercises list_projects → workspace_bootstrap → run_task → apply_and_verify → policy denial.

Current full gate: 12 test files / 48 tests PASS plus lint, strict typecheck and production build.

Next: Project Brain index/AST graph tests, then bounded context-ranking and impact-analysis tests.
