# MCP Coding v2

Production-oriented MCP software-engineering control plane for AI coding agents. ChatGPT/another AI acts as the reasoning brain; MCP Coding v2 provides secure project-scoped execution, code intelligence, verification and local engineering operations.

## Current status

- **Phase 1 — Bridge:** verified complete.
- **Phase 2 — Skill Runtime V1:** active.
- **Phase 3 — Integrated Coding Harness:** next.
- **Phase 4 — Autonomous Vibecode:** later.
- **Product:** IN DEVELOPMENT — not production ready.

Verified Phase 1/core capabilities include MCP 2026-07-28 stdio + Streamable HTTP, SQLite Project Registry, permission sessions/policies, secure filesystem, structured tasks/commands, managed processes, local Git, Project Brain/context/impact, apply-and-verify, AI Jobs/coding cycle, loopback preview/browser QA, Audit/Usage and the localhost Control Center.

## AI contributors

Start with **`AGENTS.md`**. It defines the mandatory read order, source-of-truth rules, security invariants and Definition of Done.

Then resume from:

1. `HANDOFF.md`
2. `STATUS.md`
3. active sections in `TASKS.md`
4. `VIBECODE_WORKFLOW.md`

## Run

- `npm install`
- `npm run dev:stdio`
- `npm run dev:http` (default `127.0.0.1:7317`)
- `npm run build` then `npm run start:http`
- `npm run check`

Control Center: `http://127.0.0.1:7317/control-center`

MCP HTTP endpoint: `http://127.0.0.1:7317/mcp`

Full localhost installation, connection, stop and restart instructions: `LOCALHOST_GUIDE.md`.

Capability inventory: `TOOL_CATALOG.md`.

Production gate status: `PRODUCTION_READINESS_REPORT.md`.
