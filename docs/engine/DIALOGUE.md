# Dialogue Component

## Contract

Dialogue is a specialized conversation graph. A `DialogueDefinition` owns immutable settings and a
`DialogueProgram`; a Dialogue frame owns the mutable cursor. Dialogue is not flattened into Scene
text steps and does not use a universal entity program.

Dialogue is an immutable conversation definition, not a stateful Property or Trait owner. Mutable cursor, history, show-once, and choice state belong to each Dialogue frame/invocation in the Runtime Session.

Dialogue also owns its conversation-local presentation vocabulary. Stable Stage Slots represent
Character presentation occurrences and stable Media Slots represent Layout-positioned narrow media
channels. Their retained values belong to the Dialogue invocation, not to semantic Character state,
Scene state, renderer state, or the Dialogue definition itself.

## Authoring structure

The authoritative Dialogue authoring boundary lives in
`editor/src/shared/project-schema/authoring-dialogues.ts`.

- Sequence blocks contain ordered Line, RunLua, or Comment segments and at most one Next edge.
- Choice blocks contain one or more ordered Choice edges and no transcript segments.
- Redirect blocks contain exactly one target block ID and own no edges.
- Comment blocks are editor-only and cannot be entry blocks or flow targets.
- Stage Slots have a stable ID, label, speaker-synchronization policy, and optional initial Character
  presentation state.
- Media Slots have a stable ID, label, initial visibility, and optional initial content. Content is
  deliberately limited to an image Asset or a Character presentation snapshot; the Dialogue Layout
  decides physical placement and chrome.

Every block, segment, edge, condition, effect, text value, settings object, and completion target is a
strict schema. A variant stores only fields valid for that variant. The current parser rejects the
old `linear`/`branch`/`link` shape, Link edges, `allowDisabledChoiceSelection`, embedded graph
coordinates, and embedded preview state.

Stable Dialogue, block, segment, and edge IDs support references, diagnostics, history, and resume.
Segment IDs are unique throughout their Dialogue rather than only within one Sequence block.

## Lines, choices, and policy

A Line contains typed text, an optional Character speaker override, optional retained presentation
mutations, an optional typed Condition, ordered typed Effects, show-once policy, logging policy, and
an autosave-safe-point flag. Speaker resolution is line override, then Sequence-block default, then
Dialogue default.

Line presentation may contain an optional speaker Expression plus ordered Stage and Media mutations.
Stage mutations address one Stage Slot and use `update`, `show`, `hide`, or `clear`. `update` is
sparse: omitted Character/Profile/Pose/Expression/Appearance/position/offset/scale fields preserve
the current slot value. Supplying a new Character resets Character-specific axes to that Character's
validated defaults while preserving occurrence placement/visibility unless those fields are also
changed. A Profile change falls back to that Profile's default Pose unless the same mutation supplies
a Pose. Media mutations use the same four actions; `update` may replace content while omitted content
preserves the current value.

Speaker Expression synchronization applies only to populated Stage Slots with `speakerSync` enabled
whose Character matches the resolved speaker. An off-screen speaker is valid: Dialogue text may name a
speaker even when no Stage Slot currently contains that Character. Stage occurrence speaking state is
derived from the resolved line speaker and `speakerSync`; configured Character speaking animation then
uses the ordinary Character presentation machinery from `CHARACTER.md`.

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
- Stage Slot and Media Slot creation/removal/configuration, initial retained state, speaker sync, and
  line-level sparse presentation mutations;
- derived preview and diagnostics;
- atomic creation paths that never publish an invalid intermediate Choice block.

Graph positions, viewport, selected block/segment, collapsed blocks, preview background, and condition
display are stored in `noveltea.editor.tab-state.dialogue`, not in Dialogue content. The preview
adapter emits the current `noveltea.dialogue-preview` document from Dialogue data plus those editor-owned options.

## Typed runtime execution

The additive typed execution kernel is the sole Dialogue executor on the `CompiledProject` path. It
executes Sequence, Choice, and Redirect blocks; Line and RunLua segments; Next and Choice edges;
conditions, text sources, ordered effects, disabled-choice policy, history/show-once, logging, safe
points, redirects, nested Return, and completion targets through `FlowExecutor` and `SessionState`.

Each Dialogue frame initializes every Stage/Media Slot from the immutable definition, including a
direct Dialogue entrypoint with no Scene caller. Line presentation mutations are validated against a
copy of the retained slot vectors and committed only after the whole presentation update succeeds, so
an invalid later mutation cannot leave a partially changed conversation presentation. The retained
vectors survive normal line/choice progression and are discarded with the Dialogue invocation.

`DialogueView` publishes the retained Stage/Media Slot state. Stage Slots are additionally projected
as ordinary Character presentation actors using the #91/#92 Profile/Pose/Expression/Appearance,
automatic speaking/blink, layered composition, and renderer paths. Their occurrence identity remains
Dialogue-local and does not mutate semantic Character state. Media Slot placement is not projected as
world geometry; the runtime RmlUi model publishes the slot data to the Dialogue Layout as
`gameplay.dialogue.stage_slots` and `gameplay.dialogue.media_slots`.

Dialogue choices continue to use the specialized Dialogue choice contract and the existing Dialogue
Layout path (`gameplay.choices`). They do not route through the Scene Choice System Layout role.

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
engine/include/noveltea/core/save_state.hpp
engine/src/runtime/flow_executor_dialogue.cpp
engine/src/runtime/runtime_executor_dialogue.cpp
engine/src/presentation/runtime_presentation.cpp
engine/src/ui/rmlui/runtime_ui_data_model.cpp
engine/src/core/save_state_codec/flow_codec.cpp
engine/src/core/save_state_codec/validation.cpp
editor/src/renderer/test/authoring-dialogues.test.ts
editor/src/renderer/test/dialogue-operations.test.ts
editor/src/renderer/test/dialogue-editor.test.tsx
tests/script/typed_dialogue_execution_tests.cpp
tests/core/save_state_tests.cpp
```

## Authoring, compiled, and state disposition

- **Authoring:** collection-specific graph record with strict blocks/segments/edges, Stage/Media Slot declarations, sparse Line presentation mutations, entry block, settings, and completion target.
- **Compiled:** linked immutable `DialogueDefinition`/`DialogueProgram` with Stage/Media Slot defaults, typed Line presentation commands, redirects, ordered choices, and safe points. The already-selected compiled-project schema version is retained; #93 does not increment it. The current-version wire shape requires the #93 Stage/Media Slot arrays and Line presentation object; the replaced same-version shape is rejected rather than treated as a compatibility form.
- **Mutable:** Dialogue frame cursor, retained Stage/Media Slot values, show-once/history/visit state, and waits in `SessionState`; the Dialogue definition itself has no Property/Trait state. Stage/Media Slot state is serialized with the Dialogue frame and semantically revalidated against immutable Character/Asset/Slot content during save decode/restore.
- **Tooling only:** graph coordinates, viewport, selection, collapsed state, preview settings,
  Comment blocks/segments, categories, tags, colors, and sort keys.
