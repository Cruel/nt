# Runtime State and Playback

## Runtime Composition

`runtime::RunningGame` owns one validated `LoadedCompiledPackage` and constructs one
`runtime::RuntimeSession`. The session references immutable `CompiledProject` definitions and owns
the mutable execution composition: `SessionState`, the `RuntimeWorld` Gameplay Instance boundary,
feature state/views, `FlowExecutor`, script gateway, playback state, and pending typed operations.
`RuntimeWorld` is stored with the session-owned runtime executor and borrows both `CompiledProject`
and `SessionState`; it does not copy definitions or create a second mutable state authority. Runtime
consumers obtain immutable Room, Character, and Interactable configuration only through
`RuntimeWorld::resolved_configuration(...)`, and gameplay-instance Property reads use `RuntimeWorld::resolve_property(...)` so Trait-backed Property resolution remains behind one world/property-resolution seam.

Gameplay mode is represented by typed Room, Flow, or Ended state. Presentation loading/error UI is
not persisted gameplay mode.

## State

`SessionState` stores typed variable values, typed property overrides, room visits, interactable
locations, Character world state, history, inventory selection, deterministic random state,
session-only gameplay pause, and authoritative desired-presentation records. Production runtime
lookup and mutation of declared Rooms, Characters, and Interactables crosses `RuntimeWorld`; the
underlying values remain owned by `SessionState` and the definitions remain owned by immutable
`CompiledProject`. Desired presentation uses one closed owner vocabulary:
live Scene invocation, current Room visit, named Room, runtime session, or shell. Actor, background
override, presentation-only prop, environment/loop, and mounted-Layout records carry stable typed
identities. Presentation plane does not imply authority; gameplay and shell records remain independent.
Identity-scoped Property reads resolve through the target runtime override, the target's own authored assignment, any compatible configured Trait value attached to that target, the declaration default, and finally a typed missing result. Global Properties resolve their runtime override before their required authored default. Trait requirements and conflicting providers are rejected before runtime publication.

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

Room execution mode and current-Room identity are intentionally distinct during navigation. The
Room-transition frame remains Flow-owned until its presentation wait and after-leave/after-enter
effects finish, so gameplay commands stay blocked. The authoritative Room visit changes at the
commit boundary, however, and publications expose that committed Room immediately as the persistent
base Room context. A nested Scene, Dialogue, or Interaction started by an after-enter effect may be
published beside that Room context; it does not delay or replace current-Room identity. Room
description continuation remains suppressed while the transition lifecycle is still Flow-owned.

## Saves

`SaveState` is a typed native snapshot. Its codec is an explicit serialization boundary and
validates Project identity plus the compiler-produced Save Contract, strong IDs, runtime values,
flow state, blockers, feature state, and safe-point rules. Normal load is strict and atomic: a missing
or mismatched Save Contract, stale declaration/reference, invalid value/type, or invalid Flow position
rejects the save without migration, repair, or partial restoration. The saved Project version remains
metadata and need not equal the currently loaded Project version when identity and Save Contract match.

Save format V8 persists the deterministic random-generator position and authoritative desired
presentation. It also persists every exact live Item Stack, the deterministic next-Stack allocator,
and validated engine-owned Layout State Slots. Ended Stack identities and authoritative references to
them are invalid. Layout Slot values are recursive Persistable Value trees validated against the
compiled Layout State Shape; arbitrary Lua VM state, RmlUi DOM/focus state, metatables, and backend
objects are never encoded. It stores logical identities and owner-remap data rather than effective
snapshot caches, backend handles, or operation progress. Visit, Room, Flow, and Session Slot owners
remap with the same semantic lifetime rules as their runtime owners. Scene owners remap through
snapshot-local Flow-frame IDs; current-Room owners bind to the restored visit; named-Room and session
owners restore semantically; shell records are intentionally excluded. Exact authored Room-overlay defaults rebuild from compiled
definitions, while runtime mutations persist. Actor records retain only their selected idle ID.
Runtime-selected environment records retain owner/instance/stop key, typed resource and geometry
parameters, plane/order, clock, scroll rate, opacity, and visibility. Immutable Room environment
defaults rebuild from `RoomDefinition` and are intentionally omitted from save bytes. Active text,
active choice, and Map intent are retained. Runtime-selected desired Music and Ambient records retain
stable instance/owner identity, Asset, volume, semantic fade policy, and optional replacement key.
Transient voice, sound-effect, and non-looping playback operations are not state and are omitted.
Semantic gameplay pause is deliberately excluded: a successful restore resumes the saved gameplay
mode rather than inheriting a pre-load pause flag.

