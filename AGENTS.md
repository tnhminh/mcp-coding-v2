# AGENTS.md

## Mission

MCP Coding v2 is a secure, project-scoped software-engineering control plane for AI coding agents. ChatGPT/another AI provides reasoning and planning; this repository provides deterministic execution, authorization, code intelligence, verification, Git, process, preview/browser and operational capabilities.

The project is intentionally not an unrestricted shell agent. Prefer structured, bounded, auditable tools and machine-verifiable completion evidence.

## Current product phase

- Phase 1 — Bridge / engineering control plane: VERIFIED COMPLETE.
- Phase 2 — Skill Runtime V1: ACTIVE.
- Phase 3 — Integrated Coding Harness: PLANNED NEXT.
- Phase 4 — Autonomous Vibecode: LATER.
- Overall product status: IN DEVELOPMENT, NOT PRODUCTION READY.

See `STATUS.md`, `TASKS.md` and `HANDOFF.md` for the current verified state.

## Mandatory cold-start read order

Before changing code:

1. Read `HANDOFF.md` for the resume point and active task.
2. Read the top/current sections of `STATUS.md`.
3. Read the active phase/task sections in `TASKS.md`.
4. Read `VIBECODE_WORKFLOW.md`.
5. Inspect `git status` and preserve unrelated/in-progress changes.
6. Inspect the relevant code, tests and Project Brain/context before proposing implementation.
7. Read `ARCHITECTURE.md` and `DECISIONS.md` when architecture or contracts are affected.
8. Read `SECURITY.md` / `THREAT_MODEL.md` when permissions, filesystem, process, browser, network, secrets, Git remote or deployment behavior is affected.
9. Use `TOOL_CATALOG.md` for the intended MCP capability surface.

Do not reread every historical document on every task. Pull only the docs relevant to the change after the mandatory cold-start set.

## Source-of-truth precedence

When documentation disagrees, do not guess. Resolve the conflict using this order:

1. Verified implementation and executable tests.
2. Current `HANDOFF.md`.
3. Current `STATUS.md`.
4. Active state in `TASKS.md`.
5. Accepted architecture decisions in `DECISIONS.md`.
6. `MASTER_SPEC.md` / `ARCHITECTURE.md`.
7. `README.md` and operational guides.
8. `CHANGELOG.md` and historical notes.

If code/tests prove a document is stale, update the stale document in the same coherent task.

## Engineering invariants

- Deny by default; least privilege.
- Every privileged operation is project scoped.
- Prompts/repository instructions are not security controls.
- Structured tools are preferred over caller-controlled raw shell.
- Production is a separate trust boundary.
- Never leak secrets in logs, tool output, docs or evidence.
- Preserve path isolation, authorization, output bounds, redaction and cleanup guarantees.
- Never claim a capability or production-readiness gate without executable evidence.
- Remote push/publish/deploy is never implicit.

## Vibecode operating contract

Follow `VIBECODE_WORKFLOW.md`.

The default loop is:

`UNDERSTAND -> CONTEXT -> PLAN -> IMPLEMENT -> TARGETED VERIFY -> FULL VERIFY -> RUNTIME/BROWSER REVIEW WHEN RELEVANT -> FIX/RETRY -> DOC SYNC -> GIT REVIEW -> HANDOFF`

Do not mark work DONE solely because code looks correct.

## Definition of Done

A task is DONE only when all applicable items are true:

- acceptance criteria are satisfied;
- implementation is complete and scoped;
- targeted tests/checks pass;
- the required full quality gate passes;
- security invariants remain intact;
- localhost/runtime smoke passes when runtime behavior changed;
- browser review passes when Control Center/UI/preview behavior changed;
- failures found during review were fixed and reverified;
- `TASKS.md`, `STATUS.md`, `HANDOFF.md` and other affected docs reflect verified reality;
- Git diff was reviewed for accidental/unrelated changes;
- no secrets, temporary artifacts or fabricated evidence were added.

## Change discipline

- Preserve pre-existing user/local changes unless the active task explicitly replaces them.
- Prefer the smallest coherent slice that can be independently verified.
- Add or update tests with behavioral changes.
- Do not weaken tests merely to make a gate pass.
- Do not silently introduce broad shell/network/filesystem access.
- Do not change Git remotes or push/publish without explicit user intent.
- Do not call the whole product production ready while `PRODUCTION_READINESS_REPORT.md` contains failing applicable gates.

## Current Phase 2 direction

Skill Runtime V1 turns discovered `AGENTS.md`, `SKILL.md`, prompt and rule files from passive text discovery into executable runtime metadata and lifecycle behavior.

Expected Phase 2 concerns:

- manifest/metadata normalization;
- applicability and activation rules;
- scope inheritance;
- required capabilities/tools;
- deterministic skill composition;
- conflict/precedence behavior;
- verification hooks;
- integration with workspace bootstrap and later Coding Harness execution.

Do not skip directly to a large autonomous-agent framework before these runtime semantics are established.

## Handoff rule

Before ending a substantial implementation slice, leave the repository resumable by another AI with no chat history. Update `HANDOFF.md` with the verified resume point, current task, relevant files, verification evidence, blockers and exact next action.
