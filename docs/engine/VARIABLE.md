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
  defaultValue: unknown;
  scope: 'global';
  enumValues?: string[];
}
```

Global Variables always require a valid authored default. Number defaults must be finite, integer defaults must be finite whole numbers, and enum defaults must be one of the declared enum values.

Variable IDs share the normal project entity-ID syntax and become the compiled `PropertyId`. A Variable ID therefore cannot collide with an identity-scoped Property declaration ID.

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

An identity-scoped Property instead has `scope: "identity"`, its admitted `ownerKinds`, and may omit a declaration default when absence is meaningful. Current identity owners are exactly Room, Character, and Interactable Gameplay Instances; Scene, Dialogue, Verb, Interaction, and Map definitions are not Property targets.

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

`PropertyTargetRef` is either the explicit global target or a Room, Character, or Interactable identity target. Globals do not use a fake Game/entity owner ID.

`PropertyResolver` applies the same type, enum, finiteness, and nullability validation to global and identity-scoped writes. Global reads resolve an override first and otherwise return the required authored default. Identity-scoped reads resolve runtime override, direct authored assignment, configured attached Trait value, declaration default, then typed missing. Values never propagate between same-type definitions.

### Null versus unset

Explicit nullable `null` is a stored Property value. It is distinct from removing an override.

- setting `null` on a nullable Property stores a runtime override containing null;
- unsetting removes the override record;
- after unset, normal authored fallback/default resolution is visible again.

Do not encode "unset" as `null`.

## Persistence and checkpoints

Every authoritative runtime Property override participates in checkpoints and saves. There is no `Session` versus `Save` Property persistence class.

The Save File V1 payload serializes only sparse Property overrides. Direct authored assignments, Trait configuration, declaration defaults, and other effective values are not materialized into the save. A missing override record means unset; a saved nullable null remains an explicit override.

Loading validates every saved target, declaration, and value before restoring the candidate session.

## Lua API

Global Properties use the Game facade:

```lua
local value, err = Game.prop("flag")
local ok, err = Game.set_prop("flag", true)
local ok, err = Game.unset_prop("flag")
```

Identity-scoped custom Properties currently use the owner-qualified API:

```lua
local value, present, err = noveltea.properties.get(owner_kind, owner_id, property_id)
local ok, err = noveltea.properties.set(owner_kind, owner_id, property_id, value)
local ok, err = noveltea.properties.unset(owner_kind, owner_id, property_id)
```

The `present` result is significant for nullable identity-scoped Properties: a present `nil` value is not the same as an absent/unset Property value.

The retired `noveltea.variables` runtime table must not be used.

## Editor and preview behavior

The authoring collection and UI continue to use the term Variables. Create, rename, type/default editing, dependency tracking, and condition/scene/dialogue builders still reference `/variables` in authoring source.

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
