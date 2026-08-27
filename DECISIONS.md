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

## ADR-007 — Stable SQLite driver behind async repository contracts
The built-in Node 24 `node:sqlite` API still emits an ExperimentalWarning, so local persistence uses pinned `better-sqlite3` 13.0.3. Domain repository interfaces remain Promise-based so a future PostgreSQL adapter does not require application-layer contract changes. The runtime engine floor is Node 22.13.0 so both the SQLite driver and the current validation/tooling stack have a supported Node 22 baseline.

## ADR-008 — Registry-aware canonical path isolation
Path authorization uses canonical `realpath` roots and a resolver factory built from the current project registry snapshot. A parent project excludes nested registered project roots; duplicate projects resolving to the same canonical root are rejected. Existing paths are realpath-checked and write targets resolve through their nearest existing ancestor. Windows unsafe path forms are rejected. P3 operations must still mitigate TOCTOU between resolution and filesystem mutation.

## ADR-009 — Human-issued temporary capability sessions with deny override
Privileged local coding operations require a project-bound permission session issued through the localhost Control Center. Sessions carry an explicit fixed capability set and can be revoked immediately. Finite sessions may last from 60 seconds up to 150 days; trusted local agents may explicitly request a no-expiry session, represented by the non-null sentinel timestamp 9999-12-31T23:59:59.999Z for SQLite compatibility. Policies do not grant capability: a valid session grant is always required. Enabled global or project-scoped `deny` policies override matching session grants. This prevents repository prompts or MCP callers from self-elevating by supplying a policy-like request.

## ADR-010 — Text-first secure filesystem with optimistic concurrency
Coding filesystem tools operate on bounded UTF-8 text inside registered canonical project roots. Credential-oriented paths, private-key material, binary/NUL content and files above 1 MiB are excluded. Existing-file mutations require the SHA-256 observed by the caller; writes commit through an in-directory temporary file plus rename and re-resolve the target before commit. Multi-file patch prevalidates all changes and attempts rollback on failure; destructive delete requires persistent backup storage. This is a local coding safety boundary, not a claim of race-free filesystem semantics.

## ADR-011 — Structured project tasks instead of a raw shell
The MCP coding surface does not expose arbitrary shell command strings. A permission-gated `run_task` chooses one of six fixed task kinds discovered from package.json, Cargo, Go or a bounded `.mcp/tasks.json` executable/argv profile. Runtime execution uses a sanitized environment, output/time bounds, redaction and process-tree cleanup. Windows package-manager shims are invoked only through a fixed manager + fixed task command. `apply_and_verify` composes SHA-guarded file changes with these verification tasks and rolls back by default on failure.

## ADR-012 — Bounded persistent Project Brain before richer retrieval
Project understanding is built from the already-authorized Secure Filesystem rather than unrestricted disk access. The Brain stores bounded file/language/test/config metadata plus TS/JS declarations/imports/references, reuses unchanged AST results by SHA-256 and persists the graph as a SQLite snapshot. Source snippets are not persisted in the Brain snapshot; `context_bundle` reads current authorized files on demand. Corrupt snapshots are discarded and state returns to `not_indexed`. Initial retrieval is weighted lexical+graph with strict file/character budgets; it is intentionally not labeled BM25 or Git-aware.
