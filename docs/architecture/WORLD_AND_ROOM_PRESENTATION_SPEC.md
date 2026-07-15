# World and Room Presentation Specification

Status: Proposed normative architecture. This document defines the target world, Room-resolution,
Character-presence, Interactable-placement, and Room-navigation contracts that must be implemented
before final world rendering and transition work is completed.

## Purpose

NovelTea currently has strong typed definitions, one authoritative `SessionState`, explicit Room
navigation frames, unique Interactable location state, Scene-local actors, mounted Layout policy,
safe checkpoints, and a backend-neutral presentation coordinator. The current model does not yet
provide one complete answer to the question:

> What exactly should the destination Room contain and look like before the engine begins the visual
> transition into it?

Today, Room background and overlays are initialized during Room commit, Interactables are resolved
through Room-specific placements, and Characters exist on screen only as Scene actor slots. There is
no first-class Room presentation resolver, no persistent Character world location, no Room-local cast
model, and no deterministic composition callback suitable for entry, load, preview, and backend
recovery.

This specification fixes those contracts. It defines:

- immutable Room geometry and presentation declarations;
- generic Room placement anchors shared by world subjects;
- persistent Character world state keyed by `CharacterId`;
- the distinction among persistent Characters, Room-local cast, Scene actors, and Interactables;
- a pure Room `compose` hook and its restricted capability environment;
- one derived, immutable `ResolvedRoomPresentation`;
- active-Room recomposition and invalidation rules;
- atomic Room navigation ordering and failure semantics;
- Interaction subjects that may be Characters or Interactables without a generic entity hierarchy;
- save and restore behavior, including saved current-Room visit context;
- authoring, compilation, runtime, preview, and validation requirements.

This specification does not define the complete scoped desired-presentation record model, renderer
implementation, transition shaders, audio model, or Lua runtime-capability architecture. Those are
owned by the companion presentation and runtime specifications. This document defines the world and
Room facts those systems consume.

## Relationship to other architecture documents

This specification refines, but does not discard, the following foundations:

- `CORE_DOMAIN_MODEL.md`: immutable definitions, strong IDs, one `SessionState`, specialized
  programs, explicit Flow, and JSON-free runtime state remain authoritative.
- `DOMAIN_COLLECTIONS_AND_RELATIONSHIPS.md`: Characters and Interactables remain separate typed
  domain concepts; this specification revises their shared location and Room-presentation
  relationships.
- `PRESENTATION_AND_CHECKPOINT_OWNERSHIP.md`: desired logical state remains separate from backend
  realization and finite operations.
- `RUNTIME_AND_PRESENTATION_ARCHITECTURE_CONSOLIDATION_OVERVIEW.md`: this document is the detailed
  world/Room specification required by that overview.
- `PRESENTATION_COORDINATOR_AND_RUNTIME_LAYOUT_IMPLEMENTATION_PLAN.md`: completed coordinator and
  Layout phases remain; unfinished world-rendering phases must consume the contracts defined here.

Where older component documents describe `RoomPlacement` as permanently owned by one Interactable,
or describe all actors as `{ SceneId, ActorSlotId }` state, this specification is the target
architecture and the older wording must be revised during implementation.

## Architectural principles

### One authoritative world state

Mutable world facts belong to the runtime session. The renderer, RmlUi, Room resolver, Lua VM,
editor preview, and presentation coordinator do not own Character locations, Interactable locations,
Room visits, variables, or properties.

### Resolved Room presentation is derived

`ResolvedRoomPresentation` is a deterministic result produced from immutable definitions and current
authoritative runtime inputs. It is not an independently mutable state store and is not serialized as
a second source of truth.

### Room lifecycle effects and Room composition are different

Room lifecycle effects may mutate gameplay state. Room composition may only read gameplay state and
construct a temporary presentation draft. The engine must not expose the normal mutable script API to
the composition hook.

### World identity and presentation identity are different

A persistent Character or Interactable is a gameplay subject with one authoritative world location.
An actor, sprite, Layout, prop, or effect is a presentation instance. A Scene may display the same
Character in multiple actor slots without creating additional persistent world Characters.

### Shared primitives do not imply a generic entity system

Characters and Interactables share `RoomPlacementRef`, location validation, visibility concepts, and
closed Interaction-subject variants where useful. They do not gain a common base class, downcasts,
runtime component bags, or an ECS.

### Entry presentation is atomic

The destination Room presentation is fully resolved before the Room switch is published and before
the source-to-target visual transition begins. Backgrounds, Characters, Interactables, Room props,
and participating Layouts must not appear incrementally after the destination has already become
visible unless authored post-entry behavior explicitly changes them.

### Stable IDs are required for every derived entry

Declarative and scripted Room-presentation entries use stable typed IDs. Vector position, generated
process indexes, pointer identity, Lua table identity, and evaluation order are not persistent
identity.

## Terminology

### `RoomDefinition`

Immutable compiled Room content. It owns Room-local declarations, geometry, lifecycle programs,
exits, and optional composition-hook configuration. It does not own mutable occupancy.

### `RoomPlacementDefinition`

A named Room-local spatial anchor and interaction/presentation region. It is no longer permanently
bound to one Interactable. Characters and Interactables may reference the same placement vocabulary
through typed runtime locations.

### `RoomVisitContext`

Saved authoritative context for the active Room visit, including how that visit was entered. It
allows deterministic Room recomposition after save/load without rerunning `beforeEnter` or guessing
from the current previous-Room field.

### `CharacterWorldState`

Mutable persistent world state for one `CharacterId`, including its current world location and basic
world eligibility. It does not contain Scene actor-slot state or renderer resources.

### Room-local cast

