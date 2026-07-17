# Presentation State and Transition Specification

Date: 2026-07-15

Status: Normative architecture specification. This document supersedes unfinished presentation-state,
actor-identity, Layout-slot, transition-action, and reconstructible-audio assumptions in Phases 6
through 8 of
[`PRESENTATION_COORDINATOR_AND_RUNTIME_LAYOUT_IMPLEMENTATION_PLAN.md`](plans/PRESENTATION_COORDINATOR_AND_RUNTIME_LAYOUT_IMPLEMENTATION_PLAN.md).
Completed checkpoint, clock, mounted-Layout, coordinator, and RmlUi lifecycle work remains valid.

## Purpose

This specification defines the final backend-neutral contract for desired presentation state,
presentation ownership and lifetime, immutable runtime publication, finite presentation operations,
Room-navigation transitions, Scene transition groups, Layout participation, audio intent, checkpoint
behavior, and backend reconstruction.

It exists to prevent the remaining presentation implementation from freezing transitional assumptions
that no longer describe the intended NovelTea engine. In particular, the final model must not assume
that:

- every actor is owned by a Scene actor slot;
- Room presentation consists only of a background plus overlays;
- gameplay Layout lifetime is represented by one coarse slot enum;
- a targetless `Transition` action can infer what it should transition;
- one semantic audio channel is both durable desired state and every transient playback instance;
- a mutable renderer or RmlUi object is authoritative presentation state;
- save persistence and presentation lifetime are the same concept.

This document defines semantics and ownership. It does not prescribe the exact sequence of source-file
edits; the active presentation implementation plan must be revised against this specification.

## Scope

This specification covers:

- desired presentation records and their stable identities;
- Scene, current-Room, Room, session, and shell ownership;
- complete effective presentation assembly;
- immutable `RuntimePresentationSnapshot` publication;
- background, actor, prop, environment, Layout, Map-underlay, text/choice, and desired-audio intent;
- ordinary presentation mutations and atomic grouped mutations;
- Room-navigation source-to-target transitions;
- Scene-authored `TransitionGroup` semantics;
- finite operation metadata, target domains, replacement, skip, cancellation, and failure;
- checkpoint classes and save/load reconstruction;
- renderer, RmlUi, and audio backend responsibilities;
- authoring/compiler/runtime validation required by these contracts.

The related world specification owns the detailed Room, Character, Interactable, placement, and
composition-callback model. The runtime-capability specification owns runtime transaction settlement,
deferred commands, Lua capability ports, and restricted script environments. This document consumes
those contracts and defines their presentation result.

## Non-goals

This specification does not introduce:

- an entity-component system;
- a generic entity base class;
- arbitrary script-defined presentation record types;
- a general animation timeline or cue graph;
- backend callbacks as authored continuation mechanisms;
- serialized renderer, RmlUi, tween, audio-voice, decoder, or GPU state;
- arbitrary cross-plane numeric z ordering;
- a dependency-tracked reactive Lua composition engine;
- a second mutable presentation source of truth beside runtime state;
- compatibility decoding for the current provisional Scene transition or Layout-slot shapes.

## Normative terminology

The key terms in this document are distinct and must not be used interchangeably.

### Desired presentation state

Typed, idempotent logical intent describing what should currently exist. Desired state is owned by the
runtime or shell, may be persisted when specified, and is sufficient to reconstruct fresh backend
realization.

Examples include an actor target, a mounted gameplay Layout, a selected Room rain mode, or a desired
looping ambience instance.

### Effective presentation

The deterministic result of combining immutable definitions, authoritative world state, Room
composition, and active scoped desired records for the current runtime state.

### Presentation snapshot

An immutable, backend-neutral publication of the complete effective presentation at one settled
runtime revision. Reapplying an identical snapshot is safe and performs no one-shot work.

### Presentation operation

Ordered finite or one-shot work that realizes a change or effect over time. Operations have lifecycle,
checkpoint classification, replacement, and acknowledgement semantics. Operations are not saved.

### Presentation owner

The typed identity that determines when a desired record is active, when it is automatically removed,
and whether it participates in gameplay checkpoint data.

### Presentation policy

Family-specific behavior while a desired record is active, such as plane, local order, clock, input,
pause, fitting, placement, or mixing parameters.

### Checkpoint class

The existing `Reconstructible`, `CausalBarrier`, or `Disposable` classification of ongoing activity.
It determines checkpoint safety and restoration behavior, not desired-state lifetime.

### Backend realization

Disposable renderer, RmlUi, audio, or animation objects created from a snapshot and operations.
Backend realization is never authoritative gameplay or save state.

## Architectural invariants

The final system must preserve all of these invariants.

1. `CompiledProject` owns immutable definitions and resources.
2. Runtime/session state owns authoritative gameplay state and durable desired gameplay presentation.
3. Shell state owns title, pause, settings, load/save, and confirmation presentation.
4. One projector/resolver path produces immutable effective presentation.
5. Presentation backends consume snapshots and typed operations; they do not inspect Flow frames,
   `SessionState`, arbitrary scripts, or source JSON.
6. Desired state always describes the final target even while a finite operation is active.
7. Finite operation progress, captures, voices, and GPU resources never enter save data.
8. A settled runtime transaction publishes at most one coherent target revision unless an authored
   finite operation deliberately establishes an operation boundary.
9. Desired-state lifetime, family policy, checkpoint class, and operation lifecycle are independent
   axes.
10. A save/load or backend reset converges to the published target without replaying acknowledged
    one-shots or fabricating completion.

## High-level data flow

The target presentation path is:

```text
Compiled definitions
    + authoritative world/session state
    + Room presentation resolution
    + active scoped desired records
    + active stable UI/text/Map intent
        -> effective presentation
        -> RuntimePresentationSnapshot
        -> PresentationCoordinator
        -> world renderer / RmlUi / audio realization
```

