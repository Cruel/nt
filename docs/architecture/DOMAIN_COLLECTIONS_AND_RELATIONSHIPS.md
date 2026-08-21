# Domain Collections and Relationships

## Collection disposition

This table is the authoritative current ownership map. Authoring records are editor-owned source; wire values are strict `noveltea.compiled.project` V4 data; mutable values belong to `SessionState` unless marked tooling-only.

| V2 collection/section | Authoring owner | Compiled representation | Runtime disposition |
| --- | --- | --- | --- |
| Project root/settings | Editor project/compiler | Compiled root, settings, startup hook, entrypoint, indexes | Immutable project-owned configuration; root is not an entity |
| Properties | Typed declarations and owner assignments | Global and identity-scoped `PropertyDefinition`s plus retained direct assignments | One sparse typed override store; every override is checkpoint/save state |
| Traits | Capability/configuration declarations over ordinary Properties | `TraitDefinition`s plus per-definition Trait attachments | Immutable metadata/configuration; values resolve through the Property system |
| Archetypes | Same-kind reusable Room/Character/Interactable configuration chains | Fully flattened into the attached declared instance; no Archetype wire/runtime collection | Authoring-only blueprint; no runtime identity, Location, or mutable state |
| Variables | Editor-facing Global Property declarations/defaults | Lowered into `properties[]` with `scope: global` | Same Global Property resolver/override store; no separate Variable runtime state |
| Characters | Character records | `CharacterDefinition` | Immutable definition; presented instances are `ActorState` |
| Scenes | Scene records and strict steps | `SceneDefinition` + `SceneProgram` | Scene flow frame and logical waits |
| Dialogues | Dialogue graph records | `DialogueDefinition` + `DialogueProgram` | Dialogue frame, show-once/history state |
| Rooms | Room records, placements, exits, hooks | `RoomDefinition` | Active Room, visits, RoomTransition frames |
| Interactables | Unique Interactable records and initial declarations | `InteractableDefinition` | Unique location, enabled/visible state |
| Verbs | Verb records | `VerbDefinition` + default `InteractionProgram` | Immutable; fallback execution and property overrides only |
| Interactions | Ordered rules/programs | `InteractionRule` + `InteractionProgram` | Interaction frames and effects on typed state |
| Maps | Map presentation records | `MapDefinition` linked to Room exits | Focus/visibility presentation state when needed |
| Script Modules | Inline/Asset Lua records | Script resource IDs/source references | Explicit invocation only; no entity or mutable record |
| Assets | Asset records/import metadata | Typed resource IDs and aliases | Prepared asset registries; backend resource lifetime outside session state |
| Layouts | RML/layout source records | Typed layout resource IDs | Prepared runtime UI resources, not entities |
| Shaders/materials | Dedicated authored metadata | Separate versioned shader/material document and resource IDs | Prepared render registries, not entities |
| Localization | Project locale catalogs | Compiled locale catalogs | Selected locale/fallback lookup; source catalogs immutable |
| Tests | Editor test records | Not gameplay wire data | Tooling/playback input only |
| Categories/tags/editor metadata | Editor organization | Not emitted | No runtime meaning |

Every runtime-relevant authoring collection has exactly one owner and compiled disposition above. V1 emits all valid runtime definitions; it performs no reachability pruning because approved Lua APIs may refer to stable IDs dynamically.

## Fixed relationships

### Room placement and Interactable location

`RoomPlacement { RoomPlacementId, InteractableId, bounds, presentation }` is nested immutable Room data. `InteractableState.location` is exactly Inventory, Nowhere, or `RoomPlacementRef { RoomId, RoomPlacementId }`. One unique Interactable has at most one active location. Stackable/count inventory is not V1 and awaits an explicit `ItemDefinition` design.

### Room exits and Maps

