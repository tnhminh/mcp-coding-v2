# TOOL_CATALOG

## Implemented MCP tools
- `system_health` — non-sensitive health snapshot.
- `read_file`, `stat_path`, `list_files`, `search_text` — project/session authorized read surface.
- `write_file`, `append_file` — atomic text mutation with SHA-256 guard for existing targets.
- `diff_file` — bounded proposed-content diff preview.
- `apply_patch`, `batch_patch` — exact SHA-guarded replacement; batch prevalidation and rollback attempt.
- `copy_file`, `move_file`, `delete_file` — in-project mutations; move/delete use SHA guards and delete persists a backup.

Every filesystem tool uses `project_id` + `permission_session_id`; write tools require `filesystem.write`, read tools require `filesystem.read`, and enabled deny policies override grants.

## Control Center HTTP surface
Local operations UI: `/control-center`. Current real APIs: `GET /api/control-center/overview`, `GET|POST /api/projects`, `PUT|DELETE /api/projects/:id`, `GET|POST /api/projects/:id/permission-sessions`, `POST /api/permission-sessions/:id/revoke`, `GET|POST /api/policies`, `PUT|DELETE /api/policies/:id`, `GET /api/tools`, `GET /api/settings`. These are not MCP tools; they are localhost operations APIs guarded by Host/Origin validation.

## Next MCP families
project/workspace discovery; structured tasks/commands/apply+verify; project skill discovery; brain/context/impact; workflow/jobs; browser/preview; remote/SSH/SFTP; deployment; audit/observability. Git/GitHub is deliberately deferred until the local-project coding surface is complete.
