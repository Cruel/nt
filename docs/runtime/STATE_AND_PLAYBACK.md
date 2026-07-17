# Runtime State and Playback

## Runtime Composition

`runtime::RunningGame` owns one validated `LoadedCompiledPackage` and constructs one
`runtime::RuntimeSession`. The session references immutable `CompiledProject` definitions and owns
the mutable execution composition: `SessionState`, feature state/views, `FlowExecutor`, script
gateway, playback state, and pending typed operations.

Gameplay mode is represented by typed Room, Flow, or Ended state. Presentation loading/error UI is
not persisted gameplay mode.

## State

`SessionState` stores typed variable values, typed property overrides, room visits, interactable
locations, history, inventory selection, deterministic random state, session-only gameplay pause,
and authoritative desired-presentation records. Desired presentation uses one closed owner vocabulary:
live Scene invocation, current Room visit, named Room, runtime session, or shell. Actor, background
override, presentation-only prop, environment/loop, and mounted-Layout records carry stable typed
identities. Presentation plane does not imply authority; gameplay and shell records remain independent.
Reads resolve through:

1. a typed session override;
2. the validated compiled definition/property declaration and inheritance graph;
3. the declared default.

There is no JSON property bag, fake player object, legacy parent lookup, or mutable
`ProjectDocument`.

Feature-specific state publishes `TypedRuntimeUIViewState` for Room, Scene, Dialogue, Interaction,
Inventory, TextLog, and Map presentation. The UI receives a value view and stable IDs; it cannot
mutate state except through runtime inputs.

Scene-owned desired records are removed with their exact invocation frame. Current-Room records are
removed only after a successful Room departure, while named-Room records remain stored and become
inactive outside their Room. Room overlays are not a separate runtime lifecycle: authored overlays
lower to ordinary Room-owned mounted-Layout records. Reserved Layout slots remain deterministic
authoring/runtime shorthand for stable mount keys.

The view keeps authored `gameplay_paused` separate from `effective_gameplay_pause`. The latter is a
typed, non-persistent derivation of the authoritative explicit session value, visible mounted Layout
`PauseWhileVisible` requests, platform suspension, and engine/runtime suspension. The engine supplies
that same derived fact to both the gameplay clock and typed runtime input admission. Lua pause/resume
reads and mutates only the explicit session value; removing any one derived source cannot clear
another source.

## Inputs and Outputs

`RuntimeSession::dispatch(RuntimeInputMessage)` is the single input seam. The closed variant
covers lifecycle/time, continue/choice/navigation/interaction, debug mutations, typed save/load,
playback controls, and acknowledgement/cancellation of typed presentation/audio operations.

The settled `RuntimeDispatchResult` contains a disposition, at most one coherent
`RuntimePublication`, ordered `RuntimeEvent` values, diagnostics, and a closed budget outcome. The
budget outcome distinguishes normal completion, deterministic instruction-budget yield, rejected
self-generating command cycles, and Flow execution faults. The publication carries the gameplay UI
view, desired presentation snapshot, and idempotent observations in one settled envelope revision.
The presentation snapshot also carries its own strong target revision, which increments only when the
complete effective logical target changes; UI-only, observation-only, and backend-progress changes do
not advance it.
Presentation/audio operations are submitted synchronously through `PresentationRuntimePort` before
checkpoint settlement rather than emitted for UI discovery. Notifications, save outcomes, and
one-time observations are ordered events. Runtime-owned navigation, Flow, Interactable, and autosave
work stays inside the session-owned deferred command queue and never receives an external request
identity. Desired-presentation upsert/remove and reserved-Layout set/clear commands use that same
queue. Gameplay command capabilities reject shell-owned desired records. Payloads are typed C++
values, not generic JSON.

External editor/Web boundaries decode or encode named protocol DTOs around these variants. They do
not become runtime state.

Physical host input and gameplay commands emitted by Layout Lua are admitted through the mounted
Layout input-policy evaluation before gameplay handling. RuntimeUI routes host events through typed
lifecycle contexts from the top visible plane downward. A consumed event or `Modal` context stops
lower presentation delivery. `BlockGameplay` still permits lower presentation contexts to handle an
otherwise unconsumed event, but the mounted-policy result prevents subsequent gameplay fallthrough.
`Normal` permits gameplay only when eligible UI does not consume the event. System lifecycle,
save/load, and operation acknowledgements retain separate trusted typed paths.

## Flow and Waiting

`FlowExecutor` and specialized Room/Scene/Dialogue/Interaction handlers execute compiled programs.
Flow frames, continuations, blockers, and correlation handles use strong IDs. Input, duration,
presentation, audio, child-flow, and script waits are explicit. Presentation and audio completion
must acknowledge the exact owner/blocker handle before the wait is consumed.

## Saves

`SaveState` is a typed native snapshot. Its codec is an explicit serialization boundary and
validates project identity/version, strong IDs, runtime values, flow state, blockers, feature state,
and safe-point rules.

