# Variables and Global Properties

## Purpose

Variable is the editor-facing name for a Global Property. NovelTea has one runtime Property system for typed custom gameplay state; Variables are not a second runtime value family.

The Variables editor remains the convenient authoring surface for globally scoped flags, counters, numbers, strings, and enums. Compilation lowers those records into ordinary `PropertyDefinition` entries with `scope: "global"` in the current `noveltea.compiled.project` format.

## Authoring model

Variable records live at:

```text
/variables/{variableId}
```

Their authoring data is intentionally concise:

```ts
interface VariableData {
  kind: 'variable';
  type: 'boolean' | 'integer' | 'number' | 'string' | 'enum';
  nullable: boolean;
  value: unknown;
  scope: 'global';
  enumValues?: string[];
}
```

Global Variables always require a concrete authored Value. Nullable Variables may author `null` as that Value. Non-null numbers must be finite, integers must be finite whole numbers, and enum Values must be one of the declared enum values.

Variable IDs share the normal project entity-ID syntax and become the compiled `PropertyId`. They
are unique among Variables, but may use the same key as an owner-local Property because identity
Properties are addressed by exact owner plus key rather than by a project-wide identity registry.

Rooms and Characters author ordered owner-local Property declarations directly on the owner record.
Interactable definitions author ordered Property Defaults/contracts, while Interactable Instances may
carry exact instance-local Properties and exact override state. Features use their owner-local
Property contracts. Each contract carries its key/ID, optional label/description, type, nullability,
and enum domain when applicable; concrete Values/Defaults live with the appropriate owner surface.
The same key may therefore have unrelated schemas on different owners. Traits remain self-contained
reusable contracts and do not depend on a project-wide identity Property declaration.

## Compiled contract

The compiler emits no `variables[]` runtime declaration collection. Both authoring Variables and identity-scoped Property declarations are emitted in the single `properties[]` collection.

A compiled Global Property has:

```text
scope: "global"
id
label
description
type
nullable: false
defaultValue
enumValues
```

The compiled Global Property preserves the authored Variable nullability and always carries `defaultValue`, which is the authored Value.

Identity Properties compile as exact declarations with `scope: "identity"` plus an exact `owner`
reference when a standalone declaration is needed. Concrete authored state is emitted on the owning
definition/instance contract. Exact declarations do not use `ownerKinds`, and identity is
`(owner, PropertyId)` rather than `PropertyId` alone. Scene, Dialogue, Verb, Interaction, and Map
definitions are not Property targets.

Conditions and effects that originate from Variable authoring also compile to Property vocabulary:

```text
global-property-comparison
set-global-property
{ kind: "property", id: ... }
```

There is no compiled Variable reference or separate Variable runtime store.

## Runtime model

`SessionState` stores one sparse collection of `PropertyOverride` values. Each override is addressed by:

```text
(PropertyTargetRef, PropertyId)
```

`PropertyTargetRef` is either the explicit global target or an exact Room, Character, Interactable,
or Feature identity target. The retired Item Stack owner kind is invalid rather than an alias for an
Interactable Instance. Globals do not use a fake Game/entity owner ID.

`PropertyResolver` applies the same type, enum, finiteness, and nullability validation to global and
identity-scoped writes. For an owner-qualified read it resolves the exact owner's authored contract
and compatible attached Trait contracts for that key. Global reads resolve an override first and
otherwise return the required authored Value/default. Identity resolution uses runtime override,
concrete authored value/default, compatible Trait Default, then typed missing. Values never
propagate between owners that happen to use the same key.

Lua may also create a Property key that has no authored/effective schema. Such a dynamic Property is
Session-only authoring-independent state: it stores only `(target, key, RuntimeValue)`, may change
among the ordinary scalar RuntimeValue types (including explicit null), and gains no inferred type,
enum, nullability, label, or other schema metadata. Missing dynamic keys read as absent rather than as
errors. Dynamic keys are not injected into Project authoring tables, selectors, or Property pickers.

Authored/effective schemas always take precedence over schema-less behavior. Once a key resolves to an
authored owner-local, Trait-backed, or Global Property schema, writes use that schema's normal strict
validation. If a runtime structural change would make a new schema effective over an existing dynamic
key, the current dynamic value is validated before the structural change commits. An incompatible
value rejects that structural change atomically; runtime never coerces or silently deletes the value.

### Null versus unset

Explicit nullable `null` is a stored Property value. It is distinct from removing an override.

- setting `null` on a nullable Property stores a runtime override containing null;
- unsetting removes the override record;
- after unset, normal authored fallback/default resolution is visible again.

Do not encode "unset" as `null`.

## Persistence and checkpoints

Every authoritative runtime Property override, including a schema-less dynamic Property, participates
in checkpoints and saves. There is no `Session` versus `Save` Property persistence class.

