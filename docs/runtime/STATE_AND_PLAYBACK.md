# Runtime State and Playback

## Target contract

`RuntimeSessionHost` owns one immutable `CompiledProject` by value, one `FlowExecutor`, and mutable `SessionState`. Top-level gameplay mode is exactly Room, Flow, or Ended. Loading/error UI is host state, not persisted gameplay mode.

`SessionState` owns typed globals, property overrides, active frames and stable cursors, visits/history/show-once markers, actor state, unique Interactable state/location, queues, timers, and logical waits. Definitions and decoded JSON are never mutable state.

`SaveState` is an explicitly versioned subset. It stores logical progress and stable flow positions, not renderer, RmlUi, audio backend, tween, or Lua VM state. Save-policy property overrides serialize once on their actual owner; inherited values and Session-policy overrides do not. Explicit duration waits save remaining logical time. Visual/audio operations restore to logical post-step state.

Manual save fails with typed diagnostics at nonserializable suspension points. Autosaves occur only at compiler-marked safe points after associated effects complete. Engine-defined serializable wait tokens are the only saveable script suspensions.

## Flow and startup

Entrypoint is exactly Room, Scene, or Dialogue. A separate synchronous startup Lua hook must succeed before it begins. `SessionState` owns the authoritative stack and blocker, while one `FlowExecutor` is the sole mutation service for Scene, Dialogue, Interaction, and RoomTransition frame variants. Child Scene/Dialogue calls advance the caller before pushing and Return resumes it; terminal Scene/Dialogue targets tail-replace, Room targets begin the shared Room transition pipeline, and End clears flow according to the fixed continuation contract.

Playback, RmlUi, editor preview, tests, debugger, and C ABI adapters decode boundary input into typed internal commands and expose typed events/views. Internal command/event/state payloads contain no JSON.

## Additive typed kernel state

Phases 6A through 6F add a JSON-free `SessionState`, execution kernel, shared primitive evaluator,
typed Lua invocation boundary, and closed typed Lua host-request vocabulary beside the shipped path.
Session creation initializes declared variables and one typed
entrypoint frame: Scene and Dialogue roots use `NoReturn`, while Room entry starts the shared
pre-entry `RoomTransitionFrame`. The public mode, stack, blocker, and fault views are read-only;
`FlowExecutor` is the only mutation service after initial construction.

The session-owned `FlowStack` is a closed Scene/Dialogue/Interaction/RoomTransition variant with
opaque fresh frame IDs, stable typed positions, and Caller/ResumeRoom/NoReturn destinations. Child
calls validate and advance their caller before an atomic push. Return, terminal tail replacement,
Room transition, rejection, completion, and End enforce the fixed mode/stack contract. Owner-bound
blockers require an exact frame, handle, and kind match. Execution faults are fail-stop without an
Error gameplay mode, and explicit discard selects the captured Room, the pre/post-commit transition
Room, or Ended according to the frame contract. The core-only bounded driver still returns a typed
not-yet-migrated fault for feature frames that need script-aware dispatch. The additive
`TypedExecutionKernel` now owns the sole typed Scene visitor and uses the same `FlowExecutor` for
every cursor, stack, blocker, continuation, and fault mutation. Dialogue, RoomTransition, and
Interaction visitors remain owned by their later Phase 7 slices.

`PropertyResolver` remains the sole typed property read/mutation path for this state. It validates the
property declaration, owner existence and kind, nullability, enum membership, scalar type, and finite
numbers. Reads traverse the immutable same-type parent indexes directly in runtime-override,
authored-assignment order at each level, then use the declaration default or return a typed missing
value. Overrides remain sparse on their actual owners, so ancestor changes are immediately visible
without a resolved-value cache.

`SharedPrimitiveEvaluator` is the common core boundary for conditions, effects, text sources, and
engine waits. It evaluates Always and declared-variable comparisons without coercion, applies
SetVariable through `SessionState`, and resolves inline/localized text through
requested/default/fallback catalog order. Its Lua variants remain explicit script-boundary errors so
backend-neutral core does not depend on Lua. The engine-layer `ScriptInvoker` consumes those typed Lua
predicate, text, effect, and startup values. Immediate contexts reject yields; yield-capable effects
return a closed Completed/Suspended result and retain an opaque coroutine only while an exact
frame-owned Script blocker is active.

