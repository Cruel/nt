---
name: run-the-plan
description: Execute one or more phased implementation plans by delegating planning and implementation work to ChatGPT. Use this only when requested explicitly by name.
---

# Run the Plan

Use this skill only when the user explicitly requests `run-the-plan` or clearly asks to execute an implementation plan through this workflow. At least one implementation-plan path is required.

Read and follow the `chatgpt-proxy` skill first. It governs thread creation, follow-ups, status polling, timeout recovery, errors, and deletion.

## Core rules

- Process plans, phases, subparts, threads, and commands strictly sequentially. Never pre-create or overlap work.
- Finish the complete workflow for one plan before starting another.
- Use `cgpt` for every delegation. Wait until each run reaches a terminal status; an intermediate timeout or lack of output is not completion.
- Use `--thinking high` for every `new` and substantive `chat` command unless the user requests otherwise. Use `--thinking instant` when a follow-up only asks ChatGPT to commit already-completed work.
- Prefix every initial `new` message with `@dev-nt `. Follow-up `chat` messages do not need the prefix.
- Use a fresh thread for each initial plan review, phase segmentation, implementation subpart, whole-phase audit, and post-phase remaining-plan review.
- Implement only one subpart per implementation thread.
- Do not manually inspect or audit implementation files, diffs, tests, commits, or ChatGPT's implementation claims. Do not independently repair, complete, or validate delegated work.
- The only permitted manual inspection is of the supplied plan document after ChatGPT reports planning edits.
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
2. For each main phase, determine or create its ordered subparts.
3. Implement and commit each subpart in its own thread.
4. Audit and, if necessary, finish and commit the whole phase.
5. Review the remaining phases in light of what the completed phase revealed, changing the plan only when a concrete cause justifies it.
6. Continue to the next phase, then the next supplied plan.

Delete each successfully completed thread before creating the next one.

## Initial plan review

```bash
cgpt new <plan-slug>-initial-review \
  --message "@dev-nt Review the implementation plan at <absolute-plan-path>. Do not implement it. Verify that its main phases or stages are clear and ordered for implementation, and that it has explicit completion tracking for phases and subparts. Update the plan only where needed to correct inadequate structure or tracking. Return the ordered main phases, identify existing subparts such as 1A and 1B, state whether you modified the plan, and report any blocking issue." \
  --thinking high
```

Use the returned phase and subpart structure as workflow state. If ChatGPT reports a blocker, stop.

When ChatGPT reports plan edits, inspect only the plan document and verify that the reported changes exist and satisfy the prompt. Do not ask ChatGPT to commit planning edits. If the edits are missing or materially inadequate, send a corrective follow-up in the same thread, inspect the plan again, and stop as blocked if it remains inadequate.

Delete the completed review thread:

```bash
cgpt delete <plan-slug>-initial-review
```

## Phase subparts

When a phase already has reported subparts, use them in order without independently rescoping them.

When a phase has no subparts, create a segmentation thread:

```bash
cgpt new <plan-slug>-phase-<phase>-segmentation \
  --message "@dev-nt Review the implementation plan at <absolute-plan-path>, focusing only on Phase <phase>. Do not implement it. Divide the phase into ordered subparts that each fit one GPT-5.6 Sol implementation prompt. Keep the split practical rather than overly granular. Resolve ambiguities, missing decisions, unclear boundaries, and sequencing problems that could impede implementation. Update the plan and completion tracking. Return the ordered subparts and report any blocking issue." \
  --thinking high
```

If ChatGPT reports a blocker, stop. Otherwise inspect only the plan document to verify the segmentation, clarified boundaries, resolved ambiguities, and tracking updates. Do not ask ChatGPT to commit planning edits. Use a corrective follow-up if needed, and stop if the plan remains inadequate.

Record the returned subparts and delete the segmentation thread:

```bash
cgpt delete <plan-slug>-phase-<phase>-segmentation
```

## Subpart implementation

For each subpart:

```bash
cgpt new <plan-slug>-phase-<subpart> \
  --message "@dev-nt Review the implementation plan at <absolute-plan-path> and the current repository state, then implement only Phase <subpart>. Follow the plan and project instructions, retain appropriate existing scaffolding, update completion tracking for this subpart, and run relevant validation. Do not implement later subparts or phases. Do not commit yet. Report exactly what changed, validation results, whether the subpart is complete, and any blocking issue." \
  --thinking high
```

Accept ChatGPT's response without independently inspecting the work. If it reports an incomplete subpart, unresolved validation, or any blocker, preserve the thread and stop.

When the subpart is complete, commit in the same thread:

```bash
cgpt chat <plan-slug>-phase-<subpart> \
  --message "Commit the completed Phase <subpart> implementation. Commit only files added or modified for this subpart. Include the plan completion-tracking update only if the plan was tracked before this workflow began. Do not add or commit the plan when it is a pre-existing untracked file. Do not commit these pre-existing baseline-untracked paths: <baseline-untracked-paths-or-none>. Exclude unrelated changes. Report the commit hash and any blocking issue." \
  --thinking instant
```

Stop on a commit failure or blocker. Otherwise record the hash and delete the thread:

```bash
cgpt delete <plan-slug>-phase-<subpart>
```

After the final subpart, complete the whole-phase audit before any later phase work.

## Whole-phase audit

```bash
cgpt new <plan-slug>-phase-<phase>-audit \
  --message "@dev-nt Review the implementation plan at <absolute-plan-path> and the current repository state. Verify that every requirement in all of Phase <phase>, including every subpart, is implemented and validated. Finish any missing, incomplete, inconsistent, or falsely marked-complete work and run relevant validation. Do not implement later phases. Do not commit yet. Report whether you changed anything, exactly what changed, whether the full phase is complete, validation results, and any blocking issue." \
  --thinking high
```

Accept the response without independently inspecting the work. Stop and preserve the thread if the phase is incomplete, validation remains unresolved, or any blocker exists.

If no changes were needed, record the result and delete the thread. If ChatGPT made changes, commit them first:

```bash
cgpt chat <plan-slug>-phase-<phase>-audit \
  --message "Commit the Phase <phase> completion-audit changes. Commit only files added or modified while finishing this phase. Include the plan completion-tracking update only if the plan was tracked before this workflow began. Do not add or commit the plan when it is a pre-existing untracked file. Do not commit these pre-existing baseline-untracked paths: <baseline-untracked-paths-or-none>. Exclude unrelated changes. Report the commit hash and any blocking issue." \
  --thinking instant
```

Stop on a commit failure or blocker. Otherwise record any commit hash and delete the audit thread:

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
- a phase or subpart ChatGPT cannot complete safely;
- unresolved required validation;
- a failed or non-isolatable commit;
- CLI, browser, authentication, verification, configuration, or queue failure;
- `needs_attention` or another unresolved terminal error;
- plan ambiguity that remains after a requested planning pass.

On a blocker, stop all execution, preserve the active thread and run information, and use `chatgpt-proxy` diagnostics only for delegation-system failures. Report the plan, phase or subpart, thread name, run ID when available, and ChatGPT's explanation to the user.

## Completion report

After all plans finish, report only what ChatGPT reported: plans processed, completed phases and subparts, and commit hashes. Do not add an independent quality assessment or claim manual verification.
