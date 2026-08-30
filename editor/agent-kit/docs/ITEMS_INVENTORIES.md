# Interactable Quantities and Inventories

NovelTea uses one exact-identity object model for unique and fungible gameplay objects. The retired Item Definition/Item Stack model is not a second authoring path.

An **Interactable Definition** says what a reusable object kind is. It may declare presentation, Traits/Properties, stackability, and an optional stack limit. A non-stackable Definition fixes every live Instance at quantity `1`; a stackable Definition permits positive quantity-bearing Instances up to its limit.

An **Interactable Instance** is one exact live identity with one immutable origin Definition, a positive quantity, and one Location. Two Instances of the same Definition remain distinct semantic subjects unless an explicit Merge ends one identity.

## Unique versus stackable objects

Use the same Interactable collection for both. A unique key, door, tool, coin stack, ammunition bundle, or ingredient stack is differentiated by Definition configuration and exact Instance state, not by choosing a separate Item record family.

Do not emulate stackable inventory with a custom `count` Property. Use the Definition's stackability/stack-limit fields and the Instance's canonical quantity. Interactions and Tests address exact Interactable Instance IDs rather than a visually grouped inventory row.

Stackable Definitions cannot own identity-bearing Features or Inventories. If each unit needs independently addressable child state, model it as non-stackable exact Instances instead.

## Inventories and Location

Inventories are named owner-local containers rather than standalone records. Project, Character, Interactable Instance, Room Feature, and Interactable Feature ownership are supported where the current schema admits them. An Interactable Instance can be Unplaced, directly in a Room, or in an owner-qualified Inventory.

Inventory references therefore need both the owner identity and Inventory ID. An Inventory ID such as `bag` is not globally unique by itself. Membership is derived from exact Instance Location and is semantically unordered; UI grouping never creates a new gameplay identity.

## Quantity behavior

Typed Gameplay Commands and `noveltea.interactables` Lua operations can create quantities, split, merge, transfer, add, consume, and aggregate exact Interactable Instances. Create never silently coalesces. Split preserves the source and creates a new exact identity. Merge preserves the explicit receiver and ends the donor. Whole exact transfer may preserve identity; partial transfer splits.

For initial project state, edit the infrastructure-level declared Interactable Instance registry through the normal Interactable/Room/Inventory authoring surfaces. For story-time changes, use shared Gameplay Commands, Interactions, or `noveltea.interactables` Lua operations rather than rewriting immutable authoring data.

## Interactions and selectors

An exact Interactable Instance can be an Interaction subject. A Verb slot may admit any Interactable, require a Trait, require one Interactable Definition, match a qualified/exact identity, or combine selectors as a union. The final command always binds the exact live Instance ID.

There are no `itemDefinitions` or `itemStacks` collections, no Item Stack subject/Property-owner kind, and no `noveltea.item_stacks` Lua compatibility API. Retired shapes are invalid rather than normalized.
