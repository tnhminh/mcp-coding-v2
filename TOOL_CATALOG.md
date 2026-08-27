# TOOL_CATALOG

## Implemented MCP tools
- `system_health` — non-sensitive health snapshot.
- `list_projects`, `project_info`, `project_access_status`, `workspace_bootstrap` — registered local project discovery/bootstrap plus effective access/capability introspection. Bootstrap includes safe project scripts, recognized guidance, task/preview profiles and explicit verification strategy.
- `list_task_profiles`, `run_task` — Auto Task Discovery + structured test/lint/typecheck/check/build/bench execution. Discovery recognizes safe package-script aliases, Rust/Go/Python/Maven/Gradle/.NET conventions, explicit `.mcp/tasks.json` overrides and built-in static integrity `check`; missing requested task IDs return `VERIFICATION_UNAVAILABLE`.
- `list_command_recipes`, `run_command_recipe` — validated dependency/install/codegen operations plus every existing safe-name `package.json` script through the bounded process runner; caller-controlled raw shell remains unavailable.
- `process_profiles`, `process_list`, `process_start`, `process_status`, `process_stop` — runtime-owned long-running managed package-script lifecycle for dev/start/serve/preview/storybook/watch/web/frontend/backend/server/api/app/local variants with sanitized env, bounded/redacted logs and process-tree cleanup.
- `git_status`, `git_diff`, `git_log`, `git_branches`, `git_stage`, `git_unstage`, `git_create_branch`, `git_switch_branch`, `git_commit`, `git_restore_paths` — local Git runtime. Read-only status/diff/log/branches can scope a registered subproject inside a larger monorepo; Git mutations still require the registered project root to equal the repository root. No remote push is performed.
- `list_skills`, `read_skill`, `project_guidance` — bounded AGENTS/SKILL/prompt/rule discovery across common MCP/Agents/Codex/Claude/GitHub/Cursor/Cline/Roo/Windsurf/Continue formats. Nested scoped guidance activates only when supplied `target_paths` intersects its scope; discovery reports truncation explicitly.
- `brain_build`, `brain_status` — build/refresh and inspect the persisted bounded Project Brain. Structural graph analysis is explicit for TS/JS; other indexed languages are reported as lexical-only coverage. TS/JS import resolution understands bounded `tsconfig.json` `baseUrl`/`paths` aliases.
- `find_symbol`, `symbol_references` — TS/JS declaration/reference graph queries.
- `context_bundle` — bounded weighted lexical+graph coding context retrieval with stopword filtering and larger/adaptive file/character budgets.
- `impact_analysis` — file/symbol blast-radius analysis across declarations, references, importers, tests and configs.
- `coding_cycle` — one bounded IMPLEMENT → TEST → REVIEW/FIX orchestration step with adaptive context, same-file multi-patch support, verified/baseline-accepted/deferred verification states and explicit retry/stop guidance.
- `agent_job_create`, `agent_job_list`, `agent_job_status`, `agent_job_cycle`, `agent_job_complete`, `agent_job_cancel` — persistent restart-safe coding objective lifecycle and evidence.
- `preview_profiles`, `preview_list`, `preview_start`, `preview_status`, `preview_stop` — loopback static/recognized dev preview discovery and lifecycle.
- `browser_review` — local Edge/Chrome review of a server-created preview with DOM/console/network/action/screenshot evidence. Page-side external HTTP/WebSocket egress is denied by default; trusted local operators may configure explicit origins through `MCP_BROWSER_ALLOWED_ORIGINS`.
- `apply_and_verify` — bounded SHA-guarded change application plus structured verification. New regressions roll back by default; an unchanged pre-existing source failure may retain a no-new-regression patch as `baseline_accepted` but remains `verified=false`; absent structured verifiers can be represented explicitly as deferred rather than fabricated.
- `read_file`, `read_files`, `stat_path`, `list_files`, `search_text` — project/session authorized read surface, including bounded multi-file reads and explicit list/search truncation metadata.
- `read_file_range` — bounded line/byte reads for authorized text files up to 16 MiB while returning the whole-file SHA-256 guard.
- `write_file`, `append_file` — atomic text mutation with SHA-256 guard for existing targets.
- `replace_file_lines` — atomic inclusive line-range replacement for authorized text files up to 16 MiB using the current whole-file SHA-256 guard.
- `diff_file` — bounded proposed-content diff preview.
- `apply_patch`, `batch_patch` — exact SHA-guarded replacement; batch patch supports multiple sequential patches to one file when every patch references the same original SHA, with prevalidation and rollback attempt.
- `copy_file`, `move_file`, `delete_file` — in-project mutations; move/delete use SHA guards and delete persists a backup.

Privileged project tools use `project_id` and an active project permission session. `permission_session_id` may be omitted when authorization can deterministically resolve one same-principal dominant capability envelope; a newer/equivalent superset can therefore supersede a narrower session. Different principals or incomparable active envelopes remain ambiguous and fail closed. Enabled deny policies always override grants.

## Control Center HTTP surface
Local operations UI: `/control-center`. Real APIs include Overview/Projects/Permissions/Policies/Tools/Settings, safe project access snapshots, Git status/history/branches, managed process profiles/sessions, AI Jobs, Preview/Browser, Tunnel, Audit and Usage. These are localhost operations APIs guarded by Host/Origin validation; the UI uses access snapshots to avoid probing protected job/preview APIs when the selected project lacks required capability.

## Implemented MCP resources
- `mcp://server/tool-catalog` — read-only JSON catalog only. Project files are intentionally not exposed through the MCP Resource API.

## Next MCP families
Skill Runtime; integrated Coding Harness; workflow DAG/task dependencies; richer retrieval; remote/SSH/SFTP; deployment; richer observability. Git remote publishing remains explicit and separate from the Phase 1 local Git runtime.
