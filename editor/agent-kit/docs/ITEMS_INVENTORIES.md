# Item Definitions, Item Stacks, and Inventories

NovelTea separates a fungible item's reusable definition from each live quantity-bearing identity.

An **Item Definition** says what an item is: display name/description, optional sprite/material, optional stack limit, and Item-Stack Properties/Traits that instances of that definition inherit.

An **Item Stack** is one exact live identity with one Item Definition, a positive quantity, and one Location. Two Stacks of the same definition are still different semantic subjects until an explicit stack operation combines them.

## When to use Items versus Interactables

Use Items for fungible/countable things such as currency, ammunition, ingredients, generic keys, or consumables where quantity matters. Use an Interactable for a unique object whose individual identity, presentation, Features, or state matters independently.

Do not emulate stackable inventory by putting a `count` Property on an Interactable. Do not use an Item Definition as a substitute for the exact Item Stack when an Interaction or Test needs a live subject.

## Inventories and Location

Inventories are named containers declared by their owner rather than standalone records. Project, Character, Interactable, Room Feature, and Interactable Feature ownership are supported where the current schema admits them. An Item Stack can be Unplaced, directly in a Room, or in an owner-qualified Inventory.

Inventory references therefore need both the owner identity and the Inventory ID. An Inventory ID such as `bag` is not globally unique by itself.

Moving a Stack into or out of an Inventory changes its semantic Location. UI grouping is presentation only: even if several compatible Stacks appear as one row, gameplay references still use exact Stack IDs.

## Stack behavior

Runtime gameplay can grant, consume, split, merge, and transfer Item Stacks. Stack limits are enforced. A split creates a new exact Stack identity; a full merge ends the donor identity. Code or authored behavior must not assume an ended Stack ID redirects to the survivor.

For initial project state, author Item Stack records with the desired definition, quantity, and Location. For story-time changes, use Scene gameplay effects, Interactions, or Lua rather than rewriting immutable authoring data.

## Interactions and selectors

An Item Stack can be an Interaction subject. A Verb slot may admit any Item Stack, require a Trait, require one Item Definition, match a qualified/exact identity, or combine selectors as a union. The final command binds the exact live Stack ID.

This distinction lets an Interaction mean “use any healing herb” at rule-selection time while still executing against the actual Stack the player selected.

Use `noveltea entity create itemDefinitions <id>` and `noveltea entity create itemStacks <id>` for initialized shapes. Exact schemas are `schemas/records/itemDefinitions.schema.json` and `schemas/records/itemStacks.schema.json`.
