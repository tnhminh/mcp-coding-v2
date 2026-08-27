# ARCHITECTURE

## System role

MCP Coding v2 is an engineering control plane, not a second LLM.

```text
AI / ChatGPT reasoning
        |
        v
MCP transports + tool adapters
        |
        v
Application services
        |
        v
Domain policies/state
        |
        v
Infrastructure adapters
(SQLite / filesystem / OS processes / Git / browser)
        |
        v
Registered local projects
```

Reasoning can be probabilistic; authorization, path isolation, execution bounds, verification gates and security decisions must be deterministic server behavior.

## Layering

`entrypoints/transports -> MCP adapters/composition -> application services -> domain -> infrastructure adapters`

Transport code must not own business rules.

Persistent workflow identity uses explicit IDs such as `project_id`, `job_id`, `workflow_id`, `run_id` and `permission_session_id`.

## Current repository layout

- `src/entrypoints` — stdio/HTTP process bootstrap.
- `src/runtime` — HTTP runtime lifecycle and service wiring.
- `src/app` — MCP composition and application services.
- `src/domain` — project, authorization and job domain contracts/state.
- `src/infra` — SQLite, filesystem/path and logging adapters.
- `src/control-center` — localhost operations UI.
- `tests` — executable unit/integration/MCP/runtime/browser evidence.

## Runtime module map

- `src/app/create-mcp-server.ts` — MCP tool/resource registration and adapter composition; avoid placing core business rules here.
- `src/app/runtime-services.ts` — constructs/shares application services.
- `src/app/authorization-service.ts` — project capability/session/policy authorization.
- `src/app/secure-filesystem-service.ts` — bounded project-scoped filesystem operations.
- `src/app/task-runner-service.ts` — structured verification task discovery/execution.
- `src/app/command-recipe-service.ts` — bounded dependency/install/codegen/package-script recipes.
- `src/app/managed-process-service.ts` — runtime-owned long-running local processes.
- `src/app/git-service.ts` — project-scoped local Git operations; no implicit remote push.
- `src/app/project-brain-service.ts` — bounded persistent repository index/graph.
- `src/app/context-impact-service.ts` — context retrieval and structural blast-radius evidence.
- `src/app/apply-verify-service.ts` — change application plus verification/rollback.
- `src/app/coding-cycle-service.ts` — current bounded IMPLEMENT -> TEST -> REVIEW/FIX primitive.
- `src/app/ai-job-service.ts` — persistent coding objective lifecycle.
- `src/app/project-readiness-service.ts` — dependency/config/source preflight classification and preparation.
- `src/app/skill-discovery-service.ts` — current passive AGENTS/SKILL/rules discovery; Phase 2 evolves this into Skill Runtime semantics.
- `src/app/preview-service.ts` — loopback preview lifecycle and browser evidence.
- `src/app/audit-usage-service.ts` — persistent audit/usage metadata.
- `src/app/control-center-service.ts` — localhost operations API orchestration.

## Main execution path

A typical coding operation follows:

```text
MCP request
 -> resolve registered project
 -> authorize required capabilities
 -> collect project guidance/context
 -> execute bounded operation
 -> verify result
 -> persist bounded audit/job evidence
 -> return structured result
```

Repository instructions may influence coding behavior but may not grant privileges or bypass deterministic policy.

## Storage

Repository interfaces are asynchronous so storage adapters remain replaceable.

- SQLite is the current local/single-node persistent backend.
- PostgreSQL remains the intended direction for multi-instance production where needed.
- Project Brain snapshots persist metadata/graph state, not arbitrary full source snippets.

## Security boundaries

Prompts are not a security control.

Deterministic boundaries include:

- registered project roots and canonical path resolution;
- permission sessions plus deny-policy override;
- structured command/process surfaces;
- environment/output/time bounds and redaction;
- runtime-owned process cleanup;
- loopback preview/browser confinement;
- explicit separation of local Git from remote publish/deploy;
- no production authorization inferred from local development permission.

See `SECURITY.md` and `THREAT_MODEL.md`.

## Product-phase architecture

- **Phase 1 — Bridge:** secure engineering primitives and operations control plane. Complete.
- **Phase 2 — Skill Runtime:** normalize/activate/compose scoped skills and verification hooks over the Bridge.
- **Phase 3 — Coding Harness:** integrate task state, repo/context selection, planning, multi-step execution, retry and checkpoints.
- **Phase 4 — Autonomous Vibecode:** expose higher-level goal execution using the previous deterministic layers rather than bypassing them.
