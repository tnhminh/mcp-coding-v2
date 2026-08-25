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

Current full gate: 9 test files / 37 tests PASS plus lint, strict typecheck and production build.

Next: command runner task-profile, injection, timeout/process-tree, output-limit/environment-redaction tests; then apply+verify orchestration tests.
