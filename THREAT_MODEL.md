# THREAT_MODEL

Required threats: path traversal; symlink escape; command injection/metacharacters; prompt injection from repository content; malicious project files; secret/credential/Git credential leakage; arbitrary remote execution; production deployment mistakes; SSRF; browser network abuse; cross-project/cross-tenant access; privilege escalation; replay; authorization bypass; MCP parameter abuse; DoS/oversized outputs; malicious archives; dependency supply-chain attacks.

Status: model established; mitigations/tests pending except basic localhost HTTP Host/Origin controls.