Finite operations use the same published target:

```text
settled source publication
    -> validate and commit desired target
    -> publish target revision
    -> accept typed operation bound to source and target revisions
    -> realize, replace, skip, complete, cancel, or fail
    -> converge to target publication
```

The coordinator does not calculate gameplay state. The renderer does not infer operations from a
snapshot diff. The runtime does not advance backend animation progress.

## Presentation ownership and lifetime

### Canonical owner vocabulary

Every runtime or shell desired presentation record has exactly one typed owner. The final vocabulary
is conceptually:

```cpp
using PresentationOwner = std::variant<
    ScenePresentationOwner,
    CurrentRoomPresentationOwner,
    RoomPresentationOwner,
    SessionPresentationOwner,
    ShellPresentationOwner>;
```

The implementation may use stronger family-specific wrappers, but it must preserve these exact
semantic alternatives rather than inventing subsystem-specific lifetime enums.

### Scene owner

`ScenePresentationOwner` identifies one live Scene invocation, not merely a `SceneId`. Two concurrent
or nested invocations of the same Scene have different owners.

Scene-owned desired state:

- becomes active when committed by that invocation;
- remains after the individual Scene instruction advances;
- is removed when the owning invocation returns, tail-replaces, is aborted, or otherwise ends;
- may be checkpointed only at an otherwise valid stable boundary where the owning Flow frame is
  serializable;
- is encoded using snapshot-local Flow ownership and remapped to a fresh live frame identity on load;
- is never kept alive solely by a backend object after its owner ends.

Ordinary Scene actor slots default to this owner.

### Current-Room owner

`CurrentRoomPresentationOwner` identifies the active Room visit. Runtime may use a strong
`RoomVisitInstanceId`, but checkpoint data need only preserve the semantic active-visit ownership.

Current-Room desired state:

- is active only for the currently active Room visit;
- survives save/load while restoring that visit;
- is removed only after the next successful departure from the Room;
- is not removed by a failed navigation attempt;
- is rebound to a fresh runtime visit identity during restore when necessary;
- must not be treated as disposable merely because its cleanup boundary is near.

### Room owner

`RoomPresentationOwner` carries a `RoomId`.

Room-owned desired state:

- remains stored until explicitly removed or the session ends;
- is active only while its Room is active;
- becomes inactive, but is not deleted, when another Room is entered;
- reactivates when returning to its Room;
- is checkpointed when it is mutable or selected at runtime;
- may be omitted from save only when it is exactly derivable from immutable Room definitions and no
  runtime selection or override exists.

### Session owner

`SessionPresentationOwner` identifies the current gameplay session.

Session-owned desired state:

- remains across Room navigation;
- remains until explicitly removed, replaced, or the runtime session ends;
- is checkpointed when it is gameplay presentation;
- may still be conditionally applicable to the active Room or presentation mode through typed policy;
- does not automatically draw above shorter-lived records.

### Shell owner

`ShellPresentationOwner` identifies transient host/shell presentation such as title, pause, settings,
load/save, confirmation, and debug tooling.

Shell-owned desired state:

- is not gameplay checkpoint data;
- resets according to shell and project-load policy;
- uses the same mounted Layout and operation infrastructure where appropriate;
- remains authority-isolated from gameplay scripts unless a typed shell capability explicitly permits
  an action;
- cannot be promoted into gameplay persistence merely by choosing a gameplay plane.

### Ownership does not determine draw order

Owner lifetime never implicitly determines plane or z order. A session-owned record is not drawn above
a Room-owned record merely because it lives longer. Draw order is determined by family, plane, explicit
local order or depth, and stable identity.

### Ownership changes are replacement

Changing the owner of an existing stable presentation instance is a typed replacement of its desired
record. It is not an in-place mutation of an owner token hidden from checkpoint generations.

## Stable desired-state identities

### General rule

Every multi-instance desired family has a stable typed identity sufficient for:

- deterministic upsert and removal;
- canonical snapshot ordering;
- save encoding and validation;
- operation target correlation;
- same-target replacement;
- backend reconciliation without positional matching.

IDs are never backend document IDs, texture handles, vector indexes, arbitrary strings, or operation
IDs.

### Actor presentation identity

The final actor identity cannot be only `{SceneId, ActorSlotId}`. The actor presentation key is a
closed typed variant representing the source of the stable actor instance, conceptually:

```cpp
using ActorPresentationKey = std::variant<
    CharacterActorKey,
    RoomCastActorKey,
    SceneActorKey,
    ScopedActorKey>;
```

The alternatives mean:

- `CharacterActorKey`: the effective presentation of one persistent named Character in its world
  location;
- `RoomCastActorKey`: one authored Room-local cast entry;
- `SceneActorKey`: one actor slot owned by one Scene invocation;
- `ScopedActorKey`: one explicitly created scoped presentation actor instance.

A Character definition may be referenced by multiple actor keys simultaneously. Actor presentation
identity is therefore never equivalent to `CharacterId` alone.

### Prop identity

Decorative, noninteractive world visuals use a strong `PresentationPropInstanceId` or a closed authored
identity such as a Room prop key. They do not masquerade as Interactables.

### Environment identity

Persistent weather, machinery, ambient visual modes, and similar long-lived behavior use a stable
`PresentationEnvironmentInstanceId`. A selected loop or environment mode is desired state; its exact
animation phase is backend realization.

### Layout identity

Every desired Layout mount has a stable `MountedLayoutInstanceId` or an authored logical mount key
that deterministically resolves to one. A reusable `LayoutId` is not a mounted-instance identity.

The current `LayoutSlot` enum may remain only as authoring shorthand for reserved exclusive mount keys.
It must not remain the general runtime storage or lifetime model for gameplay Layouts.

### Desired audio identity

