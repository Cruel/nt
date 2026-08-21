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

Presentation chooses either one sprite-alpha Hotspot or a custom list of normalized rectangular
Hotspots. Each Hotspot has stable owner-local identity, condition, semantic target, input priority,
and highlight policy. It may select the owning Interactable, an owner-local Feature, or another exact
admitted semantic subject. Hotspots own no Verb or Interaction program. A custom list may be empty;
such an Interactable is non-clickable and may omit its sprite and material. Sprite-alpha mode
requires a valid image sprite.

## Location and state

Room geometry belongs to nested `RoomPlacement`, not the definition. A mutable `InteractableState` stores exactly one location—Inventory, Nowhere, or a validated `RoomPlacementRef`—plus enabled and visible state. Moving an interactable updates state; it does not rewrite Room or Interactable definitions.

V1 models unique interactables only. Stackable/count-based inventory is explicitly deferred until a separate `ItemDefinition` contract exists; counts must not be simulated with generic properties.

## Authoring, compiled, and state disposition

- **Authoring version 3:** collection-specific Interactable record, Trait attachments, typed Property
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

The editor authoring schema uses the current `interactables` collection with immutable presentation and
an explicit initial location/enabled/visible declaration. The editor supports creation, nested Feature
editing, semantic Hotspot target editing, and detail editing, and validates a Room-placement initial
location against its matching placement. A newly created Interactable may temporarily have no sprite
while being authored; that incomplete presentation state does not require a fabricated Verb because
Hotspots no longer own behavior. `CompiledProject` decodes `InteractableDefinition` records,
`SessionState` initializes one live state per definition, and typed mutations reject missing
definitions and invalid placement references. Placements have no occupant back-reference or
Interactable owner. Lua, player, Map, and Interaction operations all use these same typed location
and semantic-subject APIs.

At runtime, multiple placed Interactables that reference one sprite share its source texture and alpha
occupancy. Custom mode derives a distinct owner-union binary `R8` mask through the ordinary
prefetch/jobs/residency pipeline; masks are neither authoring assets nor package entries. Hit testing
uses analytic authored rectangles, while highlighting samples the owner mask.
