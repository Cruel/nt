---
title: Rooms, objects, containment, and maps
description: How Rooms, Interactables, Features, Inventories, Locations, and Maps compose into the explorable world.
---

The explorable world is built from authoritative **Rooms** and exact semantic subjects. Presentation
geometry and navigation affordances point at that model; they do not create a parallel world graph.

## Rooms and Room-local composition

A **Room** is an explorable location with background presentation, Exits, Placements, Props,
Features, Interactable occurrences, Character cast presentation, Hotspots, and lifecycle behavior.
Room Exits are the authoritative authored navigation edges between Rooms.

A **Placement** is reusable Room-local presentation geometry. A **Prop** is presentation-only content
placed in a Room; use it for visual objects that do not need semantic gameplay identity. A **Feature**
is a stable semantic sub-part of a Room or Interactable that can own admitted Traits/Properties and
participate in Interactions.

A **Hotspot** is pointer geometry plus a semantic target. Room Hotspots can select an owner Feature,
an admitted exact subject, or an owner-local Exit. Interactable Hotspots can select the owning
Interactable or one of its Features. Hotspots do not own Verbs or gameplay programs; pointer input and
non-pointer input converge on the same semantic subjects and navigation actions.

Room lifecycle Conditions and programs govern ordinary exploration entry/exit and rejection. A
directed story/scripted Room change remains a distinct operation; do not model navigation policy by
moving logic into Hotspot geometry.

## Interactable Definitions and exact Instances

An **Interactable Definition** describes a reusable object kind. An **Interactable Instance** is one
exact live object identity created from that Definition. The Instance owns Location, quantity,
enabled/visible state, Trait changes, local Properties, and Feature overrides.

Unique and fungible objects use the same model. A non-stackable Definition admits quantity one. A
stackable Definition permits positive quantity-bearing Instances subject to its stack limit. Two
Instances of the same Definition remain different semantic subjects until an explicit operation such
as Merge ends one identity. Quantity is part of the Interactable model; do not duplicate it with an
unrelated count Property.

When an Instance is visible in a Room, the Room occurrence points at that exact Instance and supplies
Room-local placement/presentation linkage. The occurrence does not copy or own the Instance's live
state.

## Inventories and containment

An **Inventory** is a named container owned by another semantic identity, not a standalone global
record. Inventory references therefore identify both the owner and the Inventory ID. Membership is
derived from an exact Interactable Instance's **Location**.

An Instance can be unplaced, directly in a Room, or inside an admitted owner-qualified Inventory.
Moving an Instance changes that one authoritative Location. Inventory UI may group or sort members,
but those rows do not become new gameplay identities and do not change membership semantics.

Stack operations preserve exact identity rules: creating quantity does not imply automatic merging;
splitting creates another identity; merging explicitly chooses which identity survives; partial
transfer can split while whole transfer can preserve identity.

## Maps project Room topology

A **Map** is authored presentation and navigation affordance over Rooms and their Exits. Map Locations
reference Rooms. Map Connections reference authoritative Room Exits, and their endpoints are derived
from those Exits rather than authored as a second graph.

Map visibility, geometry, labels, and interaction affordances can differ from raw Room topology, but
activating a Map route still uses normal Room navigation. A Map therefore cannot create fast travel or
a connection that the Room model does not support merely by drawing a line between locations.

For exact Room composition, Interactable Instance forms, Inventory owners, Location variants, Map
geometry, quantity limits, and lifecycle program fields, use the generated Project schema reference.
