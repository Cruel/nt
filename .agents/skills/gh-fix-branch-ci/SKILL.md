---
name: gh-fix-branch-ci
description: Fix failing GitHub Actions CI for the currently checked-out branch by inspecting push-triggered runs with gh, repairing failures, committing and pushing isolated fixes, and repeating until the exact pushed HEAD is green. Use only when the user explicitly asks to fix current-branch CI; do not create or use a pull request.
---

# Fix Current Branch CI

Use this skill when the user explicitly asks to get GitHub Actions CI passing on the currently checked-out branch. This is a direct branch-push workflow, not a pull-request workflow.

The invocation authorizes the complete repair loop: inspect the current branch's push run, diagnose failures, implement the smallest coherent fixes, validate locally, commit only the repair, push the current branch, wait for the new run, and repeat until CI is green or a concrete blocker remains. Do not pause merely to request approval for the repair plan.

## Non-negotiable rules

- Operate only on the currently checked-out branch. Do not create, switch, merge, rebase, amend, or force-push branches unless the user explicitly asks.
- Do not create or inspect a PR, and do not use `gh pr` commands.
- Treat push-triggered GitHub Actions runs for the exact remote branch SHA as the source of truth. Do not substitute an older run from the same branch.
- Do not manually dispatch a workflow merely to obtain CI. The repository's workflow is expected to trigger on push.
- Capture the initial worktree status before changing anything. Never stage, alter, discard, or commit pre-existing unrelated changes or untracked paths.
- If a necessary fix overlaps a file that was already dirty at baseline, stop and report the overlap unless the user explicitly authorizes including that existing work.
- Keep commits narrowly scoped to CI repairs. Use explicit pathspecs when staging and verify the staged diff before every commit.
- Preserve successful behavior and test coverage. Do not weaken, skip, or delete a failing check merely to make CI green unless the failure proves the check is invalid and the correction remains equivalent or stronger.
- Do not claim success until every applicable push-triggered GitHub Actions run for the exact pushed HEAD has completed successfully. A missing, stale, queued, or in-progress run is not green.

## Prerequisites

- `gh` and `git` are available.
- `gh auth status` succeeds for the repository host with repository and workflow access.
- The current checkout is on a named branch with a push remote.

## Bundled inspector

Prefer the bundled inspector because it matches runs to the exact pushed SHA and extracts failed-job context:

```bash
python3 "<path-to-skill>/scripts/inspect_branch_ci.py" --repo "."
```

Add `--json` for machine-readable output. By default the script inspects the current branch's upstream remote-tracking SHA; pass `--sha "$(git rev-parse HEAD)"` after pushing when exact local-HEAD matching is required.

Exit status:

- `0`: all matching runs completed successfully.
- `1`: one or more matching runs failed.
- `2`: no exact-SHA run exists yet, or a matching run is still queued/in progress.
- `3`: local setup, authentication, repository, or command failure.

## Workflow

### 1. Establish an immutable baseline

Record:

```bash
git status --short --untracked-files=all
git branch --show-current
git rev-parse HEAD
git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'
git rev-parse '@{upstream}'
gh auth status
gh repo view --json nameWithOwner,url
```

Keep the exact baseline-dirty path set for the entire repair session. Later commits must exclude those paths unless the user explicitly authorizes an overlap.

If the checkout is detached, has no push remote, or authentication fails, stop with the exact remediation needed.

### 2. Inspect the newest pushed state

Run the bundled inspector without `--sha` first. It resolves the upstream remote-tracking SHA, which avoids accidentally looking for an unpushed local commit.

Manual fallback:

```bash
branch="$(git branch --show-current)"
remote_sha="$(git rev-parse '@{upstream}')"
gh run list \
  --branch "$branch" \
  --event push \
  --limit 50 \
  --json databaseId,workflowName,status,conclusion,headBranch,headSha,url,createdAt,updatedAt
```

Filter to `headBranch == branch` and `headSha == remote_sha`. Inspect every matching push workflow, not merely the first list entry.

For each failed run:

```bash
gh run view <run-id> --json databaseId,workflowName,status,conclusion,headBranch,headSha,url,event,jobs
gh run view <run-id> --log-failed
```

When a whole-run log is unavailable, fetch the failed job directly:

```bash
gh run view <run-id> --job <job-id> --log
gh api "/repos/<owner>/<repo>/actions/jobs/<job-id>/logs"
```

Identify the first actionable failure in each job, then determine whether several failed jobs share one root cause. Skipped dependent jobs are consequences, not independent failures.

### 3. Implement the smallest coherent repair

- Read the applicable repository instructions and subsystem documentation before editing.
- Reproduce the failure locally when practical using the narrowest equivalent command.
- Fix the root cause rather than the final cascading error.
- Run the narrowest relevant local validation first, followed by any broader check needed for confidence.
- Keep CI-only platform fixes portable; do not assume the local host reproduces Windows, macOS, Android, or Web behavior exactly.

Report the diagnosed jobs, root cause, files being changed, and local validation as work progresses, but continue without a separate approval gate.

### 4. Commit only the repair

Before committing:

```bash
git status --short --untracked-files=all
git diff -- <repair-paths>
git diff --cached --stat
git diff --cached --check
```

Stage only explicit repair paths. Verify that no baseline-dirty unrelated path entered the index. Use a focused commit message, normally `fix(ci): <root cause>` or a more accurate subsystem-scoped equivalent.

Do not commit an empty change and do not include generated build output.

### 5. Push and bind CI to the exact SHA

Push the current branch normally:

```bash
git push
sha="$(git rev-parse HEAD)"
branch="$(git branch --show-current)"
```

Poll `gh run list --branch "$branch" --event push` until at least one run appears with `headSha == sha`. Do not accept the previous SHA's run. If no exact-SHA run appears, inspect the workflow's `on.push` branch/path filters and report the trigger mismatch as a blocker; do not open a PR or use `workflow_dispatch` as a workaround.

### 6. Wait for completion

For every run matching the exact pushed SHA:

```bash
gh run watch <run-id> --exit-status
```

The repository may cancel an older run when a newer push starts. Ignore only runs proven superseded by a newer exact branch SHA. A cancellation on the current exact SHA remains a failure requiring diagnosis.

After waiting, rerun:

```bash
python3 "<path-to-skill>/scripts/inspect_branch_ci.py" --repo "." --sha "$sha"
```

### 7. Repeat until green

When CI still fails, repeat diagnosis, repair, local validation, isolated commit, push, exact-SHA discovery, and waiting. Each cycle should address current evidence; do not stack speculative fixes.

When logs show a credible GitHub-hosted runner, network, package-registry, or service outage with no repository defect, one failed-job rerun is permitted:

```bash
gh run rerun <run-id> --failed
gh run watch <run-id> --exit-status
```

Do not repeatedly rerun deterministic failures.

## Completion criteria

The task is complete only when:

- the current branch's local HEAD equals the pushed remote branch HEAD;
- every applicable push-triggered GitHub Actions run for that exact SHA is completed;
- every such run has a successful conclusion;
- local validation results are recorded;
- all repair commit hashes and the final run URLs are reported;
- unrelated baseline changes remain untouched.

On a blocker, report the branch, local HEAD, pushed SHA, run and failed-job URLs, exact failure evidence, attempted validation, repair commits already pushed, and the remaining blocker.
