---
name: chatgpt-proxy
description: Delegate a complex task to ChatGPT through the local cgpt CLI. Use this skill only when the user explicitly asks to use ChatGPT.
---

# ChatGPT Task Delegation

Use this skill only when the user explicitly asks to use ChatGPT, delegate to ChatGPT, ask ChatGPT to perform a task, or otherwise clearly requests this delegation path.

Do not invoke this skill merely because a task is difficult, lengthy, or suitable for another agent. Without an explicit request to use ChatGPT, handle the task normally or use another appropriate skill.

Use the `cgpt` wrapper executable for all delegation commands.

## Required lifecycle

Treat each complex delegated task as a temporary, self-contained ChatGPT thread:

1. Choose a unique, descriptive thread name.
2. Create the thread with the complete initial task.
3. Continue in the same thread until the task is genuinely complete.
4. Inspect or recover the durable run when a timeout or interruption occurs; never blindly resubmit.
5. Report the useful result accurately.
6. Delete the local thread after the task is complete.
7. Use diagnostics only when an error blocks the workflow; then halt and report the blocker.

Do not reuse an unrelated existing thread just to avoid creating a new one. A fresh task should normally receive a fresh thread so its context remains focused and disposable.

## Complete task workflow

### 1. Create a new task thread

Choose a short, unique name derived from the task:

```bash
cgpt new renderer-phase-8a \
  --message "Review the implementation plan and current repository state. Verify Phase 8A is complete, finish any missing work, preserve existing constraints, and run the relevant validation. Do not stage or commit changes." \
  --thinking high
```

The default behavior is to submit the durable run, poll it internally, and print the final response when it completes.

The initial prompt should include:

- the repository or working directory;
- the exact requested outcome;
- relevant files, plans, logs, or errors;
- constraints and architectural requirements;
- expected validation;
- whether staging or commits are permitted.

Use `--thinking high` for complex implementation, architecture, debugging, or repository-wide review. Use `medium` for focused ordinary work and `instant` only for simple follow-ups.

### 2. Continue until complete

Keep all related follow-up work in the same thread:

```bash
cgpt chat renderer-phase-8a \
  --message "Review your implementation against every Phase 8A requirement. Correct any remaining gaps and rerun the relevant tests." \
  --thinking high
```

Use additional `chat` commands when the first response identifies unresolved work, asks for clarification that can be answered from available context, misses a requirement, or requires another implementation/validation pass.

Do not treat a plausible first response as completion. The task is complete only when the requested work and validation have been addressed, or ChatGPT has clearly explained a genuine blocker.

Do not send simultaneous follow-ups to the same thread.

### 3. Recover interrupted work

The CLI normally polls internally. If the command times out or the client process is interrupted, do not resend the prompt.

Inspect the thread:

```bash
cgpt info renderer-phase-8a
```

Then reattach to the pending run shown by `info` or by the timeout error:

```bash
cgpt --timeout 45m run <run-id> --wait
```

A point-in-time lookup is also available:

```bash
cgpt run <run-id>
```

The server stores durable run state and the final response. Polling an existing run does not resubmit the task.

### 4. Report the result

Relay ChatGPT's useful conclusions, reported changes, limitations, blockers, and validation results accurately.

Distinguish between:

- claims made by ChatGPT;
- changes independently observed in the repository;
- tests reported by ChatGPT;
- tests independently run by the current agent.

Never claim code was changed or tests passed without supporting output or direct inspection.

### 5. Delete the task thread

After the task is complete and its result has been captured, delete the local thread:

```bash
cgpt delete renderer-phase-8a
```

This removes the active local thread mapping and releases the name while retaining durable historical run records.

Do not delete a thread while its task is still running, while follow-up work remains, or before preserving the result needed for the current response.

### 6. Diagnose blocking errors only

Do not run readiness or diagnostic commands as a normal first step. Use them only after a CLI, browser, authentication, verification, configuration, or queue error prevents the workflow from continuing:

```bash
cgpt health
cgpt doctor
cgpt browser-status
```

When one of these errors occurs, halt further delegation work. Preserve the thread and any pending run, then report the error and diagnostic output to the user as a blocking issue. Do not keep retrying, create replacement threads, or claim the delegated task completed.

## Prompt input

`new` and `chat` require exactly one prompt source:

```bash
--message "Prompt text"
--file /path/to/prompt.md
--stdin
```

Prefer `--file` or `--stdin` for long prompts, code, logs, or text with difficult shell quoting.

## Other commands

List active threads:

```bash
cgpt threads
```

Use JSON output for programmatic inspection:

```bash
cgpt --json info <thread-name>
cgpt --json run <run-id>
```

Override the total client polling timeout when needed:

```bash
cgpt --timeout 45m chat <thread-name> \
  --message "Continue and complete the requested task." \
  --thinking high
```

The server also normally deduplicates an exact repeat of the latest message in a thread. Even so, inspect the existing run after a timeout instead of relying on resubmission.

## Failure handling

A thread marked `needs_attention` requires inspection. Do not repeat its prompt automatically because the message may already have reached ChatGPT.

When the task cannot be completed, preserve the thread, run ID, diagnostic output, and best available blocker details. Do not delete the temporary thread until the blocking issue has been reported and the user decides how to proceed.
