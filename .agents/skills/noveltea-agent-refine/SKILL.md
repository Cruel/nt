---
name: noveltea-agent-refine
description: Investigate a NovelTea agent-audit report against full engine source and refine the canonical Agent Kit contract.
disable-model-invocation: true
---

Read [`../../noveltea-agent-audit-report.md`](../../noveltea-agent-audit-report.md), the supplied audit
report, and `docs/editor/AGENT_KIT.md` before editing. The audit report is **consumer evidence**, not a
root-cause analysis: treat each finding as a hypothesis to investigate against the current repository.

## Process

1. Inventory every audit finding by ID. Preserve its original question and evidence. If the report is
   `clean`, do not invent remediation work; note any successful guidance worth preserving and stop
   unless independent verification exposes a real contradiction.

   This step is complete when every reported symptom has a stable ID and none has silently become a
   presumed diagnosis.

2. Establish the intended current behavior for each finding from authoritative repository evidence.
   Inspect the relevant canonical schemas, runtime/editor implementation, internal engine docs, tests,
   and public Agent Kit sources as needed. Reproduce the behavior when practical. Separate:

   - intended behavior that is already implemented;
   - public material that is missing, misleading, or hard to route to;
   - implementation behavior that contradicts the intended contract;
   - test/tooling behavior that fails to prove the intended contract.

   This step is complete only when the finding can be explained without relying on the consumer
   agent's guess.

3. Classify each finding before changing files. Use the narrowest applicable class:

   - **routing/discoverability** — the fact already exists on the correct public surface but agents are
     not reliably led to it;
   - **shared concept gap** — audience-neutral meaning, relationships, invariants, lifecycle, or
     author-visible behavior are missing or unclear;
   - **schema/reference gap** — exact structure, field-local surprising semantics, cross-field
     constraint, lifecycle note, or checked example belongs beside the canonical Zod schema;
   - **agent workflow gap** — coding-agent operating procedure or testing discipline is missing;
   - **technical contract gap** — exact Lua/RmlUi/shader/Layout/runtime authoring behavior is outside
     Project schema semantics and belongs in focused technical guidance;
   - **diagnostic contract gap** — validation/CLI/runtime rejection is correct but its supported
     diagnostic does not give an author enough stable information to understand or correct the issue;
   - **tooling/automation contract gap** — a supported workflow lacks a stable semantic tool/UI surface;
   - **coverage/witness gap** — a canonical example or test can pass without distinguishing correct
     behavior from a plausible wrong implementation;
   - **implementation defect** — engine/editor/CLI behavior contradicts the intended public contract;
   - **stale public contract** — public guidance states behavior that is no longer intended/current;
   - **no actionable gap** — the public contract and routing are sufficient and the reported friction
     does not justify a product/docs change.

4. Route confirmed gaps through the canonical ownership map below. Prefer one authoritative owner for
   each fact. When one confirmed gap reveals an adjacent cluster of the same public semantics, audit
   that bounded cluster so the result is coherent rather than a one-sentence patch.

5. Implement the remediation at the owning surface and add the highest useful verification seam.
   Generated Agent Kit Markdown and raw schemas are outputs: change their canonical source or metadata,
   then verify generation. When a workflow needs stable interaction identity, establish a semantic
   product/tooling hook and test/document that supported hook rather than teaching positional or
   incidental selectors.

   For executable coverage, require a **witness**: the assertion must turn red under the plausible
   wrong behavior it claims to distinguish. Reset or establish authoritative state before checks when
   inherited state could create a false positive.

6. Verify the source-less contract. Generate/sync the Agent Kit through the repository's normal seam
   and answer the original consumer question using the installed/generated kit alone. Run focused
   schema/generation tests and the relevant behavioral/Feature Lab/native tests; follow repository
   formatting, lint, and validation requirements for touched code.

   This step is complete when the original friction is either intentionally resolved or explicitly
   classified as no-action, and every confirmed fix is observable through the supported public surface.

7. Report disposition by original finding ID: classification, intended behavior, authoritative
   evidence, canonical owner changed (if any), verification, and any remaining limitation. Call out
   implementation bugs separately from documentation gaps so historical broken behavior does not become
   public contract.

## Canonical ownership map

Use the current architecture in `docs/editor/AGENT_KIT.md` as authority if it evolves. The baseline is:

- `docs/public/concepts/` owns the shared human/agent mental model: public meaning, relationships,
  invariants, lifecycle, and observable semantics. Keep engine/editor implementation architecture out.
- `editor/agent-kit/GUIDE.md` owns top-level routing among concepts, generated reference, workflow,
  technical material, and raw-schema fallback. Fix a weak pointer here instead of copying the routed
  fact into another surface.
- Canonical Zod schemas plus `withSchemaDocumentation` own exact serialized shape and non-obvious
  field-local semantics, constraints, lifecycle notes, relationships, and schema-checked examples.
  Generated compact reference and raw schemas derive from this source; do not hand-maintain a parallel
  domain reference.
- `editor/agent-kit/workflows/` owns concise coding-agent procedure: file-first editing, command choice,
  validation/testing discipline, and operational gotchas. It is not a second engine-domain manual.
- `editor/agent-kit/technical/` owns focused authoring/runtime surfaces that Project schemas cannot
  express, such as Lua, RmlUi, shader, and system Layout behavior.
- `engine/assets/system/ui/` plus the generated system-layout manifest own exact built-in UI source and
  role/path facts. Stable automation identities are supported tooling contracts and should be semantic.
- Feature Lab is a warning/error-clean canonical demonstration of supported behavior. Put deliberately
  invalid or statically contradictory authoring in focused validation/native negative tests. Use manual
  coverage only when an actual tooling limitation prevents an authoritative executable seam, and record
  that limitation precisely.
- Engine/editor/CLI defects are fixed in implementation with behavior tests. Public docs describe the
  intended current contract rather than preserving historical bugs or workarounds.
- Supported author-facing diagnostics are executable contract too. Improve the validator/CLI/runtime
  diagnostic and test it when the behavior is correct but the reported reason/action is insufficient;
  do not use prose documentation as a substitute for an actionable diagnostic at the failing seam.
- `editor/agent-kit-provenance.json` records the actual reviewed source revisions/areas for hand-authored
  payload documents changed by the refinement.

## Refinement bar

For every confirmed public-contract gap, a source-less authoring agent should be able to determine the
correct behavior from `noveltea agent sync` output without repository source access. Preserve useful
existing guidance, avoid duplicated meanings across surfaces, and prefer a checked example or executable
witness when prose alone would leave the same ambiguity possible.