Input, duration, presentation, and audio waits allocate owner-bound typed blockers; duration blockers
retain remaining logical milliseconds and advance deterministically. Immediate waits complete
synchronously. ChildFlow remains an atomic frame call rather than a blocker, and opaque Script
suspensions remain nonserializable and separate from engine-defined logical waits. Completion,
cancellation, duration advancement, and Lua resume require the exact owner and typed handle; stale or
mismatched operations leave the active wait unchanged.

`ScriptHostServices` uses the same `SessionState` and `PropertyResolver` paths for declared variable
and property mutations. It validates definition IDs, property owners and values, Interactable
placement ownership, active mode, Room exits, and flow targets before queuing a closed
`ScriptHostRequest`. Transient starts, child calls, and tail replacements remain distinct request
variants. Requests are not executed in Phase 6E; Phase 7 frame visitors and Phase 9 adapters own that
work. After Phase 7A, `noveltea.interactables.location` reads the shared live Interactable state.
Movement requests remain validated queued values until Phase 7E consumes them. The same closed queue
now carries Scene autosave-safe-point requests after the associated instruction, wait, child
Dialogue, or ordered choice effects have completed; persistence remains Phase 8 and external request
adaptation remains Phase 9.

This path is additive. Host-request consumption, persistence codecs, and consumer cutover remain
owned by later phases. It does not adapt
compiled data back into legacy data or reroute Engine, preview, package launch, editor playback, Lua,
or runtime UI consumers.

## Phase 7A typed feature state and views

Phase 7A extends the additive `SessionState` with the shared mutable state required by the feature
executors without implementing those executors. Scene-local `ActorState` is keyed by
`{ SceneId, ActorSlotId }`; each value is validated against a compiled ActorCue, Character, pose, and
expression. Every compiled Interactable receives exactly one live `InteractableState` initialized
from its declaration, and named operations validate movement to Inventory, Nowhere, or a matching
Room placement as well as enabled/visible changes.

The same state owner records Room visit counts, Dialogue line/show-once and choice history, typed
text-log entries with closed origins, resolved presented text, Scene or Dialogue choices, current
background, layout slots, Room overlays, logical transition completion, audio-channel state, and Map
visibility/mode/focus. All containers remain read-only to consumers; mutation uses named
`Result`-returning operations that validate IDs, nested IDs, resources, enum ranges, and values
against the immutable `CompiledProject` before changing state. `FlowExecutor` remains the sole owner
of flow-stack, cursor, blocker, and mode mutation.

`FeatureView` is a closed JSON-free variant of Scene, Dialogue, Room, Interaction, Inventory, and Map
view records, with separate typed Actor and text-log snapshots used by those presentation contracts.
These are snapshot/output contracts rather than a second state owner. Phase 7B through 7F build the
corresponding executors and typed RmlUi adapters. The shipped controller-backed `RuntimeUIViewState`
path remains unchanged until the later atomic consumer cutover.

`script::TypedExecutionKernel` is the composition root for this additive path. It owns one
`SessionState` and composes one `FlowExecutor`, `SharedPrimitiveEvaluator`, `ScriptHostServices`, and
`ScriptInvoker` against the same immutable `CompiledProject`. Its closed dispatch methods route Lua
and non-Lua Condition, Effect, and TextSource variants to the appropriate validated service while
preserving typed errors. It exposes wait and exact script-resume/cancel operations and, after Phase
7D, executes the complete flat Scene V1 program, compiled Dialogue V2 graph, and typed Room lifecycle
transaction. Interaction instruction execution and queued external request consumption remain
deferred to their owning phases.

`FlowExecutor` remains one logical, noncopyable authority over flow-stack, cursor, blocker, mode, and
fault mutation. Its implementation is partitioned by responsibility: generic stack and run-loop
orchestration remains in `flow_executor.cpp`, while typed blocker operations, Room-transition
operations, Scene cursor/wait/choice operations, and Dialogue cursor/wait/choice operations live in
dedicated translation units. Room transition cursor/wait operations remain in the dedicated Room
translation unit, while the typed Room visitor composes those operations with shared evaluators and
session state. Later Interaction frame operations should follow the same
implementation split rather than creating competing flow-state owners.

## Phase 7B typed Character/Actor and Scene execution

The additive Scene visitor executes every compiled Scene instruction without JSON: step conditions,
background and actor cues, text, audio, variables, yield-capable Lua, input, duration, presentation,
and audio waits, branches, choices with ordered effects, layouts, transitions, child Dialogue calls,
and terminal continuations. Stable Scene IDs remain at the current instruction while a wait, Lua
suspension, choice selection, or choice effect is incomplete. Exact blocker ownership is required to
resume, cancel, advance, or choose; invalid and stale operations leave the cursor and presentation
state unchanged.

