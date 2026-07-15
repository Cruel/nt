# Scene Component

## Contract

Scene is the canonical visual-novel orchestration component; new code never uses Cutscene. A
`SceneDefinition` owns immutable metadata and a specialized flat `SceneProgram`. Scene is not a
universal command stream, graph VM, keyframe timeline, or polymorphic controller.

Scene may `extends` another Scene only for declared custom-property lookup. Steps, defaults,
programs, resources, and continuations remain local and do not merge.

## Program

Authoring V2 uses the strict step union: SetBackground, ActorCue, CallDialogue, ShowText, AudioCue,
SetVariable, RunLua, Wait, ConditionalBranch, Choice, SetLayout, Transition, and Comment. Comment is
editor-only and removed by compilation. Each step contains only fields valid for its variant,
including condition, wait, and safe-point data where meaningful. Stable step IDs support diagnostics
and save/resume.

A Scene frame holds the mutable instruction cursor and wait/correlation state. `CallDialogue` pushes a
Dialogue frame and resumes at the next Scene step after Return. A final Scene/Dialogue continuation
tail-replaces; Room enters Room mode; Return pops; End clears execution and enters Ended mode. Return
is invalid for a direct project entrypoint.

## Presentation actions and transition terminology

A Scene is an ordered program of engine actions. It is not itself a visual transition, and the word
`Transition` does not mean transferring execution from one `SceneDefinition` to another. Scene-to-
Scene execution transfer is controlled by branches, child calls, and the Scene's terminal
`FlowTarget`.

Current presentation-changing Scene actions include:

- `SetBackground`, which selects a new background and currently carries a local `none`, `fade`, or
  `cut` visual policy;
- `ActorCue`, which changes one actor slot and currently carries a local `none`, `fade`, or `slide`
  visual policy;
- `SetLayout`, which shows, hides, or swaps one logical Layout slot; the referenced Layout and its
  mounted policy determine the runtime presentation plane;
- the standalone `Transition` action, whose current schema contains `fade`, `cut`, or `dissolve`, a
  duration, optional color, and wait policy.

The standalone `Transition` action is not yet a complete production contract. It identifies an effect
but does not identify the presentation mutations that form its target, contain child actions, or state
whether it applies to earlier or later steps. In particular, `Dissolve` is undefined without an exact
source and target composition. Phase 6 of the presentation implementation plan must resolve this by
either replacing it with an explicit transition group/container or removing the general standalone
action from V1. Runtime code must not invent implicit "consume the preceding actions" behavior.

The intended grouped authoring need, if retained, is conceptually:

```text
TransitionGroup(dissolve, 500 ms, wait) {
    SetBackground(courtyard)
    ActorCue(alice, show at left)
    SetLayout(rain-overlay)
}
```

That would mean one atomic transition from the previous scene presentation to the explicit grouped
target. It would still be an action inside the current Scene program, not a transition between Scene
entities. A future drag-and-drop or node editor may render the same typed program as a group or
transition edge without changing runtime semantics.

## Authoring, compiled, and state disposition

- **Authoring V2:** collection-specific Scene record, optional `extends`, typed property assignments,
  strict ordered steps, and explicit terminal continuation.
- **Compiled:** `SceneDefinition` plus `SceneProgram`, linked typed references, retained parent edge,
  property assignments, and compiler-marked safe points.
- **Mutable:** Scene `FlowFrame`, actor state, logical waits, visit/history data, and property overrides
  in `SessionState`.
- **Tooling only:** comments, selected step, timeline/graph coordinates, preview playback/background,
  categories, tags, colors, and sort keys.

Conditions and Lua text expressions are synchronous. RunLua may yield through an engine-owned handle
bound to the Scene frame. Lua coroutine state is never saved. Autosaves occur only at compiler-marked
safe points.

## Authoring implementation

Phase 3B establishes the authoritative Scene authoring boundary in
`editor/src/shared/project-schema/authoring-scenes.ts`. A Scene record contains its display name,
initial background and Layout references, a non-empty ordered step sequence, and an explicit terminal
`FlowTarget`. Preview selection and other editor-only state are not serialized into Scene data.

Every step is a strict discriminated-union member. A step stores only fields valid for its type;
unknown fields and payloads belonging to another variant are rejected at every nested boundary.
Changing a step type creates a fresh payload for the new type instead of retaining hidden inactive
payloads. Conditions, effects, waits, and autosave-safe-point flags are represented only on variants
where they are meaningful.

The editor supports ordered creation, selection, duplication, deletion, reordering, type replacement,
variant-specific editing, explicit continuation editing, diagnostics, undo/redo, and a derived Scene
preview. The preview receives its selected step from editor state and emits
`noveltea.scene-preview.v2`; it does not mutate or annotate the authoring record.

Scene edits publish through `scene.replaceData`. The command validates the complete proposed strict
payload before replacing `/scenes/{sceneId}/data`, preserving deterministic command history and
undo/redo semantics.

## Implementation files

```text
editor/src/shared/project-schema/authoring-scenes.ts
editor/src/shared/project-schema/scene-project.ts
editor/src/renderer/project/scene-operations.ts
editor/src/renderer/editors/scenes/SceneEditor.tsx
editor/src/renderer/test/authoring-scenes.test.ts
editor/src/renderer/test/scene-operations.test.ts
editor/src/renderer/test/scene-editor.test.tsx
```

## Non-goals

Do not restore legacy cutscene arrays or compatibility APIs. V1 does not provide parallel tracks,
keyframes, or a general graph VM.
