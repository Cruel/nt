#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from shutil import which
from typing import Any, Iterable, Sequence

FAILURE_CONCLUSIONS = {
    "action_required",
    "cancelled",
    "failure",
    "startup_failure",
    "stale",
    "timed_out",
}
SUCCESS_CONCLUSIONS = {"success"}
FAILURE_MARKERS = (
    "error",
    "failed",
    "failure",
    "fatal",
    "traceback",
    "exception",
    "assert",
    "panic",
    "timeout",
    "timed out",
    "segmentation fault",
    "undefined reference",
    "cannot find",
    "not found",
)
GENERIC_FAILURE_LINES = (
    "process completed with exit code",
    "the command exited with code",
)
PENDING_LOG_MARKERS = (
    "still in progress",
    "log will be available when it is complete",
)
DEFAULT_MAX_LINES = 160
DEFAULT_CONTEXT_LINES = 30
RUN_FIELDS = (
    "databaseId,displayTitle,workflowName,status,conclusion,headBranch,headSha,"
    "url,event,createdAt,updatedAt"
)
RUN_VIEW_FIELDS = (
    "databaseId,workflowName,status,conclusion,headBranch,headSha,url,event,jobs"
)


class CommandResult:
    def __init__(self, returncode: int, stdout: str, stderr: str):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Inspect push-triggered GitHub Actions runs for the current branch's exact "
            "pushed SHA and extract failed-job context."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--repo", default=".", help="Path inside the target Git repository.")
    parser.add_argument("--branch", help="Branch name (defaults to the current branch).")
    parser.add_argument(
        "--sha",
        help=(
            "Exact pushed commit SHA. Defaults to the current branch's upstream "
            "remote-tracking SHA, then local HEAD when no upstream exists."
        ),
    )
    parser.add_argument(
        "--workflow",
        action="append",
        default=[],
        help="Workflow name to include. Repeat for multiple workflows.",
    )
    parser.add_argument("--limit", type=int, default=50, help="Maximum branch runs to query.")
    parser.add_argument("--max-lines", type=int, default=DEFAULT_MAX_LINES)
    parser.add_argument("--context", type=int, default=DEFAULT_CONTEXT_LINES)
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of text output.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = find_git_root(Path(args.repo))
    if repo_root is None:
        return fail("not inside a Git repository")
    if which("gh") is None:
        return fail("gh is not installed or not on PATH")
    auth = run_command(["gh", "auth", "status"], repo_root)
    if auth.returncode != 0:
        return fail(command_message(auth, "gh authentication failed"))

    branch = args.branch or git_value(["branch", "--show-current"], repo_root)
    if not branch:
        return fail("the checkout is detached; a named current branch is required")

    local_head = git_value(["rev-parse", "HEAD"], repo_root)
    if not local_head:
        return fail("unable to resolve local HEAD")

    upstream = git_value(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        repo_root,
    )
    upstream_head = git_value(["rev-parse", "@{upstream}"], repo_root) if upstream else ""
    target_sha = args.sha or upstream_head or local_head

    runs = fetch_runs(branch, max(1, args.limit), repo_root)
    if runs is None:
        return 3

    workflows = {name.casefold() for name in args.workflow}
    matching = [
        run
        for run in runs
        if str(run.get("headBranch") or "") == branch
        and str(run.get("headSha") or "") == target_sha
        and (
            not workflows
            or str(run.get("workflowName") or "").casefold() in workflows
        )
    ]

    summary: dict[str, Any] = {
        "branch": branch,
        "localHead": local_head,
        "upstream": upstream or None,
        "upstreamHead": upstream_head or None,
        "targetSha": target_sha,
        "localHeadIsPushed": local_head == target_sha,
        "runs": [],
    }

    if not matching:
        latest = runs[0] if runs else None
        summary["status"] = "no_exact_sha_run"
        summary["latestBranchRun"] = latest
        render(summary, args.json)
        return 2

    any_failure = False
    any_pending = False
    all_success = True
    for listed_run in matching:
        run_result = analyze_run(
            listed_run,
            repo_root=repo_root,
            max_lines=max(1, args.max_lines),
            context=max(1, args.context),
        )
        summary["runs"].append(run_result)
        status = normalize(run_result.get("status"))
        conclusion = normalize(run_result.get("conclusion"))
        if status != "completed":
            any_pending = True
            all_success = False
        elif conclusion in FAILURE_CONCLUSIONS or run_result.get("failedJobs"):
            any_failure = True
            all_success = False
        elif conclusion not in SUCCESS_CONCLUSIONS:
            all_success = False

    if any_failure:
        summary["status"] = "failed"
        exit_code = 1
    elif any_pending:
        summary["status"] = "pending"
        exit_code = 2
    elif all_success:
        summary["status"] = "success"
        exit_code = 0
    else:
        summary["status"] = "non_success"
        exit_code = 1

    render(summary, args.json)
    return exit_code


