# NovelTea Codex Agents

The root agent owns requirements, architecture, implementation integration, and the final answer. Custom agents exist only for work that benefits from an isolated context, independent judgment, or parallel execution.

## Default Workflow

Keep a task in the root agent when it is small, already understood, tightly sequential, architecture-heavy, or dependent on the full user conversation. Delegation adds a separate context, tool work, and summary, so it must earn that overhead.

There is no default multi-agent chain. Select only the independent work that is actually useful:

1. `nt_scout` for one bounded code-mapping or version-specific research question.
2. `nt_worker` for one well-specified implementation slice whose ownership and acceptance criteria are already clear.
3. `nt_verifier` for builds, tests, acceptance checks, and failure triage on a stable snapshot.
4. `nt_reviewer` for independent semantic review at a meaningful integration boundary.

Planning and architecture normally stay in the root agent because that thread already holds the user requirements and prior decisions. Critical or unusually ambiguous implementation and final review should also stay in a Sol root rather than duplicating the full context into another Sol subagent.

## Model Routing

- GPT-5.6 Sol is reserved for the root task when difficult planning, integration, or final judgment requires it.
- GPT-5.6 Terra handles codebase scouting, normal implementation, and independent semantic review.
- GPT-5.6 Luna handles mechanical verification and structured failure triage.
- Low verbosity keeps subagent summaries compact.
- Reasoning effort increases only with the role's error cost.

The exact model and reasoning settings live in each `.codex/agents/*.toml` file. Reevaluate them when OpenAI changes the recommended Codex model family or relative pricing.

## Concurrency

`.codex/config.toml` allows at most five open agent threads and one delegation level. Five is a safety cap; most tasks should use zero or one subagent, and larger tasks usually need no more than two. Do not parallelize writers against the same files or implementation slice. Run verification only against a stable snapshot, not while another agent is editing it.
