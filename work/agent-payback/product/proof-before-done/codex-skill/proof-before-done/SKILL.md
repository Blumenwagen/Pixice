---
name: proof-before-done
description: Configure or repair repository guidance for coding agents, including AGENTS.md, Claude companion instructions, permission boundaries, task briefs, and change-specific verification. Use when a user asks to set up agent rules, reduce agent drift, define safe autonomy, or require evidence before completion. Do not use for ordinary feature implementation or generic code review.
---

# Proof Before Done

Create concise repository guidance that is based on facts in the current project. The result should help an agent choose the right commands, stay inside its authority, and prove a change works before claiming completion.

## Inspect before drafting

Read existing instruction files and the smallest set of project files needed to establish:

- the stack and package manager;
- real build, test, lint, typecheck, and preview commands;
- architectural boundaries that current code actually follows;
- generated files and files that should not be edited;
- actions that need human approval;
- the checks required for common change types.

Prefer implementation and CI files over aspirational documentation when they conflict. Never invent a command. If a useful command cannot be verified, label it unresolved and ask the user only if the missing choice blocks a safe setup.

## Preserve what already works

Do not replace an existing `AGENTS.md` or `CLAUDE.md` wholesale. Reconcile duplicates, keep project-specific facts, and call out conflicts that would change agent behavior. Keep root guidance short. Put narrow rules close to the code they govern only when the repository has a real need for nested guidance.

For Codex, account for instruction precedence from root to the current directory. An `AGENTS.override.md` replaces the regular file at the same level. Do not create an override unless the user asks for a temporary or directory-specific replacement.

## Produce four controls

Create or update the smallest useful set:

1. `AGENTS.md` with repository facts, normal working rules, and verified commands.
2. `CLAUDE.md` only when the user uses Claude Code or requests a companion file.
3. `docs/agent/permissions.md` with actions grouped as allowed, ask first, and never without new authority.
4. `docs/agent/done-checklist.md` with change-type checks and required handoff evidence.

Use the files in `assets/templates/` as starting points. Remove unused sections and all bracketed placeholders from files you deliver.

## Permission boundary

Treat read-only inspection and ordinary workspace edits as separate permissions. Keep these behind an explicit approval unless the user already authorized them:

- credentials or secret stores;
- production systems and production data;
- payments, purchases, or financial transactions;
- public posts, messages, releases, or account changes;
- destructive or difficult-to-recover actions;
- access outside the stated project scope.

Instructions must not imply that a task grants broader authority than the user provided.

## Define done by change type

Map each common change type to the smallest check that could catch a real failure. Examples include focused unit tests for logic, a production build for bundling, browser checks for UI, migration validation for schema changes, and diff inspection for documentation or configuration.

Every completion handoff should state:

- what changed;
- which checks ran and their results;
- what could not be checked;
- any remaining risk or required human action.

Never say a check passed unless it ran.

## Final review

Before finishing:

- remove vague advice that could fit any repository;
- remove duplicated rules already enforced by tooling;
- confirm every command exists in package scripts, task files, CI, or project documentation;
- confirm the permission file does not silently widen access;
- confirm the done checklist covers the repository's highest-risk change types;
- inspect the final diff for accidental changes.

