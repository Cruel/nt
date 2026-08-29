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

A Line contains typed text, an optional Character speaker override, ordered typed inline cues, an
optional typed Condition, an ordered shared Gameplay Command effect program, show-once policy,
logging policy, and an
autosave-safe-point flag. Speaker resolution is line override, then Sequence-block default, then
Dialogue default. Cue IDs are stable within the Dialogue. Every cue has a Unicode code-point text
offset plus an explicit order for deterministic same-position sequencing.

The cue stream has distinct typed classes for ActiveText presentation tokens and semantic Dialogue
cues. Semantic cues cover speaker Expression changes, Stage mutations, Media mutations, Character
Gestures, Voice, Sound Effects, and modest Camera emphasis (`shake`, `punch`, and `flash`). Voice and
Sound Effect cues carry semantic audio policy rather than mixer-channel state; Gesture and Camera
cues carry explicit wait/skippable policy. Structured editor controls and markup source are two views
over this same cue array; neither owns a parallel presentation blob.

Inline source markup uses ordinary ActiveText tags for text presentation plus `[nt-cue ...]`
authoring tags for semantic cues. Source parsing strips both classes from the stored plain text and
places them at shared cue positions. Compilation reconstructs only ActiveText presentation tags into
the runtime text source and emits semantic cues separately as typed compiled records. Consequently,
semantic authoring tags never reach the runtime rich-text parser and cannot become a gameplay-command
language. Malformed semantic markup is retained as an explicit invalid authoring cue so source edits
round-trip losslessly and validation can report the exact problem.

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

Voice is always a causal Dialogue-associated one-shot. Sound Effect cues choose causal or disposable
one-shot behavior explicitly; awaited, synchronized, and play-on-skip Sound Effects must be causal.
Both use the shared Audio Purpose/Pause Policy/gain/pan/skip contracts. Their semantic Owner is the
exact Dialogue Flow invocation, so transient playback cannot outlive the conversation that emitted
it. Camera cues intentionally expose only short shake/punch/flash emphasis; multi-stage camera
choreography remains Scene work.

Text source is Inline, Localized key, or synchronous Lua expression; markup is Plain or ActiveText.
Show-once state is keyed by Dialogue ID plus Segment ID.

A Choice edge contains typed label text, an optional Condition, an ordered shared Gameplay Command
effect program, logging policy, an
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

A Sequence may also contain `CallScene` and `Handoff` segments. `CallScene` pushes a child Scene and
records the exact Dialogue invocation as its caller. The child binds Scene inputs with the same typed
rules as a Scene call. Its UI policy is explicit: `conceal` exposes only the child Scene while it runs;
`preserve` keeps the exact caller Dialogue view available alongside the child Scene. Returning from
the child resumes the exact saved Dialogue cursor.

`Handoff` is cooperative control transfer rather than a named branch. When the active Dialogue has a
direct awaiting Scene caller, Handoff advances the Dialogue cursor exactly once, records the
engine-owned Dialogue frame identity plus an optional scalar payload, and reactivates that Scene at
its already-authored next sequential Event. A later Scene `ResumeDialogue` Event swaps control back to
that exact suspended Dialogue invocation; the same Dialogue/Scene pair may repeat this cycle. Authors
never create routing names or invocation IDs for this mechanism. If no direct awaiting Scene exists,
the runtime emits a warning diagnostic, leaves the Dialogue active at its advanced cursor, and
continues normally.

The handoff relation and optional payload are checkpoint data. Restore remaps the saved frame identity
to fresh runtime frame IDs and rejects stale or incoherent relations. If the awaiting Scene terminates,
returns, or tail-replaces instead of resuming the Dialogue, the suspended Dialogue is discarded with
that handled path so it cannot become unreachable live Flow state.

A successful Handoff is also an eligible semantic checkpoint boundary. The Dialogue cursor advances
once before control is transferred, the exact Dialogue and awaiting Scene identities remain linked in
engine-owned Execution Provenance, and deferred autosave is requested only after that relationship is
committed. Cancellation/discard records the Dialogue invocation as cancelled rather than synthesizing
a successful Dialogue or Scene Outcome.

Autosave after a line or choice occurs after its effects complete and only at the resulting
compiler-marked safe point.

## Editor boundary

Dialogue edits publish through `dialogue.replaceData`, which validates a complete strict payload
before replacing `/dialogues/{id}/data`. Undo/redo and dirty tracking therefore operate on valid
authoring records.

The Dialogue editor supports:

- creation, selection, type replacement, deletion, and safe stable-ID rename for blocks;
- dense Sequence transcript editing and safe segment-ID rename;
- child Scene target/input/UI-policy editing and Handoff payload/condition editing;
- ordered Choice edge creation, editing, reordering, deletion, and safe edge-ID rename;
- typed text-source, Character, Condition, shared Gameplay Command, show-once, logging, autosave, and completion fields;
- Stage Slot and Media Slot creation/removal/configuration, initial retained state, speaker sync, and
  line-level sparse semantic cues;
- a cue timeline for stable cue IDs, text offsets, deterministic same-position order, Gesture
  targeting/wait/skip policy, Voice/SFX Asset and audio policy, and Camera emphasis parameters, plus
  inline markup-source round-tripping over the same cue model;
- derived preview and diagnostics;
- atomic creation paths that never publish an invalid intermediate Choice block.

