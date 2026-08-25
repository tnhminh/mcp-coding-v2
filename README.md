# MCP Coding v2

Production-oriented MCP software-engineering control plane. Current verified scope: Phase 0 plus Phase 1 foundation (official MCP SDK v2, modern 2026-07-28 stdio/Streamable HTTP contracts, strict configuration, typed errors, structured JSON logging, health endpoints and graceful runtime lifecycle). Phase 2 project isolation/persistence is now active.

## Run
- `npm install`
- `npm run dev:stdio`
- `npm run dev:http` (default `127.0.0.1:7317`)
- `npm run build && npm run start:http` on shells that support `&&`, or run the two commands separately in Windows PowerShell
- `npm run check`

Full localhost installation/connection/stop/restart instructions: `LOCALHOST_GUIDE.md`.

This repository is not yet production ready. See `STATUS.md` and `PRODUCTION_READINESS_REPORT.md`.