Derived presentation declarations owned by a Room. Room-local cast entries are useful for decorative,
temporary, or nonpersistent occupants. They do not create persistent world Characters and are not
Interaction subjects by default.

### `RoomPresentationDraft`

A temporary mutable builder used only while resolving one Room. It is initialized from validated
Room declarations and authoritative world state, may be modified by the restricted composition hook,
and becomes invalid when resolution returns.

### `ResolvedRoomPresentation`

An immutable backend-neutral description of the complete world-facing Room target. It contains
resolved references and values suitable for projection into the runtime presentation snapshot.

### `RoomPresentationResolution`

The complete result of Room resolution. It includes the immutable presentation target and the
derived Room-facing interaction/view data needed by runtime UI and input admission. Both parts are
produced from the same inputs and publication revision.

### Persistent world Character

A `CharacterDefinition` whose `CharacterWorldState` currently places it in a Room. It has one
authoritative world identity keyed by `CharacterId`.

### Scene actor

A presentation instance controlled by a Scene invocation and identified by Scene actor-slot
semantics. It may reference a Character that also has persistent world state, but it does not
implicitly move or duplicate that world Character.

### Interaction subject

A closed typed reference to a gameplay object that can participate in an Interaction. Initially this
is either a persistent Character or an Interactable.

## Current implementation baseline

The current implementation contains the following useful foundations:

- `RoomDefinition` with background, overlays, lifecycle conditions/effects, placements, and exits;
- `RoomTransitionFrame` with explicit condition, hook, commit, and completion stages;
- `InteractableState` with one location, enabled state, and visible state;
- `RoomPlacementRef { RoomId, RoomPlacementId }`;
- `RoomView` with description, background, overlays, placements, exits, and controls;
- `CharacterDefinition` with poses, expressions, defaults, resources, and Dialogue presentation;
- `ActorState` keyed by `{ SceneId, ActorSlotId }`;
- `PresentationProjector`, `RuntimePresentationSnapshot`, and `PresentationCoordinator`;
- checkpoint generations and a retained checkpoint service;
- mounted Layout presentation planes and lifecycle domains.

The current implementation has these limitations:

- each `RoomPlacement` points back to exactly one Interactable, duplicating and constraining the
  authoritative location relationship;
- Characters have no persistent world location or Room occupancy state;
- all actor state is Scene-slot keyed;
- Room-local decorative cast is not represented;
- Room entry commits before a complete world presentation target is resolved;
- Room composition cannot be deterministically rerun after load or backend recovery;
- the current `previous_room` concept does not fully preserve entry-exit/direction context;
- Interaction operands are Interactable-only;
- `RoomView` and presentation projection do not share one complete Room resolution;
- Room overlays, future Room actors, Interactables, and props do not yet flow through one resolver.

Implementation must migrate these limitations atomically. No compatibility path for the obsolete
Scene-only actor or Interactable-owned placement model is required.

## World location model

### Generic Room placements

The target Room placement contract is conceptually:

```cpp
struct RoomPlacementDefinition {
    RoomPlacementId id;
    NormalizedRect bounds;
    RoomPlacementPresentation presentation;
    std::int32_t order = 0;
};
```

The exact field names may follow existing conventions, but the following rules are mandatory:

- the placement belongs to exactly one `RoomDefinition`;
- the placement does not contain an `InteractableId` or `CharacterId` owner;
- `RoomPlacementRef { RoomId, RoomPlacementId }` remains the stable cross-boundary reference;
- placement bounds are finite and normalized;
- local ordering is explicit and deterministic;
- optional placement presentation may define a label, Layout-backed hit region, anchor behavior, or
  editor visualization, but it does not own the occupant;
- a placement is an anchor/region, not a mutable occupancy record.

This removes the current duplicated relationship in which an Interactable location names a placement
and the placement separately names that Interactable.

### Placement occupancy

Room placements are not exclusive locks by default. More than one presentation subject may resolve
to the same placement when the author intentionally overlaps content. The resolver must maintain
stable ordering and the editor should warn about suspicious overlap, but runtime resolution must not
invent ownership transfer or silently move another subject.

If a future feature requires exclusive occupancy, it must add an explicit typed policy. Exclusivity
must not be inferred from the existence of one placement reference.

### Interactable location

The existing unique-Interactable location model remains:

```cpp
using InteractableLocation = std::variant<
    InventoryLocation,
    NowhereLocation,
    RoomPlacementRef>;
```

`InteractableState` remains authoritative for:

- current location;
- enabled state;
- visible state.

Moving an Interactable changes `InteractableState`. It does not rewrite `RoomDefinition`, a resolved
Room result, or a renderer object.

An Interactable located at a placement in the active Room is eligible for Room resolution. Its
definition supplies reusable visual content; the placement supplies Room-local geometry; mutable
state determines whether it is enabled or visible.

### Character world location

The initial Character world-location model is:

```cpp
using CharacterWorldLocation = std::variant<
    NowhereCharacterLocation,
    RoomPlacementRef>;

struct CharacterWorldState {
    CharacterId character;
    CharacterWorldLocation location;
    bool enabled = true;
    bool visible = true;
};
```

The final implementation may reuse a common `NowhereLocation` marker where type safety remains
clear. It must not permit Inventory as a Character location in this initial contract.

Each `CharacterDefinition` has at most one persistent world state keyed by its `CharacterId`. A
Character with `Nowhere` location remains valid for Dialogue and Scene presentation but is not a
persistent occupant of a Room.

The initial world state is declared with the Character authoring record and compiled into
`CharacterDefinition` as one explicit `CharacterInitialWorldState`, analogous to an Interactable's
initial state declaration. `SessionState` copies that declaration into live `CharacterWorldState`
during initialization. No parallel compiled initial-state table or Room-owned duplicate is allowed.

