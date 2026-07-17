---
name: run-the-plan
description: Execute one or more phased implementation plans by delegating planning and implementation work to ChatGPT. Use only when explicitly requested.
---

# Run the Plan

Use this skill only when the user explicitly requests `run-the-plan` or clearly asks to execute an implementation plan using this workflow.

This skill requires at least one implementation-plan document. Do not invoke it without a plan path. When multiple plan documents are provided, process them sequentially: finish the complete workflow for the first document before starting the next.

Read and follow the `chatgpt-proxy` skill before beginning. Use that skill for thread creation, follow-up messages, timeout recovery, error handling, and thread deletion.

## Non-negotiable rules

- Perform the entire workflow strictly sequentially. Never run plan reviews, segmentation, implementations, commits, phases, subparts, plans, or ChatGPT threads concurrently.
- Wait for the current ChatGPT command and thread to complete before issuing the next command. Do not skip ahead, pre-create later threads, or begin later work while an earlier phase or subpart is still running.
- Use `--thinking high` for every `new` and `chat` command unless the user explicitly requests a different level.
- Prefix every initial `new` thread message with `@dev-nt `. Follow-up `chat` messages do not need this prefix.
- Create a fresh ChatGPT thread for each initial plan review, phase-segmentation task, implementation subpart, and whole-phase completion audit.
- Do not manually review or audit ChatGPT's implementation work, diffs, tests, or commits. Rely on ChatGPT's responses.
- Do not independently repair, complete, or validate the implementation.
- If ChatGPT reports a blocking issue, stop the entire workflow immediately. Do not force progress, skip the issue, create a replacement thread, or move to another phase or plan.
- Do not implement more than one subpart in a single implementation thread.
- Do not proceed to a later main phase until every subpart of the current phase has been implemented and committed, and the whole-phase completion audit has finished successfully.

## Establish the target repository

Resolve the repository containing each supplied implementation plan. Use absolute plan paths in every ChatGPT prompt so the referenced document is unambiguous.

Before sending any ChatGPT request for a repository, record its initial untracked files:

```bash
git -C <repository-root> status --short --untracked-files=all
```

Preserve the exact baseline set of paths marked `??`, especially untracked documentation and implementation-plan files. These files existed before this workflow began and must not be included in commits unless ChatGPT itself created them during this workflow.

Keep this baseline list for every later commit prompt in that repository. Do not infer the list again after work starts, because newly created files must remain distinguishable from pre-existing untracked files.

## CLI command

Use the `cgpt` wrapper executable for every ChatGPT delegation command.
ChatGPT CLI runs can take 30 minutes or longer to finish, so use longer timeout values for your bash/shell tooling if needed. Keep polling or retrying the run-status operation as needed until it reaches a terminal status; do not treat an intermediate timeout or lack of immediate output as completion.

## Workflow overview

For each implementation plan, perform these stages in order:

1. Ask ChatGPT to review and normalize the plan structure.
2. Process each main phase in implementation order.
3. Ensure the current phase has appropriately sized subparts.
4. Implement each subpart in a fresh thread.
5. Ask ChatGPT to commit that subpart in the same thread.
6. Delete the completed thread.
7. After the final subpart, ask ChatGPT in a fresh thread to verify the entire phase and finish any remaining work.
8. If the phase audit required changes, ask ChatGPT to commit those changes in the same thread.
9. Delete the completed phase-audit thread.
10. Move to the next main phase.
11. After every phase in the current plan is complete, start the next supplied plan.

Each numbered stage must finish before the next begins. There is never more than one active plan-execution thread or command at a time.

## Initial plan review

Create a fresh thread for the plan review. The initial message must begin with `@dev-nt`:

```bash
cgpt new <plan-slug>-initial-review \
  --message "@dev-nt Review the implementation plan at <absolute-plan-path>. Do not implement the plan. Verify that it is organized into clear main phases or stages in implementation order. Verify that it contains an explicit section or checklist tracking completed phases and subparts. If either structure is missing or inadequate, update the plan to add it. Return the ordered list of main phases and identify which phases already have subparts such as 1A, 1B, and so on. Report whether you modified the plan and report any blocking issue." \
  --thinking high
```

Use the ordered phase and subpart information in ChatGPT's response as the workflow state.