Save format V5 persists the deterministic random-generator position and authoritative desired
presentation. It stores logical identities and owner-remap data rather than effective snapshot caches,
backend handles, or operation progress. Scene owners remap through snapshot-local Flow-frame IDs;
current-Room owners bind to the restored visit; named-Room and session owners restore semantically;
shell records are intentionally excluded. Exact authored Room-overlay defaults rebuild from compiled
definitions, while runtime mutations persist. Actor records retain only their selected idle ID.
Runtime-selected environment records retain owner/instance/stop key, typed resource and geometry
parameters, plane/order, clock, scroll rate, opacity, and visibility. Immutable Room environment
defaults rebuild from `RoomDefinition` and are intentionally omitted from save bytes. Active text,
active choice, and Map intent are retained.
Semantic gameplay pause is deliberately excluded: a successful restore resumes the saved gameplay
mode rather than inheriting a pre-load pause flag.

Environment and idle loop phase, backend epochs, material/GPU resources, effective snapshots, and
finite-operation progress are never encoded. Restore validates every saved owner and resource before
publishing a fresh `SessionState`; invalid records fail atomically. Room resolution and presentation
projection then rebuild the effective target, and a fresh world backend starts reconstructible loops
at phase zero without fabricating a completed operation.

`TypedSaveSlotStore` persists encoded save bytes without owning a JSON DOM. The memory
implementation supports preview/tests; the filesystem implementation supports players and keeps
slots below its configured root.

`RuntimeSession` owns the runtime checkpoint service and one private, non-reentrant outer
dispatch transaction. Nested Flow, Lua, and deferred-command work appends to that transaction rather
than recursively dispatching. After commands and synchronous presentation/audio acceptance settle,
the service receives typed queue, Flow, Lua, presentation-barrier, and mutation facts. It publishes
deterministic readiness and an immutable retained candidate only at an eligible boundary. Structural
changes capture immediately; time-only changes coalesce on one second of deterministic elapsed
runtime input, while unchanged idle transactions do not re-encode.

The current presentation boundary publishes a transitional causal status before backend work.
Awaited presentation/audio, voice and gameplay SFX until semantic termination, ActiveText reveal/fade,
live transition progress, and live audio-channel progress block checkpoint replacement. Stored desired
presentation no longer makes an otherwise safe checkpoint ineligible.

Save/load requests travel through `SaveRuntimeInput` and `LoadRuntimeInput`. Unsupported or unsafe
save points return typed outcomes/diagnostics. `SaveDocument` and controller checkpoint JSON no
longer exist.

## Playback and Debugging

Authoring tests compile with the project and lower to the named editor playback protocol. Playback
drives the same `RuntimeSession` input seam used by interactive preview. Observations and final
debug snapshots are encoded from typed views, outputs, diagnostics, and stable IDs.

Supported commands include lifecycle/time, continue, stable dialogue/scene choices, room exits,
interactable selection, typed interaction invocation, and declared debug state changes. Unsupported
selector clicks, index-only ambiguous targets, arbitrary playback Lua, and old assertion forms fail
validation rather than taking a compatibility path.

Recorder begin/end/clear/undo/replay are typed session inputs. Replayed steps therefore exercise the
same runtime state machine as live actions.

## Presentation Boundary

`RuntimeUI` consumes typed publications/events and emits typed inputs through a host-provided
callback. Engine host orchestration owns session dispatch, desired-presentation reconciliation,
backend flushing, and later completion-input queuing. RuntimeUI stores no runtime-session pointer,
presentation-operation handler, or completion queue. Layout, transition, tween, audio, ActiveText,
and direct-render code remain presentation backends only. They cannot inspect compiled gameplay JSON
or own Flow/session/save state.

Typed audio operations are consumed by `RuntimeAudioAdapter`. It resolves only compiled audio Asset
IDs, translates the typed channel/action/options to `AudioSystem`, reports backend failures through
the runtime diagnostic seam, and returns exact completion inputs for awaited operations. Neither
`SessionState` nor Lua owns audio backend handles.
## Presentation coordination

Live presentation and audio outputs are accepted by the engine-owned `RuntimePresentationBridge`
and `core::PresentationCoordinator` before backend delivery. The coordinator owns total operation
ordering, lifecycle, and presentation checkpoint barriers. `RuntimeSession` retains operation
ID allocation and exact Flow/script completion validation, and consumes the coordinator's immutable
status only when the outer dispatch transaction settles. Reset and load terminate old operations
without synthesizing successful completion, then reconcile a fresh projected snapshot.

RmlUi is a snapshot backend. Gameplay mounted-Layout desired records, including authored Room overlays
lowered to Room-owned mounts, reconcile into ephemeral instances from compiled document/fragment
resources. The snapshot carries each mount's stable key, owner, full mounted policy, plane/order, and
composition group. The backend applies that policy directly; the old slot/overlay snapshot shape and
target-derived policy reconstruction are removed.
