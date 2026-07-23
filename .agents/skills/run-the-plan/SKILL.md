---
name: run-the-plan
description: Execute one or more phased implementation plans by delegating planning and implementation work to ChatGPT. Use this only when requested explicitly by name.
---

# Run the Plan

Use this skill only when the user explicitly requests `run-the-plan` or clearly asks to execute an implementation plan through this workflow. At least one implementation-plan path is required.

Read and follow the `chatgpt-proxy` skill first. It governs thread creation, follow-ups, status polling, timeout recovery, errors, and deletion.

## Core rules

- Process plans, phases, existing subparts, threads, and commands strictly sequentially. Never pre-create or overlap work.
- Finish the complete workflow for one plan before starting another.
- Use `cgpt` for every ChatGPT delegation. Wait until each run reaches a terminal status; an intermediate timeout or lack of output is not completion.
- Use `--thinking high` for every `new` and `chat` command unless the user requests otherwise.
- Prefix every initial `new` message with `@dev-nt `. Follow-up `chat` messages do not need the prefix.
- Use a fresh thread for each initial plan review, implementation unit, whole-phase audit, and post-phase remaining-plan review.
- Implement only one existing subpart or one whole phase per implementation thread.
- Do not independently audit implementation correctness, repair incomplete work, validate test claims, or second-guess ChatGPT's implementation choices. The only manual inspection permitted is of changed-file paths and diff summaries needed to stage and commit work.
- Beyond plan-document verification and changed-file inspection for staging, do not inspect implementation files, diffs, tests, or ChatGPT's implementation claims.
- Stop immediately on any blocker. Do not skip ahead, retry blindly, replace the thread, commit partial work, or continue with another phase or plan.

## Repository baseline

Resolve the repository containing each plan and use the plan's absolute path in every prompt.

Before the first ChatGPT request for a repository, capture:

```bash
git -C <repository-root> status --short --untracked-files=all
```

Record the exact baseline paths marked `??`. Exclude them from every later commit unless ChatGPT created them during this workflow. Keep one baseline per repository; when several plans share a repository, retain the baseline captured before the first plan.

## Workflow

For each plan, in order:

1. Review and normalize the plan structure.
2. For each main phase, use its existing ordered subparts, if any; otherwise treat the whole phase as one implementation unit.
3. Implement and commit each implementation unit in its own thread.
4. Audit and, if necessary, finish and commit the whole phase.
5. Review the remaining phases in light of what the completed phase revealed, changing the plan only when a concrete cause justifies it.
6. Continue to the next phase, then the next supplied plan.

Delete each successfully completed thread before creating the next one.

## Initial plan review

```bash
cgpt new <plan-slug>-initial-review \
  --message "@dev-nt Review the implementation plan at <absolute-plan-path>. Do not implement it. Verify that its main phases or stages are clear and ordered for implementation and that it has explicit completion tracking. Update the plan only where needed to correct inadequate phase structure or tracking. Return the ordered main phases and any existing subparts, state whether you modified the plan, and report any blocking issue." \
  --thinking high
```

Use the returned phase structure and any existing subparts as workflow state. If ChatGPT reports a blocker, stop.

When ChatGPT reports plan edits, inspect only the plan document and verify that the reported changes exist and satisfy the prompt. Do not ask ChatGPT to commit planning edits. If the edits are missing or materially inadequate, send a corrective follow-up in the same thread, inspect the plan again, and stop as blocked if it remains inadequate.

Delete the completed review thread:

```bash
cgpt delete <plan-slug>-initial-review
```

## Phase implementation units

When a phase already has reported subparts, use them in order without independently rescoping them. Each existing subpart is one implementation unit.

When the initial review returns a phase with no subparts, skip any separate segmentation pass and treat the whole phase as one implementation unit.

## Implementation

For each implementation unit, substitute its existing subpart identifier or its whole-phase identifier for `<unit>`:

```bash
cgpt new <plan-slug>-phase-<unit> \
  --message "@dev-nt Review the implementation plan at <absolute-plan-path> and the current repository state, then implement only Phase <unit>. Follow the plan and project instructions, retain appropriate existing scaffolding, update completion tracking for this implementation unit, and run relevant validation. Do not implement later subparts or phases. Do not commit yet. Report exactly what changed, validation results, whether the implementation unit is complete, and any blocking issue." \
  --thinking high
```

