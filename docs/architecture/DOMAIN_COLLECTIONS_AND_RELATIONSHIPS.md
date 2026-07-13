# Domain Collections and Relationships

## Collection disposition

This table is the authoritative V2 ownership map. Authoring records are editor-owned source; wire values are strict `noveltea.compiled.project` V1 data; mutable values belong to `SessionState` unless marked tooling-only.

| V2 collection/section | Authoring owner | Compiled representation | Runtime disposition |
| --- | --- | --- | --- |
| Project root/settings | Editor project/compiler | Compiled root, settings, startup hook, entrypoint, indexes | Immutable project-owned configuration; root is not an entity |
| Properties | Typed declarations and owner assignments | `PropertyDefinition`s and retained assignments/parent edges | Typed live overrides; Session or Save persistence |
| Variables | Global typed declarations/defaults | Variable definitions and initial values | Mutable globals in session/save state |
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

## Inheritance and properties

Editor categories/tags organize source only. Runtime `extends` is an immutable same-collection edge on Room, Scene, Dialogue, Character, Interactable, Verb, Interaction, and Map. Compilation rejects missing parents, self-parenting, cross-collection edges, and cycles, but never flattens valid edges.

Property resolution is: owner runtime override, owner authored assignment, then the same two locations on each nearest ancestor, then declaration default, then typed missing. Unset removes one override and resumes lookup. Ancestor changes are immediately visible to unshadowed descendants. Save-policy overrides serialize once on the actual owner; inherited values and Session-policy overrides do not.

Structural and executable fields never inherit except Verb behavior: availability conditions all pass root-to-child, and default programs fall back child-to-root through Handled/Unhandled/Failed before the project undefined-interaction fallback.

## Startup, continuation, Lua, and saving

Entrypoint is exactly Room, Scene, or Dialogue. Startup Lua is a separate synchronous non-yielding hook and must succeed before the entrypoint starts. Continuations are exactly Scene, Dialogue, Room, Return, or End.

Conditions and Lua text expressions cannot yield. Effects and explicit script instructions may yield with an engine-owned typed handle bound to one frame. VM/coroutine state is never serialized. Saving is rejected at nonserializable suspensions; only engine-defined serializable wait tokens can make a suspension save-safe. Explicit duration waits save remaining logical time. Autosaves occur only at compiler-marked safe points after associated effects finish.
