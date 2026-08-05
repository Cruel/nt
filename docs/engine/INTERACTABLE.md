# Interactable Component

## Contract

`InteractableDefinition` is immutable runtime content for one uniquely identified world/inventory object. Interactable replaces the generic gameplay term Object. It is not an Item synonym and is not a counted inventory row.

Interactable is property-bearing and may `extends` another Interactable only for declared custom-property lookup. Identity, presentation, interaction structure, and location do not merge.

Presentation chooses either one sprite-alpha hotspot or a custom list of normalized rectangular
hotspots. Each hotspot has stable owner-local identity, condition, one-arity Verb activation, input
priority, and highlight policy. A custom list may be empty; such an Interactable is non-clickable and
may omit its sprite and material. Sprite-alpha mode requires a valid image sprite.

## Location and state

Room geometry belongs to nested `RoomPlacement`, not the definition. A mutable `InteractableState` stores exactly one location—Inventory, Nowhere, or a validated `RoomPlacementRef`—plus enabled and visible state. Moving an interactable updates state; it does not rewrite Room or Interactable definitions.

V1 models unique interactables only. Stackable/count-based inventory is explicitly deferred until a separate `ItemDefinition` contract exists; counts must not be simulated with generic properties.

## Authoring, compiled, and state disposition

- **Authoring version 3:** collection-specific Interactable record, optional `extends`, typed property assignments, immutable identity/presentation, hotspot behavior, and initial state declaration.
- **Compiled:** `InteractableDefinition`, retained parent edge, linked resources, property assignments, and validated initial location/state declaration.
- **Mutable:** `InteractableState` and property overrides in `SessionState`; Save-policy values and logical state enter `SaveState`.
- **Tooling only:** categories, tags, colors, sort keys, notes, selection, and preview state.

Interactions use a closed Character-or-Interactable subject union. Operands are an exact typed subject,
`AnyCharacter`, `AnyInteractable`, or `AnySubject`. Lua can access declared properties through typed
host APIs but cannot mutate arbitrary JSON.

## Implementation

The editor authoring schema uses the current `interactables` collection with immutable presentation and an
explicit initial location/enabled/visible declaration. The editor supports creation and detail editing
and validates a Room-placement initial location against its matching placement. `CompiledProject`
decodes `InteractableDefinition` records, `SessionState` initializes one live state per definition,
and typed mutations reject missing definitions and invalid placement references. Placements have no
occupant back-reference or Interactable owner. Lua,
player, Map, and Interaction operations all use these same typed location APIs.

At runtime, multiple placed Interactables that reference one sprite share its source texture and alpha
occupancy. Custom mode derives a distinct owner-union binary `R8` mask through the ordinary
prefetch/jobs/residency pipeline; masks are neither authoring assets nor package entries. Hit testing
uses analytic authored rectangles, while highlighting samples the owner mask.
