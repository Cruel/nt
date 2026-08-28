# Archetypes, Traits, and Properties

These mechanisms solve different reuse/state problems. Do not treat them as interchangeable inheritance systems.

## Archetypes: reusable structural configuration

An Archetype is reusable authoring configuration for exactly one kind: Room, Character, or Interactable. A declared record may attach one same-kind Archetype; an Archetype may itself have one same-kind base, forming a single acyclic chain.

Archetypes are appropriate when several records share structural configuration: Room composition defaults, Character presentation profiles, Interactable presentation/features, Trait attachments, or authored Property schemas/Defaults. The declared record can override inherited fields.

Character `initialWorldState` and Interactable `initialState` are intentionally instance-local rather than inherited. Do not use an Archetype as a runtime identity, state object, polymorphic “class”, or Interaction subject. Gameplay sees the resulting Room/Character/Interactable, not the Archetype it came from.

If only a small capability/value set is shared, prefer a Trait rather than creating an Archetype solely for that purpose.

## Traits: named Property-backed capabilities

Traits are declared in `traits.json`. A Trait identifies which gameplay owner kinds it supports and owns ordinary typed Property contracts. Each contract may provide an optional Default; no Default means a concrete owner must eventually supply a Value.

Use a Trait when gameplay needs to ask “does this subject have capability/state family X?” or when several identities should receive the same Property configuration. Interaction Subject Selectors can match Traits directly.

Traits do not add Room exits, Character poses, Interactable Features, Scene events, Dialogue blocks, Verb programs, or executable behavior. They do not inherit from other Traits.

## Properties: owner-local semantic state

There is no project-wide identity Property registry or `properties.json`. Rooms and Characters own their concrete local Property schemas/Values. Interactable definitions and Archetypes own reusable schemas with optional Defaults. Exact Interactable Instances live in `project.json` under `interactableInstances`; they inherit their definition/Archetype/Trait baseline, may override inherited Values, and may add completely Instance-local typed Properties. Nested Room Features use concrete Values, while Interactable-definition Features use reusable Defaults.

The same key is independent on different owners. Typed authoring references therefore identify an exact owner plus Property key. Normal Property pickers expose only statically authored local/Trait/Archetype/definition contracts; schema-less runtime-only keys are not Project authoring content.

Use Properties for semantic state that conditions, Interactions, Scenes, Dialogue effects, or Lua need to read/change. Do not put editor-only presentation choices or structural configuration into generic Properties merely because they are mutable.

Effective authored precedence follows specificity: a concrete Value/definition Default overrides an inherited Archetype Default, which overrides a Trait Default. An exact Interactable Instance Value is more specific than every definition-side layer. Compatible Traits may contribute the same key, but competing Trait Defaults must agree exactly. Runtime overrides can temporarily replace the authored result without changing Project source.

## Choosing among them

- Reuse a large same-kind structural configuration: **Archetype**.
- Mark/configure a cross-record semantic capability expressed through Properties: **Trait**.
- Store one typed semantic value: **Property**.
- Implement behavior: **Interaction, Scene, Dialogue, or Lua**, not any of the above.

Use `noveltea entity create archetypes <id>` and `schemas/records/archetypes.schema.json` for exact Archetype shape. Use `traits.json`, the owning record schemas, and the generated `project.json` schema for exact Trait, owner-local Property, and Interactable Instance forms.
