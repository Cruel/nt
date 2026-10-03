---
name: noveltea-agent-audit
description: Audit a completed NovelTea CLI authoring task for consumer-side friction and produce a handoff report.
disable-model-invocation: true
---

Read [`../../noveltea-agent-audit-report.md`](../../noveltea-agent-audit-report.md) first. Produce a
report that another agent can investigate later with full NovelTea source access.

Keep this pass observational. Reuse the evidence produced by the work and read the public authoring
surface when needed; preserve uncertainty instead of repairing NovelTea or rewriting the project to
resolve a finding.

## Process

1. Reconstruct the authoring path from the current conversation, project changes, CLI output, and
   installed Agent Kit material that was available during the work. Stay in the **consumer**
   perspective: unresolved uncertainty is evidence, not a prompt to inspect NovelTea engine source.

   This step is complete when the major task steps and the public material used at each relevant point
   are clear enough to distinguish a NovelTea contract/tooling problem from ordinary project work.

2. Identify only **material friction**. A finding earns a place when it changed the work path: the
   agent was blocked, had to experiment or infer unsupported semantics, encountered apparently
   contradictory public behavior, relied on a brittle workaround, or completed the task with material
   uncertainty. Clear diagnostics for routine author mistakes do not need a finding.

   It is a valid successful outcome to find no material friction. Do not manufacture findings to make
   the report look useful.

3. For every finding, fill the report fields from the shared contract. Treat the observed difficulty as
   a **symptom**. Preserve what was asked, consulted, assumed, observed, and tried. Phrase “What would
   have helped” as a consumer need such as a relationship explanation, checked example, clearer
   diagnostic, stable semantic identifier, or explicit testing guidance; leave repository ownership and
   root-cause diagnosis to the refinement pass.

   This step is complete when a source-aware agent could reproduce the reasoning failure without having
   to guess what the original agent found confusing.

4. Record guidance that worked. Prefer specific surfaces that resolved uncertainty or prevented a
   mistake. This is preservation evidence for the refinement pass, not praise.

5. Emit the report using the shared contract. If the outcome is `clean`, say so plainly, include the
   task summary, and keep the Findings section empty.

## Evidence discipline

Use evidence from the authoring surface: `.noveltea/agent/`, `noveltea --help`, command output,
validation/test diagnostics, tracked project records, and the conversation/work history. When exact
output is long, quote only the fragment needed to identify the friction.

Distinguish “I could not find this” from “the material contradicted this” and from “I inferred this by
experiment.” Those are different symptoms even when they concern the same feature.
