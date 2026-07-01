# Variable Entity

## Purpose

Variable records define typed global authoring variables for NovelTea projects. They are intended to reduce typo-prone script state, provide defaults for runtime session state, and give the editor a structured surface for conditions, branches, watches, and test assertions.

This document covers the new authoring variable model. Legacy property-list behavior is reference material only.

## Current Status

Variables are implemented as a typed authoring collection in the editor. The Variables editor supports creating variables, editing type/default/enum metadata, and applying command-backed replacements. Validation checks data shape, enum values, and default-value compatibility.

Runtime variable/session semantics are not fully documented as a complete gameplay state system yet. Current native runtime state exists in `GameSession` and `SaveDocument`, while Lua bindings and runtime controller work continue to evolve.

## Collection

Variable records live at:

```json
/variables/{variableId}
```

The record uses the standard authoring record wrapper. Variable-specific data lives in `record.data`.

```ts
interface VariableData {
  kind: 'variable';
  type: 'boolean' | 'integer' | 'number' | 'string' | 'enum';
  defaultValue: unknown;
  scope: 'global';
  enumValues?: string[];
  runtimeName?: string;
}
```

## Identity Rules

Variable IDs use the project entity ID format:

```text
lowercase kebab-case, starts with a letter, contains only letters, numbers, and hyphens
```

Examples:

```text
has-key
chapter-number
relationship-iris
current-route
```

`runtimeName` is optional and should only be used when a stable runtime/script name must differ from the authoring ID. Its semantics are not yet deeply enforced by runtime export.

## High-Level Model

A variable is a named typed global value with an authoring default. It is not currently a local scene/dialogue variable or a complex object store.

`scope` is currently fixed to `global`, leaving room for future local or namespaced scopes without inventing them prematurely.

Enum variables store an allowed string set in `enumValues`. Their default must be one of those enum values.

## Data Model

`kind` is always `variable`.

`type` determines how the default value is parsed, displayed, and validated.

`defaultValue` stores the default runtime/session value.

`scope` is currently always `global`.

`enumValues` is used only for `enum` variables.

`runtimeName` is optional and currently acts as metadata for future runtime/script naming.

## References

Variable references use the authoring variable reference shape:

```ts
{ $var: 'variable-id' }
```

This shape is defined separately from generic `{ collection, id }` references because variables are often used inside condition/assertion payloads and future expression builders.

Tests, dialogue conditions, scene variable steps, room scripts, and Lua hook surfaces may refer to variables conceptually. Only typed schema-owned references can participate in automatic rename/delete tracking today; references embedded in raw Lua strings require future script analysis or explicit diagnostics.

## Defaults

`defaultVariableData()` creates a global boolean variable by default:

```ts
{
  kind: 'variable',
  type: 'boolean',
  scope: 'global',
  defaultValue: false,
}
```

Default values by type are:

- `boolean`: `false`;
- `integer`: `0`;
- `number`: `0`;
- `string`: empty string;
- `enum`: first normalized enum value, or `default` for a new enum variable.

A new enum variable defaults to:

```ts
{
  kind: 'variable',
  type: 'enum',
  scope: 'global',
  enumValues: ['default'],
  defaultValue: 'default',
}
```

## Validation

Variable validation checks:

- `record.data` parses as `VariableData`;
- enum variables have at least one enum value;
- enum values are non-empty;
- enum values are unique;
- `defaultValue` is compatible with the variable type;
- integer defaults are finite whole numbers;
- number defaults are finite numbers;
- enum defaults match one of the enum values.

Validation currently does not parse Lua source to discover unknown variable names used in scripts.

## Command Behavior

Variable-specific commands include:

- `variable.replaceData` to replace a variable's full typed data after validation;
- `variable.setType` to change type and normalize the default value;
- `variable.setDefaultValue` to update the default value while enforcing type compatibility.

Generic entity commands handle record creation, rename, deletion, metadata updates, parent assignment, and duplication.

## Editor Behavior

The Variables editor presents variables as an editable authoring table/detail surface. It normalizes text input into typed values using the same parser functions as validation.

Enum editing accepts comma-separated or newline-separated values, trims them, and filters empty text before validation. Invalid defaults or duplicate enum values are rejected through command diagnostics.