If ChatGPT reports a blocker, stop immediately and report it to the user. Preserve the thread according to the `chatgpt-proxy` skill.

If ChatGPT says it modified the plan, directly inspect only the supplied plan document and verify that the reported structural edits actually exist and match the request. This is the sole exception to the rule against manually checking ChatGPT's work.

Do not ask ChatGPT to commit plan-review edits. Planning documents are commonly baseline-untracked files and must remain uncommitted unless a later explicit user instruction says otherwise.

If the expected plan edits are missing or materially different from what ChatGPT reported, send a follow-up in the same thread identifying the discrepancy and asking ChatGPT to correct the plan. Wait for that response, inspect the plan document again, and stop as blocked if the requested structure still is not present.

After the plan structure has been verified, delete the completed review thread:

```bash
cgpt delete <plan-slug>-initial-review
```

If ChatGPT reports that no plan changes were needed, delete the review thread after recording the reported phase structure.

## Main phase loop

Process the main phases in the exact implementation order reported by ChatGPT. For every new main phase, begin with the subpart decision below.

### Phase without subparts

When ChatGPT reports that a main phase has no subparts such as `1A`, `1B`, and so on, create a fresh segmentation thread before implementation:

```bash
cgpt new <plan-slug>-phase-<phase>-segmentation \
  --message "@dev-nt Review the implementation plan at <absolute-plan-path>, focusing only on Phase <phase>. Do not implement it. Segment this phase into ordered subparts sized so that each subpart can be completed in a single GPT-5.6 Sol implementation prompt. Keep the split practical and not overly granular. Eliminate ambiguities, missing decisions, unclear boundaries, and sequencing problems that could impede implementation. Update the plan and its completion-tracking section accordingly. Return the ordered subparts and report any blocking issue." \
  --thinking high
```

If ChatGPT reports a blocker, stop immediately.

When ChatGPT reports that segmentation succeeded, directly inspect only the supplied plan document. Verify that the requested ordered subparts, clarified boundaries, resolved ambiguities, and completion-tracking updates are present. This plan-document check is permitted; do not inspect implementation files or other work.

Do not ask ChatGPT to commit segmentation or other planning-document edits.

If the expected edits are missing or inadequate, send a follow-up in the same segmentation thread describing the discrepancy and asking ChatGPT to correct it. Wait for completion, inspect the plan again, and stop as blocked if the requested phase structure still is not present.

After verification, record the ordered subparts from ChatGPT's response and delete the segmentation thread:

```bash
cgpt delete <plan-slug>-phase-<phase>-segmentation
```

### Phase with existing subparts

When ChatGPT reports that the phase already has subparts, use those subparts in the reported order. Do not independently revise their scope or add another segmentation pass.

## Subpart implementation loop

For each subpart in the current phase, create a new thread. The initial message must begin with `@dev-nt` and must reference the implementation plan explicitly:

```bash
cgpt new <plan-slug>-phase-<subpart> \
  --message "@dev-nt Review the implementation plan at <absolute-plan-path> and the current repository state, then implement only Phase <subpart>. Follow all plan constraints and existing project instructions. Identify and retain appropriate existing scaffolding, update the plan's completion tracking for this subpart, and run the relevant validation. Do not implement later subparts or phases. Do not commit yet. Report exactly what you changed, what validation passed or failed, whether the subpart is complete, and any blocking issue." \
  --thinking high
```

Accept ChatGPT's response as the implementation result. Do not inspect the repository, diff, tests, or plan to verify it.

If ChatGPT says the subpart is incomplete or reports any blocking issue, stop immediately. Preserve the thread and report the blocker to the user. Do not ask ChatGPT to commit partial work unless the user later gives explicit instructions.

When ChatGPT reports that the subpart is complete, ask it to commit the work in the same thread:

```bash
cgpt chat <plan-slug>-phase-<subpart> \
  --message "Commit the completed Phase <subpart> implementation work. Commit only files you added or modified for this subpart. Include the plan completion-tracking update only if that plan document was already tracked before this workflow began. Do not add or commit the implementation plan when it is one of the pre-existing untracked files. Do not commit any pre-existing untracked files from the workflow baseline: <baseline-untracked-paths-or-none>. Do not include unrelated changes. Report the commit hash and any blocking issue." \
  --thinking high
```

