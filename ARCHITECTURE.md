# ARCHITECTURE

## Layering
`entrypoints/transports -> MCP adapters -> application services -> domain -> infrastructure adapters`.

Transport code must not own business rules. Persistent workflow identity will use explicit IDs (`project_id`, `job_id`, `workflow_id`, `run_id`, `permission_session_id`).

## Initial repository layout
- `src/entrypoints`: transport/process bootstrap
- `src/app`: MCP composition and application services
- `src/domain`: entities, policies, state machines (next slices)
- `src/infrastructure`: storage/OS/provider adapters (next slices)
- `tests`: executable verification

## Storage direction
Repository interfaces first. SQLite for local/single-node mode; PostgreSQL adapter for multi-instance production.

## Security boundary
Prompts are not a security control. Path isolation, permission checks, command policy, production elevation and secret redaction must be deterministic server logic.
