# MASTER_SPEC

## Product
MCP Coding v2 is a secure project-scoped execution, code-intelligence, workflow, verification, Git, browser, remote/deployment and operations control plane for AI coding agents.

## Required capability groups
Project Registry; Permission Engine; Policy Engine; Secure Filesystem; Project Brain; Context Retrieval; Command/Task Runner; Apply+Verify; Workflow/Tasks; AI Jobs; Git/GitHub; Browser/Preview; Remote Server/SSH/SFTP; Deployment; Secrets; Audit; Observability; Control Center; pluggable storage/providers.

## Invariants
- deny by default and least privilege
- every privileged operation is project scoped
- structured tools preferred over raw shell
- completion requires machine-verifiable evidence
- production is a separate trust boundary
- no secrets in logs, tool output or project docs
- docs must reflect verified reality

## Protocol target
MCP specification 2026-07-28 using official TypeScript SDK v2; stdio and Streamable HTTP transports.