def find_git_root(start: Path) -> Path | None:
    result = run_command(["git", "rev-parse", "--show-toplevel"], start)
    if result.returncode != 0:
        return None
    return Path(result.stdout.strip())


def git_value(args: Sequence[str], repo_root: Path) -> str:
    result = run_command(["git", *args], repo_root)
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def run_command(args: Sequence[str], cwd: Path) -> CommandResult:
    process = subprocess.run(
        args,
        cwd=cwd,
        text=True,
        errors="replace",
        capture_output=True,
    )
    return CommandResult(process.returncode, process.stdout, process.stderr)


def fetch_runs(branch: str, limit: int, repo_root: Path) -> list[dict[str, Any]] | None:
    result = run_command(
        [
            "gh",
            "run",
            "list",
            "--branch",
            branch,
            "--event",
            "push",
            "--limit",
            str(limit),
            "--json",
            RUN_FIELDS,
        ],
        repo_root,
    )
    if result.returncode != 0:
        fail(command_message(result, "gh run list failed"))
        return None
    try:
        data = json.loads(result.stdout or "[]")
    except json.JSONDecodeError:
        fail("unable to parse gh run list JSON")
        return None
    if not isinstance(data, list):
        fail("unexpected gh run list JSON shape")
        return None
    return data


def analyze_run(
    listed_run: dict[str, Any],
    repo_root: Path,
    max_lines: int,
    context: int,
) -> dict[str, Any]:
    run_id = str(listed_run.get("databaseId") or "")
    result = run_command(
        ["gh", "run", "view", run_id, "--json", RUN_VIEW_FIELDS], repo_root
    )
    if result.returncode != 0:
        return {
            **listed_run,
            "inspectionError": command_message(result, "gh run view failed"),
        }
    try:
        detail = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return {**listed_run, "inspectionError": "unable to parse gh run view JSON"}
    if not isinstance(detail, dict):
        return {**listed_run, "inspectionError": "unexpected gh run view JSON shape"}

    failed_jobs: list[dict[str, Any]] = []
    for job in detail.get("jobs") or []:
        if not isinstance(job, dict):
            continue
        if normalize(job.get("conclusion")) not in FAILURE_CONCLUSIONS:
            continue
        failed_jobs.append(
            analyze_job(
                run_id,
                job,
                repo_root=repo_root,
                max_lines=max_lines,
                context=context,
            )
        )

    return {
        "databaseId": detail.get("databaseId") or listed_run.get("databaseId"),
        "workflowName": detail.get("workflowName") or listed_run.get("workflowName"),
        "status": detail.get("status") or listed_run.get("status"),
        "conclusion": detail.get("conclusion") or listed_run.get("conclusion"),
        "headBranch": detail.get("headBranch") or listed_run.get("headBranch"),
        "headSha": detail.get("headSha") or listed_run.get("headSha"),
        "url": detail.get("url") or listed_run.get("url"),
        "event": detail.get("event") or listed_run.get("event"),
        "failedJobs": failed_jobs,
    }


def analyze_job(
    run_id: str,
    job: dict[str, Any],
    repo_root: Path,
    max_lines: int,
    context: int,
) -> dict[str, Any]:
    job_id = str(job.get("databaseId") or "")
    failed_steps = [
        str(step.get("name") or "")
        for step in job.get("steps") or []
        if isinstance(step, dict)
        and normalize(step.get("conclusion")) in FAILURE_CONCLUSIONS
    ]
    log_text, log_error, log_status = fetch_job_log(run_id, job_id, repo_root)
    result: dict[str, Any] = {
        "databaseId": job.get("databaseId"),
        "name": job.get("name"),
        "status": job.get("status"),
        "conclusion": job.get("conclusion"),
        "url": job.get("url"),
        "failedSteps": failed_steps,
        "logStatus": log_status,
    }
    if log_error:
        result["logError"] = log_error
    if log_text:
        result["failureSnippet"] = extract_failure_snippet(
            log_text, max_lines=max_lines, context=context
        )
        result["logTail"] = tail_lines(log_text, max_lines)
    return result


