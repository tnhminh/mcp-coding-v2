# SECURITY

Security posture is deny-by-default. Production controls are not yet complete.

Implemented baseline: localhost HTTP bind, Host/Origin validation, minimal non-sensitive health payload, structured log redaction, registry-aware project-root canonicalization and adversarial traversal/junction/symlink/nested-project/Windows path isolation tests. No privileged filesystem/shell/remote tools exist yet.

Before privileged capabilities: complete capability/temporary permissions, policy hooks, audit, secret references/scanning/redaction and the remaining threat-model tests in `THREAT_MODEL.md`. Filesystem operations must consume `ProjectPathResolverFactory` per project and must not reconstruct unchecked paths after resolution; P3 must additionally address operation-time TOCTOU/race behavior.
