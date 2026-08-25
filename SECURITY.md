# SECURITY

Security posture is deny-by-default. Production controls are not yet complete.

Implemented baseline: localhost HTTP bind, Host/Origin validation, minimal non-sensitive health payload, structured log redaction, registry-aware project-root canonicalization and adversarial traversal/junction/symlink/nested-project/Windows path isolation tests.

Privileged local capabilities require a valid project-bound temporary permission session; enabled global/project deny policies override grants. Secure Filesystem tools are live and deny sensitive credential paths, private-key material, binary/NUL content and text over 1 MiB. Writes use canonical re-resolution, temp-file + rename commit and SHA-256 optimistic concurrency; batch patch prevalidates all targets and attempts rollback; delete requires a persisted backup. Directory traversal does not follow symlinks.

Structured command execution now requires `command.run`, exposes only fixed task kinds, never accepts caller-provided raw shell, sanitizes inherited environment variables, caps/redacts output, enforces timeouts and cleans process trees. On Windows, package.json tasks use a fixed manager/task command through `cmd.exe`; custom `.mcp/tasks.json` profiles remain direct executable+argv and reject `.cmd/.bat` shims. `apply_and_verify` composes filesystem writes with task verification and rolls back by default when verification fails.

Project Brain only enumerates/reads through the permission-gated Secure Filesystem surface. Persistent Brain snapshots store bounded file metadata, hashes, symbol/import/reference/test/config graph data but do not persist source-file content snippets. Invalid snapshot JSON is removed and state fails closed to `not_indexed`; context snippets are generated on demand from current authorized files.

Residual risk: filesystem pathname checks reduce but cannot mathematically eliminate all OS-level TOCTOU races without descriptor-relative/open-handle APIs. Repository-controlled task definitions are trusted code once a human grants `command.run`; production identity/RBAC, audit, complete secret scanning and stronger OS sandboxing remain incomplete. Brain indexing is intentionally capped and currently provides weighted lexical+graph retrieval rather than semantic embeddings/BM25.
