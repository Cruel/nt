# Interactable Component

## Contract

`InteractableDefinition` is immutable reusable configuration. It does not identify a live object.
Every live world/inventory object is an exact Interactable Instance with its own stable
`InteractableInstanceId` and a reference to one `InteractableDefinition` identified by
`InteractableDefinitionId`.

Interactable is Property-bearing and may attach compatible Traits. Trait members remain ordinary
Properties; identity, presentation, Feature ownership, interaction structure, and location do not
merge through Traits.

A declared Interactable Definition authoring record may attach one same-kind Archetype. The
Archetype contributes immutable presentation/configuration, Trait attachments, and Property
schemas/Defaults. Mutable Location/enabled/visible state does not belong to the Definition. Editor edits
operate on the resolved effective configuration and become explicit overrides; compilation emits a
flattened `InteractableDefinition` plus separate declared Instance records.

Interactable Definitions are reusable Property schema sources rather than live Property owners. They
may declare ordered typed Property contracts with optional Defaults and may intentionally leave a
required contract without a Default for concrete Instances to satisfy. A Definition Default is more
specific than an inherited Archetype Default, which is more specific than a Trait Default.

An Interactable may own stable nested Features. Each Feature has an ID unique within the owning
Interactable, a label, compatible Trait attachments, and compatible Property assignments. An exact
Feature subject is always referenced as `(InteractableInstanceId, FeatureId)`; a bare Feature ID is not a
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

## Instance identity, Location, and state

Declared Instances live in the project-level `interactableInstances` registry. Each entry owns its
stable exact ID, Definition reference, optional editor label, authoritative Location, enabled/visible
state, Trait additions/removals, sparse inherited Property overrides, and ordered completely
Instance-local typed Properties. Multiple Instances may reference the same Definition and remain
independent identities. Effective Values resolve by specificity: Instance-local/override Value,
Definition Default, inherited Archetype Default, Trait Default, then missing. Resetting an inherited
override reveals the lower layer instead of copying that lower Value into the Instance.

Room geometry belongs to nested `RoomPlacement`, not the Definition. A mutable `InteractableState`
stores exactly one authoritative Location—owner-qualified Inventory, Room, or Unplaced—plus enabled
and visible state. Room Location names only the `RoomId`; visual placement is supplied separately by
Room Interactable occurrences, which reference the exact Instance. Moving an Interactable updates
Instance state; it does not rewrite its Definition.

An Interactable may declare owner-local Inventories. Inventory membership is derived solely from Interactable Location, and each Inventory reference includes both its owner and owner-local `InventoryId`. Inventory ownership may also belong to the Project/session convention, Characters, or Features. Containment is acyclic, and moving an Inventory owner changes descendants' derived effective Room without rewriting their direct Inventory Locations.

The former Item Definition/Item Stack project model is retired. `docs/engine/ITEM.md` records that
boundary; follow-up stackability work extends exact Interactable Instances rather than restoring
parallel Item identities.

## Authoring, compiled, and state disposition

- **Authoring Definition:** collection-specific Interactable record, Trait attachments, ordered typed
  Property schemas with optional Defaults, owner-local Features, immutable presentation, and semantic
  Hotspot targets.
- **Authoring Instance:** infrastructure-level `interactableInstances` registry entry with exact ID,
  Definition reference, optional editor label, Location/state, Trait deltas, sparse inherited Value
  overrides, and ordered Instance-local typed Properties.
- **Compiled:** immutable `InteractableDefinition` records plus separate
  `InteractableInstanceDeclaration` records. Room occurrences refer to exact Instance IDs.
- **Mutable:** exact-Instance `InteractableState` and Property overrides in `SessionState`; Save-policy
  values and logical state enter `SaveState` under the same Instance identity.
- **Tooling only:** categories, tags, colors, sort keys, notes, selection, and preview state.

Interactions use a closed Character/Interactable/Feature subject union. Operands are an exact typed
subject, `AnyCharacter`, `AnyInteractable`, or `AnySubject`; Feature subjects retain their owner-qualified
identity. Lua can access declared Interactable Properties through the ordinary typed Property API and
Feature Properties through the owner-qualified Feature helpers; neither API mutates arbitrary JSON.

## Implementation

The editor authoring schema uses the current `interactables` collection for Definitions and the
project-level `interactableInstances` registry for exact Instances. The editor supports Definition
creation, nested Feature editing, semantic Hotspot target editing, an Instance list in the
Interactable editor, and Room workflows that either create-and-place a new Instance or place an
existing Instance atomically. The Interactable editor and Room composition surface expose the same
compact exact-Instance Property editor; both mutate the registry entry rather than a Room occurrence
or placement. The creation wizard accepts Definition identity, an optional
same-kind Archetype, and an optional sprite. Without an Archetype, creation uses `none` when no sprite
is selected and `sprite-alpha` when an image sprite is selected. With an Archetype, the sprite choice
defaults to the Archetype's sprite; choosing a specific sprite or `No sprite` creates an explicit
presentation override while the Archetype's Hotspot mode and behavior remain inherited.
Alpha or non-empty custom Hotspots without a sprite are authoring errors because that configuration
cannot compile into a loadable runtime project. A
visible Room occurrence whose Interactable has no sprite is allowed but produces an authoring warning
because it will not render. `CompiledProject` decodes immutable Definitions and separate declared
Instances; `SessionState` initializes one live state per Instance, and typed mutations reject missing
Rooms/Inventories and containment cycles atomically. Authored concrete Instances with unresolved
required Property contracts are compile errors, and runtime Instance creation validates the same
effective contracts before publishing a new identity.
Placements have no occupant back-reference or Interactable owner. Lua, player, Map, and Interaction
operations all use these same typed Location and semantic-subject APIs.

At runtime, multiple placed Interactables that reference one sprite share its source texture and alpha
occupancy. Custom mode derives a distinct owner-union binary `R8` mask through the ordinary
prefetch/jobs/residency pipeline; masks are neither authoring assets nor package entries. Hit testing
uses analytic authored rectangles, while highlighting samples the owner mask.