### No Character-instance collection in the initial architecture

The initial design deliberately does not add a separate `CharacterInstanceDefinition` collection.
One `CharacterId` represents one persistent named world identity when world state is used. Scene and
Room presentation may still render multiple actor instances referencing the same Character.

If NovelTea later needs multiple persistent world instances sharing one Character template, a future
specification may split Character archetype from instance. Current IDs and save records must remain
typed enough to support that migration, but the engine should not pay the additional authoring,
property-owner, editor, save, and Interaction complexity now.

### Saved active Room visit context

The runtime must store an explicit active visit context, conceptually:

```cpp
struct RoomVisitContext {
    RoomId room;
    std::optional<RoomId> source_room;
    std::optional<RoomExitRef> entry_exit;
    std::uint64_t visit_index;
};
```

`entry_exit` refers to the source Room's selected exit. It is absent for direct entry, project
startup, editor teleport, or other navigation that did not use an exit.

The visit context is authoritative and saveable. It allows Room composition to depend on:

- the Room from which the player arrived;
- the exact exit/direction used;
- the target Room's visit ordinal;
- whether entry was direct rather than exit-based.

This solves reconstructibility for directional entry presentation. For example, a foyer may select a
left-facing curtain loop when entered through the west door. Save/load reruns composition with the
same saved visit context instead of rerunning `beforeEnter` or relying on transient callback state.

The existing active/previous Room and visit-count APIs may be retained as derived conveniences, but
they must not compete with `RoomVisitContext` as another entry-context source of truth.

## Character roles and ownership

### `CharacterDefinition`

`CharacterDefinition` continues to own immutable reusable content:

- identity and display name;
- Dialogue name and style;
- poses and expressions;
- default pose and expression;
- sprite/material references and transforms;
- declared custom properties and same-kind property inheritance.

It does not own current world location, current Room placement, Scene actor slots, transition
progress, renderer resources, or a mutable on-screen singleton.

### Persistent world Characters

A persistent world Character is a `CharacterId` whose `CharacterWorldState` places it in a Room.
Room resolution creates a presentation actor for it using:

- its immutable Character definition;
- its authoritative world location;
- Room placement geometry;
- Character defaults;
- applicable Room declarations and composition overrides;
- applicable scoped desired-presentation contributions defined by the companion presentation spec.

Moving Sarah from foyer to kitchen changes `CharacterWorldState[sarah].location`. It does not require
mutually exclusive Room variables or duplicate Room-owned Sarah definitions.

Persistent world Characters may be Interaction subjects when enabled, visible, located in the active
Room, and admitted by the resolved Room interaction view.

### Room-local cast

A Room may declare lightweight cast entries conceptually shaped as:

```cpp
struct RoomCastEntry {
    RoomCastEntryId id;
    CharacterId character;
    Condition condition;
    RoomPlacementId placement;
    std::optional<CharacterPoseId> pose;
    std::optional<CharacterExpressionId> expression;
    bool visible = true;
    std::int32_t order = 0;
};
```

Room-local cast entries are derived presentation, not persistent world Characters. They are suitable
for:

- decorative occupants;
- crowds and attendants;
- conditional background Characters;
- portrayals whose location outside the Room is irrelevant;
- Room-specific variants that should be recomputed from variables/properties.

Room-local cast entries:

- are owned by the Room definition;
- are reevaluated during every Room resolution;
- are not serialized as mutable Character world state;
- are not Interaction subjects by default;
- use stable `RoomCastEntryId` identity;
- may reference the same `CharacterDefinition` more than once through distinct entry IDs;
- must not silently mutate `CharacterWorldState`.

If an occupant must move between Rooms, preserve state, or participate in general Interactions, it
should use persistent Character world state rather than a Room-local cast entry.

### Scene actors

Scene actors remain presentation instances controlled by Scene actions. A Scene actor may portray a
Character regardless of that Character's persistent world location.

Scene actor behavior must obey these rules:

- creating or removing a Scene actor does not move the persistent Character;
- a Scene may portray the same Character in multiple actor slots;
- Scene actor identity includes its owning Scene invocation or equivalent stable presentation owner,
  not only `SceneId`;
- Scene completion removes Scene-owned actor presentation according to the companion scoped
  presentation specification;
- an explicit world command is required to change `CharacterWorldState`.

The current global `{ SceneId, ActorSlotId }` key is therefore not the final universal actor identity.
It may remain as a nested Scene-program address, but runtime desired actor identity must support
Scene, Room-derived, and persistent-world sources without collisions.

### Actor resolution identities

Every actor emitted by Room resolution must have deterministic backend-neutral identity. The exact
variant belongs to the presentation-state specification, but this spec requires distinct identity
for at least:

- persistent world Character actor: keyed by `CharacterId` in the active Room;
- Room-local cast actor: keyed by `{ RoomId, RoomCastEntryId }`;
- composition-hook actor: keyed by `{ RoomId, stable hook-provided entry ID }`;
- scoped desired actor contribution: keyed by its typed presentation-record ID;
- Scene actor: keyed by its owning Scene invocation and actor slot.

The resolver must reject duplicate identities within one effective target rather than accepting
last-write-wins behavior accidentally.

## Interactables and Interaction subjects

### Interactables remain unique gameplay entities

An Interactable continues to represent one unique world/inventory gameplay object. It is not a
presentation prop and not a stackable Item count.

An Interactable is included in active Room resolution when:

- its location is a `RoomPlacementRef` owned by the active Room;
- the placement exists;
- its state is visible for presentation;
- its definition and resources resolve successfully.

Enabled state affects Interaction eligibility. Visible state affects presentation and, by default,
selection eligibility. A future explicit invisible-interaction policy must be typed; it must not
arise accidentally because UI and renderer used different resolution paths.

