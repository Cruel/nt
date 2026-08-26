# Archetypes, Traits, and Properties

These mechanisms solve different reuse/state problems. Do not treat them as interchangeable inheritance systems.

## Archetypes: reusable structural configuration

An Archetype is reusable authoring configuration for exactly one kind: Room, Character, or Interactable. A declared record may attach one same-kind Archetype; an Archetype may itself have one same-kind base, forming a single acyclic chain.

Archetypes are appropriate when several instances share structural configuration: Room composition defaults, Character presentation profiles, Interactable presentation/features, Trait attachments, or authored Property values. The declared record can override inherited fields.

Character `initialWorldState` and Interactable `initialState` are intentionally instance-local rather than inherited. Do not use an Archetype as a runtime identity, state object, polymorphic “class”, or Interaction subject. Gameplay sees the resulting Room/Character/Interactable, not the Archetype it came from.

If only a small capability/value set is shared, prefer a Trait rather than creating an Archetype solely for that purpose.

## Traits: named Property-backed capabilities

Traits are declared in `traits.json`. A Trait identifies which gameplay owner kinds it supports and lists ordinary identity-scoped Property requirements/configured values.

Use a Trait when gameplay needs to ask “does this subject have capability/state family X?” or when several identities should receive the same Property configuration. Interaction Subject Selectors can match Traits directly.

Traits do not add Room exits, Character poses, Interactable Features, Scene events, Dialogue blocks, Verb programs, or executable behavior. They do not inherit from other Traits.

## Properties: actual semantic values

Identity-scoped Properties are declared in `properties.json`. Rooms, Characters, Interactables, and Item Stack semantics through Item Definitions use those declarations where owner kinds permit them. A Trait may require a Property or provide a configured value; a record may also assign a direct authored value.

Use Properties for semantic state that conditions, Interactions, Scenes, Dialogue effects, or Lua need to read/change. Do not put editor-only presentation choices or structural configuration into generic Properties merely because they are mutable.

When both are present, direct authored Property assignments take precedence over Trait-provided configuration. Runtime overrides can temporarily replace the authored result without changing the source record.

## Choosing among them

- Reuse a large same-kind structural configuration: **Archetype**.
- Mark/configure a cross-record semantic capability expressed through Properties: **Trait**.
- Store one typed semantic value: **Property**.
- Implement behavior: **Interaction, Scene, Dialogue, or Lua**, not any of the above.

Use `noveltea entity create archetypes <id>` and `schemas/records/archetypes.schema.json` for exact Archetype shape. Use `properties.json`/`traits.json` plus the generated top-level schemas for their exact declaration forms.