Every persistent desired looping audio record has a stable `DesiredAudioInstanceId`. Multiple desired
instances may use the same semantic bus, especially for layered ambience.

Convenience APIs such as `set_music()` may use a reserved well-known replacement key, but the core
model must not limit all desired audio to one mutable record per channel.

### Singleton target identities

Families that are semantically singleton in one effective presentation use a typed singleton target,
not an arbitrary string. The initial singleton families are:

- effective world background;
- stable ActiveText presentation;
- active choice presentation;
- active Map presentation where only one Map view is supported.

## Desired presentation families

### Background

The effective world background contains:

- optional asset;
- optional color;
- fitting policy;
- optional material;
- visibility or absence;
- any validated backend-neutral parameters required by the selected material contract.

The Room definition supplies the baseline. Scoped background overrides may replace it. For the
singleton background only, effective override precedence is:

1. Scene-owned override from the active topmost applicable invocation;
2. current-Room override;
3. named-Room override for the active Room;
4. session override;
5. resolved Room baseline.

This precedence is specific to a singleton override family. It does not establish general draw order
or permit unrelated owners to collide silently.

An override removal reveals the next applicable source. A background transition operates between the
fully resolved old and new effective backgrounds.

### Actors

Each effective actor target contains at least:

- stable `ActorPresentationKey`;
- referenced `CharacterId`;
- resolved pose and expression identities;
- resolved pose and expression assets/materials;
- resolved pose anchor, offsets, and scale;
- logical placement and cue offsets;
- visibility;
- plane and local depth/order within world content;
- selected reconstructible idle/loop state where applicable.

The projector resolves expression-to-pose relationships and Character defaults. The renderer does not
consult `CharacterDefinition` to complete an actor record.

Gameplay-relevant Character world location is not stored only in this actor record. The world
specification owns that authoritative state. Actor projection is the visual result.

### Interactable world presentation

Visible Interactables in the active Room are projected from authoritative Interactable location,
visibility, enabled state, and the referenced Room placement definition.

The snapshot contains the complete world-rendering data required for each visible placement, including:

- `InteractableId`;
- active `RoomPlacementRef`;
- normalized or logical bounds;
- resolved sprite/material presentation;
- visibility and enabled state where visual policy depends on them;
- stable depth/order.

The renderer does not query runtime Interactable state or Room definitions.

### Props

Props are presentation-only world records. They have stable identity, owner, visual resource/material,
placement/bounds, visibility, plane, and order. They cannot be selected as Interaction operands unless
they are separately modeled as a real gameplay entity.

### Environment and reconstructible loops

Environment records represent selected long-lived presentation modes such as rain, fog, machinery,
lighting modes, or actor/Room decorative loops.

Each record includes:

- stable instance identity;
- owner;
- validated definition or typed effect kind;
- complete reconstruction parameters;
- plane and order;
- selected clock domain when semantically applicable;
- deterministic replacement or stop key.

Exact loop phase is omitted from save and normally restarts from phase zero. Any future cue that can
mutate gameplay, invoke Lua, resume Flow, or issue an external request makes the activity causal and
requires a separately typed execution contract.

### Gameplay Layout mounts

The desired presentation contains complete gameplay-mounted Layout records, not only coarse Layout
slots. Each mount contains:

- stable mounted-instance identity;
- `LayoutId`;
- `PresentationOwner`;
- immutable mounted policy for that publication;
- visibility;
- resolved presentation plane;
- deterministic local order and composition group;
- any stable authored binding identity needed by runtime UI.

The existing mounted policy dimensions remain:

- `PresentationPlane`;
- local order;
- `LayoutClockDomain`;
- `LayoutInputMode`;
- `GameplayPausePolicy`;
- visibility;
- `EscapeDismissalPolicy`;
- typed entrance/exit operation references when such operations exist.

Changing policy publishes a replacement desired mount with the same stable instance when valid. The
RmlUi adapter never owns a hidden policy override.

### Room overlays are Layout mounts

An authored Room overlay is a declarative source for a Room-owned or current-Room-owned Layout mount.
It is not a separate final desired-state or snapshot family.

The compiler/resolver lowers an applicable Room overlay to a normal mounted Layout record with stable
identity and complete policy. Runtime overlay visibility changes update that desired mount. This
consolidates Room overlay lifetime, plane, ordering, checkpointing, and backend reconciliation with all
other gameplay Layouts.

### ActiveText and choices

ActiveText and choice state remain logical runtime/UI state rather than world actor records. A stable
publication includes:

- resolved text/content identity;
- current page;
- fully presented versus reveal/fade phase inputs;
- input-wait and prompt eligibility inputs;
- exact choice kind, owner, option IDs/order, enabled/visible state, and meaningful selection.

Reveal/fade is a finite causal operation when execution depends on it. Glyph alpha, prompt pulses,
hover, and focus are backend-local realization.

ActiveText and choices are outside the default world transition planes.

### Map presentation

The stable Map record includes Map identity, mode, visibility, focus/selection intent, referenced
background intent, and Layout mount identity where applicable.

An engine-rendered Map background is a `GameUi` underlay. The Map Layout is a normal gameplay Layout
mount. Neither participates in default world Scene/Room transitions.

### Desired audio

Persistent desired looping audio is desired presentation state. Each record includes:

- stable `DesiredAudioInstanceId`;
- owner;
- semantic bus such as Music or Ambient;
- asset;
- loop flag, which must be true for reconstructible desired V1 records;
- volume and other validated semantic parameters;
- optional explicit replacement group/key;
- pause/clock behavior where supported by the final audio policy.

Multiple desired Ambient instances may coexist. A convenience Music key may enforce one selected BGM
without constraining the underlying model.

Voice and ordinary one-shot `audio.play()` calls are distinct transient operations. They may create
multiple simultaneous backend tracks and never overwrite desired looping state merely because they use
the same semantic bus.

## Effective presentation assembly

