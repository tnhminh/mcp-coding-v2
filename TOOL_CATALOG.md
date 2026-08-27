# TOOL_CATALOG

## Implemented MCP tools
- `system_health` — non-sensitive health snapshot.
- `list_projects`, `project_info`, `project_access_status`, `workspace_bootstrap` — registered local project discovery/bootstrap plus effective access/capability introspection. Bootstrap includes safe project scripts, recognized guidance, task/preview profiles and explicit verification strategy.
- `list_task_profiles`, `run_task` — Auto Task Discovery + structured test/lint/typecheck/check/build/bench execution. Discovery recognizes safe package-script aliases, Rust/Go/Python/Maven/Gradle/.NET conventions, explicit `.mcp/tasks.json` overrides and built-in static integrity `check`; missing requested task IDs return `VERIFICATION_UNAVAILABLE`.
- `list_command_recipes`, `run_command_recipe` — validated dependency/install/codegen operations plus every existing safe-name `package.json` script through the bounded process runner; caller-controlled raw shell remains unavailable.
- `list_skills`, `read_skill`, `project_guidance` — nested AGENTS/SKILL/prompt/rule discovery across common MCP/Agents/Codex/Claude/GitHub/Cursor/Cline/Roo/Windsurf/Continue formats plus bounded guidance bundle.
- `brain_build`, `brain_status` — build/refresh and inspect the persisted bounded Project Brain.
- `find_symbol`, `symbol_references` — TS/JS declaration/reference graph queries.
- `context_bundle` — bounded weighted lexical+graph coding context retrieval.
- `impact_analysis` — file/symbol blast-radius analysis across declarations, references, importers, tests and configs.
- `coding_cycle` — one bounded IMPLEMENT → TEST → REVIEW/FIX orchestration step with verification/context/impact evidence.
- `agent_job_create`, `agent_job_list`, `agent_job_status`, `agent_job_cycle`, `agent_job_complete`, `agent_job_cancel` — persistent restart-safe coding objective lifecycle and evidence.
- `preview_profiles`, `preview_list`, `preview_start`, `preview_status`, `preview_stop` — loopback static/recognized dev preview discovery and lifecycle.
- `browser_review` — local Edge/Chrome review of a server-created preview with DOM/console/network/action/screenshot evidence and same-origin browser isolation.
- `apply_and_verify` — bounded change application plus structured verification with default rollback on failure.
- `read_file`, `read_files`, `stat_path`, `list_files`, `search_text` — project/session authorized read surface, including bounded multi-file reads.
- `write_file`, `append_file` — atomic text mutation with SHA-256 guard for existing targets.
- `diff_file` — bounded proposed-content diff preview.
- `apply_patch`, `batch_patch` — exact SHA-guarded replacement; batch prevalidation and rollback attempt.
- `copy_file`, `move_file`, `delete_file` — in-project mutations; move/delete use SHA guards and delete persists a backup.

Privileged project tools use `project_id` and an active project permission session. `permission_session_id` may be omitted only when authorization can resolve one unambiguous active session that grants the complete required capability set; distinct active authorization envelopes fail closed and require an explicit session ID. Enabled deny policies always override grants.

## Control Center HTTP surface
Local operations UI: `/control-center`. Current real APIs include Overview/Projects/Permissions/Policies/Tools/Settings plus `GET|POST /api/projects/:id/ai-jobs`, `GET /api/ai-jobs/:id`, `POST /api/ai-jobs/:id/cancel`, `GET /api/projects/:id/preview-profiles`, `GET|POST /api/projects/:id/previews`, `GET /api/previews/:id`, `POST /api/previews/:id/stop`, and `POST /api/previews/:id/review`. These are not MCP tools; they are localhost operations APIs guarded by Host/Origin validation.

## Implemented MCP resources
- `mcp://server/tool-catalog` — read-only JSON catalog only. Project files are intentionally not exposed through the MCP Resource API.

## Next MCP families
workflow DAG/task dependencies; richer retrieval; remote/SSH/SFTP; deployment; audit/observability. Git/GitHub is deliberately deferred until the local-project coding surface and Control Center integration are complete.
