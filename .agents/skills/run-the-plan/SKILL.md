---
name: run-the-plan
description: Execute supplied phased implementation plans through sequential ChatGPT delegation, per-unit commits, and phase audits. Use only when the user explicitly requests `run-the-plan`.
---

# Run the Plan

Require at least one implementation-plan path. Read and follow `chatgpt-proxy` first; it owns `cgpt` lifecycle, timeout recovery, diagnostics, and thread deletion.

## Operating rules

- Work on one plan, phase, implementation unit, command, and ChatGPT thread at a time. Complete a plan before beginning the next.
- Use `cgpt` for every delegation. Use `--thinking medium` for implementation and `--thinking high` for plan reviews and audits, unless the user specifies otherwise.
- Prefix every `cgpt new` message with `@dev-nt `. Do not prefix `cgpt chat` messages.
- Create a fresh thread for every plan review, implementation unit, and phase audit. Use follow-ups only to correct the plan review that created that thread.
- Treat an existing subpart as one implementation unit. If a phase has no subparts, treat the entire phase as one unit. Never create a new segmentation pass or rescope units yourself.
- Run a whole-phase audit only when the completed main phase had existing subparts. Do not audit a main phase implemented as one whole-phase unit.
- Do not inspect source, tests, detailed diffs, or implementation quality. Inspect only the plan document when this workflow asks you to, plus changed-file paths and diff statistics needed for staging.
- Do not repair, validate, or second-guess ChatGPT's work. Trust its completion and validation reports for workflow decisions.
- On any blocker, stop the entire workflow, preserve the active thread and run information, and report it. Do not skip, retry blindly, create a replacement thread, or commit partial work.

## Establish state

For each plan, resolve an absolute plan path and its repository root. Derive a unique, shell-safe `<plan-slug>` from the plan filename (lowercase letters, digits, and hyphens); add a numeric suffix if necessary. Use stable identifiers for `<phase>` and `<unit>` in thread names; normalize them the same way and include their ordinal when names could collide.

Before the first delegation for each repository, record its baseline once:

```bash
git -C <repository-root> status --short --untracked-files=all
```

Record every baseline `??` path. Never stage one of those paths unless ChatGPT created it during this workflow. Never commit the plan file when it was untracked at baseline. A tracked plan file may be committed with the unit or audit that updates its completion tracking.

Keep this minimal workflow state outside ChatGPT: plan path, repository root, baseline-untracked paths, ordered phases and subparts, current thread/run, and commit hashes.

## For each plan

### 1. Normalize the plan

```bash
cgpt new <plan-slug>-initial-review \
  --message "@dev-nt Review the implementation plan at <absolute-plan-path>. Do not implement it. Verify that its main phases or stages are clear, ordered, and have explicit completion tracking. Modify the plan only where needed to correct inadequate phase structure or tracking. Return the ordered main phases and existing subparts, whether you modified the plan, and any blocking issue." \
  --thinking high
```

If a blocker is reported, stop. If edits are reported, inspect only the plan document. Confirm the reported edits exist and meet the prompt. If not, use one or more corrective follow-ups in the same thread; stop if the plan remains inadequate. Capture the returned ordered structure, then delete the completed thread.

### 2. Implement every unit in the current phase

For each existing subpart in order, or once for a phase without subparts:

```bash
cgpt new <plan-slug>-phase-<unit> \
  --message "@dev-nt Review the implementation plan at <absolute-plan-path> and the current repository state, then implement only Phase <unit>. Follow the plan and project instructions, retain appropriate existing scaffolding, update completion tracking for this implementation unit, and run relevant validation. As implementation reveals concrete constraints, integration effects, assumptions, or risks that affect later phases, record them in the plan immediately. Modify later phase scope, sequencing, boundaries, or validation only when a direct finding from this implementation makes the existing plan inaccurate or impractical; preserve unaffected content and do not make speculative or preference-only revisions. When a downstream finding can be resolved by a precise later-phase requirement or validation gate, record that change and continue. Report it as a blocker only when it leaves the current unit or remaining implementation unsafe, ambiguous, or not executable. Before reporting completion, verify every requirement assigned to this implementation unit and every applicable exit gate. Do not implement later subparts or phases. Do not commit. Report exactly what changed, validation results, whether the implementation unit is complete, every plan change and its concrete implementation cause, and any blocking issue." \
  --thinking medium
```

If ChatGPT reports incompleteness, unresolved validation, or a blocker, preserve the thread and stop. Otherwise commit only this unit's changes:

```bash
git -C <repository-root> status --short
git -C <repository-root> diff --stat
git -C <repository-root> add <unit-files...>
git -C <repository-root> commit -m "<plan-slug>: implement Phase <unit>"
```

Select `<unit-files...>` from the reported changed paths, excluding baseline-untracked paths and an untracked-at-baseline plan. Stop if the commit fails. Record its hash, then delete the thread.

### 3. Audit a completed phase with subparts only

Skip this step entirely when the main phase had no existing subparts; its single implementation unit is its only implementation pass. Do not create an audit thread to re-review that whole-phase unit.

```bash
cgpt new <plan-slug>-phase-<phase>-audit \
  --message "@dev-nt Review the implementation plan at <absolute-plan-path> and the current repository state. Verify that every requirement in all of Phase <phase>, including every subpart and the phase exit gate, is implemented and validated. Finish any missing, incomplete, inconsistent, or falsely marked-complete work and run relevant validation. Also verify that concrete findings from the phase were accurately reflected in the remaining plan and that no unjustified downstream changes were made. If a downstream implication remains unresolved and leaves the remaining implementation unsafe, ambiguous, or not executable, report it as a blocking issue. Do not implement later phases or commit. Report whether you changed anything, exactly what changed, whether the full phase is complete, validation results, and any blocking issue." \
  --thinking high
```

If the phase is incomplete, validation is unresolved, or a blocker exists, preserve the thread and stop. If changes were made, stage only paths reported for this audit, applying the same exclusions, and commit:

```bash
git -C <repository-root> status --short
git -C <repository-root> diff --stat
git -C <repository-root> add <audit-files...>
git -C <repository-root> commit -m "<plan-slug>: Phase <phase> completion-audit"
```

Stop on commit failure. Record any hash and delete the audit thread.

## Blocking and completion

Block on an explicit blocker, an incomplete unit or phase, unresolved required validation, failed or non-isolatable commit, delegation-system failure, `needs_attention`, or plan ambiguity that persists after correction. For delegation-system failures, use only the diagnostics specified by `chatgpt-proxy` and then halt.

After every supplied plan completes, report only ChatGPT's reported completion and validation, the plans/phases/subparts processed, and commit hashes. Do not provide an independent quality assessment or claim manual verification.
