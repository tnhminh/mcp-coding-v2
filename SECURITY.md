# SECURITY

Security posture is deny-by-default. Production controls are not yet complete.

Implemented baseline: localhost HTTP bind, Host/Origin validation, minimal non-sensitive health payload, no secret handling, no privileged filesystem/shell/remote tools yet.

Before privileged capabilities: implement project-root canonicalization, permissions, policy hooks, audit, secret references/redaction and the threat-model tests in `THREAT_MODEL.md`.