## Editor Preview

There is no dedicated live engine preview for a variable record. Variables are expected to become visible through runtime state watches, condition builders, scene/dialogue preview, test playback, and preview state inspection.

## Runtime Status

Runtime state currently exists through `GameSession`, `RuntimeStateSnapshot`, `SaveDocument`, and runtime controller/session-host types. The complete mapping from authoring variable records to runtime session state is still a work in progress.

Variable defaults should eventually initialize runtime state when a project/session starts, and save data should preserve runtime values. Until that mapping is explicitly implemented and tested, authoring variables should be treated as structured editor data and future runtime intent.

## Export / Package Status

Variables are part of the authoring project schema but are not currently converted into a dedicated runtime variable table by `buildAuthoringRuntimeExport()`. Export currently focuses on rooms, entrypoint handling, asset file entries, and shader/material metadata.

Scene/dialogue/test systems may refer to variables in their own data, but a complete variable runtime export path still needs to be defined.

## Scripting Status

Lua is the runtime scripting target. Variables should eventually be exposed to Lua through the runtime session/game state API, not through ad-hoc string globals. Current variable records provide enough metadata for that binding, but the exact script API is not yet fully specified in this doc.

Raw Lua hook fields may mention variable names manually. Those mentions are not currently statically tracked as `VariableRef` values.

## Relationship To Other Entity Types

Variables are expected to support:

- scene variable set/check steps;
- dialogue conditions and branch behavior;
- room enter/leave and hotspot scripts;
- action/interaction conditions;
- tests and assertions;
- runtime save/load state;
- future editor condition builders.

Variables should remain backend-neutral and should not depend on renderer, UI, audio, or platform implementation types.

## Legacy Reference Notes

Legacy `PropertyList` and `ContextObject` files are useful for understanding old state/property behavior. They are not compatibility requirements for the new variable schema.

The old engine used script/context mechanisms that do not map directly to the new Lua-first authoring/runtime boundary. Do not document Duktape/JavaScript property access as a new requirement.

## Recommended Authoring Patterns

Use boolean variables for flags, integer variables for counters, number variables for continuous values, string variables for free text, and enum variables when the valid states are known.

Prefer enum variables over string variables for story routes, modes, and state machines where editor validation should prevent typos.

Keep variable IDs stable once scripts, tests, scenes, or dialogues reference them.

## Current Implementation Files

Primary editor files:

```text
editor/src/shared/project-schema/authoring-variables.ts
editor/src/shared/project-schema/authoring-validation.ts
editor/src/renderer/project/variable-operations.ts
editor/src/renderer/editors/variables/VariablesEditor.tsx
editor/src/renderer/commands/builtin-commands.ts
```

Related engine files:

```text
engine/include/noveltea/core/game_session.hpp
engine/include/noveltea/core/save_document.hpp
engine/include/noveltea/script/script_runtime.hpp
engine/include/noveltea/script/runtime_script_executor.hpp
engine/src/core/game_session.cpp
engine/src/core/save_document.cpp
engine/src/script/lua/script_runtime.cpp
engine/src/script/lua/runtime_script_executor.cpp
```

Useful legacy references:

```text
refs/NovelTea/include/NovelTea/PropertyList.hpp
refs/NovelTea/src/core/PropertyList.cpp
refs/NovelTea/include/NovelTea/ContextObject.hpp
refs/NovelTea/src/core/ContextObject.cpp
```

## Known Gaps

- Runtime initialization from variable defaults is not fully documented or exposed as a complete component contract.
- Variable values are not yet exported into a dedicated runtime state table.
- Lua references in script strings are not statically tracked.
- The editor does not yet provide variable watch/debugger UI during preview.
- Scope is currently fixed to `global`; local/scoped variables are not implemented.

## Future Work

- Define the runtime session storage model for authoring variables.
- Export variable defaults into runtime packages.
- Add Lua get/set APIs around runtime state.
- Add condition-builder UI for scenes, dialogues, rooms, and actions.
- Add preview variable watches and test assertion helpers.

## Verification

This doc was written from the current variable schema, variable operation helpers, validation aggregator, Variables editor, and runtime session/save/script headers. No build is required for this documentation-only change.
