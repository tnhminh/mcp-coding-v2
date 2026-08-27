# TEST_STRATEGY

Layers: unit, integration, MCP protocol contract, end-to-end, browser, deployment/rollback and adversarial security tests.

Every executable task must run targeted verification then full applicable checks. Current baseline command: `npm run check` = lint + strict typecheck + Vitest + production TypeScript build.

Verified: official MCP v2 client contract tests negotiate 2026-07-28 over spawned stdio and real localhost Streamable HTTP, then exercise tools/list, tools/call, unknown-tool handling and strict input-schema rejection.

Verified: config validation, safe public-error projection, JSON log redaction/reserved-field integrity and idempotent HTTP runtime shutdown are covered by `runtime-foundation.test.ts`.

Verified: Project Registry persistence covers migration idempotency, complete aggregate round-trip, async failure semantics, case-insensitive alias uniqueness, updates/removal and JSON-only metadata.

Verified: `project-path-resolver.test.ts` covers lexical/absolute traversal, missing/write targets, junction/symlink escape, safe internal links, sibling/nested project isolation, duplicate canonical roots, registry factory enforcement and Windows unsafe-path forms.

Verified: `control-center.test.ts` exercises the real dashboard/Overview, Project Registry, Permissions/Policies, persistent AI Job/Workflow APIs and real Preview/Browser lifecycle over HTTP, including Edge/Chrome screenshot evidence. The Control Center exposes pending modules honestly instead of simulating backend availability.

Verified: `authorization.test.ts` covers granted/missing capability, wrong-project, expired, revoked and inactive-project sessions plus global/project deny overrides. `control-center.test.ts` covers human-facing session issuance/revoke and policy create/update/delete APIs.

Verified: `secure-filesystem.test.ts` covers read/stat/list/search, sensitive and binary blocking, traversal/junction isolation, atomic SHA-guarded writes, diff, exact/batch patch, copy/move/delete and backup behavior. `mcp-filesystem-contract.test.ts` proves a Control Center grant enables real MCP read/write and a subsequent deny policy blocks write immediately.

Verified: `task-runner.test.ts` covers structured profile discovery, no caller-controlled shell interpolation, environment isolation, output redaction/capping, timeout and Windows process-tree cleanup. `workspace-bootstrap.test.ts` covers project metadata, task/preview profiles, AGENTS/SKILL discovery and static/no-task `preview_browser` routing. `apply-verify.test.ts` proves unavailable task profiles fail before mutation, plus successful verification, rollback of existing/new files on failure and explicit no-rollback mode. `ai-job.test.ts` proves unavailable profiles do not advance job status/iteration. The HTTP MCP E2E contract exercises list_projects → workspace_bootstrap → run_task → apply_and_verify → policy denial.

Verified: `project-brain-context.test.ts` covers bounded indexing, TS/JS declarations/import resolution/references, test/config classification, incremental SHA reuse, persisted snapshot reload after runtime recreation, corrupted-snapshot fail-closed behavior, bounded context ranking and declaration→importer→related-test impact analysis. `mcp-filesystem-contract.test.ts` now also exercises brain_build/find_symbol/context_bundle/impact_analysis over real HTTP MCP.

Verified: `coding-cycle.test.ts` covers verified review evidence, failed verification with rollback/fix guidance, iteration-stop behavior and authorization. `ai-job.test.ts` covers persistent fail→fix→review→complete, runtime restart recovery, invalid completion, optimistic CAS and proof that permission-session IDs are not serialized into job rows.

Verified: `command-recipe.test.ts` covers recipe discovery, bounded/redacted recognized project script execution and requirement for one session granting read/write/command capabilities.

Verified: `preview-browser.test.ts` runs real local Edge/Chrome headless against loopback static/dev previews, checks interaction/DOM/console/screenshot evidence, blocks external browser egress, denies `.env` and `credentials.json`, verifies dev log redaction and proves preview process-tree shutdown. MCP protocol contracts now also assert resources/list + resources/read for `mcp://server/tool-catalog` across stdio/HTTP, including the 2025-era Streamable HTTP handshake.

Verified: `audit-usage.test.ts` covers persistent audit/usage accounting, automatic real MCP tool-call instrumentation, explicit unavailable ChatGPT-via-MCP token visibility, provider-reported token totals/cost metadata and proof that Control Center audit excludes request-body markers/tool arguments.

Current full gate: 25 test files / 101 tests PASS plus lint, strict typecheck, production build, `npm audit --omit=dev` with 0 vulnerabilities and `git diff --check` PASS. Phase 1 Bridge regressions cover native local Git operations, managed process lifecycle, exact MCP catalog/runtime parity and the required Bridge capability surface.

Next: complete remaining Project Brain + Tasks/Commands Control Center integration and strengthen audit actor identity/retention plus broader observability.
