# Traits

Traits are discoverable capability/configuration declarations that directly own reusable typed
Property contracts. They do not introduce a second value namespace, a generic component bag,
structural inheritance, or executable inheritance.

Current authoring uses the stable `noveltea.authoring.project` identity and compiled gameplay uses `noveltea.compiled.project` Format V1. The current contracts contain only the Trait form; normal readers reject the retired universal same-type `extends` shape rather than maintaining a compatibility path.

## Declaration

A Trait has:

- a globally unique Trait ID and author-facing label;
- an optional description;
- one or more supported owner kinds (`Applies To` in the editor);
- zero or more ordered typed Property contracts.

A Trait Property contract owns its own:

- stable key;
- optional author-facing label and description;
- scalar type, nullability, and ordered enum domain where applicable;
- optional Default.

Trait Property contracts do not reference the retired project-wide identity Property registry.
An absent Default means the Trait contributes schema/capability only; an attached concrete owner must
eventually provide a more-specific value. Empty Traits are valid semantic markers and may be compiled,
attached, and matched at runtime without declaring any Properties.

Traits attach to stateful Gameplay Instances—Room, Character, and Interactable—and to Item Stack
semantic state through its immutable Item Definition defaults plus live Stack Trait set. Scene,
Dialogue, Verb, Interaction, and Map are immutable program/vocabulary definitions rather than
stateful Property- or Trait-bearing identities. Assets, Layouts, Script Modules, Shaders, Materials,
Variables/Global Properties, Tests, and the Project root are also not Trait owners.

Traits cannot attach Traits and cannot inherit from another Trait. A Trait never contributes structural fields such as Room exits, Scene instructions, Dialogue blocks, Character poses, Interactable presentation, Interaction rules, Verb programs, or Map topology.

## Resolution and precedence

For a Trait-backed identity-scoped Property on Gameplay Instance `I`, runtime lookup is:

1. `I`'s sparse runtime override in `SessionState`;
2. `I`'s more-specific concrete authored Value/Default where that owner kind supplies one;
3. an attached Trait Default;
4. a typed missing-value result.

A direct concrete authored value therefore overrides a Trait Default, and a runtime override overrides
both. Unsetting a runtime override resumes the same authored resolution. Property values on one
identity never flow to another identity.

Two attached Traits may contribute the same key only when their type/nullability contracts are
compatible; enum contracts additionally require the same values in the same order. Label and
description do not participate in compatibility. If more than one contributing Trait supplies a
Default, those Defaults must agree exactly. An attached Trait Property with no Default must be
satisfied by a more-specific concrete source; reusable Trait declarations themselves may remain
incomplete.

## Discovery, Lua, tests, and saves

The compiled project retains each Trait's complete typed Property contracts plus Trait attachments on
the supported Gameplay Instance families. For migrated Room and Character owners, the compiler also
publishes the effective exact-owner Property schema needed by the existing Property runtime seam;
that is a compiled projection of the Trait contract, not a project-wide authoring registry.

Lua does not have a separate Trait-value API. Trait-backed values are read and mutated through the same typed Property APIs described in `docs/engine/VARIABLE.md`, including `noveltea.properties.get`, `set`, and `unset`. Conditions, focused previews, test playback, and runtime execution use the same Property resolution seam.

Saves serialize only sparse runtime Property overrides. Trait declarations, Trait Defaults, concrete
authored values/defaults, and effective schemas remain immutable compiled data and are never
materialized as effective save values.

## Authoring workspace and diagnostics

Workspace projects persist Trait declarations in `traits.json`. Collaborator-visible Trait colors are
stored under tracked editor record metadata and have no compiled/runtime meaning. Migrated concrete
owners store Trait attachments plus their own local Property state; they do not duplicate Trait-owned
schema fields.

The Desktop Editor provides a first-class Traits surface for creating, editing, renaming, and deleting
Traits, editing `Applies To`, reordering Property contracts, and choosing optional Defaults. Concrete
owner Property Managers show attached Traits as colored controls and collapse compatible Trait
contributions to one effective Property row per key. The `Use` cell retains its numeric reference count
while displaying Trait provenance; multiple contributing Traits use deterministic hard-stop color
segments rather than blended colors. Trait-owned schema is read-only from the concrete owner; owner
editing changes only the more-specific Value/Default override.

Detaching a Trait, deleting a Trait Property, or deleting a Trait removes pure Trait-only
contributions. If the disappearing Trait source was the last schema source for an explicit local
override, the editor materializes that value as a standalone local Property so authored state is not
silently destroyed. Trait deletion reports known structural usages and cleans straightforward
attachments/deltas; it deliberately does not attempt arbitrary Lua or string rewriting. Trait ID
rename updates straightforward typed references and attachment sites plus tracked color metadata.

Validation/compiler diagnostics reject at least:

- a missing Trait attachment;
- a Trait attached to an unsupported owner kind;
- an invalid Trait Property contract or Default;
- duplicate Trait attachments or duplicate Trait Property members;
- incompatible same-key Trait Property schemas;
- conflicting same-key Trait Defaults;
- an unsatisfied no-Default Trait Property on a concrete owner.

The cross-language golden corpus includes `trait-properties-localization.json`, whose Trait contracts
exercise typed Defaults and required concrete values through authoring, compiler, native decode, and
runtime Property resolution without changing any selected format/version number.
