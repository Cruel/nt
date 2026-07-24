# Dialogue Component

## Contract

Dialogue is a specialized conversation graph. A `DialogueDefinition` owns immutable settings and a
`DialogueProgram`; a Dialogue frame owns the mutable cursor. Dialogue is not flattened into Scene
text steps and does not use a universal entity program.

Dialogue may `extends` another Dialogue only for declared custom-property lookup. Blocks, segments,
edges, settings, and completion behavior remain local and do not merge.

## Authoring V2 structure

The authoritative Dialogue authoring boundary lives in
`editor/src/shared/project-schema/authoring-dialogues.ts`.

- Sequence blocks contain ordered Line, RunLua, or Comment segments and at most one Next edge.
- Choice blocks contain one or more ordered Choice edges and no transcript segments.
- Redirect blocks contain exactly one target block ID and own no edges.
- Comment blocks are editor-only and cannot be entry blocks or flow targets.

Every block, segment, edge, condition, effect, text value, settings object, and completion target is a
strict schema. A variant stores only fields valid for that variant. The normal V2 parser rejects the
old `linear`/`branch`/`link` shape, Link edges, `allowDisabledChoiceSelection`, embedded graph
coordinates, and embedded preview state.

Stable Dialogue, block, segment, and edge IDs support references, diagnostics, history, and resume.
Segment IDs are unique throughout their Dialogue rather than only within one Sequence block.

## Lines, choices, and policy

A Line contains typed text, an optional Character speaker override, an optional typed Condition,
ordered typed Effects, show-once policy, logging policy, and an autosave-safe-point flag. Speaker
resolution is line override, then Sequence-block default, then Dialogue default.

Text source is Inline, Localized key, or synchronous Lua expression; markup is Plain or ActiveText.
Show-once state is keyed by Dialogue ID plus Segment ID.

A Choice edge contains typed label text, an optional Condition, ordered Effects, logging policy, an
autosave-safe-point flag, and one target block ID. `showDisabledChoices` controls whether a false
choice is hidden or displayed disabled. Disabled choices are never selectable.

`logMode` is Everything, Nothing, OnlyChoices, or OnlyLines. A line or choice `logged` flag may
suppress that item, but it cannot force logging when the global mode excludes its category.

RunLua segments are explicit yield-capable instructions with an optional Condition. Comment segments
and Comment blocks are tooling-only and are removed by compilation.

## Graph validation

Authoring validation enforces the block-specific graph contract before compilation:

- Sequence blocks may own at most one Next edge and no Choice edges.
- Choice blocks require at least one Choice edge and may own no Next edge.
- Redirect and Comment blocks may own no edges.
- Runtime edges and redirects may not target Comment blocks.
- Missing blocks, duplicate stable IDs, invalid typed references, and type-incompatible variable
  effects are errors.
- Redirect-only cycles are errors because they cannot present content or suspend.
- Non-Comment blocks unreachable from the entry block are warnings.

## Calls and completion

Dialogue completion uses the shared closed FlowTarget variant: Scene, Dialogue, Room, Return, or End.
Scene `CallDialogue` pushes a Dialogue frame and resumes the caller after Return. A direct Dialogue
entrypoint may not complete with Return because it has no caller.

Autosave after a line or choice occurs after its effects complete and only at the resulting
compiler-marked safe point.

## Editor boundary

Dialogue edits publish through `dialogue.replaceData`, which validates a complete strict payload
before replacing `/dialogues/{id}/data`. Undo/redo and dirty tracking therefore operate on valid
authoring records.

The Dialogue editor supports:

- creation, selection, type replacement, deletion, and safe stable-ID rename for blocks;
- dense Sequence transcript editing and safe segment-ID rename;
- ordered Choice edge creation, editing, reordering, deletion, and safe edge-ID rename;
- typed text-source, Character, Condition, Effect, show-once, logging, autosave, and completion fields;
- derived preview and diagnostics;
- atomic creation paths that never publish an invalid intermediate Choice block.

Graph positions, viewport, selected block/segment, collapsed blocks, preview background, and condition
display are stored in `noveltea.editor.tab-state.dialogue.v2`, not in Dialogue content. The preview
adapter emits `noveltea.dialogue-preview.v2` from Dialogue data plus those editor-owned options.

## Typed runtime execution

The additive typed execution kernel is the sole Dialogue executor on the `CompiledProject` path. It
executes Sequence, Choice, and Redirect blocks; Line and RunLua segments; Next and Choice edges;
conditions, text sources, ordered effects, disabled-choice policy, history/show-once, logging, safe
points, redirects, nested Return, and completion targets through `FlowExecutor` and `SessionState`.

The mutable cursor retains stable block, segment, edge, and effect positions across input and Lua
suspension. Advancement is validated and atomic: a failed effect, invalid target, stale blocker, or
disabled choice does not consume the active position. Current line and choice presentation are
published as a typed `DialogueView`; line/choice history and typed text-log entries have one
session-owned source of truth.

## Implementation files

```text
editor/src/shared/project-schema/authoring-flow.ts
editor/src/shared/project-schema/authoring-dialogues.ts
editor/src/shared/project-schema/dialogue-project.ts
editor/src/renderer/project/dialogue-operations.ts
editor/src/renderer/editors/dialogues/DialogueEditor.tsx
editor/src/renderer/editors/dialogues/DialogueGraph.tsx
engine/include/noveltea/core/compiled_project.hpp
engine/include/noveltea/core/feature_state.hpp
engine/include/noveltea/core/feature_view.hpp
engine/include/noveltea/core/flow.hpp
engine/include/noveltea/core/flow_executor.hpp
engine/src/runtime/flow_executor_dialogue.cpp
engine/src/runtime/runtime_executor_dialogue.cpp
editor/src/renderer/test/authoring-dialogues.test.ts
editor/src/renderer/test/dialogue-operations.test.ts
editor/src/renderer/test/dialogue-editor.test.tsx
tests/script/typed_dialogue_execution_tests.cpp
```

## Authoring, compiled, and state disposition

- **Authoring V2:** collection-specific graph record, optional `extends`, typed properties, strict
  blocks/segments/edges, entry block, settings, and completion target.
- **Compiled:** linked `DialogueDefinition`/`DialogueProgram`, retained parent edge, redirects,
  ordered choices, property assignments, and safe points.
- **Mutable:** Dialogue frame cursor, show-once/history/visit state, waits, and property overrides in
  `SessionState`.
- **Tooling only:** graph coordinates, viewport, selection, collapsed state, preview settings,
  Comment blocks/segments, categories, tags, colors, and sort keys.