Environment, idle, and audio loop phase, decoder/sample position, backend epochs and handles,
material/GPU resources, effective snapshots, and finite-operation progress are never encoded. Restore
validates every saved owner, Layout State Shape/value, and resource before publishing a fresh
`SessionState`; invalid records fail atomically. Stateful Layout realization is then staged hidden,
input-disabled, non-pausing, and non-dismissible while reconstructed Slot values and resolved bindings
are already available to synchronous Layout Lua. The authored policy is admitted only after that local
reconstruction succeeds. Room resolution and presentation projection then rebuild the effective
target, and fresh world/audio backends start reconstructible loops at phase zero without fabricating a
completed operation or replaying an acknowledged one-shot.

`TypedSaveSlotStore` persists encoded save bytes without owning a JSON DOM. The memory
implementation supports preview/tests; the filesystem implementation supports players and keeps
slots below its configured root.

`RuntimeSession` owns the runtime checkpoint service and one private, non-reentrant outer
dispatch transaction. Nested Flow, Lua, and deferred-command work appends to that transaction rather
than recursively dispatching. After commands and synchronous presentation/audio acceptance settle,
the service receives typed queue, Flow, Lua, presentation-barrier, and mutation facts. It continuously
publishes deterministic readiness and replaces one immutable retained candidate only at an eligible
semantic boundary. Structural changes capture checkpoint state immediately; time-only changes coalesce
on one second of deterministic elapsed runtime input, while unchanged idle transactions do not
re-encode. A manual save is retained by default: it immediately writes the latest already-promoted
checkpoint and never forces capture of the current live state. An autosave is deferred by default: it
waits for the first newly promoted eligible checkpoint after the request and pins that exact revision
for retry if the slot write fails. Retained checkpoint publication does not request a visual thumbnail.
A thumbnail capture is queued only after a manual save, autosave, or other typed save-slot write
actually persists that checkpoint, and the asynchronous result updates only slots still bound to the
same checkpoint revision.

The presentation coordinator publishes exact causal status before backend work. Awaited finite
presentation/audio, voice and gameplay SFX until semantic termination, ActiveText reveal/fade, and any
opaque Lua suspension block checkpoint replacement. Those barriers do not invalidate the latest
retained checkpoint, so a manual save can still persist it while new promotion is ineligible.
Reconstructible desired actor idles, environment loops, Layouts, validated Layout State Slots, and
desired audio remain checkpoint-safe; backend transition progress, tween progress, audio voices,
decoder positions, arbitrary Lua tables, and RmlUi state are never runtime checkpoint facts.

Save/load requests travel through `SaveRuntimeInput` and `LoadRuntimeInput`. Unsupported or unsafe
save points return typed outcomes/diagnostics. `SaveDocument` and controller checkpoint JSON no
longer exist.

System save/load menus consume the published `CheckpointRuntimeObservation` and query
`TypedSaveSlotStore` for slot contents, then dispatch the same typed runtime inputs. Menu navigation,
confirmation state, and the mounted shell stack remain shell-owned ephemeral state and are cleared by
reset/load/project reload. Runtime user settings are passed as the typed `RuntimeUserSettings` value
and are not stored in gameplay checkpoints. Their separate strict V2 persistence document contains
independent UI and text scales. Loading clamps both values against the accessibility policy on the
validated loaded compiled project, while disabled settings resolve to `1.0`; the provisional V1
document is unsupported. A project reload retains the user selections only through that new
project's authoritative policy rather than interpreting bootstrap accessibility metadata again.

