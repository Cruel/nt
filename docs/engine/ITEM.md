# Retired Item Model

## Current contract

`ItemDefinition` and `ItemStack` are not canonical authoring or Compiled Project content. The
Project has no `itemDefinitions` or `itemStacks` top-level collections, and the Compiled Project
decoder rejects those retired fields rather than treating them as aliases.

Inventory-capable world objects use the Interactable definition/Instance model described in
`docs/engine/INTERACTABLE.md`. An Interactable Definition is immutable configuration. Every live
object has an exact `InteractableInstanceId`, a definition reference, one Location, enabled/visible
state, and Instance-local Trait/Property deltas.

The old Item runtime IDs, state records, mutation implementation, save fields, Property-owner and
Interaction-subject variants, Lua surface, and preview/debug projections have been removed. There is
no compatibility alias or second runtime object model behind the Interactable Instance contract.

## Authoring and editor

The editor exposes Interactable Definitions as the reusable authoring collection. Exact Instances
live in the project-level `interactableInstances` registry, which is infrastructure rather than an
Explorer collection. Room authoring can either create a new Instance from a Definition or place an
already-declared Instance without changing its identity.

Do not add Item Definition/Item Stack creation flows, schemas, generated agent-kit record schemas,
compatibility readers, deprecated Lua aliases, or save/protocol variants. Counted/stackable inventory
behavior preserves exact Interactable Instance identity and extends that model rather than restoring
the retired Item family.
