# Interactable Component

## Contract

`InteractableDefinition` is immutable runtime content for one uniquely identified world/inventory object. Interactable replaces the generic gameplay term Object. It is not an Item synonym and is not a counted inventory row.

Interactable is property-bearing and may `extends` another Interactable only for declared custom-property lookup. Identity, presentation, interaction structure, and location do not merge.

## Location and state

Room geometry belongs to nested `RoomPlacement`, not the definition. A mutable `InteractableState` stores exactly one location—Inventory, Nowhere, or a validated `RoomPlacementRef`—plus enabled and visible state. Moving an interactable updates state; it does not rewrite Room or Interactable definitions.

V1 models unique interactables only. Stackable/count-based inventory is explicitly deferred until a separate `ItemDefinition` contract exists; counts must not be simulated with generic properties.

## Authoring, compiled, and state disposition

- **Authoring V2:** collection-specific Interactable record, optional `extends`, typed property assignments, immutable identity/presentation, and initial state declaration.
- **Compiled:** `InteractableDefinition`, retained parent edge, linked resources, property assignments, and validated initial location/state declaration.
- **Mutable:** `InteractableState` and property overrides in `SessionState`; Save-policy values and logical state enter `SaveState`.
- **Tooling only:** categories, tags, colors, sort keys, notes, selection, and preview state.

Interactions refer to typed Interactable IDs or explicit `AnyInteractable` wildcards. Lua can access declared properties through typed host APIs but cannot mutate arbitrary JSON.

## Current implementation scaffold

The editor authoring schema uses the V2 `interactables` collection with immutable presentation plus
an explicit initial location/enabled/visible declaration. The editor provides creation and detail
editing, and validates a room-placement initial location against the matching Room placement. The
additive typed runtime decodes native `InteractableDefinition` records and Phase 7A initializes one
session-owned `InteractableState` per definition. Named mutations reject missing definitions and Room
placements owned by another Interactable. The typed Lua location read uses this live state; movement
requests remain queued until Phase 7E executes them. The shipped legacy Object path remains intact
until the Phase 10 consumer cutover, and no old Object compatibility was added to the typed model.