### Inputs

The effective active presentation is assembled from:

1. immutable project and Room definitions;
2. authoritative world state, including the active Room, Character world location, and Interactable
   location/state;
3. the pure Room-presentation resolution result;
4. stored Room-owned desired records applicable to the active Room;
5. stored current-Room records for the active visit;
6. stored session records;
7. live Scene-invocation records;
8. stable text, choice, Map, and desired-audio intent;
9. shell presentation, published through its authority boundary where required by the host.

The exact Room composition sources and callback restrictions are defined by the world specification.

### Derived and stored values

The resolved Room baseline and complete effective presentation are derived values. They are not a
second independently saved mutable model.

Saves store:

- authoritative world state;
- runtime-selected scoped desired records;
- stable logical text/choice/Map/audio intent;
- enough ownership information to reconstruct active records.

Saves do not store a redundant serialized effective snapshot when the snapshot can be recreated from
those values.

### Merge rules

Multi-instance families merge by stable typed identity. Independent identities coexist. An explicit
upsert of the same identity replaces its prior desired record atomically. Removing one identity never
removes another record merely because both reference the same Character, Layout, asset, or bus.

Singleton families use their documented typed precedence. Implementations must not resolve collisions
using unordered-container iteration, insertion timing, backend document order, or pointer identity.

### Canonical ordering

Snapshot collections are canonical. Ordering uses:

1. `PresentationPlane` declaration order;
2. family-specific local order/depth;
3. stable typed identity as a deterministic tie-breaker.

Authoring sequence may determine an explicit local order, but raw source collection order must not
leak into runtime ordering unless the schema declares it meaningful.

### Failure atomicity

Effective resolution and snapshot publication are failure-atomic. Missing definitions, invalid
placement, unresolved resources, owner mismatches, duplicate stable identities, or invalid policy
produce typed diagnostics and preserve the previous complete publication.

No backend may receive a partially resolved target.

## Runtime presentation publication

### Coherent publication boundary

The presentation snapshot is published from the same settled runtime transaction as the gameplay UI
view and runtime observations. The enclosing runtime publication carries one coherent revision.

The presentation snapshot retains its own monotonic `PresentationSnapshotRevision` for coordinator and
backend reconciliation. One atomic effective-target change increments it exactly once. Backend-only
progress and lifecycle changes do not increment it.

### Snapshot content

The final `RuntimePresentationSnapshot` must contain complete backend-neutral records for at least:

- runtime mode and active Room identity;
- effective background;
- visible Interactable Room placements;
- effective actors;
- props;
- environment/loop intent;
- gameplay Layout mounts with resolved plane/policy;
- stable ActiveText and choice state;
- Map presentation;
- desired looping audio intent.

The current separate `PresentationRoomOverlay`, `PresentationLayoutSlot`, and one-record-per-channel
audio collections are transitional and must be replaced or lowered into the final families above.

### No backend lookup of gameplay definitions

The projector resolves every definition relationship needed to draw or mount the snapshot. A narrow
asset resolver may translate typed asset/material/Layout resource IDs into prepared backend resources,
but it must not expose a general `CompiledProject` pointer for semantic interpretation.

### Reconciliation

Snapshot reconciliation is idempotent and failure-atomic. Backends may cache realized records by stable
identity, but those caches are disposable and never become another source of truth.

## Presentation mutations

### Ordinary mutations

Ordinary runtime commands mutate authoritative world state or scoped desired records through typed
semantic APIs. Examples include:

- moving a Character or Interactable;
- upserting/removing a scoped actor;
- adding/removing a prop;
- selecting/clearing environment state;
- mounting/unmounting a Layout;
- setting/clearing a background override;
- setting/stopping desired looping audio.

At runtime transaction settlement, affected presentation is resolved and published once.

An ordinary mutation has immediate visual target semantics unless its typed command also requests a
finite operation.

### No mutable global composition

There is no persistent `CurrentComposition` object. The temporary draft used by Room composition or a
transition group cannot be retained by Lua or another subsystem after its callback/transaction.

### Mutation validation

Every command validates:

- caller authority and allowed owner kinds;
- referenced definitions and resources;
- stable identity ownership;
- Room/placement compatibility;
- plane and policy restrictions;
- replacement key/type compatibility;
- persistence requirements;
- finite-operation parameter combinations.

Validation completes before mutation is committed.

## Atomic presentation target construction

### Presentation mutation set

An atomic target is constructed by applying a closed typed set of presentation mutations to a
temporary draft derived from the current effective target. This temporary value may be named
`PresentationTargetDraft` or equivalent internally.

It is not another general runtime transaction framework. The enclosing runtime dispatch transaction
remains the atomic publication boundary.

### All-or-nothing behavior

Every mutation in an atomic set is evaluated and validated before publication. If any mutation fails:

- no desired-state mutation is committed;
- no target revision is published;
- no operation ID or lifecycle is accepted;
- no Flow blocker is installed for that target;
- diagnostics identify the exact invalid child mutation.

### No arbitrary side effects

Atomic presentation target construction cannot contain:

- variable/property/gameplay mutations unrelated to presentation target state;
- navigation;
- Scene/Dialogue calls or returns;
- Lua invocation;
- waits, choices, or input blockers;
- save/load commands;
- host requests;
- audio one-shots;
- notifications;
- future semantic cues.

Such work remains ordinary ordered program execution outside the atomic group.

## Scene `TransitionGroup`

### Replacement of targetless `Transition`

The standalone Scene `Transition` action is removed. It has no compatibility interpretation.

The final authored construct is an explicit `TransitionGroup` containing:

- one transition kind;
- duration;
- optional fade color where valid;
- wait-for-completion policy;
- skippable policy;
- an ordered closed list of presentation-only child mutations.

The group never retroactively consumes preceding Scene actions and never implicitly captures following
actions.