### Presentation props are not Interactables

A decorative visual added by Room declarations, composition, Scene presentation, or scoped desired
state is a prop or other presentation record. It cannot participate in an Interaction merely because
it uses the same sprite as an Interactable.

To make an object interactive, authors must define or reference an actual Interactable and move its
authoritative state to a Room placement.

### Character and Interactable subjects

The Interaction domain must migrate from Interactable-only operands to an explicit closed subject
variant, conceptually:

```cpp
struct CharacterInteractionSubject {
    CharacterId character;
};

struct InteractableInteractionSubject {
    InteractableId interactable;
};

using InteractionSubject = std::variant<
    CharacterInteractionSubject,
    InteractableInteractionSubject>;
```

Exact and wildcard operands should become typed variants such as:

```cpp
struct ExactInteractionSubjectOperand {
    InteractionSubject subject;
};

struct AnyCharacterOperand {};
struct AnyInteractableOperand {};
struct AnyInteractionSubjectOperand {};
```

The exact final wildcard set must be closed and compiler-validated. It must not use string kind tags
or generic entity IDs.

Interaction selection, preview/test inputs, runtime messages, Interaction matching, and RmlUi binding
must consume the same subject vocabulary. Room-local cast entries are not valid exact subjects.

### Interaction eligibility derives from one resolution

The active Room's selectable/interactive subject list must be derived from the same
`RoomPresentationResolution` used to publish visual occupants. This prevents a Character or
Interactable from being visible in the renderer but absent from Interaction selection, or selectable
after composition has suppressed its presentation.

Eligibility considers:

- authoritative location;
- authoritative enabled/visible state;
- placement validity;
- Room and Interaction conditions;
- deterministic composition visibility overrides allowed by this specification;
- current runtime mode and input policy.

## Room definition target model

The target `RoomDefinition` conceptually owns:

```cpp
struct RoomDefinition {
    PropertyBearingDefinition<RoomId> identity;
    std::string display_name;
    TextContent description;
    RoomPresentationDefaults presentation;
    RoomLifecycle lifecycle;
    std::vector<RoomPlacementDefinition> placements;
    std::vector<RoomExit> exits;
    std::optional<RoomCompositionHook> compose;
};
```

`RoomPresentationDefaults` includes the Room's declarative baseline, such as:

- background;
- Room-overlay or world-Layout entries;
- Room-local cast;
- decorative props;
- environmental presentation declarations;
- other world-facing Room defaults admitted by the scoped presentation specification.

The implementation may retain current background/overlay fields while migrating, but the compiler
and resolver must expose one coherent baseline rather than several unrelated initialization paths.

### Declarative conditions

Room-local cast, props, overlays, and environmental entries may carry typed conditions. Declarative
conditions are the preferred authoring mechanism for common cases such as:

```text
Show Sarah at the window when sarah_visited is true.
Show the rain overlay when storm_active is true.
Show the broken-window prop when window_broken is true.
```

Conditions are evaluated synchronously through the existing typed condition evaluator. Missing or
invalid references fail compilation. Runtime condition evaluation failure fails Room resolution.

### No structural inheritance merge

Room `extends` remains custom-property lookup only. Placements, cast entries, props, overlays,
composition hooks, exits, backgrounds, and lifecycle programs do not merge through inheritance.

## Room composition hook

### Developer-facing contract

The preferred author-facing name is `compose`, with a callback shaped conceptually as:

```lua
function room.compose(context, presentation)
    -- Read state through context.
    -- Modify only this temporary presentation draft.
end
```

The callback parameter is named `presentation` for author usability. The C++ implementation type may
be `RoomPresentationDraft`.

### Why this is not `onLoad`

`onLoad` is ambiguous. It could mean package load, save load, asset preload, editor preview, Room
entry, or backend restoration. `compose` specifically means:

> Deterministically derive the Room's current target presentation from immutable Room content,
> authoritative runtime state, and saved Room-visit context.

### Composition ordering

Resolution proceeds in this order:

1. validate the target Room and visit context;
2. initialize the draft from Room declarative defaults;
3. add eligible persistent Characters located in the Room;
4. add eligible Interactables located in the Room;
5. evaluate declarative Room-local cast, props, Layouts, and environment conditions;
6. invoke the optional restricted `compose` callback against the Room baseline draft;
7. apply applicable saved current-Room, named-Room, and session desired-presentation contributions;
8. validate the completed draft and resolve all resources/placements;
9. freeze the immutable `ResolvedRoomPresentation` and associated Room view/interaction data.

The companion scoped-presentation specification defines conflict and precedence rules among scoped
records, but it must preserve this integration boundary: Room declarations and pure composition build
the Room baseline first; explicit saved desired-state contributions are then able to add, remove, or
override that baseline. Scene-owned presentation is layered by the broader presentation projector
after Room resolution rather than being an input to the Room's pure `compose` callback.

### Composition context

The read-only context must provide only deterministic Room-relevant queries, including:

- target Room ID;
- saved `RoomVisitContext`;
- source Room and entry exit when present;
- current visit index and prior visit count;
- runtime locale where text resolution requires it;
- read-only variables;
- read-only typed property lookup;
- read-only Character world state;
- read-only Interactable state;
- immutable compiled definition queries exposed through safe semantic helpers.

The callback must not receive `Engine`, `RuntimeSession`, `SessionState`, `FlowExecutor`, renderer,
RmlUi, audio, save storage, or unrestricted script APIs.

### Draft capabilities

The draft API should provide closed typed operations such as:

```lua
presentation:set_background(...)
presentation:show_character(...)
presentation:hide_character(...)
presentation:add_cast_actor(...)
presentation:add_prop(...)
presentation:remove_prop(...)
presentation:mount_layout(...)
presentation:unmount_layout(...)
presentation:set_environment(...)
```