Scene-local actors are created or updated only through validated `SessionState` operations. Their
Character, pose, expression, logical placement, visibility, and logical presentation-completion state
are live values; `CharacterDefinition` remains immutable. Resolved Scene text, choices, actors,
backgrounds, layouts, transitions, and audio channels are exposed through a JSON-free `SceneView` for
runtime-UI consumers. Scene safe points emit typed host requests only after the associated unit has
completed, including after a child Dialogue returns and after every selected choice effect commits.

The controller-backed `CutsceneController` remains transitional Phase 10 deletion debt because the
shipped runtime UI, preview, playback, debugger, and package consumers have not yet made their atomic
cutover. Phase 7B does not route those consumers through the additive kernel and does not implement
Room, Interaction, Map, persistence, or external adapter behavior.

## Phase 7C typed Dialogue execution

The additive Dialogue visitor executes compiled Sequence, Choice, and Redirect blocks without JSON.
It resolves Line and RunLua segments, Next and Choice edges, synchronous conditions and text sources,
speaker fallback, ordered effects, typed input and script blockers, redirects, nested Return, and
terminal completion through the shared flow stack. The frame retains stable block, segment, edge,
and effect positions while input or Lua is suspended. Failed effects, invalid targets, stale handles,
and disabled selections do not partially advance the cursor.

Dialogue history, show-once state, current line, active choice, and text log remain owned by
`SessionState`. `showDisabledChoices` controls visibility only; disabled options remain
unselectable. Global log mode and per-item suppression are applied before session-owned typed log
entries are appended. Line and choice safe points queue distinct typed host requests only after their
ordered effects complete. Runtime-facing presentation is exposed as a JSON-free `DialogueView`.

The controller-backed `DialogueController` remains transitional Phase 10 deletion debt. Phase 7C
does not reroute the shipped runtime UI, preview, playback, debugger, package player, persistence, or
external request adapters; those consumers remain subject to the planned atomic cutover.

## Phase 7D typed Room execution

The additive Room visitor executes initial entry, direct exit navigation, and Room flow targets
through one `RoomTransitionFrame`. It evaluates source `canLeave`, the selected exit condition, and
target `canEnter` before hooks or the room-switch commit. Before-leave, before-enter, after-leave, and
after-enter effects advance one indexed unit at a time. Yielding Lua effects retain the exact stage
and effect index and require the matching frame-owned script handle before advancement.

The room-switch commit atomically validates and publishes the target background, authored overlay
defaults, and visit increment before post-switch hooks run. Rejection before that boundary resumes
the source Room without running hooks. A pre-commit fault discards to the source; a post-commit fault
discards to the target. An initial rejected or faulted transition with no source Room ends the typed
session because no valid Room exists to resume.

In completed Room mode, typed inputs start exit navigation or transient Scene/Dialogue flows.
`RoomView` resolves the Room description, exits, placement labels, overlays, and live Interactable
placement visibility from `CompiledProject` plus `SessionState`. Room property reads and mutations
use the sole shared `PropertyResolver`; runtime ancestor changes are immediately visible to
unshadowed descendants and do not copy values into child state.

The shipped controller-backed Room, runtime UI, preview, playback, debugger, package player,
persistence, and external request adapters remain transitional Phase 10 cutover debt. Phase 7D does
not implement Map presentation/execution.

## Phase 7E typed Interaction execution

The additive Interaction visitor accepts a typed Verb plus ordered Interactable operands only from
completed Room mode. It validates operand count and live enabled state, evaluates the complete Verb
availability chain root-to-child, and selects one matching Interaction rule by exact-operand count
before explicit wildcards, with compiled declaration order as the final deterministic tie-break.
Active-Room, Room-placement proximity, and predicate contexts are evaluated against typed session
state and shared conditions. Equal-specificity authoring ties continue to produce compiler warnings.

Interaction programs execute ApplyEffect, MoveInteractable, SetInteractableState, Notify, CallScene,
and CallDialogue instructions with a stable typed cursor. Yielding Lua effects retain the exact
instruction until the frame-owned script blocker completes. Child Scene and Dialogue frames return
to the next Interaction instruction. Handled programs apply their typed FlowTarget; Unhandled
programs continue from the selected rule to Verb defaults child-to-root. Failed instructions
fail-stop without fallback. After the root remains Unhandled, V1 emits the deterministic typed
undefined-interaction notification, `Nothing happens.`; the wire currently has no separate authored
project fallback program.