def fetch_job_log(
    run_id: str, job_id: str, repo_root: Path
) -> tuple[str, str, str]:
    result = run_command(
        ["gh", "run", "view", run_id, "--job", job_id, "--log"], repo_root
    )
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout, "", "ok"

    error = command_message(
        result,
        "gh run view returned an empty job log; trying the Actions job-log API",
    )
    if is_pending_log_message(error):
        return "", error, "pending"

    repo_slug = fetch_repo_slug(repo_root)
    if not repo_slug:
        return "", error, "unavailable"
    fallback = run_command(
        ["gh", "api", f"/repos/{repo_slug}/actions/jobs/{job_id}/logs"], repo_root
    )
    if fallback.returncode != 0:
        fallback_error = command_message(fallback, "gh api job logs failed")
        status = "pending" if is_pending_log_message(fallback_error) else "unavailable"
        return "", fallback_error, status
    return fallback.stdout, "", "ok"


def fetch_repo_slug(repo_root: Path) -> str:
    result = run_command(
        ["gh", "repo", "view", "--json", "nameWithOwner"], repo_root
    )
    if result.returncode != 0:
        return ""
    try:
        data = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return ""
    return str(data.get("nameWithOwner") or "") if isinstance(data, dict) else ""


def extract_failure_snippet(log_text: str, max_lines: int, context: int) -> str:
    lines = log_text.splitlines()
    if not lines:
        return ""
    marker_index = find_failure_index(lines)
    if marker_index is None:
        return "\n".join(lines[-max_lines:])
    start = max(0, marker_index - context)
    end = min(len(lines), marker_index + context + 1)
    window = lines[start:end]
    if len(window) > max_lines:
        window = window[-max_lines:]
    return "\n".join(window)


def find_failure_index(lines: Sequence[str]) -> int | None:
    generic_index: int | None = None
    for index in range(len(lines) - 1, -1, -1):
        lowered = lines[index].casefold()
        if not any(marker in lowered for marker in FAILURE_MARKERS):
            continue
        if any(marker in lowered for marker in GENERIC_FAILURE_LINES):
            if generic_index is None:
                generic_index = index
            continue
        return index
    return generic_index


def tail_lines(text: str, max_lines: int) -> str:
    return "\n".join(text.splitlines()[-max_lines:])


def is_pending_log_message(message: str) -> bool:
    lowered = message.casefold()
    return any(marker in lowered for marker in PENDING_LOG_MARKERS)


def normalize(value: Any) -> str:
    return str(value or "").strip().casefold()


def command_message(result: CommandResult, fallback: str) -> str:
    return (result.stderr or result.stdout or fallback).strip()


def render(summary: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(summary, indent=2))
        return

    print(f"Branch: {summary['branch']}")
    print(f"Target pushed SHA: {summary['targetSha']}")
    print(f"Local HEAD: {summary['localHead']}")
    if summary.get("upstream"):
        print(f"Upstream: {summary['upstream']} ({summary.get('upstreamHead')})")
    if not summary.get("localHeadIsPushed"):
        print("Note: local HEAD differs from the inspected pushed SHA.")
    print(f"Status: {summary['status']}")

    if summary["status"] == "no_exact_sha_run":
        latest = summary.get("latestBranchRun") or {}
        print("No push run matched the exact target SHA.")
        if latest:
            print(
                "Latest branch run: "
                f"{latest.get('workflowName', '')} {latest.get('headSha', '')} "
                f"{latest.get('status', '')}/{latest.get('conclusion', '')}"
            )
            if latest.get("url"):
                print(f"Run URL: {latest['url']}")
        return

    for run in summary.get("runs") or []:
        print("-" * 72)
        print(
            f"Workflow: {run.get('workflowName', '')} "
            f"({run.get('status', '')}/{run.get('conclusion', '')})"
        )
        if run.get("url"):
            print(f"Run URL: {run['url']}")
        if run.get("inspectionError"):
            print(f"Inspection error: {run['inspectionError']}")
        for job in run.get("failedJobs") or []:
            print(f"  Failed job: {job.get('name', '')}")
            if job.get("url"):
                print(f"  Job URL: {job['url']}")
            failed_steps = job.get("failedSteps") or []
            if failed_steps:
                print(f"  Failed steps: {', '.join(failed_steps)}")
            if job.get("logError"):
                print(f"  Log error: {job['logError']}")
            snippet = job.get("failureSnippet") or ""
            if snippet:
                print("  Failure snippet:")
                print(indent_block(snippet, "    "))
    print("-" * 72)


def indent_block(text: str, prefix: str) -> str:
    return "\n".join(f"{prefix}{line}" for line in text.splitlines())


def fail(message: str) -> int:
    print(f"Error: {message}", file=sys.stderr)
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
