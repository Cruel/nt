# Scene Component

## Contract

Scene is the canonical visual-novel orchestration component; new code never uses Cutscene. A
`SceneDefinition` owns immutable metadata, one invocation Stage policy, and a specialized flat
`SceneProgram`. Scene is not a universal command stream, graph VM, keyframe VM, or polymorphic
controller.

Scene is an immutable orchestration definition, not a stateful Property or Trait owner. Mutable Scene execution state belongs to each Scene frame/invocation in the Runtime Session.

## Program

Current Scene authoring is an ordered sequence of stable semantic Events. The Event operation union is
SetBackground, ActorCue, CallScene, StartDetachedScene, CallDialogue, ShowText, AudioCue,
SetVariable, RunLua, Wait, ConditionalBranch, Choice, SetLayout, TransitionGroup, and Comment. Comment is editor-only and
removed by compilation. Every runtime Event has a stable ID, an editor-visible timeline track,
explicit start and duration values, and zero or more completion dependencies on earlier enabled
runtime Events. Each operation contains only fields valid for its variant, including condition, wait,
and safe-point data where meaningful.

Timeline placement does not turn Scene into a graph or reorder semantic execution. Runtime starts
Events in authored order. Non-blocking operations may remain in presentation realization after the
Event cursor advances; explicit completion dependencies are the authored vocabulary for constraining
later work that must wait for earlier operation completion. The editor may render the ordered Events
as tracks and overlapping clips without introducing author-visible handlers or edges.

A Scene frame holds the mutable Event cursor, Stage-initialization state, bound typed inputs, the last
returned child Outcome, and wait/correlation state. `CallScene` and `CallDialogue` push a child frame
and resume the caller at its explicit next position after Return. Scene calls are runtime-depth
bounded so data-dependent recursion cannot exhaust the native stack or grow the Flow stack without
limit.

Every Scene has exactly one explicit terminal action. `Return` resumes a valid caller and may carry one
Outcome declared by the returning Scene. `Continue/Replace Scene` and `Continue/Replace Dialogue`
tail-replace the current invocation while preserving its original return destination. `Release to
Exploration` clears foreground Flow and resumes the existing Current Room; it is invalid when no
Current Room exists. `Complete Game` marks the playthrough complete, ends the Runtime Session's
foreground execution, and causes the host shell to return to the title/start screen without the
ordinary unsaved-progress confirmation. There is no implicit Scene fallthrough and Scene does not use
the generic Flow `End` target.

Scene inputs are named, typed (`boolean`, `integer`, `number`, or `string`), optionally nullable, and
may declare defaults. Calls and Scene-to-Scene Continue bind inputs explicitly. A direct project
Scene entrypoint therefore requires every non-nullable input to have a default. Outcomes are named
declarations local to the Scene and are valid only on Return.

`StartDetachedScene` records an explicit `flow`, `active-room`, or `runtime-session` owner and enters
the engine's deterministic deferred-command FIFO rather than recursively re-entering execution. The
launch is non-awaited: the foreground Flow advances independently while each detached invocation owns
its own Flow stack and blocker state over the same authoritative Runtime Session. Duration waits are
therefore allowed and advance independently. Detached targets are validated as background-safe: they
cannot capture exclusive player input, yield Lua, await foreground presentation/audio completion, or
handoff into foreground-only Dialogue/terminal control. Active-Room ownership additionally requires a
Current Room. Flow-owned work is cancelled when its initiating Flow ends; Active-Room work is cancelled
when that Room visit ends; Runtime-Session work lives until session termination. Detached launches
share the runtime command budget and deterministic ordering rules. Checkpoint promotion is deferred
while detached work is live until the later detached restoration/provenance contract can persist that
work without loss. Broader presentation/audio lifetime orchestration remains governed by the subsystem
ownership contracts described in the later Scene orchestration work.

## Invocation Stage

Every Scene invocation selects exactly one Stage before executing its first runtime Event:

