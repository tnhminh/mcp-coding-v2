# TEST_STRATEGY

Layers: unit, integration, MCP protocol contract, end-to-end, browser, deployment/rollback and adversarial security tests.

Every executable task must run targeted verification then full applicable checks. Current baseline command: `npm run check` = lint + strict typecheck + Vitest + production TypeScript build.

Verified: official MCP v2 client contract tests negotiate 2026-07-28 over spawned stdio and real localhost Streamable HTTP, then exercise tools/list, tools/call, unknown-tool handling and strict input-schema rejection.

Verified: config validation, safe public-error projection, JSON log redaction/reserved-field integrity and idempotent HTTP runtime shutdown are covered by `runtime-foundation.test.ts`.

Next: project registry repository/migration tests, path-isolation adversarial tests and permission/policy tests.