### Initial child mutation vocabulary

The initial closed child set includes presentation mutations supported by the completed domain model,
at minimum:

- set/clear effective background override;
- actor show, hide, move, pose, or expression target changes;
- add/remove/swap a participating gameplay Layout mount;
- add/remove/update a prop when the world specification exposes props;
- select/clear participating environment state when implemented.

The implementation plan may stage prop/environment child support after the core group exists, but it
must not replace the closed variant with a generic command table.

### Included presentation planes

The default world transition composition contains:

- `WorldBackground`;
- `WorldContent`;
- `WorldOverlay`.

It excludes:

- `GameUi`;
- ActiveText;
- `MenuOverlay`;
- `Modal`;
- `Debug`;
- host letterbox bars;
- the `Transition` composite plane itself.

Resolved mounted-instance plane is authoritative. `LayoutKind`, resource target intent, logical slot,
or RmlUi implementation does not independently determine inclusion.

### Excluded-plane children

A `TransitionGroup` cannot silently include a child mutation whose resolved target plane is outside
the group composition. The compiler/runtime must either reject that child in the group or require it
to remain a separate ordinary Scene action according to the final authored schema.

### Source and target

The group binds to:

- the last successfully published effective source revision;
- one atomic target revision produced by the child mutation set;
- the matching engine-world and participating `WorldOverlay` Layout composition for each revision.

Source and target are explicit coordinator/backend metadata. They are not inferred from a framebuffer,
snapshot diff, RmlUi document order, or later mutable state.

### Initial visual kinds

The initial grouped kinds are:

- `Cut`: immediate target publication, zero duration, no operation lifecycle;
- `Fade`: source to opaque color to target over the total duration; default color is black;
- `Dissolve`: deterministic alpha cross-dissolve from source to target; color is invalid.

`Dissolve` does not imply a noise-mask shader in V1.

### No-effective-change behavior

If the atomic target is identical on all included planes, the group completes synchronously without an
operation lifecycle or checkpoint barrier.

### Wait and checkpoint class

For finite grouped operations:

- `waitForCompletion=true` creates an exact Flow completion target and `CausalBarrier`;
- `waitForCompletion=false` creates a `Disposable` operation because the target is already durable;
- skippability does not determine checkpoint class.

### Phase 7C/7D implementation boundary

The strict authoring, compiled-wire, native-program, temporary-target, and shared-operation contracts
are implemented. The initial concrete child set is background set/clear, actor cue, and participating
Layout mutation; prop and environment children remain intentionally absent rather than represented by
a generic command payload. `TransitionGroupInstruction` replaces the old standalone instruction, and
the old discriminant is rejected at authoring and native decode boundaries.

Finite requests live in `core/presentation_operation_requests.hpp`. They contain only typed IDs,
domain values, clocks, durations, target keys, source/target publication revisions, skip policy, exact
completion ownership, and checkpoint class derivation. They contain no JSON, callback, renderer,
RmlUi, or backend object.

Phase 7D makes those requests live. The runtime stages the complete target, reconciles its immutable
snapshot synchronously, accepts the revision-bound operation, and only then settles checkpoint
eligibility. A failed target reconciliation or precommit acceptance restores the staged source;
accepted disposable work creates no barrier, while accepted causal work is visible to settlement.
Scene groups, standalone finite changes, and Room navigation all use this transaction seam without
sharing semantic target types or Flow completion ownership. Renderer realization remains a Phase 8
backend responsibility.

## Room-navigation transitions

### Shared realization, distinct semantic operation

Room navigation and Scene transition groups share source/target composition and backend transition
machinery. They remain distinct typed semantic operations because navigation commits Room/world state
and controls Room lifecycle ordering.

The shared contract expresses this with separate `RoomNavigationTransitionOperation` and
`SceneTransitionGroupOperation` structs embedding `FinitePresentationOperationCommon`. Room
navigation requires an exact `PresentationFlowCompletion`; Scene groups carry it only when awaited.

Rooms are never represented as Scenes merely to reuse transition code.

### Navigation pipeline

The normative navigation order is:

```text
validate source, exit, and destination
  -> evaluate leave/exit/enter conditions
  -> run before-leave and before-enter gameplay effects
  -> resolve complete destination Room presentation
  -> validate the complete target
  -> atomically commit destination gameplay and desired presentation
  -> publish the target revision
  -> realize the selected navigation transition
  -> run after-leave and after-enter effects
  -> admit destination Room interaction
```

A failure before commit leaves the source Room and source publication active. A backend failure after
logical commit follows the typed operation failure policy and must not roll gameplay state backward
through an untyped callback.

### Transition policy precedence

The selected navigation transition is resolved in this order:

1. explicit typed navigation-request override;
2. selected Room-exit transition policy;
3. project default Room-navigation transition policy.

No renderer constant or previous transition setting supplies an implicit fallback.

### Causal semantics

An animated Room-navigation transition is a `CausalBarrier` for its entire accepted lifecycle. Room
navigation does not continue to after hooks or destination input until its exact terminal result is
committed.

The live runtime implements this ordering with an exact prepared-target commit. It does not rederive
the target visit through the baseline `commit_room_entry()` helper. Source current-Room records are
removed and target Room overlays/world presentation are published in the same logical commit before
operation acceptance. Precommit failure retains the source; postcommit backend failure retains the
target and faults the navigation Flow.

A `Cut` navigation completes synchronously. A future deliberately nonblocking teleport operation
would require a separate typed contract; it is not inferred by `wait=false` on ordinary Room
navigation.

### Current-Room cleanup point

Current-Room desired records are removed as part of the successful logical departure/target commit.
They remain intact during condition evaluation, before hooks, and failed navigation attempts.

## Targeted finite operations

### Background interpolation

An animated background change operates on the typed background target domain. The initial animated
kind is cross-fade. Immediate `none`/`cut` changes require zero duration and allocate no lifecycle.

