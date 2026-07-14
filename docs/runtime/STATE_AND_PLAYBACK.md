# Runtime State and Playback

## Runtime Composition

`CompiledRuntime` owns one validated `LoadedCompiledPackage` and constructs one
`TypedRuntimeSession`. The session references immutable `CompiledProject` definitions and owns
the mutable execution composition: `SessionState`, feature state/views, `FlowExecutor`, script
gateway, playback state, and pending typed operations.

Gameplay mode is represented by typed Room, Flow, or Ended state. Presentation loading/error UI is
not persisted gameplay mode.

## State

`SessionState` stores typed variable values, typed property overrides, room visits, interactable
locations, history, inventory selection, and other declared mutable state. Reads resolve through:

1. a typed session override;
2. the validated compiled definition/property declaration and inheritance graph;
3. the declared default.

There is no JSON property bag, fake player object, legacy parent lookup, or mutable
`ProjectDocument`.

Feature-specific state publishes `TypedRuntimeUIViewState` for Room, Scene, Dialogue, Interaction,
Inventory, TextLog, and Map presentation. The UI receives a value view and stable IDs; it cannot
mutate state except through runtime inputs.

## Inputs and Outputs

`TypedRuntimeSession::apply(RuntimeInputMessage)` is the single input seam. The closed variant
covers lifecycle/time, continue/choice/navigation/interaction, debug mutations, typed save/load,
playback controls, and acknowledgement/cancellation of typed presentation/audio/host operations.

Results contain a disposition, closed `RuntimeOutputMessage` values, and `core::Diagnostic`
records. Outputs include view publication, presentation/audio operations, host requests, save
outcomes, playback observations, and diagnostics. Payloads are typed C++ values, not generic JSON.

External editor/Web boundaries decode or encode named protocol DTOs around these variants. They do
not become runtime state.

## Flow and Waiting

`FlowExecutor` and specialized Room/Scene/Dialogue/Interaction handlers execute compiled programs.
Flow frames, continuations, blockers, and correlation handles use strong IDs. Input, duration,
presentation, audio, child-flow, and script waits are explicit. Presentation and audio completion
must acknowledge the exact owner/blocker handle before the wait is consumed.

## Saves

`SaveState` is a typed native snapshot. Its codec is an explicit serialization boundary and
validates project identity/version, strong IDs, runtime values, flow state, blockers, feature state,
and safe-point rules.

`TypedSaveSlotStore` persists encoded save bytes without owning a JSON DOM. The memory
implementation supports preview/tests; the filesystem implementation supports players and keeps
slots below its configured root.

Save/load requests travel through `SaveRuntimeInput` and `LoadRuntimeInput`. Unsupported or unsafe
save points return typed outcomes/diagnostics. `SaveDocument` and controller checkpoint JSON no
longer exist.

## Playback and Debugging

Authoring tests compile with the project and lower to the named editor playback protocol. Playback
drives the same `TypedRuntimeSession` input seam used by interactive preview. Observations and final
debug snapshots are encoded from typed views, outputs, diagnostics, and stable IDs.

Supported commands include lifecycle/time, continue, stable dialogue/scene choices, room exits,
interactable selection, typed interaction invocation, and declared debug state changes. Unsupported
selector clicks, index-only ambiguous targets, arbitrary playback Lua, and old assertion forms fail
validation rather than taking a compatibility path.

Recorder begin/end/clear/undo/replay are typed session inputs. Replayed steps therefore exercise the
same runtime state machine as live actions.

## Presentation Boundary

`RuntimeUI` consumes typed view publications and dispatches typed inputs. Layout, transition, tween,
audio, ActiveText, and direct-render code remain presentation backends only. They cannot inspect
compiled gameplay JSON or own Flow/session/save state.