Room exits own navigation topology. `RoomExit { RoomExitId, target RoomId, condition }` is nested Room data. A Map connection references `RoomExitRef { RoomId, RoomExitId }`; its target is derived from the exit. Selecting a location changes focus only. Selecting a connection invokes the normal Room navigation pipeline only when the exit belongs to the active Room. Maps do not grant fast travel or duplicate topology.

### Character definitions and actors

`CharacterDefinition` owns immutable identity, dialogue presentation, poses, expressions, and default resources. Scene-local `ActorSlotId` references one Character and permits multiple simultaneous slots for that Character. `ActorState` owns current pose, expression, placement, visibility, and completed logical presentation state.

### Scene and Dialogue calls

`SessionState` owns one explicit flow stack and blocker; one non-state-owning `FlowExecutor` is the sole
mutation service. It runs Scene, Dialogue, Interaction, and RoomTransition frame variants. A Scene or
Interaction call to Scene/Dialogue advances the caller and pushes a fresh child frame; Return pops it
and resumes that caller. A terminal Scene/Dialogue target tail-replaces at the same depth while
preserving the frame's return destination. A Room target replaces the chain with a RoomTransition
frame and therefore still runs the applicable Room conditions and hooks before Room mode begins. End
clears flow and enters Ended mode. Return is invalid at a direct project entrypoint, but a transient
root flow started from Room mode may Return to its captured Room.

## Traits and properties

Editor categories/tags organize source only. Traits attach only to stateful Gameplay Instances: Room, Character, and Interactable. Scene, Dialogue, Verb, Interaction, and Map are immutable program/vocabulary definitions and are not Property or Trait owners. A Trait declares required or configured ordinary identity-scoped Properties for that closed owner set; it does not contribute structural fields or create a separate runtime value family.

Identity Property resolution is: target runtime override, owner direct authored assignment, configured value from an attached Trait, declaration default, then typed missing. Global Property resolution is its runtime override followed by its required authored default. Unset removes one override and resumes lookup; explicit nullable null remains a value. Identity values never propagate between definitions. Every runtime Property override serializes once at its actual target; authored assignments, Trait configuration, defaults, and other effective values do not.

Compilation rejects missing or owner-incompatible Trait attachments, incompatible configured values, conflicting Trait providers, and unsatisfied required members. Universal same-type gameplay `extends` is retired.

## Archetypes

Declared Rooms, Characters, and Interactables may attach at most one same-kind Archetype. An Archetype may itself name at most one same-kind base Archetype, producing a single acyclic chain. Archetypes contribute immutable structural configuration, Trait attachments, and direct authored Property assignments; the declared instance may author explicit overrides on top of the resolved chain. Character `initialWorldState` and Interactable `initialState` are instance-local and are never inherited. Clearing an override reveals the next Archetype value, while detaching materializes the current effective configuration into the declared instance.

Archetypes are authoring-only blueprints. They do not become `CharacterDefinition`, `RoomDefinition`, or `InteractableDefinition` identities, cannot own Location or runtime mutable state, and are not serialized into saves. The authoring compiler resolves the entire chain and emits only the flattened declared-instance definition into compiled V4. Runtime inspection therefore observes exactly the effective compiled Room/Character/Interactable configuration through the existing immutable-definition/`RuntimeWorld::resolved_configuration(...)` boundary; no runtime Archetype lookup exists.

Verb availability and default programs are definition-local; an unhandled selected Interaction program falls back only to that Verb's own default program before the project undefined-interaction fallback.

## Startup, continuation, Lua, and saving

Entrypoint is exactly Room, Scene, or Dialogue. Startup Lua is a separate synchronous non-yielding hook and must succeed before the entrypoint starts. Continuations are exactly Scene, Dialogue, Room, Return, or End.

Conditions and Lua text expressions cannot yield. Effects and explicit script instructions may yield with an engine-owned typed handle bound to one frame. VM/coroutine state is never serialized. Saving is rejected at nonserializable suspensions; only engine-defined serializable wait tokens can make a suspension save-safe. Explicit duration waits save remaining logical time. Autosaves occur only at compiler-marked safe points after associated effects finish.
