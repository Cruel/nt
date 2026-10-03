# NovelTea agent audit report contract

This is the handoff format between `noveltea-agent-audit` and `noveltea-agent-refine`.

The report records the **consumer experience**, not the engine diagnosis. A finding is useful when it
preserves what the authoring agent needed to know, what public material it consulted, what it observed,
and how the uncertainty changed its work. It does not need to identify the missing implementation or
the correct repository file.

## Outcome

Use one of:

- `clean` — the task completed without material NovelTea contract/tooling friction.
- `friction-found` — one or more material findings follow.

Include a one- or two-sentence task summary and, when already known, the NovelTea CLI/version context.

## Findings

Number findings `F1`, `F2`, ... in the order they affected the work. For each finding, provide:

- **Friction kind:** one or more of `blocked`, `detour`, `ambiguity`, `apparent-contradiction`,
  `discoverability`, or `unstable-workaround`.
- **Task step:** what the agent was trying to accomplish when the friction appeared.
- **Question:** the author-visible question it could not answer confidently.
- **Public material consulted:** Agent Kit pages, generated references/schemas, CLI help/output,
  diagnostics, project records, authored Tests, or other material actually available to the agent.
- **Initial interpretation:** the reasonable interpretation or assumption the agent started with, if
  one mattered.
- **Observed evidence:** the behavior, diagnostic, test result, or other evidence that exposed the
  difficulty. Preserve short exact commands/diagnostics when they materially help reproduction.
- **Workaround or experiment:** what the agent did to continue, if anything.
- **Impact:** how this changed the work: extra attempts, inability to proceed, brittle authoring,
  uncertainty in correctness, or other concrete cost.
- **Remaining uncertainty:** what the agent still cannot establish from the public surface. `None` is
  valid when experimentation resolved the immediate task.
- **What would have helped:** describe the missing *kind of information or capability* from the
  consumer perspective, without assigning a root cause or repository patch.

Routine mistakes with clear diagnostics are not findings unless the diagnostic itself created material
friction. A successful task may have zero findings.

## Guidance that worked

Record public guidance, diagnostics, examples, CLI behavior, or stable tooling surfaces that materially
helped the agent reach the correct result. This section may be empty, but it is valuable when present:
the refinement pass should preserve patterns that already work.

## Report boundary

Keep engine/source diagnoses out of this report. Phrases such as “the concept page did not tell me how
these two operations relate” are appropriate; claims such as “add metadata to schema field X” require
source knowledge and belong in the refinement pass.
