# DECISIONS

## ADR-001 — TypeScript + official MCP SDK v2
Use Node.js TypeScript and `@modelcontextprotocol/server`/`@modelcontextprotocol/node` v2 targeting MCP 2026-07-28.

## ADR-002 — TypeScript 6.0.3
Initial TypeScript 7 selection conflicted with current `typescript-eslint` peer range. We selected 6.0.3 rather than forcing an invalid dependency tree.

## ADR-003 — Transport isolation
MCP server composition is a factory independent of stdio/HTTP entrypoints.

## ADR-004 — localhost HTTP by default
Initial HTTP server binds `127.0.0.1` and uses SDK-provided localhost Host/Origin validators. Remote exposure will require explicit auth/network design.