Accept ChatGPT's response without independently inspecting the work. If it reports an incomplete implementation unit, unresolved validation, or any blocker, preserve the thread and stop.

When ChatGPT reports the implementation unit is complete, commit the work directly:

```bash
# Inspect what changed
git status --short
git diff --stat
```

Stage all files changed by this implementation unit, excluding pre-existing baseline-untracked paths and the plan file when it was a pre-existing untracked file. Include the plan completion-tracking update only if the plan was tracked before this workflow began.

```bash
git add <file1> <file2> ...
git commit -m "<plan-slug>: implement Phase <unit>"
```

Stop on a commit failure. Otherwise record the hash and delete the thread:

```bash
cgpt delete <plan-slug>-phase-<unit>
```

After the phase's final implementation unit, complete the whole-phase audit before any later phase work.

## Whole-phase audit

```bash
cgpt new <plan-slug>-phase-<phase>-audit \
  --message "@dev-nt Review the implementation plan at <absolute-plan-path> and the current repository state. Verify that every requirement in all of Phase <phase>, including every subpart, is implemented and validated. Finish any missing, incomplete, inconsistent, or falsely marked-complete work and run relevant validation. Do not implement later phases. Do not commit yet. Report whether you changed anything, exactly what changed, whether the full phase is complete, validation results, and any blocking issue." \
  --thinking high
```

Accept the response without independently inspecting the work. Stop and preserve the thread if the phase is incomplete, validation remains unresolved, or any blocker exists.

If no changes were needed, record the result and delete the thread. If ChatGPT reports changes were made, commit them directly:

```bash
# Inspect what changed
git status --short
git diff --stat
```

Stage only files added or modified during the audit, following the same exclusion rules as implementation-unit commits:

```bash
git add <file1> <file2> ...
git commit -m "<plan-slug>: Phase <phase> completion-audit"
```

Stop on a commit failure. Otherwise record any commit hash and delete the audit thread:

```bash
cgpt delete <plan-slug>-phase-<phase>-audit
```

## Post-phase remaining-plan review

After every main phase audit succeeds, review the phases that remain in the current plan before starting any of them:

```bash
cgpt new <plan-slug>-after-phase-<phase>-review \
  --message "@dev-nt Review the implementation plan at <absolute-plan-path> after completion of Phase <phase>. Do not implement anything. Review all remaining phases and determine whether concrete findings, constraints, integration effects, or risks revealed by the completed phase require changes to their scope, sequencing, boundaries, or validation. Do not make adjustments merely to rewrite, optimize, or second-guess the plan; change it only when a specific cause from the implementation justifies the change. Preserve unaffected plan content. Update completion tracking only when necessary for justified plan changes. Return the ordered remaining phases and subparts, explain each concern and its concrete cause, state exactly whether you modified the plan, and report any blocking issue. If no phases remain, explicitly report that and make no changes." \
  --thinking high
```

If ChatGPT reports a blocker, stop. If it reports plan edits, inspect only the plan document and verify that every edit has the stated concrete cause and that unaffected content was preserved. Do not ask ChatGPT to commit planning edits. Send a corrective follow-up if the changes are missing, unjustified, or materially inconsistent with the prompt; stop if they remain inadequate.

Replace the remaining workflow state with the returned ordered phases and subparts, then delete the review thread:

```bash
cgpt delete <plan-slug>-after-phase-<phase>-review
```

Only then may the workflow advance to the next main phase or, when none remain, the next supplied plan.

## Blocking conditions

Blocking conditions include:

- an explicit blocker or unresolved prerequisite;
- a phase or existing subpart ChatGPT cannot complete safely;
- unresolved required validation;
- a failed or non-isolatable commit;
- CLI, browser, authentication, verification, configuration, or queue failure;
- `needs_attention` or another unresolved terminal error;
- plan ambiguity that remains after a requested planning pass.

On a blocker, stop all execution, preserve the active thread and run information, and use `chatgpt-proxy` diagnostics only for delegation-system failures. Report the plan, phase or subpart, thread name, run ID when available, and ChatGPT's explanation to the user.

## Completion report

After all plans finish, report only what ChatGPT reported: plans processed, completed phases and subparts, and commit hashes. Do not add an independent quality assessment or claim manual verification.
