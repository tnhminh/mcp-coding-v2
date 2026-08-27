# VIBECODE_WORKFLOW

## Purpose

This document defines how an AI coding agent should work inside MCP Coding v2 so changes remain efficient, verifiable, secure and easy to hand off.

## Standard loop

```text
UNDERSTAND
   -> CONTEXT
   -> PLAN
   -> IMPLEMENT
   -> TARGETED VERIFY
   -> FULL VERIFY
   -> RUNTIME / BROWSER REVIEW (when relevant)
   -> FIX + REVERIFY (if anything fails)
   -> DOC SYNC
   -> GIT DIFF REVIEW
   -> HANDOFF
```

A failed stage loops back to the smallest stage that can fix the root cause. Do not continue forward with known blocking failures.

## 1. UNDERSTAND

- Read `AGENTS.md`.
- Resume from `HANDOFF.md`.
- Check `STATUS.md` and active `TASKS.md` entries.
- Inspect Git status before editing.
- State the acceptance criteria from existing project docs/tests rather than inventing scope.
- Identify whether the task affects security, public MCP contracts, persistence, Control Center/UI, runtime lifecycle or operations.

## 2. CONTEXT

Use the smallest sufficient context:

- inspect relevant files and tests;
- use Project Brain/context/impact data when available;
- identify callers, dependencies and nearby tests before broad refactors;
- read related ADR/security docs only when the affected boundary requires them.

Avoid loading the entire repository or all historical documentation into the model context when a bounded slice is enough.

## 3. PLAN

Choose a coherent implementation slice that can be verified independently.

A good plan states:

- files/modules likely affected;
- behavioral contract being added/changed;
- tests/evidence required;
- security or compatibility constraints;
- rollback/failure behavior when applicable.

Do not expand scope just because adjacent cleanup is possible.

## 4. IMPLEMENT

- Follow existing layer boundaries.
- Keep transport adapters thin; business rules belong in application/domain services.
- Prefer typed structured inputs over raw commands/strings.
- Preserve project scoping, canonical path checks, permissions/policies, redaction, bounds and cleanup.
- Add/update tests alongside changed behavior.
- Preserve unrelated dirty-worktree changes.

## 5. TARGETED VERIFY

Run the narrowest relevant checks first so failures are cheap to diagnose.

Examples:

- one relevant Vitest file;
- typecheck after contract/type changes;
- lint after structural edits;
- build after entrypoint/runtime changes;
- specific browser/Control Center test after UI changes.

Fix root causes before continuing.

## 6. FULL VERIFY

Before marking a coding slice complete, run the repository-required quality gate:

```powershell
npm run check
```

The gate currently covers lint, strict TypeScript typecheck, Vitest and production build.

Run additional gates documented in `TEST_STRATEGY.md` when applicable, such as audit, diff checks or security/browser qualification.

Never report PASS from an old run after changing code that could invalidate it.

## 7. RUNTIME AND BROWSER REVIEW

When runtime behavior changes:

1. build/restart the localhost runtime as appropriate;
2. verify `/health/live` and `/health/ready`;
3. smoke the affected MCP/API flow.

When Control Center, preview or browser-visible behavior changes:

1. start/reuse the registered loopback preview/runtime;
2. run Browser Review using the project-supported browser capability;
3. inspect DOM, console, network and screenshot evidence;
4. fix defects;
5. rerun review until blocking issues are clean.

Code tests do not replace browser review for browser-visible regressions.

## 8. FIX AND RETRY

If any verification/review fails:

- capture the concrete failure;
- identify the root cause;
- make the smallest corrective change;
- rerun the targeted failure;
- rerun the full applicable gate;
- repeat until acceptance criteria pass or a genuine external blocker exists.

Do not hide, downgrade or delete legitimate tests to force green status.

## 9. DOCUMENTATION SYNC

Update docs with verified facts, not intended future behavior.

At minimum consider:

- `TASKS.md`: task state and evidence;
- `STATUS.md`: current verified capabilities/gaps;
- `HANDOFF.md`: exact resume point and next action;
- `CHANGELOG.md`: meaningful completed changes;
- `TOOL_CATALOG.md`: MCP/public capability changes;
- `DECISIONS.md`: durable architecture decisions;
- `SECURITY.md` / `THREAT_MODEL.md`: changed trust boundaries;
- operational docs when commands/run behavior changes.

If documentation conflicts with executable behavior, fix the documentation in the same slice.

## 10. GIT REVIEW AND CHECKPOINT

Before handoff:

- inspect Git status and diff;
- verify no unrelated files were accidentally changed;
- verify no secrets or temporary artifacts are included;
- create a local checkpoint/commit only when that is part of the requested workflow and permissions allow it;
- never change remote origin or push/publish implicitly.

## 11. HANDOFF

A good handoff lets a new AI continue without conversation history.

Record:

- current phase/slice;
- last verified state/checkpoint;
- what changed;
- relevant files;
- exact tests/checks run and their results;
- runtime/browser evidence when applicable;
- known blockers/risks;
- dirty working-tree notes that must be preserved;
- exact next task and acceptance criteria.

## Stop conditions

Stop and report a blocker only when the issue is genuinely external or unsafe to bypass, such as missing credentials/authorization, unavailable required external service, or an explicit trust-boundary decision requiring the user.

Internal test failures, code defects or documentation drift are not blockers; fix them within the loop.

## Definition of Done

```text
IMPLEMENTED
+ TARGETED VERIFY PASS
+ FULL REQUIRED GATE PASS
+ RUNTIME/BROWSER REVIEW PASS WHEN APPLICABLE
+ SECURITY INVARIANTS PRESERVED
+ DOCS SYNCED
+ DIFF REVIEWED
+ HANDOFF UPDATED
= DONE
```