The desired target is committed before the finite operation is accepted.

### Actor interpolation

Actor finite operations target one `ActorPresentationKey`. The initial kinds are:

- opacity fade for show, hide, pose, expression, or general target replacement where valid;
- slide for show, hide, or move only.

Slide interpolates between old and target placement. Show/hide derives an offscreen endpoint from
resolved actor bounds and the nearest horizontal viewport edge. Pose or expression plus slide is
invalid in V1.

### Layout entrance and exit

Layout entrance/exit operations use the same coordinator lifecycle and stable mounted-instance target
domain when introduced. RmlUi CSS animation remains backend-local and is not automatically promoted to
a semantic operation.

An ordinary mount/unmount without an explicit operation changes desired state immediately.

### One-shot effects and notifications

Future gameplay one-shot visual effects and notifications require explicit typed alternatives. They
are causal by default unless a separate API contract guarantees that omission cannot affect authored
behavior.

They are never represented as arbitrary callbacks attached to a generic tween.

## Common finite-operation contract

### Required metadata

Every accepted finite presentation or audio operation has:

- strong session-local operation identity;
- total presentation-operation sequence;
- gameplay or shell authority;
- typed semantic operation alternative;
- typed target/replacement domain;
- selected clock domain;
- duration where finite;
- skippable policy;
- checkpoint class derived by the typed API;
- optional exact completion target;
- explicit source and target presentation revisions when it transitions desired presentation.

Backend handles, callbacks, opacity, elapsed progress, render targets, voices, and document pointers are
not part of this metadata.

### Target domains

The initial replacement target vocabulary is a closed variant containing at least:

- world-composition transition target;
- Room-navigation transition target;
- background target;
- actor target by `ActorPresentationKey`;
- Layout target by `MountedLayoutInstanceId` when semantic entrance/exit exists;
- audio playback instance target where cancellation/replacement applies.

Target domains are not string channels.

### Lifecycle

The existing lifecycle states remain normative:

- accepted;
- running;
- completed;
- cancelled with typed reason;
- replaced with typed replacement identity;
- failed with typed domain and diagnostic.

Only the coordinator commits lifecycle transitions. Backend facts are validated acknowledgements, not
direct mutation of runtime blockers or checkpoint status.

### Operation boundary

Every emitted finite desired-state operation forms an outer runtime publication boundary:

1. commit the desired target;
2. publish and reconcile its target snapshot;
3. accept and deliver the operation;
4. register any causal barrier;
5. only then allow later authored instructions to execute.

This applies to non-awaited operations as well. It prevents ordered operations from collapsing into a
later unrelated snapshot.

### No-change elision

If source and target are semantically identical for the operation target, the operation completes
synchronously without allocating backend work or a checkpoint barrier.

### Same-target replacement

A later accepted operation replaces only an active operation in the same typed target domain:

- background replaces background;
- one actor operation replaces only the same actor key;
- different actor keys may animate concurrently;
- one mounted Layout operation replaces only the same mounted instance;
- one grouped world transition replaces the grouped world transition target according to coordinator
  policy;
- Room navigation cannot be casually replaced by an unrelated Scene transition.

Replacing an awaited operation uses a typed terminal replacement/cancellation path. It is not silently
reported as successful completion.

### Skip and fast-forward

Skipping a skippable operation:

- snaps backend realization to the durable desired target;
- reports `completed`, not `cancelled`;
- releases only the exact completion target;
- removes its causal barrier in the same committed lifecycle transition.

A non-skippable active operation remains active and causes fast-forward to stop with a typed reason.

### Cancellation

Cancellation is reserved for semantic termination such as:

- explicit abort;
- owner ended;
- runtime reset;
- project reload;
- checkpoint load;
- backend failure policy;
- replacement where the lifecycle records cancellation rather than a separate replaced state.

Cancellation never fabricates completion.

### Clocks

Gameplay-authored world operations use the gameplay clock in V1. Gameplay pause freezes them.
Shell operations may use unscaled presentation time through their typed contract.

Progress is based on accumulated typed clock delta, never render-frame count or raw wall time.

## Audio operations

### One-shot instance semantics

Every `audio.play()` one-shot creates a distinct playback operation/backend instance. Multiple calls
may overlap even on the same semantic bus. Completion, stop, fade, and correlation operate on explicit
instances or typed groups rather than overwriting one channel record.

### Desired loops versus playback operations

Persistent desired loops are reconciled from snapshot state. Starting a fresh backend voice for a
desired loop is realization, not a replayable authored one-shot operation.

Explicit replace/fade commands may create finite audio operations while updating the desired target.

### Checkpoint policy

The initial audio classification is:

- desired looping music/ambience: `Reconstructible` logical state;
- awaited voice: `CausalBarrier`;
- non-awaited voice: `CausalBarrier` in V1;
- gameplay sound effect: causal when awaited or cue-bearing, and causal by default until a separately
  typed disposable API proves omission safe;
- UI-only sound: `Disposable` only through an API that forbids authored dependencies.

Exact sample position, decoder state, fades, voices, and tracks are never encoded.

### Backend concurrency limits

Backend voice limits and stealing policy are realization configuration. They must not change the
semantic rule that distinct accepted playback operations have distinct identity and terminal status.
Failure to allocate a voice produces a typed operation failure or documented disposable drop; it must
not silently overwrite an unrelated active operation.

## Presentation planes and composition

### Canonical planes

The current canonical planes remain:

```text
WorldBackground
WorldContent
WorldOverlay
GameUi
MenuOverlay
Modal
Transition
Debug
```

Their declaration order is semantic coarse order. A schema/runtime revision is required to add or
reorder planes.

### Local ordering

Local order is meaningful only within one plane. Cross-plane comparison of local-order integers is
invalid.

### World transition composition