The Save File V1 payload serializes only sparse Property overrides. Direct authored assignments, Trait
configuration, declaration defaults, and other effective values are not materialized into the save.
A dynamic Property uses that same existing override record; no schema metadata is added to the save.
A missing override record means unset; a saved null remains an explicit present value whether the key
is authored-nullable or schema-less dynamic.

Loading validates every saved target, declaration, and value before restoring the candidate session.

## Lua API

Global Properties use the Game facade:

```lua
local value, present, err = Game.prop("flag")
local ok, err = Game.set_prop("flag", true)
local ok, err = Game.unset_prop("flag")
```

`Game.prop` uses the same presence convention as identity-scoped reads: `present == false` means that
the key has no effective value, while `present == true` with `value == nil` is an explicit null.
`Game.set_prop` and capability-bound gameplay identity `set_prop` methods may create a missing key as a
schema-less dynamic Property. There is intentionally no separate API for dynamically declaring a typed
or enum schema.

Identity-scoped custom Properties currently use the owner-qualified API:

```lua
local value, present, err = noveltea.properties.get(owner_kind, owner_id, property_id)
local ok, err = noveltea.properties.set(owner_kind, owner_id, property_id, value)
local ok, err = noveltea.properties.unset(owner_kind, owner_id, property_id)
```

The `present` result is significant for all Property reads that may be schema-less: a present `nil`
value is not the same as an absent/unset Property value.

The retired `noveltea.variables` runtime table must not be used.

## Editor and preview behavior

The authoring collection and UI continue to use the term Variables. Create, rename, type/Value editing, dependency tracking, and condition/scene/dialogue builders still reference `/variables` in authoring source. Variables are the visual/interaction baseline for the shared Property Manager: Variable, owner-local, reusable Default, Trait-contract, and exact Instance surfaces use the same compact Property table, create/edit dialog, type presentation, typed scalar/null controls, Use cell, and delete/reset action language. Semantic adapters supply the different persistence and inheritance behavior rather than constructing separate Property UIs.

Owner Property lists expose best-effort Uses counts and rename repair where the owning semantic adapter has straightforward structured-reference evidence. This is intentionally shallow: explicit owner/key references are repaired, but general Lua/static analysis is outside this slice. Deleting a used Property warns and leaves unresolved references for validation to report.

Scene gameplay Property mutation uses the shared Gameplay Command owner operand plus `propertyId`, the
same representation used by Interaction and Dialogue command programs. Typed owner/Property selectors
enumerate the selected owner's statically known effective authored schema; validation rejects missing
keys and incompatible set Values. The retired Scene-only `{ key }` operation shape and project-wide
identity Property-definition `$ref` form are not second supported namespaces.

Preview/debug "set variable" operations are editor-facing commands only. They parse the Variable ID as a `PropertyId` and mutate the Global Property through the runtime Property gateway. Reset removes the runtime override rather than writing the default value.

## Validation and strict-version policy

Current authoring uses the stable `noveltea.authoring.project` identity and current compiled gameplay data uses `noveltea.compiled.project` Format V1. Normal readers reject unsupported boundary versions and retired shapes; there is no dual reader for the former compiled `variables[]` representation or Property persistence field.

The cross-language golden corpus is the contract evidence: editor compiler output, canonical checked-in JSON, and the native decoder/linker must move together.

## Primary implementation files

Editor:

```text
editor/src/shared/project-schema/authoring-variables.ts
editor/src/shared/project-schema/authoring-properties.ts
editor/src/shared/authoring-compiler-shared-lowering.ts
editor/src/renderer/editors/variables/VariablesEditor.tsx
editor/src/renderer/components/properties/PropertyManager.tsx
editor/src/renderer/components/properties/PropertyTable.tsx
editor/src/renderer/components/properties/PropertyEditDialog.tsx
editor/src/renderer/components/properties/PropertySchemaFields.tsx
editor/src/renderer/components/properties/PropertyValueInput.tsx
editor/src/renderer/components/properties/TypedPropertyFields.tsx
editor/src/renderer/components/properties/OwnerLocalPropertiesEditor.tsx
editor/src/renderer/components/properties/OwnerDefaultPropertiesEditor.tsx
editor/src/renderer/project/owner-local-property-references.ts
```

Engine/runtime:

```text
engine/include/noveltea/core/property.hpp
engine/include/noveltea/core/property_resolver.hpp
engine/include/noveltea/core/session_state.hpp
engine/include/noveltea/core/save_state.hpp
engine/src/core/property_resolver.cpp
engine/src/core/save_state.cpp
engine/src/core/save_state_codec/
engine/src/runtime/runtime_command_gateway.cpp
engine/src/script/lua/bind_typed_script_host.cpp
```

## Traits

Traits are now the supported capability/configuration layer over identity-scoped Properties; see `docs/engine/TRAIT.md`. They reuse these exact Property declarations, values, Lua APIs, mutation validation, checkpoint semantics, and save semantics. Universal same-type gameplay definition inheritance is retired.
