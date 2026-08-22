# Item Definitions and Item Stacks

## Contract

An Item Definition is immutable Project content for fungible inventory. It owns a stable
`ItemDefinitionId`, display name, description, optional sprite/material presentation, attached Traits,
authored Property assignments, and an optional positive Stack limit. An Item Stack is a live,
authoritative identity containing exactly one definition, a positive checked quantity, one direct
Location, attached Traits, and sparse runtime Property overrides.

The authoring and compiled Project contracts remain V4, and SaveState remains V8. Issue #78 replaces
each already-selected current shape atomically; normal readers require the new fields and reject the
replaced V4/V8 shapes. There is no compatibility reader, missing-field default, or version bump.

## Identity and arithmetic

Authored Stack IDs are declared identities. Runtime allocations use the saved monotonic
`runtime-item-stack-N` allocator. Operations use lexicographic Stack-ID order wherever more than one
candidate can participate:

- split keeps the source identity and creates one identity carrying copied Traits and Property
  overrides;
- merge keeps the explicit receiver and ends the donor;
- transfer preserves the source for a whole-quantity move when it can, otherwise it splits and then
  coalesces or keeps the result separate according to the explicit placement policy;
- grant fills compatible existing Stacks first, then creates the fewest limit-respecting Stacks;
- consume by filter uses stable ID order and ends every fully consumed identity;
- aggregate is a checked sum and never changes state.

Every mutation validates its complete result before publication and is atomic. Quantities and sums
are positive safe integers bounded by `9,007,199,254,740,991`; definition Stack limits are enforced.
An ended identity is immediately stale: it is erased with its Property overrides, never redirects to
a surviving Stack, and is rejected by new Property and Interaction lookups and by saved authoritative
references.

## Compatibility and Properties

Two Stacks may coalesce only when their definitions and all effective semantic state match. This
includes the canonical Trait set and every Item-Stack Property after ordinary Property resolution:
runtime override, definition assignment, configured Trait value, declaration default, or typed
missing value. No Property reducer or implicit value synthesis exists. Split copies sparse overrides;
merge is legal only when effective values already agree.

## Location, publication, and Interaction

Stack Location is the same closed Unplaced, Room, or owner-qualified Inventory union used for
Interactables. Inventory membership follows only direct Location. Effective Room follows Inventory
ownership without rewriting descendants. `RoomView` and `InventoryView` publish exact `ItemStackView`
entries, including identity, definition, quantity, Location, effective Room, presentation, and Traits.
UI may group equal-looking rows, but a grouping is derived display state and is never an Interaction,
Property, mutation, or save identity.

`ItemStackInteractionSubject` carries one exact live Stack ID. Runtime Room eligibility includes
Stacks whose effective Room is the active Room. Authoring Interactions, playback tests, recorder
drafts, preview protocol, active selection, Flow frames, and saves preserve that exact identity.
Interaction rules may also use the narrow `AnyItemStack` operand matcher; it never substitutes an Item
Definition for a complete command's exact live Stack reference.

## Save, Lua, and editor surfaces

SaveState V8 stores every live Stack exactly, its declared/runtime provenance flag, direct Location,
Traits, sparse Property overrides, and the next allocator value. Restore validates all definitions,
limits, Locations, Traits, owners, references, and allocator ordering before atomically publishing a
fresh SessionState.

Gameplay Lua exposes `noveltea.item_stacks.get`, `set_traits`, `split`, `merge`, `transfer`, `grant`,
`consume`, `consume_definition`, and `aggregate_definition`. Ordinary `noveltea.properties` calls use
owner kind `item-stack`. Results
report exact surviving, changed, created, and ended IDs; a later lookup of an ended ID fails as
stale.

The editor provides Item Definition and Item Stack explorer collections, typed creation wizard paths,
typed detail forms, validation, compilation, exact Interaction/test subject selection, and canonical
golden fixtures. Definition Trait/Property attachments continue to use the shared record tooling.

## Main implementation areas

- Authoring/compiler: `editor/src/shared/project-schema/authoring-items.ts` and shared compiler/schema
  modules.
- Editor: `editor/src/renderer/editors/items/ItemEditor.tsx`, collection metadata, and new-entity/test
  tooling.
- Native model/codec: `compiled_project.hpp`, compiled Project decoder/validation, and
  `save_state` codec modules.
- Runtime: `feature_state.hpp`, `session_state.cpp`, `runtime_world.cpp`, Property resolution,
  presentation publication, and Interaction execution.
- Lua: `runtime_command_gateway`, `runtime_script_api`, and `bind_typed_script_host.cpp`.
