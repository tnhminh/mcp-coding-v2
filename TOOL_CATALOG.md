# TOOL_CATALOG

## Implemented
### system_health
Read-only. Input: empty object. Output: service, version, status, timestamp. No sensitive details.

## Control Center HTTP surface
Local operations UI: `/control-center`. Current real APIs: `GET /api/control-center/overview`, `GET|POST /api/projects`, `PUT|DELETE /api/projects/:id`, `GET|POST /api/projects/:id/permission-sessions`, `POST /api/permission-sessions/:id/revoke`, `GET|POST /api/policies`, `PUT|DELETE /api/policies/:id`, `GET /api/tools`, `GET /api/settings`. These are not MCP tools; they are localhost operations APIs guarded by Host/Origin validation.

## Planned MCP families
project registry; permissions/policies; filesystem; brain/context/impact; tasks/commands/apply+verify; workflow/jobs; Git/GitHub; browser/preview; remote/SSH/SFTP; deployment; audit/observability.
