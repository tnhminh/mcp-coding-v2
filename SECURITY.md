# SECURITY

Security posture is deny-by-default. Production controls are not yet complete.

Implemented baseline: localhost HTTP bind, Host/Origin validation, minimal non-sensitive health payload, structured log redaction, registry-aware project-root canonicalization and adversarial traversal/junction/symlink/nested-project/Windows path isolation tests. No privileged filesystem/shell/remote tools exist yet.

Privileged local capabilities now require a valid project-bound temporary permission session; enabled global/project deny policies override grants. Sessions expire automatically and can be revoked immediately from the Control Center. Production identity/RBAC, audit and secret-reference/scanning controls remain incomplete. Filesystem operations must consume `ProjectPathResolverFactory` per project and must not reconstruct unchecked paths after resolution; P3 must additionally address operation-time TOCTOU/race behavior.