Engine world rendering and RmlUi mounts on `WorldOverlay` are independently realized but participate
in one source/target world composition for Room navigation and Scene transition groups.

RmlUi documents are not flattened into engine quads, and engine world records are not translated into
RmlUi documents solely to simplify capture.

### Backend view ranges

The host allocates deterministic contiguous backend ranges per plane and RmlUi context. Internal RmlUi
filter/layer/clip passes remain contiguous. World transition source, target, and composite ranges remain
below `GameUi`.

## Layout-specific rules

### Resource and mount separation

`LayoutResource` is reusable immutable content. A desired mounted instance owns runtime policy and
lifetime. Loading the same resource twice produces distinct mounted instances when allowed.

### Policy immutability per publication

One published mounted record has one complete policy. Showing, hiding, reordering, or changing clock,
input, pause, or dismissal publishes a replacement record rather than mutating adapter-local state.

### Gameplay and shell authority

Gameplay and shell mounts use the same mount shape but different owner authority and persistence.
Shell code cannot write gameplay checkpoint mounts through an unchecked owner enum, and gameplay code
cannot replace protected shell mounts.

### Input and pause remain independent

Layout visibility, rendering, input capture, gameplay admission, clock advancement, and pause request
remain separate policy dimensions. Lifetime does not imply any of them.

## Checkpoint semantics

### Independent axes

For every relevant record or operation, the architecture answers separately:

1. Who owns the desired state and when is it active?
2. Is the desired state encoded, derived, or intentionally transient?
3. How does it behave while active?
4. Is ongoing work reconstructible, causal, or disposable?
5. What lifecycle state is the operation currently in?

No single enum answers all five questions.

### Desired-state persistence matrix

The final rules are:

| Desired state | Checkpoint treatment |
| --- | --- |
| Immutable Room baseline | Derive from the exact active Room definition. |
| Pure Room composition output | Recompute from restored authoritative inputs. |
| Runtime-selected Room composition choice that cannot be re-derived without history | Store the selected scoped desired record. |
| Scene-owned desired record | Store only at a stable serializable Flow boundary and remap its saved frame owner. |
| Current-Room desired record | Store and bind to the restored active visit; remove on next successful departure. |
| Named-Room desired record | Store unless exactly immutable-definition-derived. |
| Session gameplay desired record | Store. |
| Shell desired record | Do not store in gameplay checkpoint. |
| Character world location | Store as authoritative world state. |
| Interactable state/location | Store as authoritative world state. |
| Explicit scoped actor/prop/environment/Layout record | Store according to gameplay owner. |
| Desired looping audio record | Store according to gameplay owner. |
| Backend interpolation/loop/sample phase | Never store. |

### Reconstructible activity

Reconstructible desired loops, Layout mounts, actors, environment state, and desired audio never block
checkpoint replacement when their logical records validate.

### Causal barriers

An active causal operation blocks creation of a newer retained checkpoint from acceptance until exact
completion, cancellation, replacement, or failure is committed. Manual save may still write the prior
retained checkpoint.

### Disposable activity

Disposable work is omitted or snapped to target and does not block checkpoint replacement. Its typed
API must forbid semantic callbacks, gameplay mutation, Flow continuation, Lua invocation, external
requests, and meaningful future cues.

### Save does not serialize an effective snapshot cache

Checkpoint codecs serialize authoritative and selected logical records. They do not serialize the
renderer-facing snapshot as an opaque cache. Restore reprojects a fresh snapshot and validates it.

## Restore, reset, and backend recovery

### Checkpoint load

Loading a checkpoint performs this presentation sequence:

1. terminate all live finite presentation and audio operations with `CheckpointLoad`;
2. discard backend realization and pending backend facts;
3. restore authoritative runtime and scoped desired records;
4. remap saved Scene and current-Room ownership to fresh live identities;
5. resolve the active Room and complete effective presentation;
6. publish one fresh stable snapshot;
7. reconcile world, Layout, text/choice/Map, and desired-audio backends;
8. begin with no restored causal or disposable operation progress.

No completion input is synthesized for omitted operations.

### Runtime reset and project reload

Runtime reset and project reload terminate operation lifecycles with their existing typed reasons,
discard transient realization, clear or replace scoped gameplay records according to session ownership,
and reconcile only from the new authoritative target.

### Renderer or device reset

A backend reset does not alter desired state. The backend recreates resources from the current snapshot.

For a live finite operation:

- disposable work may snap to target or restart only when its typed contract permits;
- causal work may continue from retained CPU-side semantic progress when supported;
- inability to reconstruct causal work produces typed failure/cancellation, never fabricated success;
- desired target remains authoritative throughout.

### RmlUi reload

RmlUi documents and contexts are recreated from desired mounted instances and policy. Document-local
CSS animation state may restart. Stable logical UI content is rebound from the coherent runtime
publication.

### Audio device reset

Desired loops create fresh backend voices. Acknowledged one-shots do not replay. Active causal
playback follows typed failure/recovery policy and never becomes a new desired loop by accident.

## Script and runtime command surface

This specification defines semantic capability, not exact Lua spelling. The final runtime gateway must
support typed operations equivalent to:

- upsert/remove scoped actor;
- add/remove prop;
- set/clear environment;
- mount/unmount/show/hide gameplay Layout;
- set/clear background override;
- set/stop desired looping audio;
- request finite actor/background/world operations;
- navigate a Room through the normal navigation transaction;
- query stable effective or desired state where authorization permits.

The gateway must enforce owner, authority, and policy validation. Lua never receives renderer objects,
RmlUi contexts/documents, audio voices, tween handles, or mutable snapshot pointers.

Room composition receives only its restricted draft and read-only queries. It cannot call these
ordinary mutation capabilities.

## Authoring and compiler requirements

### Stable IDs

Every authored nested record that becomes a stable desired instance or operation target has a stable,
validated ID. Editor reorder does not change identity.