Graph positions, viewport, selected block/segment, collapsed blocks, preview background, and condition
display are stored in `noveltea.editor.tab-state.dialogue`, not in Dialogue content. The preview
adapter emits the current `noveltea.dialogue-preview` document from Dialogue data plus those editor-owned options.

## Typed runtime execution

The typed execution kernel is the sole Dialogue executor on the `CompiledProject` path. It
executes Sequence, Choice, and Redirect blocks; Line, RunLua, CallScene, and Handoff segments; Next and Choice edges;
conditions, text sources, ordered shared Gameplay Command effects, disabled-choice policy,
history/show-once, logging, safe
points, redirects, nested Return, and completion targets through `FlowExecutor` and `SessionState`.
Dialogue effect programs use the same command definitions and immediate-transaction semantics as
Interactions. Observable/yielding commands inside nested `If/Else` store the exact nested command
cursor in the Dialogue frame so resume and checkpoint restore continue after the boundary rather than
re-running prior mutations. Program-local command results are cleared when that line/choice effect
program ends.

Each Dialogue frame initializes every Stage/Media Slot from the immutable definition, including a
direct Dialogue entrypoint with no Scene caller. Semantic line cues are compiled in position/order
sequence and crossed in that deterministic cross-type order as ActiveText reveal reaches each Unicode
code-point position. RuntimeUI reports reveal progress through one typed runtime input carrying the
exact Dialogue frame, segment, logical offset, and whether the advance is a skip. The runtime cursor
advances a cue before issuing its external one-shot/finite operation, so replayed progress,
completion, cancellation, and checkpoint reconstruction cannot execute the same cue twice.

Stage/Media mutations and speaker Expression changes commit through `FlowExecutor`. Gesture cues use
the semantic Character Gesture presentation operation from `CHARACTER.md`; Voice/SFX use typed Audio
operations; Camera cues use the finite camera operation vocabulary. Awaited cue work uses a distinct
completion handle while the line's Input blocker remains authoritative. Completion resumes crossing
toward the stored reveal target. Cancellation leaves the already-crossed cue consumed and later
reveal progress continues after it rather than replaying it.

Fast-forward traverses the remaining cue stream before completing the line. Stateful semantic cues
still commit once. Unreached disposable one-shots and normal stop/suppress Voice/SFX are suppressed,
skippable Gesture/Camera emphasis is settled by omission, and non-skippable/explicit play-on-skip
work remains subject to its declared causal/wait policy. This prevents skip from burst-playing a line
of effects while preserving explicit barriers.

`DialogueView` publishes the retained Stage/Media Slot state. Stage Slots are additionally projected
as ordinary Character presentation actors using the #91/#92 Profile/Pose/Expression/Appearance,
automatic speaking/blink, layered composition, and renderer paths. Their occurrence identity remains
Dialogue-local and does not mutate semantic Character state. Media Slot placement is not projected as
world geometry; the runtime RmlUi model publishes the slot data to the Dialogue Layout as
`gameplay.dialogue.stage_slots` and `gameplay.dialogue.media_slots`.

Dialogue choices continue to use the specialized Dialogue choice contract and the existing Dialogue
Layout path (`gameplay.dialogue.choices`). They do not route through the Scene Choice System Layout role.

The mutable cursor retains stable block, segment, edge, effect, next-cue, and revealed-code-point
positions across input and Lua suspension. Save data stores only this logical cue cursor; audio
decoder position, Gesture/Camera tween phase, ActiveText renderer progress, and backend handles are
never serialized. Save validation rejects a cursor that claims to have crossed a cue beyond the
revealed frontier or leaves an earlier cue uncrossed behind it. Checkpoint barriers prevent awaited
external cue work from being captured mid-operation. Advancement is validated and atomic: a failed
effect, invalid target, stale blocker, or disabled choice does not consume the active position.
Current line and choice presentation are published as a typed `DialogueView`; line/choice history and
typed text-log entries have one session-owned source of truth.

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
engine/src/runtime/runtime_session.cpp
engine/src/presentation/runtime_presentation.cpp
engine/src/runtime_presentation_bridge.cpp
engine/src/runtime_audio_adapter.cpp
engine/src/ui/rmlui/active_text_presenter.cpp
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

- **Authoring:** collection-specific graph record with strict blocks/segments/edges, Stage/Media Slot declarations, positioned typed Line cues, entry block, settings, and completion target. ActiveText/semantic source markup is a reversible view over the same cue array.
- **Compiled:** linked immutable `DialogueDefinition`/`DialogueProgram` with Stage/Media Slot defaults, ordered semantic Line cues including Voice/SFX/Gesture/Camera policy, ActiveText-only runtime text, redirects, ordered choices, and safe points. The already-selected compiled-project schema version remains unchanged. The current-version wire shape requires the #93 Stage/Media Slot arrays and the positioned `cues` array; the replaced same-version Line `presentation` shape is rejected rather than treated as compatibility input.
- **Mutable:** Dialogue frame cursor including `nextCue`/`revealOffset`, retained Stage/Media Slot values, show-once/history/visit state, and waits in `SessionState`; the Dialogue definition itself has no Property/Trait state. Stage/Media Slot state and the logical cue cursor are serialized with the Dialogue frame and semantically revalidated against immutable Character/Asset/Slot/cue content during save decode/restore. External cue realization state is never saved.
- **Tooling only:** graph coordinates, viewport, selection, collapsed state, preview settings,
  Comment blocks/segments, categories, tags, colors, and sort keys.
