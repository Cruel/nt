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

The editor authoring schema now uses the V2 `interactables` collection, and Room/test authoring references target Interactable records. The collection payload is still temporary Phase 3 scaffolding until the complete Interactable contract is implemented. Native code and the transitional runtime-export wire still use legacy Object-shaped models only to keep the current runtime buildable; Phases 4--8 replace those boundaries with compiled definitions and typed state. No old Object compatibility is required.