- `inherited` leaves the caller's current presentation visible and layers Scene-owned changes over it;
- `staged-room` resolves a Room as a visual composition template without changing Current Room,
  Character/Interactable Location, Active Room Context, navigation, or Room lifecycle;
- `blank` replaces world presentation with an authored background and optional Layout without
  requiring any Current Room.

Staged Room resolution intentionally exposes no exploration Hotspots or eligible Interaction
subjects and does not execute the Room composition/lifecycle hook surface. Room cast,
Interactable occurrences, props, environments, background, overlays, and presentation-space camera
defaults may still be reused as visual composition.

Stage presentation belongs to the Scene invocation. Staged actors, props, environments, backgrounds,
and Layouts are rewritten to stable owner-qualified occurrence identities derived from the Flow frame
plus their semantic occurrence key. A nested child Scene therefore overlays its caller; when the child
returns, its owner disappears and the unchanged caller Stage is projected again. Staging never creates
or moves Gameplay Instances.

## Presentation actions and transition terminology

A Scene is an ordered program of engine actions. It is not itself a visual transition, and the word
`Transition` does not mean transferring execution from one `SceneDefinition` to another. Scene-to-
Scene execution transfer is controlled by branches, child calls, detached launches, and the Scene's
typed terminal action.

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

The standalone targetless `Transition` action has been removed from authoring, compiler, compiled wire,
and the native compiled program. It has no compatibility interpretation. A group never consumes
earlier or later Scene Events implicitly.

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

- **Authoring:** collection-specific Scene record with typed inputs and Outcomes, one explicit Stage,
  strict ordered Events, Event timeline metadata/completion dependencies, and one explicit terminal
  action.
- **Compiled:** immutable `SceneDefinition` plus `SceneProgram.events`; each compiled Event wraps one
  typed instruction with its stable ID, timeline metadata, and completion dependencies.
- **Mutable:** Scene `FlowFrame`, Stage initialization, actor/presentation state, logical waits, and
  invocation-local execution data in `SessionState`; the Scene definition itself has no
  Property/Trait state.
- **Tooling only:** comments, selected Event, scrub position/playback state, categories, tags, colors,
  and sort keys. Authored track/start/duration values are contract data, not editor-only annotations.

Conditions and Lua text expressions are synchronous. RunLua may yield through an engine-owned handle
bound to the Scene frame. Lua coroutine state is never saved. Autosaves occur only at compiler-marked
safe points.

## Authoring implementation

The authoritative Scene authoring boundary lives in
`editor/src/shared/project-schema/authoring-scenes.ts`. A Scene record contains its display name, one
Stage (`inherited`, `staged-room`, or `blank`), typed input and Outcome declarations, a non-empty
ordered Event sequence, and one explicit typed terminal action. The former same-version generic
Scene `continuation` field is not accepted. The earlier same-version `defaultBackground`, `defaultLayout`, and `steps`
shape is not accepted. Preview selection and scrub/play state are not serialized into Scene data.

Every Event operation is a strict discriminated-union member. An Event stores only fields valid for its type;
unknown fields and payloads belonging to another variant are rejected at every nested boundary.
Changing an Event type creates a fresh payload for the new type instead of retaining hidden inactive
payloads. Conditions, effects, waits, and autosave-safe-point flags are represented only on variants
where they are meaningful.

The editor supports Stage configuration, ordered creation, selection, duplication, deletion,
reordering, type replacement, variant-specific editing, track/start/duration editing, completion
dependencies, overlapping clip visualization, scrubbing, timeline playback, input/Outcome and
terminal editing, Scene-call input bindings, detached ownership, diagnostics, undo/redo, and a derived Scene preview. The preview receives its selected Event
and derived timeline data from editor state and emits `noveltea.scene-preview`; it does not mutate or
annotate the authoring record with transient playback state.

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

Do not restore legacy cutscene arrays, the superseded same-version Scene step shape, or compatibility
APIs. Tracks are an editor/timeline view over one ordered Event sequence; they are not parallel
program counters, keyframe handlers, or a general graph VM.