These names are illustrative. Final binding names belong to the runtime-capability specification.
Every operation must:

- accept typed or validated IDs;
- require a stable entry ID for additions;
- reject missing Characters, placements, Layouts, assets, materials, or environment definitions;
- reject duplicate effective identities;
- mutate only the temporary draft;
- return structured diagnostics on failure.

The draft does not provide `add_interactable` as a way to create gameplay entities. An actual
Interactable must be moved through authoritative world state before resolution. The draft may change
how an already-located Interactable is presented or suppress it from the resolved view when the
contract explicitly permits that override.

### Purity restrictions

The composition callback must not:

- yield or create a coroutine suspension;
- mutate variables, properties, Character state, Interactable state, Flow, Room mode, or scoped
  desired state;
- navigate, call or replace a Scene/Dialogue, or invoke an Interaction;
- play or stop audio;
- request saves, autosaves, notifications, platform work, or host work;
- read wall-clock time, frame count, backend timing, or nondeterministic random values;
- access renderer, RmlUi, miniaudio, SDL, filesystem, network, or OS APIs;
- retain the draft or context beyond the callback;
- mutate shared Lua globals in a way that affects future resolution;
- depend on callback invocation count.

The implementation must enforce these restrictions with a dedicated restricted binding environment,
not by documentation alone. A composition callback is not an ordinary `RunLua` instruction.

### Determinism

Given the same:

- `CompiledProject`;
- target `RoomId`;
- saved `RoomVisitContext`;
- authoritative runtime variables/properties/world state;
- scoped desired-presentation records;
- runtime locale;

the resolver must produce the same logical result and ordering. Hash-map iteration, Lua table
iteration, process addresses, backend state, or frame timing must not affect output.

### Callback failure

Composition failure returns typed diagnostics and publishes no partial draft.

- During navigation, failure occurs before Room commit and leaves the source Room authoritative.
- During startup direct Room entry, failure prevents successful runtime start.
- During save restoration, failure faults restoration rather than loading a partially presented Room.
- During active-Room recomposition, failure prevents a new publication and faults the runtime
  transaction. The last backend frame may remain visible only as a diagnostic fallback; it is not a
  new authoritative result.
- During editor preview, failure appears as preview diagnostics.

## Room presentation resolution

### Resolver ownership

One backend-neutral `RoomPresentationResolver` owns Room resolution. No renderer, RuntimeUI path,
Room hook, Scene executor, editor adapter, or save loader may implement a parallel Room-assembly path.

Conceptually:

```cpp
class RoomPresentationResolver {
public:
    Result<RoomPresentationResolution, Diagnostics>
    resolve(const CompiledProject& project,
            const SessionState& state,
            const RoomVisitContext& visit,
            const ScopedPresentationView& scoped,
            std::string_view runtime_locale) const;
};
```

The exact dependency ports may change after the runtime-capability specification. The resolver must
receive read-only inputs and return owned values. It must not mutate `SessionState`.

### Resolved presentation contents

`ResolvedRoomPresentation` must include complete backend-neutral world-facing records for at least:

- Room identity and visit context identity/revision;
- resolved background;
- resolved persistent world Character actors;
- resolved Room-local and compose-hook cast actors;
- resolved Interactable visuals and placement geometry;
- resolved decorative props;
- participating Room/world Layout mounts;
- environment and looping presentation intent admitted by the presentation spec;
- stable ordering and presentation-plane membership;
- enough resource IDs and resolved Character pose/expression information for projection without
  querying mutable runtime state from a renderer.

It must not include:

- bgfx handles or view IDs;
- RmlUi contexts/documents/elements;
- miniaudio voices or decoder state;
- tween objects or interpolation progress;
- Lua references, tables, functions, or coroutine state;
- mutable pointers into `CompiledProject` or `SessionState`;
- JSON values;
- callbacks.

### Associated Room view

The same resolution must produce or support derivation of Room-facing runtime UI data, including:

- resolved description text/markup;
- visit count/context;
- valid exits and labels;
- placement bounds and labels;
- visible/selectable Interaction subjects;
- controls admitted by the active runtime mode and Layout/input policy.

The engine must not independently evaluate Room occupants once for rendering and again for UI.

### Resolved values are revisioned

Room resolution participates in the settled runtime publication boundary. Its output receives or is
embedded in the same publication revision used by gameplay UI and the broader
`RuntimePresentationSnapshot`.

The resolver itself need not invent another global transaction system. It runs before the existing
runtime transaction publishes.

## Recomposition

### When recomposition occurs

The active Room is resolved:

- before initial Room entry;
- before every successful Room-navigation commit;
- after save restoration;
- after explicit active-Room presentation invalidation;
- after a settled runtime transaction that changed a possible Room-composition input;
- for editor Room preview;
- for backend recovery when the current immutable publication must be rebuilt from logical state.

Backend recovery may reuse the last immutable resolved publication when it remains valid; it must not
rerun ordinary lifecycle effects.

### Dirty tracking

Initial implementation should use conservative explicit dirty tracking rather than arbitrary Lua
dependency analysis.

Changes that mark active Room presentation dirty include at least:

- variables or properties readable by composition/declarative conditions;
- Character world location/enabled/visible state;
- Interactable location/enabled/visible state;
- applicable current-Room, Room, or session desired-presentation records;
- Room overlay/Layout state;
- runtime locale changes affecting resolved text;
- explicit `Room.refresh_presentation()` or equivalent typed command.

The runtime may coalesce multiple changes and resolve once at transaction settlement. It must not
resolve every rendered frame.

### Recomposition is not Room reentry

Active-Room recomposition does not:

- increment visit count;
- replace `RoomVisitContext`;
- run `canEnter`, `canLeave`, `beforeEnter`, `afterEnter`, `beforeLeave`, or `afterLeave`;
- clear current-Room scoped state;
- reset Flow;
- create a Room-navigation transition unless a higher-level command explicitly requests a visual
  transition from the previous target to the new target.

### Publication behavior

If the newly resolved target differs from the previous target, the runtime publishes the new desired
snapshot once. The presentation coordinator may cut, interpolate, or run an explicit finite operation
according to the command that caused the change and the scoped-presentation contract.

Pure recomposition does not implicitly invent animation. If no transition operation was authored,
the desired target changes with normal reconciliation.

## Room navigation transaction

### Final stage ordering

Room navigation follows this normative order:

```text
1. validate navigation source, requested target, and selected exit
2. evaluate source canLeave
3. evaluate selected exit condition when applicable
4. evaluate target canEnter
5. run source beforeLeave effects
6. run target beforeEnter effects
7. construct the pending target RoomVisitContext
8. resolve the complete target Room presentation
9. atomically commit:
     - active Room/Room mode target
     - previous/source Room history
     - target visit count and active RoomVisitContext
     - cleanup of source current-Room scoped desired state
     - target resolved publication
10. realize the configured source-to-target Room navigation transition
11. run source afterLeave effects
12. run target afterEnter effects
13. complete the navigation frame and admit normal target Room input
```

Steps 5 and 6 retain existing yielding lifecycle-effect behavior. Step 8 itself is synchronous and
non-yielding.

The implementation may represent the visual transition as an explicit stage and blocker in the Room
navigation frame. It must preserve the above semantic order.

### Why composition follows `beforeEnter`

`beforeEnter` may mutate authoritative state that determines the target presentation. For example,
it may set `sarah_visited`, move Sarah to the foyer, or change a Room property. The resolver must see
those completed mutations so Sarah and other content are already present in the transition target.

### Why `afterEnter` follows the visual transition

`afterEnter` is for work that should occur once the destination has visually taken over, such as
starting Dialogue, showing a notification, or issuing post-entry gameplay behavior. Presentation
that must be visible in the transition target belongs in Room declarations, authoritative world
state, scoped desired state established before resolution, or the `compose` callback.

### Current-Room scope during navigation

The companion scoped-presentation specification must define exact command behavior during navigation.
This specification fixes these world semantics:

- source current-Room state remains active in the captured source presentation;
- source current-Room state is removed only by successful commit;
- target composition does not inherit source current-Room state;
- ordinary `current-room` commands issued before commit refer to the currently active source visit
  unless an explicit target-visit API says otherwise;
- target presentation preparation should normally use authoritative world mutations, target
  Room-owned state, declarative Room content, or the pure composition hook rather than ambiguous
  current-Room commands during `beforeEnter`.

### Transition policy

The detailed transition type belongs to the presentation-state specification. Room navigation must
support this precedence:

1. explicit navigation-command override;
2. selected exit transition policy;
3. project default Room-navigation transition.

The normal Room-navigation visual operation is causal and blocks normal target Room input until it
completes, is skipped according to policy, or fails.

### Failure semantics

Before the atomic commit:

- failure leaves the source Room and source current-Room state authoritative;
- target visit count is not incremented;
- no target resolved publication becomes visible;
- no source current-Room cleanup occurs.

After the atomic commit:

- the target Room remains authoritative;
- source current-Room state remains removed;
- failure is fail-stop and reported with typed diagnostics;
- the runtime must not silently roll back to the source after showing or committing the target;
- checkpoint replacement remains blocked until the causal navigation operation reaches a terminal
  state accepted by runtime policy.

These rules preserve the existing pre-commit/source and post-commit/target fault distinction.

### Direct entry and teleport

Project startup, debug teleport, tests, and explicit direct Room targets use the same resolver and
commit contract. They may omit selected-exit validation and use an absent `entry_exit` in
`RoomVisitContext`. They must not bypass `canEnter`, lifecycle hooks, composition, visit counting, or
publication unless a narrowly named debug-only operation explicitly documents the bypass.

## Scripts, Scenes, and world mutation

### Ordinary scripts do not mutate the resolved draft

The `RoomPresentationDraft` exists only inside `compose`. Ordinary Scene scripts, Interaction
programs, Layout events, tests, and debug tools modify:

- authoritative world state, such as Character or Interactable location; or
- typed scoped desired-presentation records defined by the companion presentation spec.

They do not retain or modify the last `ResolvedRoomPresentation`.

### Character world commands

The runtime capability layer must provide semantic Character world operations such as:

```text
Character.location(character)
Character.move(character, room, placement)
Character.remove_from_world(character)
Character.set_enabled(character, enabled)
Character.set_visible(character, visible)
```

Exact Lua names are not fixed here. These commands validate definitions and placements, mutate
`CharacterWorldState`, mark affected Room presentation dirty, participate in save generations, and
publish only at settled transaction boundaries.

### Interactable commands

Existing Interactable location and state APIs remain semantic world operations. They must migrate
from the current external-host-request round trip to the final internal runtime-command path when the
runtime-capability plan implements that separation.

### Presentation-only additions

Scripts and Scenes may add actors, props, Layouts, or environment state with Scene, current-Room,
Room, or session lifetime through the scoped desired-presentation API. Such records are not actual
Interactables and do not change persistent Character world location unless an explicit world command
also does so.

### Scene presentation over a Room

A Scene may execute while a Room remains the underlying gameplay location. The effective world target
may include:

- the resolved active Room presentation;
- applicable scoped desired-presentation records;
- Scene-owned actor/Layout/background contributions.

