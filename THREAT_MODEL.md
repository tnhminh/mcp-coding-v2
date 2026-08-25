# THREAT_MODEL

Required threats: path traversal; symlink escape; command injection/metacharacters; prompt injection from repository content; malicious project files; secret/credential/Git credential leakage; arbitrary remote execution; production deployment mistakes; SSRF; browser network abuse; cross-project/cross-tenant access; privilege escalation; replay; authorization bypass; MCP parameter abuse; DoS/oversized outputs; malicious archives; dependency supply-chain attacks.

Status: model established. Implemented/tested so far: localhost HTTP Host/Origin controls plus project path traversal, absolute escape, junction/symlink escape, nested registered-project isolation, duplicate canonical-root rejection and Windows unsafe-path forms. Operation-time filesystem races/TOCTOU, authorization, command, secret, remote, browser, deployment and remaining threats are pending.