If ChatGPT reports a commit failure or any other blocker, stop immediately and preserve the thread.

After ChatGPT reports a successful commit, record the reported commit hash and delete the completed thread:

```bash
cgpt delete <plan-slug>-phase-<subpart>
```

Then continue to the next subpart. After the final subpart of a main phase is committed, perform the whole-phase completion audit below. Do not return to the main phase loop until that audit has completed successfully.

## Whole-phase completion audit

After every subpart of the current main phase has been implemented and committed, create a fresh thread to verify the phase as a whole. Do this before starting the next main phase. The initial message must begin with `@dev-nt`:

```bash
cgpt new <plan-slug>-phase-<phase>-audit \
  --message "@dev-nt Review the implementation plan at <absolute-plan-path> and the current repository state. Verify that every requirement in the entirety of Phase <phase>, including all of its subparts, has actually been implemented and validated. If anything is missing, incomplete, inconsistent, or only marked complete without being implemented, finish it now and run the relevant validation. Do not implement later phases. Do not commit yet. Report whether you had to make changes, exactly what you changed, whether the full phase is complete, what validation passed or failed, and any blocking issue." \
  --thinking high
```

Accept ChatGPT's response as the phase-audit result. Do not inspect the implementation, diff, tests, or repository to verify it.

If ChatGPT says the phase is incomplete, required validation remains unresolved, or any blocking issue exists, stop immediately. Preserve the phase-audit thread and report the blocker to the user.

If ChatGPT reports that the full phase is complete and no changes were required, record that result and delete the phase-audit thread:

```bash
cgpt delete <plan-slug>-phase-<phase>-audit
```

If ChatGPT reports that it made changes to finish the phase, ask it to commit those changes in the same thread:

```bash
cgpt chat <plan-slug>-phase-<phase>-audit \
  --message "Commit the Phase <phase> completion-audit changes you just made. Commit only files you added or modified while finishing this phase. Include the plan completion-tracking update only if that plan document was already tracked before this workflow began. Do not add or commit the implementation plan when it is one of the pre-existing untracked files. Do not commit any pre-existing untracked files from the workflow baseline: <baseline-untracked-paths-or-none>. Do not include unrelated changes. Report the commit hash and any blocking issue." \
  --thinking high
```

If ChatGPT reports a commit failure or any other blocker, stop immediately and preserve the thread. After it reports a successful commit, record the commit hash and delete the phase-audit thread:

```bash
cgpt delete <plan-slug>-phase-<phase>-audit
```

Only after the phase-audit thread has completed successfully and been deleted may the workflow advance to the next main phase.

## Multiple implementation plans

When multiple plan documents were supplied, do not interleave them. Complete all phases and subparts of the current plan, including every requested commit, before performing the initial review for the next plan.

Never start work on the next plan while any review, segmentation, implementation, commit, recovery operation, or thread from the current plan remains active.

Use a separate baseline-untracked list for each repository. If multiple plans belong to the same repository, retain the original baseline captured before the first plan and continue excluding those paths throughout the entire multi-plan job.

## Blocking conditions

Treat any of the following as blocking:

- ChatGPT explicitly reports a blocker or unresolved prerequisite.
- ChatGPT says a phase or subpart cannot be completed safely.
- Required validation fails and ChatGPT does not resolve it.
- A commit fails or ChatGPT cannot isolate the correct changes.
- The CLI, browser, authentication, verification, configuration, or queue fails.
- A run enters `needs_attention` or another unresolved terminal error state.
- Plan ambiguity remains after the requested segmentation or clarification pass.

On a blocker:

1. Stop all plan execution immediately.
2. Do not start another thread, subpart, phase, or plan.
3. Do not retry the same prompt blindly.
4. Preserve the active thread and run information.
5. Use the diagnostic behavior from the `chatgpt-proxy` skill only when the blocker is a delegation-system error.
6. Report the blocker, current plan, current phase or subpart, active thread name, run ID when available, and ChatGPT's explanation to the user.

## Completion report

After all supplied plans are complete, report completion based only on ChatGPT's responses. Include the plans processed, phases and subparts reported complete, and commit hashes reported by ChatGPT.

Do not add an independent quality assessment or claim to have manually verified the implementation.