### TransitionGroup schema

The authoring and compiled schemas must replace standalone `transition` with a strict grouped variant.
The compiler validates:

- nonempty and valid child mutation list where required;
- allowed child alternatives;
- plane participation;
- duration and kind combinations;
- fade color validity;
- wait and skippable semantics;
- references and stable IDs;
- absence of side-effecting child instructions.

There is no fallback decoder for the targetless action.

### Finite timing validation

Immediate kinds require zero duration and cannot wait. Animated kinds require positive duration.
Contradictory combinations fail validation rather than being normalized by the renderer.

### Owner validity

The compiler/runtime rejects owner alternatives that cannot be meaningful in the authored context.
For example, an authored Room default cannot claim a live Scene-invocation owner, and an ordinary
gameplay Scene cannot create a protected shell owner.

### Layout plane validation

The compiler and resolver validate participating Layout plane before an atomic transition target is
committed. A slot or resource kind is not substituted for resolved plane.

### Reconstruction closure

Every reconstructible record must carry complete typed reconstruction data and close all referenced
resources. A record that depends on hidden Lua state or backend callbacks is invalid.

## Diagnostics

Diagnostics should identify:

- desired record family and stable identity;
- owner and active Room/Scene context;
- referenced definition/resource;
- mutation or TransitionGroup child path;
- operation ID/sequence and target domain when applicable;
- source and target snapshot revisions;
- checkpoint-class or lifecycle conflict;
- backend failure domain without exposing backend handles.

Invalid authored/runtime input must return structured diagnostics. It must not reach assertion,
termination, throwing access, unchecked lookup, or partial publication.

## Current implementation disposition

The current implementation is a useful transitional foundation but not the final contract.

| Current concept | Final disposition |
| --- | --- |
| `PresentationCoordinator` lifecycle, sequencing, barrier status | Retain and extend to the final typed operations/targets. |
| `RuntimePresentationSnapshotPublisher` | Retain the publication role; extend/revise snapshot content and coherent revision integration. |
| `PresentationActor` keyed by `ActorSlotKey` | Replace with generalized `ActorPresentationKey`. |
| Separate `PresentationRoomOverlay` | Replace by normal mounted Layout records. |
| `PresentationLayoutSlot` and `SessionState::m_layouts` as general gameplay Layout state | Replace by stable scoped mounted-instance records; optionally lower reserved authoring shorthands. |
| One `PresentationAudioChannel` per channel | Replace by desired-loop instances plus transient playback operations. |
| Standalone targetless Scene `Transition` | Delete and replace with `TransitionGroup`. |
| `LogicalTransitionState` as a durable pseudo-target | Deleted in Phase 8C; committed desired targets plus operation lifecycle are authoritative. |
| `RuntimeLayoutManager` typed mounted policy and live RmlUi integration | Retain as low-level realization/policy infrastructure, then reduce behind final Layout realization ownership. |
| `RuntimeTransitionManager` callback/midpoint model | Deleted in Phase 8C after the coordinator transition backend became live. |
| Historical `TweenService` raw-target/callback/string owner model | Deleted. Replaced by a backend-local handle-based `animation::TweenService`; Twink remains private interpolation infrastructure and owns no semantic operation lifecycle. |
| RmlUi lifecycle contexts and engine clock routing | Retain. |
| Retained checkpoint service and checkpoint classes | Retain and extend with corrected scoped records. |

## Required verification

Implementation plans derived from this specification must include tests for at least:

- canonical owner activation and cleanup for Scene, current-Room, Room, session, and shell;
- current-Room save/load followed by cleanup on successful departure;
- failed navigation preserving current-Room records;
- nested/concurrent Scene invocations with distinct actor owners;
- persistent Character actor, Room-local cast actor, Scene actor, and explicit scoped actor coexistence;
- Interactable world projection without renderer access to runtime state;
- prop versus Interactable semantic separation;
- Room overlay lowering to ordinary Layout mount;
- multiple gameplay Layout mounts using the same Layout resource;
- policy/lifetime independence for Layouts;
- multiple desired ambience loops and overlapping transient audio plays;
- singleton background precedence and removal fallback;
- canonical ordering independent of unordered containers;
- failure-atomic effective resolution and backend reconciliation;
- one coherent UI/presentation publication revision;
- TransitionGroup all-or-nothing validation and publication;
- no implicit capture of adjacent Scene actions;
- included `WorldOverlay` and excluded `GameUi`/shell planes;
- no-effective-change operation elision;
- exact source/target revision binding;
- awaited causal and non-awaited disposable finite operations;
- same-target replacement without cancelling unrelated actors;
- skippable completion versus cancellation;
- Room-navigation causal ordering and after-hook timing;
- gameplay-clock pause behavior;
- checkpoint barriers registered before settlement;
- restore without operation replay or fabricated completion;
- renderer, RmlUi, and audio device reset convergence;
- absence of JSON, SDL, bgfx, RmlUi, miniaudio, callback, and backend handles from shared contracts.

## Completion criteria

This specification is implemented when:

- every desired gameplay presentation family uses the shared owner vocabulary;
- complete active Room/world presentation is published in one immutable snapshot;
- actor identity is no longer Scene-slot-only;
- Room overlays and gameplay Layouts use one mounted-instance state model;
- persistent desired audio and transient playback are separate and support multiple instances;
- Scene `TransitionGroup` has an explicit atomic target and the targetless action is gone;
- Room navigation resolves and commits a complete target before visual realization;
- finite operations use one coordinator lifecycle, typed target domains, and exact revision binding;
- checkpoint persistence follows logical ownership while operation progress remains omitted;
- fresh or reset backends reconstruct from the same snapshot without reading gameplay internals;
- the revised presentation implementation plan and durable rendering/runtime/component documentation
  describe only this ownership model.
