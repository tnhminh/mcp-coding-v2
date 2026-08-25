# SECURITY

Security posture is deny-by-default. Production controls are not yet complete.

Implemented baseline: localhost HTTP bind, Host/Origin validation, minimal non-sensitive health payload, structured log redaction, registry-aware project-root canonicalization and adversarial traversal/junction/symlink/nested-project/Windows path isolation tests.

Privileged local capabilities require a valid project-bound temporary permission session; enabled global/project deny policies override grants. Secure Filesystem tools are live and deny sensitive credential paths, private-key material, binary/NUL content and text over 1 MiB. Writes use canonical re-resolution, temp-file + rename commit and SHA-256 optimistic concurrency; batch patch prevalidates all targets and attempts rollback; delete requires a persisted backup. Directory traversal does not follow symlinks.

Residual risk: filesystem pathname checks reduce but cannot mathematically eliminate all OS-level TOCTOU races without descriptor-relative/open-handle APIs. Production identity/RBAC, audit, complete secret scanning and command-runner isolation remain incomplete. P4 must execute structured tasks without shell interpolation, with bounded environment/output/time and process-tree cleanup.
