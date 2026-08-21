# Traits

Traits are discoverable capability/configuration declarations backed entirely by ordinary identity-scoped Properties. They do not introduce a second value namespace, a generic component bag, structural inheritance, or executable inheritance.

Current authoring and compiled gameplay schemas remain `noveltea.authoring.project` V4 and `noveltea.compiled.project` V4. Issue #68 replaces the retired universal same-type `extends` shape in those already-selected versions; normal readers reject the retired field rather than maintaining a compatibility path.

## Declaration

A Trait has:

- a globally unique Trait ID and author-facing label;
- an optional description;
- one or more supported owner kinds;
- one or more ordinary Property members.

A Property member is exactly one of:

- `required`: the attached identity must have a value available from its own assignment, another attached Trait's configured value, or the Property declaration default;
- `configured`: the Trait supplies an authored value for that ordinary Property.

Trait members always reference existing identity-scoped Property declarations. Their configured values use the same `RuntimeValue` scalar vocabulary, type/nullability/enum validation, and owner-kind restrictions as direct Property assignments.

Traits currently attach to Room, Scene, Dialogue, Character, Interactable, Verb, Interaction, and Map identities. Assets, Layouts, Script Modules, Shaders, Materials, Variables/Global Properties, Tests, and the Project root are not Trait owners.

Traits cannot attach Traits and cannot inherit from another Trait. A Trait never contributes structural fields such as Room exits, Scene instructions, Dialogue blocks, Character poses, Interactable presentation, Interaction rules, Verb programs, or Map topology.

## Resolution and precedence

For an identity-scoped Property on definition `D`, runtime lookup is exactly:

1. `D`'s sparse runtime override in `SessionState`;
2. `D`'s own authored Property assignment;
3. a configured value supplied by an attached Trait;
4. the Property declaration default;
5. a typed missing-value result.

A direct authored assignment therefore overrides Trait configuration, and a runtime override overrides both. Unsetting a runtime override resumes the same authored/Trait/default lookup. Property values on one identity never flow to another identity.

Two attached Traits may configure the same Property only when they provide the same scalar value. Conflicting configured values are invalid authoring and compiled data. A required member is considered satisfied by a direct assignment, a configured attached Trait, or a declaration default; otherwise compilation fails.

## Discovery, Lua, tests, and saves

The compiled project retains Trait declarations and per-definition Trait attachments. This metadata remains discoverable to editor dependency/search tooling and to runtime code that needs capability identity, while the actual values continue to resolve through the Property system.

Lua does not have a separate Trait-value API. Trait-backed values are read and mutated through the same typed Property APIs described in `docs/engine/VARIABLE.md`, including `noveltea.properties.get`, `set`, and `unset`. Conditions, focused previews, test playback, and runtime execution use the same Property resolution seam.

Saves serialize only sparse runtime Property overrides. Trait declarations, Trait configured values, direct authored assignments, and Property declaration defaults remain immutable compiled data and are never materialized as effective save values.

## Authoring workspace and diagnostics

Workspace projects persist Trait declarations in `traits.json`. Property-bearing records store only their attached Trait IDs plus any direct `properties` assignments.

Validation/compiler diagnostics reject at least:

- a missing Trait attachment;
- a Trait attached to an unsupported owner kind;
- a Trait member that names a missing or owner-incompatible Property;
- a configured Trait value incompatible with its Property declaration;
- duplicate Trait attachments or duplicate Trait Property members;
- incompatible configured values from multiple attached Traits;
- an unsatisfied required Trait Property.

The cross-language golden corpus includes `trait-properties-localization.json`, whose `tense-room` Trait configures the ordinary `mood` Property and requires the ordinary `visit-count` Property. That fixture is the representative authoring/compiler/native-runtime acceptance seam for Trait-driven state.
