# DECISIONS

## ADR-001 — TypeScript + official MCP SDK v2
Use Node.js TypeScript and `@modelcontextprotocol/server`/`@modelcontextprotocol/node` v2 targeting MCP 2026-07-28.

## ADR-002 — TypeScript 6.0.3
Initial TypeScript 7 selection conflicted with current `typescript-eslint` peer range. We selected 6.0.3 rather than forcing an invalid dependency tree.

## ADR-003 — Transport isolation
MCP server composition is a factory independent of stdio/HTTP entrypoints.

## ADR-004 — localhost HTTP by default
Initial HTTP server binds `127.0.0.1` and uses SDK-provided localhost Host/Origin validators. Remote exposure will require explicit auth/network design.

## ADR-005 — Use createMcpHandler for modern HTTP
Direct NodeStreamableHTTPServerTransport wiring is a legacy/stateless transport primitive and did not satisfy the 2026-07-28 server/discover negotiation contract. HTTP now mounts SDK v2 createMcpHandler through toNodeHandler, with localhost Host/Origin guards in front.

## ADR-006 — No unauthenticated non-loopback HTTP
Until remote authentication/authorization is implemented, configuration accepts only loopback hosts. Runtime failures use typed errors and structured JSON logs; arbitrary caller fields cannot overwrite reserved log keys.
