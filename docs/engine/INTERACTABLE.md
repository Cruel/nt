# Interactable Component

## Contract

`InteractableDefinition` is immutable runtime content for one uniquely identified world/inventory object. Interactable replaces the generic gameplay term Object. It is not an Item synonym and is not a counted inventory row.

Interactable is Property-bearing and may attach compatible Traits. Trait members remain ordinary
Properties; identity, presentation, Feature ownership, interaction structure, and location do not
merge through Traits.

A declared Interactable authoring record may attach one same-kind Archetype. The Archetype contributes immutable presentation/configuration, Trait attachments, and Property assignments, while `initialState` remains local to the declared Interactable and is never inherited. Editor edits operate on the resolved effective configuration and become explicit overrides; compilation emits only the flattened `InteractableDefinition`, with no runtime Archetype identity or mutable state.

An Interactable may own stable nested Features. Each Feature has an ID unique within the owning
Interactable, a label, compatible Trait attachments, and compatible Property assignments. An exact
Feature subject is always referenced as `(InteractableId, FeatureId)`; a bare Feature ID is not a
runtime identity.

Presentation chooses one of three explicit Hotspot modes: `none`, `sprite-alpha`, or `custom`.
`none` performs no pointer hit testing and does not require a sprite. `sprite-alpha` provides one
Hotspot whose hit area comes from the sprite alpha mask and therefore requires a valid image sprite.
`custom` contains authored normalized rectangular Hotspots and requires a valid image sprite whenever
the list is non-empty. Each Hotspot has stable owner-local identity, condition, semantic target, input
priority, and highlight policy. It may select the owning Interactable, an owner-local Feature, or
another exact admitted semantic subject. Hotspots own no Verb or Interaction program. An empty custom
list remains structurally valid while authoring, but `none` is the canonical way to declare an
intentionally non-clickable Interactable.

## Location and state

Room geometry belongs to nested `RoomPlacement`, not the definition. A mutable `InteractableState` stores exactly one authoritative Location—owner-qualified Inventory, Room, or Unplaced—plus enabled and visible state. Room Location names only the `RoomId`; visual placement is supplied separately by Room Interactable occurrences. Moving an Interactable updates state; it does not rewrite Room or Interactable definitions or presentation occurrences.

An Interactable may declare owner-local Inventories. Inventory membership is derived solely from Interactable Location, and each Inventory reference includes both its owner and owner-local `InventoryId`. Inventory ownership may also belong to the Project/session convention, Characters, or Features. Containment is acyclic, and moving an Inventory owner changes descendants' derived effective Room without rewriting their direct Inventory Locations.

Interactables remain unique objects. Fungible inventory uses the separate Item Definition/Item Stack
contract in `docs/engine/ITEM.md`; counts must not be simulated with generic Interactable Properties.

## Authoring, compiled, and state disposition

- **Authoring:** collection-specific Interactable record, Trait attachments, typed Property
  assignments, owner-local Features, immutable presentation, semantic Hotspot targets, and initial
  state declaration.
- **Compiled:** `InteractableDefinition`, retained Trait attachments, nested Features, linked resources,
  Property assignments, semantic Hotspot targets, and validated initial location/state declaration.
- **Mutable:** `InteractableState` and property overrides in `SessionState`; Save-policy values and logical state enter `SaveState`.
- **Tooling only:** categories, tags, colors, sort keys, notes, selection, and preview state.

Interactions use a closed Character/Interactable/Feature subject union. Operands are an exact typed
subject, `AnyCharacter`, `AnyInteractable`, or `AnySubject`; Feature subjects retain their owner-qualified
identity. Lua can access declared Interactable Properties through the ordinary typed Property API and
Feature Properties through the owner-qualified Feature helpers; neither API mutates arbitrary JSON.

## Implementation

The editor authoring schema uses the current `interactables` collection with immutable presentation,
owner-local Inventory declarations, and an explicit initial Location/enabled/visible declaration. The
editor supports creation, nested Feature editing, semantic Hotspot target editing, typed Room/Inventory/
Unplaced Location editing, and detail editing. The creation wizard accepts identity, an optional
same-kind Archetype, and an optional sprite. Without an Archetype, creation uses `none` when no sprite
is selected and `sprite-alpha` when an image sprite is selected. With an Archetype, the sprite choice
defaults to the Archetype's sprite; choosing a specific sprite or `No sprite` creates an explicit
presentation override while the Archetype's Hotspot mode and behavior remain inherited.
Alpha or non-empty custom Hotspots without a sprite are authoring errors because that configuration
cannot compile into a loadable runtime project. A
visible Room occurrence whose Interactable has no sprite is allowed but produces an authoring warning
because it will not render. `CompiledProject` decodes one canonical
`InteractableDefinition` per declared Interactable, `SessionState` initializes one live state per
definition, and typed mutations reject missing Rooms/Inventories and containment cycles atomically.
Placements have no occupant back-reference or Interactable owner. Lua, player, Map, and Interaction
operations all use these same typed Location and semantic-subject APIs.

At runtime, multiple placed Interactables that reference one sprite share its source texture and alpha
occupancy. Custom mode derives a distinct owner-union binary `R8` mask through the ordinary
prefetch/jobs/residency pipeline; masks are neither authoring assets nor package entries. Hit testing
uses analytic authored rectangles, while highlighting samples the owner mask.
