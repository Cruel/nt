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

## Transitional runtime adapter

The package exporter still targets the pre-Phase-5 runtime project envelope. It carries stable Scene
step IDs through that adapter and warns for typed instructions the transitional runtime cannot yet
execute. This is a one-way export compatibility boundary, not a second Scene authoring model. The
final typed `SceneProgram` compiler and executor replace it in later phases.

## Implementation files

```text
editor/src/shared/project-schema/authoring-scenes.ts
editor/src/shared/project-schema/scene-project.ts
editor/src/renderer/project/scene-operations.ts
editor/src/renderer/editors/scenes/SceneEditor.tsx
editor/src/shared/project-schema/compiled-runtime-export.ts
editor/src/renderer/test/authoring-scenes.test.ts
editor/src/renderer/test/scene-operations.test.ts
editor/src/renderer/test/scene-editor.test.tsx
```

## Non-goals

Do not restore legacy cutscene arrays or compatibility APIs. V1 does not provide parallel tracks,
keyframes, or a general graph VM.
