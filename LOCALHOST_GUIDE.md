# Localhost Runbook

This runbook covers installing, verifying, starting, testing, stopping and connecting to MCP Coding v2 on a Windows localhost.

## 1. Requirements

- Windows PowerShell.
- Node.js `>=22.13.0`.
- npm.
- Project directory: `E:\mcp-coding-v2`.

Verify:

```powershell
node --version
npm --version
```

## 2. Install dependencies

```powershell
cd E:\mcp-coding-v2
npm install
```

Do not use `--force` or `--legacy-peer-deps` to bypass dependency errors.

## 3. Run the quality gate

```powershell
npm run check
```

The command must pass lint, strict TypeScript typecheck, Vitest and production build before a local deployment is treated as verified.

## 4. Development HTTP mode

```powershell
cd E:\mcp-coding-v2
npm run dev:http
```

Default listener:

- Host: `127.0.0.1`
- Port: `7317`
- Control Center: `http://127.0.0.1:7317/control-center`
- MCP endpoint: `http://127.0.0.1:7317/mcp`
- Liveness: `http://127.0.0.1:7317/health/live`
- Readiness: `http://127.0.0.1:7317/health/ready`

This mode runs TypeScript through `tsx` and is intended for development.

## 5. Production-like localhost mode

Build first:

```powershell
cd E:\mcp-coding-v2
npm run build
```

Then run compiled JavaScript:

```powershell
npm run start:http
```

This is the preferred localhost deployment mode when actively developing is not required.

## 6. Verify health

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:7317/health/live
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:7317/health/ready
```

Both endpoints should return HTTP `200` and a small JSON payload with `service`, `version`, `status` and `timestamp`.

## 7. Use the Control Center

Open:

```text
http://127.0.0.1:7317/control-center
```

The CMS/operations surface is backed by real APIs. You can manage Project Registry entries, issue/revoke temporary permission sessions and create/enable/disable/delete global or project-scoped authorization policies. Removing a registry entry does not delete files on disk. MCP/Tools and Settings show the effective backend state.

Project Registry data persists by default in `.runtime/mcp-coding-v2.sqlite`. Override the database location with `MCP_DATABASE_PATH` when required.

## 8. Connect an MCP client over HTTP

Use this Streamable HTTP endpoint:

```text
http://127.0.0.1:7317/mcp
```

The client must support modern MCP negotiation. The server targets MCP specification `2026-07-28`.

The exposed MCP surface is broader than the filesystem layer: project/bootstrap/readiness, secure filesystem, structured tasks/command recipes, managed processes, local Git, Project Brain/context/impact, apply-and-verify/coding cycle/AI Jobs, preview/browser review and audit-related operational capabilities are implemented. Use `TOOL_CATALOG.md` as the current capability inventory rather than copying a potentially stale tool list into this runbook.

Privileged project tools require the relevant project-scoped authorization. Permission sessions can be issued from the Control Center; finite sessions support 60 seconds through 150 days, and trusted-local agents may explicitly use no-expiry mode. Enabled deny policies still override grants. Existing-file writes/patches use SHA-256 optimistic concurrency to prevent silent overwrite of changed files.

## 9. Use stdio instead of HTTP

Development stdio:

```powershell
cd E:\mcp-coding-v2
npm run dev:stdio
```

Compiled stdio:

```powershell
npm run build
npm run start:stdio
```

For a local MCP client that launches servers itself, configure it to execute the stdio command from `E:\mcp-coding-v2` rather than using the HTTP URL.

## 10. Override localhost port or log level

Example:

```powershell
$env:MCP_PORT='7318'
$env:LOG_LEVEL='debug'
npm run start:http
```

Allowed HTTP hosts are intentionally restricted to loopback values: `127.0.0.1`, `localhost`, or `::1`. Non-loopback exposure is blocked until authentication/authorization for remote access is implemented.

## 11. Check which process owns the port

```powershell
Get-NetTCPConnection -LocalPort 7317 -State Listen |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

Inspect it:

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId = <PID>" |
  Select-Object ProcessId,Name,CommandLine
```

## 12. Stop the localhost server

If it is running in the foreground, press `Ctrl+C` so graceful shutdown can run.

For a detached local process, first identify the PID on port `7317`, verify that its command line belongs to `E:\mcp-coding-v2`, then stop that process:

```powershell
Stop-Process -Id <PID>
```

Do not kill a PID until the command line has been verified.

## 13. Restart after source changes

For development mode, stop and rerun:

```powershell
npm run dev:http
```

For production-like localhost mode:

```powershell
npm run check
npm run build
npm run start:http
```

## 14. Troubleshooting

### Port 7317 already in use

Find the listener with `Get-NetTCPConnection`. If it is an existing MCP Coding v2 instance, stop/restart it. If it belongs to another application, use another port:

```powershell
$env:MCP_PORT='7318'
npm run start:http
```

### Health endpoint fails

Run the server in the foreground to see structured JSON startup logs:

```powershell
$env:LOG_LEVEL='debug'
npm run dev:http
```

### MCP client cannot connect

Confirm in order:

1. `/health/live` is `200`.
2. `/health/ready` is `200`.
3. Client URL is exactly `/mcp`, not the health URL.
4. Client supports modern Streamable HTTP MCP.
5. The client is running on the same machine or can actually reach this localhost. A cloud-hosted client cannot directly reach the PC's `127.0.0.1`.

## 15. Current limitations

This repository is still in development, but Phase 1 Bridge is verified complete. Structured task/command execution, apply+verify, Project Brain/context/impact, persistent AI Jobs/coding cycle, local Git, managed processes and loopback Browser/Preview QA are already implemented.

The active priority is **Phase 2 Skill Runtime V1**. Production identity/RBAC, broader secret scanning, richer retrieval/workflow DAG, Remote SSH/SFTP, deployment/rollback, richer observability and final production qualification remain incomplete. See `AGENTS.md`, `HANDOFF.md`, `STATUS.md`, `TASKS.md` and `PRODUCTION_READINESS_REPORT.md` for current verified state.