## Playback and Debugging

Authoring tests compile with the project and lower to the named editor playback protocol. Playback
drives the same `RuntimeSession` input seam used by interactive preview. Reports encode the final
`RuntimePublication` with its gameplay UI view, presentation revision/summary, and published
observations alongside ordered events and diagnostics. Interactive preview retains that same coherent
publication directly; it does not read state back through RuntimeUI or recompute checkpoint facts.

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

`RuntimeAudioAdapter` starts audio only from mandatory published `AssetLease<AudioAsset>` values.
`AudioSystem` retains each lease for the voice or track lifetime and exposes no public raw-clip,
path-based, or alias-based prepared playback overload. A missing desired-audio lease blocks/fails the
coherent publication instead of synchronously loading the source. Editor preview remains isolated from
runtime track identity and uses asynchronous Demand requests before handing leases to `AudioSystem`.

## Presentation coordination

Live presentation and audio outputs are accepted by the engine-owned `RuntimePresentationBridge`
and `core::PresentationCoordinator` before backend delivery. The coordinator owns total operation
ordering, lifecycle, and presentation checkpoint barriers. `RuntimeSession` retains operation
ID allocation and exact Flow/script completion validation, and consumes the coordinator's immutable
status only when the outer dispatch transaction settles. Reset and load terminate old operations
without synthesizing successful completion, then reconcile a fresh projected snapshot.

Finite operations carry their exact predecessor snapshot across the runtime-to-host boundary. A
running candidate retains that predecessor through ownership replacement and realizes it when the
snapshot backend is bound, before publishing the target revision. Predecessor realization is a
fallible candidate-commit gate: failure while priming the already-bound backend or while binding a
new backend fails the load and restores the previous game/resources rather than activating a target
whose source revision was never realized.

New-game, reset, and load replacement are host-owned candidate transactions. Each candidate owns a
fresh Project `ScriptRuntime`/Lua VM and a complete candidate `RuntimeSession`; the frontend/RmlUi Lua
state is separate and remains stable across gameplay-session replacement. Bootstrap and Hook Registry
freeze finish before candidate session construction. New-game and reset candidates then run On Game
Ready and synchronously start/settle the typed entrypoint before they are eligible to replace live
state. A title-screen load may stop that already-settled candidate after validation, so a later shell
Start changes lifecycle admission only; it does not execute authored startup a second time.

Save restoration decodes and validates against the immutable compiled Project, reconstructs a fresh
executor/session, runs On Game Ready against the restored authoritative state, and projects one
coherent initial publication without dispatching Start. It therefore does not rerun the entrypoint,
Room lifecycle, crossed cues, or completed Flow instructions. Failed reset/load construction keeps the
previous session, Project VM, publication, and host generations untouched. On successful replacement,
the old session is destroyed before its old Project VM, invalidating its capability generation and
cancelling any retained script invocation authority. Backend `Running` acknowledgements update
lifecycle state only; they never synthesize completion or cancellation input. Only terminal
Completed/Failed facts resume or cancel the owning Flow operation.

The engine settles terminal presentation inputs immediately after advancing and flushing the
presentation backends in the same frame. This publishes post-transition Room, ActiveText, and
debugger state without depending on a later animation or pointer-driven frame. Presentation work
created by that settlement remains staged until the following frame, so it cannot consume backend
time retroactively in the frame that completed its predecessor.

RmlUi is a snapshot backend. Gameplay mounted-Layout desired records, including authored Room overlays
lowered to Room-owned mounts, reconcile into ephemeral instances from compiled document/fragment
resources. The snapshot carries each mount's stable key, owner, full mounted policy, plane/order, and
composition group. The backend applies that policy directly; the old slot/overlay snapshot shape and
target-derived policy reconstruction are removed.