The companion presentation-state specification defines merge and replacement rules. This document
requires that Scene presentation not destroy or mutate the underlying Room resolution merely by
being displayed.

When a Scene ends, Scene-owned presentation is removed according to its owner semantics. Persistent
world locations and Room-owned presentation remain unless explicitly changed.

## Save and restore

### Saved authoritative data

Save data must include:

- active `RoomVisitContext`;
- Room visit counts and required Room history;
- `CharacterWorldState` for every Character;
- existing `InteractableState`;
- saved variables and property overrides;
- scoped current-Room, Room, and session desired-presentation records defined by the companion spec;
- stable Flow/checkpoint state according to the checkpoint contract.

### Derived data not saved

Save data does not include:

- `RoomPresentationDraft`;
- `ResolvedRoomPresentation` as a second authoritative snapshot;
- Room-local cast evaluation results;
- condition evaluation caches;
- resolved text caches;
- renderer resources;
- RmlUi documents or elements;
- exact animation/loop phase;
- transition source/destination render targets;
- Lua callback state.

### Restore procedure

Restoring a save containing an active Room performs:

```text
1. decode and validate authoritative save state
2. restore active RoomVisitContext, world state, variables/properties, and scoped desired state
3. resolve the active Room through RoomPresentationResolver
4. publish one coherent gameplay UI and presentation revision
5. reconstruct backends from desired state
```

Room entry conditions and lifecycle hooks are not rerun. The saved visit context and already-mutated
authoritative state are the inputs needed to reproduce the Room target.

### Current-Room state

Current-Room scoped desired state is saved. On restore, it is associated semantically with the
restored active Room visit and remains until the next successful Room departure. The engine need not
preserve a process-local numeric visit token if it can restore the exact lifetime semantics with a
fresh internal token.

### Checkpoint safety

Room composition is synchronous and occurs inside runtime transaction settlement. The engine never
captures a checkpoint halfway through composition.

Long-running reconstructible Room presentation, such as environmental loops, may remain active while
a checkpoint is captured. Finite causal navigation or authored operations remain governed by the
existing `CheckpointClass` contract.

## Authoring model

### Room editor

The Room editor must ultimately support:

- generic named placement anchors independent of a specific occupant;
- Room background and description;
- exits and navigation-transition policy;
- lifecycle conditions/effects;
- Room-local cast entries with conditions and pose/expression/placement controls;
- Room props and world-overlay Layout entries;
- environment declarations admitted by the presentation spec;
- optional composition-hook selection/configuration;
- preview with variables, properties, visit context, Character world locations, and Interactable
  state;
- diagnostics for missing references, invalid placement use, duplicate IDs, and composition errors.

The editor should expose declarative conditions for common arrangements before requiring authors to
write Lua.

### Character editor

The Character editor must support an optional initial world state:

- Nowhere or Room placement location;
- enabled state;
- visible state.

Dialogue-only Characters default to Nowhere. Character pose/expression preview remains tooling state
and is not confused with world location.

### Interactable editor

Interactable initial Room location continues to reference a Room placement. The Room placement no
longer points back to the Interactable. Editor operations must repair or reject stale initial/runtime
references when a placement is deleted or renamed according to normal typed-reference policy.

### Scene editor

Scene actor controls remain presentation controls. An explicit Character-world action or script
command is required to move a persistent Character. The editor must not imply that showing Sarah in
a Scene automatically moves Sarah into the active Room.

### Interaction editor

Interaction rules and test controls must support exact Character and Interactable subjects plus the
closed wildcard variants. The editor should clearly distinguish persistent Characters from
Room-local cast entries, which cannot be selected as gameplay subjects.

## Authoring compiler and compiled boundary

The pure TypeScript compiler must:

- compile generic Room placements without occupant back-references;
- validate Character and Interactable initial locations against Room placements;
- compile Character initial world state;
- compile Room-local cast and other declarative Room presentation entries;
- validate every local nested ID and reference;
- compile optional composition-hook references/configuration;
- compile Room navigation transition policy;
- compile Character/Interactable Interaction-subject variants;
- preserve deterministic ordering;
- calculate complete resource closure for all Room declarations and composition-hook modules;
- emit no editor-only preview state.

The native decoder/linker must reject:

- missing Rooms, placements, Characters, Interactables, Layouts, assets, materials, or scripts;
- placement references owned by the wrong Room;
- invalid pose/expression combinations;
- duplicate nested IDs;
- invalid enum values or nonfinite geometry;
- invalid Interaction-subject variants;
- composition-hook configuration that violates the compiled contract;
- cyclic or cross-kind property inheritance as already required.

The wire migration must be atomic. The engine does not retain a legacy decoder for the old
Interactable-owned placement or Interactable-only Interaction operand shape.

## Runtime state organization

This specification does not require multiple state owners. The target `SessionState` remains one
authoritative aggregate, but its world-related slice must contain at least:

```text
active RoomVisitContext
Room visit counts/history
CharacterWorldState records
InteractableState records
variables and property overrides used by world resolution
```

Scoped desired-presentation records may live in a presentation-state slice of the same aggregate.
The `RoomPresentationResolver` receives const views of those state families.

Mutation APIs must:

- validate against `CompiledProject` before mutation;
- update structural checkpoint generations;
- mark affected Room presentation dirty;
- avoid publishing intermediate targets;
- return typed diagnostics;
- preserve no-exceptions/no-compiler-RTTI policy.

## Preview, testing, and tooling

### Editor Room preview

Room preview must call the same resolver contract as runtime, with an explicit preview input bundle
containing:

- selected Room;
- preview `RoomVisitContext`;
- preview variable/property values;
- preview Character world states;
- preview Interactable states;
- preview scoped contributions where supported;
- runtime locale.

