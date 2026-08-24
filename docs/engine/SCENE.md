# Scene Component

## Contract

Scene is the canonical visual-novel orchestration component; new code never uses Cutscene. A
`SceneDefinition` owns immutable metadata and a specialized flat `SceneProgram`. Scene is not a
universal command stream, graph VM, keyframe timeline, or polymorphic controller.

Scene is an immutable orchestration definition, not a stateful Property or Trait owner. Mutable Scene execution state belongs to each Scene frame/invocation in the Runtime Session.

## Program

Current Scene authoring uses the strict step union: SetBackground, ActorCue, CallDialogue, ShowText, AudioCue,
SetVariable, RunLua, Wait, ConditionalBranch, Choice, SetLayout, TransitionGroup, and Comment. Comment is
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

- `SetBackground`, which selects a new background and carries a local `none`, `fade`, or `cut` visual
  policy plus duration, wait-for-completion, and skippable fields;
- `ActorCue`, which changes one actor slot and carries a local `none`, `fade`, or `slide` visual policy
  plus duration, wait-for-completion, and skippable fields;
- `SetLayout`, which shows, hides, or swaps one logical Layout slot and carries `none` or `fade` plus
  duration, wait-for-completion, and skippable fields; the referenced Layout and mounted policy
  determine the runtime presentation plane;
- `TransitionGroup`, which contains one or more closed presentation mutations and defines one exact
  atomic target.

`AudioCue` uses the semantic audio contract rather than a mixer channel. Each cue declares Purpose,
desired-loop versus one-shot lifetime, Pause Policy, gain and stereo pan, optional admitted Pan
Source, causality/synchronization, and skip behavior. Desired Music/Ambience additionally declares a
stable instance ID and optional replacement group; it becomes reconstructible Desired Presentation
State and cannot wait for decoder completion. One-shot Voice and Sound Effect cues may be causal,
awaited/synchronized, disposable, or explicitly play-on-skip as admitted by validation. UI Sound is
always disposable, unscaled, and cannot control gameplay. The retired `channel`, `loop`, and
`volume` Scene audio representation is not accepted by the current authoring or compiled-project shape.

The standalone targetless `Transition` action has been removed from authoring, compiler, compiled wire, and
the native compiled program. It has no compatibility interpretation. A group never consumes earlier
or later Scene steps implicitly.

The grouped authoring contract is conceptually:

```text
TransitionGroup(dissolve, 500 ms, wait) {
    SetBackground(courtyard)
    ActorCue(alice, show at left)
    SetLayout(rain-overlay)
}
```

The initial child vocabulary is closed to background set/clear, actor cue, and participating Layout
set/hide/swap mutations. Children cannot wait, change Flow, run Lua, issue external requests, or carry
other side effects. Layout children must resolve to `WorldOverlay`; `GameUi`, ActiveText, menus,
modals, debug UI, and letterbox bars are excluded. Background and actor children participate in
`WorldBackground` and `WorldContent` respectively.

`cut` is immediate and requires zero duration, no wait, and no color. `fade` and `dissolve` require a
positive duration; `dissolve` accepts no color. Every child has a stable group-local ID, and the group
must contain at least one child. Validation builds a temporary target and commits nothing on failure.

The compiled contract is `TransitionGroupInstruction`. Shared finite-operation contracts bind an
accepted animated group to a typed world-composition target, gameplay clock, skippable policy,
source/target `PresentationSnapshotRevision` values, optional exact Flow completion ownership, and
checkpoint class. Non-awaited work is disposable; awaited work is causal. Runtime commits and
publishes the complete target first, then the presentation coordinator delivers the revision-bound
operation to the world backend. The barrier remains active until the backend publishes the exact
terminal acknowledgement.

Standalone finite presentation policies use the same strict timing rules. `none` and background
`cut` require zero duration and cannot wait. Background `fade`, actor `fade`/`slide`, and Layout
`fade` require positive duration. Actor `slide` is valid only for show, hide, and move. The background
action's `color` is durable target content, not a transition fade color. Compiled instructions retain
duration, exact presentation-wait intent, and skippability. Background cross-fade, actor fade/slide,
and Layout fade use the same coordinator lifecycle as grouped transitions. Same-target replacement
supersedes only that background, actor key, or mounted Layout key; different actor/Layout identities
may remain active concurrently. Skip, reset, owner termination, or project reload discards transient
realization and leaves the already-published target authoritative.

## Authoring, compiled, and state disposition

- **Authoring:** collection-specific Scene record with strict ordered steps and explicit terminal continuation.
- **Compiled:** immutable `SceneDefinition` plus `SceneProgram`, linked typed references, and compiler-marked safe points.
- **Mutable:** Scene `FlowFrame`, actor state, logical waits, and invocation-local execution data in `SessionState`; the Scene definition itself has no Property/Trait state.
- **Tooling only:** comments, selected step, timeline/graph coordinates, preview playback/background,
  categories, tags, colors, and sort keys.

Conditions and Lua text expressions are synchronous. RunLua may yield through an engine-owned handle
bound to the Scene frame. Lua coroutine state is never saved. Autosaves occur only at compiler-marked
safe points.

## Authoring implementation

The authoritative Scene authoring boundary lives in
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
`noveltea.scene-preview`; it does not mutate or annotate the authoring record.

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