`SessionState` remains the only owner of Interactable location, enabled, and visible state.
`InteractionView`, `InventoryView`, and Room interaction controls expose typed presentation without
generic JSON. Quick verbs are marked explicitly and every control reports inherited availability.
The shipped controller/runtime-UI consumer path remains Phase 10 cutover debt; final typed RmlUi and
Map integration remain Phase 7F.

## Current scaffold

The shipped path still uses `GameSession`, `RuntimeController`, JSON-bearing `RuntimeInput`/`RuntimeOutput`, `SaveDocument`, controller snapshots, numeric entities, and `ProjectModel`. `RuntimeSessionHost::apply_input`, deterministic playback, slot-store abstraction, and editor test integration are useful seams to retain, but their payloads and internals are replaced in Phases 6--10.

Current save preservation of unknown legacy keys, fake player-object inventory locations, Script entrypoints, and controller JSON are temporary behavior, not future policy. Platform slot persistence and production save/load RmlUi remain deferred implementation work.

## Relevant consumers and tests

Consumers include Engine loading/ticking, RmlUi runtime UI, Lua execution, editor preview/test playback, debugger mutation/snapshots, and package players. Existing coverage includes runtime host/controller/session/save/editor API/UI-view tests and editor playback/export tests; later phases replace assertions as each seam migrates.

## Current input/output boundary to retain

The existing backend-neutral driving seam is
`RuntimeSessionHost::apply_input(const RuntimeInput&)`. Headless tests, editor preview injection, and
RmlUi actions already converge on it. Current inputs include lifecycle Start/Stop/Reset, deterministic
Tick, Continue, Dialogue choice, navigation, Object selection/clearing, Action execution, save load,
entrypoint changes, and editor test steps.

The concrete names and JSON-bearing payloads are transitional, but these properties are useful:

- mode-specific input validation happens in runtime code rather than UI handlers;
- invalid input returns `handled = false` plus diagnostics;
- all callers receive the same deterministic state transition path;
- recorded playback can reuse exactly the same input API.

`RuntimeInputResult` currently returns `handled`, a backend-neutral `RuntimeUIViewState`, deterministic
outputs, and diagnostics. `RuntimeSessionHost` translates internal `ControllerCommand` batches into
mode, script-request, notification, text-log, save-mutation, and view-update outputs. Phase 9 replaces
the string/JSON variants, not the host boundary or the principle that controllers do not directly
drive RmlUi/editor code.

## Current save behavior to migrate

The current host can snapshot `GameSession` plus controller state into `SaveDocument`, store/load
typed slot IDs through `SaveSlotStore`, and use `MemorySaveSlotStore` for tests and preview. Platform
file, browser, and Android persistence deliberately remains outside core.

Current saves preserve recognized legacy fields and unknown JSON keys, store controller data under
`_novelteaRuntime`, and represent inventory through a fake player/Object location. Object placement
falls back through save locations, project Room membership, then `startInv`.

Those representations are explicitly replaced, but the working capabilities must remain covered:

- snapshot and restore live progress;
- manual save/load and reserved autosave;
- stale-reference diagnostics;
- backend-neutral slot storage;
- save-backed Interactable placement;
- deterministic restoration of the active flow/UI view.

The target `SaveState` removes unknown-key preservation, fake entity locations, and controller JSON,
then represents the same capabilities with strong IDs, typed Interactable locations, typed flow
frames, and declared persistent properties.

## Current recorded playback behavior

`core::editor::RuntimePlaybackSession` currently accepts a `RuntimePlaybackSpec`, loads a project,
emits an initial zero-delta tick, and applies each recorded step through `RuntimeSessionHost`.
Non-tick inputs receive a zero-delta drain tick using the same playback-step index so queued controller
commands settle deterministically.

Project test records use `init`, `steps`, and `check`. Core records hook source and script-request
outputs; the engine/script layer may execute setup/check Lua and return diagnostics. Reports contain
pass/fail, per-step observations, outputs, diagnostics, final preview state, and stable JSON export.

This runner is a valuable acceptance harness for the migration. Each typed feature slice should
replace its assertions and payloads while preserving deterministic step execution and reportability,
rather than introducing a separate test-only runtime path.