Preview must not maintain a separate interpretation of cast conditions or placement occupancy.

### Runtime preview and debugger

The full-game preview/debugger should expose:

- active Room and saved visit context;
- persistent Character world locations;
- Interactable locations;
- resolved Room actor/prop/Layout entries and their source/owner;
- Room-presentation dirty/revision status;
- composition diagnostics;
- selectable Interaction subjects.

Debug mutations use the same typed runtime capabilities as Lua and tests.

### Required test categories

Implementation plans must include at least:

- generic placement validation and migration tests;
- Character initial/world-location tests;
- persistent Character movement between Rooms;
- Room-local cast condition and identity tests;
- same Character used by persistent world, Room-local cast, and Scene actor without identity collision;
- Interactable and Character Interaction-subject matching;
- pure composition callback capability-denial tests;
- deterministic composition output tests;
- entry-direction/exit-dependent composition tests;
- save/load reconstruction using saved `RoomVisitContext`;
- active-Room recomposition without lifecycle reentry;
- pre-commit composition failure preserving the source Room;
- post-commit transition failure preserving the target Room;
- current-Room state cleanup only after successful departure;
- one coherent UI/presentation publication revision;
- editor preview/runtime resolver parity;
- Linux and Web build/test coverage, with Android coverage when affected host/render boundaries are
  implemented.

## Validation and invariants

The following invariants are mandatory.

### Definition invariants

- Room placement IDs are unique within a Room.
- Room cast/prop/overlay/environment IDs are unique within their typed family.
- Every Room-local reference resolves to the correct definition kind.
- Character pose and expression references are valid for the selected Character.
- Every initial Character/Interactable Room location references an existing placement in the named
  Room.
- Room structural collections do not inherit or merge.

### Runtime world invariants

- Every Character has at most one `CharacterWorldState` keyed by `CharacterId`.
- Every Interactable has exactly one `InteractableState` keyed by `InteractableId`.
- A Room placement reference always names an existing placement owned by the named Room.
- The active Room and active `RoomVisitContext.room` agree.
- Normal Room mode has one valid resolved Room publication.
- Scene actor creation never mutates Character world location implicitly.
- Room-local cast never creates a persistent world Character implicitly.

### Resolution invariants

- Resolution is synchronous and deterministic.
- Resolution does not mutate authoritative state.
- Every emitted entry has stable typed identity.
- Duplicate effective identities fail with diagnostics.
- Rendered/selectable persistent subjects derive from one resolution.
- No partial result is published on failure.
- No backend object enters the resolved value.

### Navigation invariants

- No target publication appears before all pre-entry effects and target resolution succeed.
- Source current-Room state remains until successful commit.
- Target visit count and context update exactly once.
- After hooks never run before visual entry reaches the defined completion point.
- Normal target Room input is blocked during the causal navigation operation.

### Save invariants

- Active Room visit context, Character world state, and Interactable state are serialized once.
- Derived Room presentation is never a second persisted authority.
- Restore does not rerun Room lifecycle effects.
- Current-Room scoped state survives restore and is removed on the next successful departure.

## Diagnostics

World and Room diagnostics should use stable namespaces such as:

```text
room.definition.*
room.placement.*
room.compose.*
room.resolve.*
room.navigation.*
character.world.*
interaction.subject.*
```

Diagnostics must identify relevant stable IDs and the failing source path or runtime operation. The
engine must not report only a generic Lua, renderer, or invalid-state error when a typed Room or world
invariant can be named.

## Non-goals

This specification does not add:

- a generic entity/component system;
- a common Character/Interactable base class;
- stackable inventory Items or counts;
- multiple persistent Character instances per Character definition;
- pathfinding, navigation meshes, physics, collision, or 3D transforms;
- automatic spatial exclusivity for placements;
- arbitrary save-anywhere Lua coroutine serialization;
- per-frame Room composition;
- dependency tracing for arbitrary Lua reads;
- direct renderer or RmlUi access from Room composition;
- automatic conversion of Room-local cast into Interaction subjects;
- implicit movement of persistent Characters when Scenes display them;
- legacy compiled-project or save compatibility.

## Implementation disposition

The implementation work derived from this specification should be segmented by substantive domain:

1. authoring/compiled world contract migration, including generic placements, Character world state,
   Room-local cast, composition-hook references, and Interaction subjects;
2. native runtime world state and save migration;
3. restricted composition environment and `RoomPresentationResolver`;
4. Room navigation transaction integration and coherent publication;
5. preview/editor/debugger migration and deletion of obsolete paths.

The active presentation implementation plan should consume the completed world contract before
implementing final world renderer and transition realization. The exact phase numbering belongs to
that revised plan.

## Completion criteria

This specification is implemented only when:

- Room placements are generic anchors rather than Interactable-owned records;
- persistent Characters have typed saved world state keyed by `CharacterId`;
- Room-local cast, persistent world Characters, Scene actors, and Interactables have nonduplicated
  ownership and stable identities;
- Character and Interactable Interaction subjects use one closed typed variant;
- one `RoomPresentationResolver` produces complete deterministic Room targets for entry, active
  recomposition, save restore, preview, and recovery;
- the Room `compose` callback is restricted and enforceably side-effect-free;
- saved `RoomVisitContext` preserves source/exit/visit information needed for recomposition;
- destination presentation is fully resolved before atomic Room commit and visual transition;
- active-Room recomposition does not rerun lifecycle hooks;
- saves contain authoritative inputs rather than cached resolved presentation;
- current-Room scoped presentation survives save/load and clears only on successful Room departure;
- UI, Interaction selection, and world presentation derive from the same settled Room resolution;
- no current production path still relies on Interactable-owned placement, Scene-only universal actor
  identity, or independent renderer/UI Room assembly.
