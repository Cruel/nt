---
title: Project model, identity, and state
description: Project ownership, stable references, Archetypes, Traits, Properties, and the boundary between authored and runtime state.
---

The **Project** is the root authoring unit. It owns game-wide settings, startup, localization policy,
the reusable record collections, and infrastructure-level declarations such as the initial
Interactable Instance registry. It is not itself a generic gameplay subject or Property owner.

Project-wide **Distribution Notices** are explicit references to plain-text `.txt` or `.md` files
inside the Project, with optional display names. They are included unconditionally when a Runtime
Package is exported. Asset attachments with purpose `distribution-notice` are included only when
the associated physical Asset is actually packaged; missing notices for excluded Assets do not
block an unrelated export. The same Project file may be referenced by several Assets or by a
Project-wide declaration without duplicating it. Original notice bytes remain separate in the
Runtime Package's `licenses/` namespace, outside the gameplay Asset registry. These relationships
are declarations, not an inference of license obligations.

Exported players also ship their own engine/library license texts, drawn from that
platform's certified player template rather than from the Project. Players can
open the built-in **Licenses** menu from the title or pause menu to read the
separate **Engine & Libraries** and **Game Assets** collections. Custom title,
pause, and Licenses System Layouts may replace the built-in presentation while
retaining the engine-owned notice catalog and actions. In the editor preview,
if the selected target's engine notice inventory is unavailable, the viewer can
still show Project notices without borrowing another platform's licenses.

## Identity and references

Top-level records have stable IDs within their collection. A Room ID and Character ID may use the
same text without becoming the same identity because the collection is part of the reference.
Nested identities such as Room Exits, Features, Dialogue blocks, Scene events, and Character
presentation parts are scoped by their owner.

References therefore identify the semantic thing being referenced, not its label, filesystem order,
or current visual position. Owner-qualified references matter whenever a nested ID is not globally
unique. Renaming a label is presentation; changing a stable ID changes identity and must repair every
reference that names it.

## Definitions, instances, and occurrences

NovelTea uses these terms deliberately:

- A **Definition** is reusable configuration. An Interactable Definition can provide presentation,
  stackability, Features, Inventories, Traits, and Property defaults without being a live object.
- An **Instance** is an exact gameplay identity. An Interactable Instance has one Definition and owns
  its live Location, quantity, enabled/visible state, Trait deltas, and Property state.
- An **occurrence** is presentation of an existing semantic identity in a particular context. A Room
  Interactable occurrence gives an exact Instance Room-local placement/presentation linkage; a Scene
  actor slot or Dialogue Stage Slot presents a Character without creating another Character.

This boundary prevents presentation data from accidentally becoming authoritative gameplay state.

## Archetypes, Traits, and Properties

An **Archetype** reuses structural authoring configuration for one compatible gameplay kind. A Room,
Character, or Interactable can inherit from a same-kind Archetype chain and override inherited
configuration. Archetypes are not runtime identities, Interaction subjects, or polymorphic gameplay
classes.

A **Trait** is a named, reusable Property-backed capability/configuration contract. Traits can be
attached to compatible owners and can be matched by Interaction subject selection. They do not add
new structural fields or executable behavior.

A **Property** is a typed semantic value contract. Concrete gameplay identities and admitted Features
can own values, while reusable Definitions, Traits, and Archetypes can contribute Property schemas and
defaults. The same Property key on two different owners is not one global variable. More-specific
concrete values resolve over reusable defaults according to the owning concept's contract. Project-wide
Variables are a separate global-state concept and should be used when the state is genuinely global.

Use these mechanisms for different problems: Archetypes for broad same-kind reuse, Traits for a named
cross-record capability, and Properties for the typed value itself. Behavior belongs in Interactions,
Scenes, Dialogues, or Lua rather than in any of those reuse/state declarations.

## Authored state versus runtime state

Project source describes the starting model: declarations, initial values, relationships, and
programs. A playthrough owns mutable runtime state derived from that model. Runtime Property changes,
Interactable movement, quantity changes, Room progress, and story flow do not mutate the authored
records they came from.

Some presentation state is intentionally even narrower. A Layout occurrence can have local UI state,
and Character presentation in a Scene can change independently of the Character's world state. Only
explicit gameplay mutations should change persistent semantic state.

The Project chooses one initial content entrypoint: Room, Scene, or Dialogue. Startup scripting is a
separate bootstrap concern rather than a fourth entrypoint kind.

For exact ownership forms, reference encodings, Property value types, Archetype shapes, Trait
contracts, and initial-state fields, use the generated Project schema reference.
