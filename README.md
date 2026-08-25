# MCP Coding v2

Production-oriented MCP software-engineering control plane. Verified scope now includes MCP 2026-07-28 runtime, SQLite Project Registry, temporary permissions/policies, canonical cross-project isolation, a real Control Center, secure local-project filesystem tools, workspace/skill discovery, structured project tasks, apply-and-verify rollback orchestration, and a persistent bounded Project Brain with context/impact tools.

## Run
- `npm install`
- `npm run dev:stdio`
- `npm run dev:http` (default `127.0.0.1:7317`)
- `npm run build && npm run start:http` on shells that support `&&`, or run the two commands separately in Windows PowerShell
- `npm run check`

Control Center: `http://127.0.0.1:7317/control-center` (or open `/`, which redirects there).

Full localhost installation/connection/stop/restart instructions: `LOCALHOST_GUIDE.md`.

This repository is not yet production ready. See `STATUS.md` and `PRODUCTION_READINESS_REPORT.md`.
