# Project Entity

## Purpose

The Project entity is the root authoring document for a NovelTea project. It owns project metadata, global settings, the startup entrypoint, editor session state, and all typed authoring collections.

This document covers the new authoring project format. It is not a compatibility description of the old NovelTea project file. The old project model is useful for migration and runtime-package reference only.

## Current Status

The editor has a typed authoring project schema and generic collection wrapper. Project validation is implemented for schema shape, record identity, parent/inheritance relationships, entrypoint existence, asset aliases, default layout settings, and the typed component validators that currently exist.

The native engine still has `ProjectDocument` and `ProjectModel` types that primarily support the current runtime/export path and migrated legacy-style runtime package model. The authoring-to-runtime export path is intentionally partial: room entrypoints and room export are currently supported more directly, while scenes and dialogues still emit runtime-compatibility warnings during export.

## Collection

Project is the root document, not a normal collection record. Its current authoring shape is:

```ts
interface AuthoringProject {
  schema: 'noveltea.authoring.project';
  schemaVersion: 1;
  project: {
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
  };
  settings: Record<string, unknown>;
  entrypoint: ReferenceTarget | null;
  editor: EditorProjectState;
  assets: AuthoringCollection;
  variables: AuthoringCollection;
  shaders: AuthoringCollection;
  materials: AuthoringCollection;
  layouts: AuthoringCollection;
  characters: AuthoringCollection;
  rooms: AuthoringCollection;
  objects: AuthoringCollection;
  verbs: AuthoringCollection;
  actions: AuthoringCollection;
  dialogues: AuthoringCollection;
  scenes: AuthoringCollection;
  maps: AuthoringCollection;
  scripts: AuthoringCollection;
  tests: AuthoringCollection;
}
```

Typed entity records inside collections use the shared wrapper:

```ts
interface AuthoringRecordBase {
  id: string;
  label: string;
  description?: string;
  parent?: ReferenceTarget | null;
  inherits?: ReferenceTarget | null;
  tags: string[];
  color?: string | null;
  sortKey?: string | null;
  data: Record<string, unknown>;
}
```

## Identity Rules

The project ID and all entity IDs use the project entity ID format:

```text
lowercase kebab-case, starts with a letter, contains only letters, numbers, and hyphens
```

Examples:

```text
new-project
opening-room
iris-neutral
main-menu-layout
```

Record map keys must match `record.id`. Parent and inheritance references use `{ collection, id }` targets where `collection` must be one of the known authoring collections.

## High-Level Model

The project document has three major state categories.

Persistent project state is stored directly in the authoring project and participates in validation/export. This includes metadata, settings, entrypoint, and entity collections.

Persistent editor session state is stored under `project.editor`. It is editor-only state and should not be interpreted as runtime game state.

Transient editor state lives in renderer stores and workbench services. It should not be serialized into runtime packages.

## Data Model

`schema` and `schemaVersion` identify the authoring format. Current values are `noveltea.authoring.project` and `1`.

`project` stores human-facing project metadata: ID, name, version, author, and description.

`settings` is a namespaced settings bag. Current typed project settings include `settings.startup.initScript`, `settings.ui.systemLayouts`, `settings.text.defaultFont`, `settings.titleScreen`, and `settings.app.icon`. System layout role refs and default font may be null or absent, which means the built-in fallback resource is used.

`entrypoint` is the intended startup target. It can reference any known authoring collection structurally, but runtime export currently accepts room entrypoints only.

`editor` stores editor-only project state.

The collections store authoring records. Some collections already have typed `record.data` schemas; others are currently placeholders and should not be documented as fully implemented until their schema/editor/runtime support exists.

## References

Project-level references use the generic `ReferenceTarget` shape:

```ts
interface ReferenceTarget {
  collection: AuthoringCollectionKey;
  id: string;
}
```

The validator checks that project entrypoint, record parent references, and record inheritance references point to known records. Component-specific validators check deeper `$ref` shapes inside `record.data`.

## Defaults

`createAuthoringProject()` creates a new authoring document with:

- schema `noveltea.authoring.project`;
- schema version `1`;
- project ID `new-project` unless overridden;
- project name `New Project` unless overridden;
- version `0.1.0` unless overridden;
- empty author and description unless overridden;
- empty `settings`;
- null `entrypoint`;
- default editor project state;
- empty maps for every authoring collection.

Entity records are created through generic entity operations. Collections with typed schemas get typed default data through `defaultDataForCollection()`.

## Validation

Project validation currently checks:

- root authoring project schema;
- missing project entrypoint warning;
- entrypoint target existence when configured;
- valid collection names in references;
- record ID format;
- record key and `record.id` consistency;
- non-empty record labels;
- parent target existence;
- inheritance target existence;
- self-parent and self-inheritance errors;
- parent and inheritance cycle detection;
- asset record data and alias safety;
- default layout setting validity;
- typed project settings for startup script, default font, title screen image/options, and project icon;
- typed layout, variable, shader, material, character, room, dialogue, scene, and test data.

Current validation does not make every collection fully typed. `objects`, `verbs`, `actions`, `maps`, and `scripts` exist as collections but do not yet have the same dedicated V1 authoring schema coverage as the high-priority typed components.

## Command Behavior

Generic project and entity commands handle most project-level edits:

- `project.applyPatch`
- `project.replaceAtPath`
- `project.addAtPath`
- `project.removeAtPath`
- `entity.createRecord`
- `entity.replaceRecord`
- `entity.renameId`
- `entity.duplicateRecord`
- `entity.deleteRecord`
- `entity.updateMetadata`
- `entity.setParent`

Entity creation uses collection-specific default data where available. Rename operations rewrite references across the project. Delete preflight checks reference usages before removing a record.

Project UI settings and editor preferences are not the same layer. The existing Settings tab is editor preferences. The Project Settings tab is the dedicated authoring surface for game/runtime settings, project metadata, startup entrypoint, startup init Lua, default layout/font, title-screen options, and project icon.

Project-level commands include metadata, entrypoint, startup, runtime default layout/font, title-screen, and project-icon operations. These commands keep Project Settings edits undoable and avoid direct store mutation.

## Editor Behavior

The workbench treats project data as the persistent source of truth. Typed editors read and update records through command-backed operations rather than mutating project data directly.

The Project explorer uses collection metadata from `authoring-collections.ts` to group and create records. Project-wide validation feeds diagnostics into the editor problems/workbench surfaces.

The current `SettingsTabEditor` wraps the editor settings route for app preferences. `ProjectSettingsEditor` is separate and opens as a workbench utility tab from `Project > Project Settings…` and from Package Export when project-level blockers such as a missing entrypoint are detected.

## Editor Preview

Project-level preview is currently mediated through preview documents generated by component-specific helpers such as layout, shader/material, character, and room preview builders.

The project entrypoint is intended to drive full startup preview, but runtime preview behavior is still being refined. Component docs should describe their own preview payloads and limitations.

## Runtime Status

Native runtime support currently includes:

- `ProjectDocument` for JSON project root ownership and basic entrypoint validation;
- `ProjectModel` for runtime/migration-facing entity stores such as rooms, maps, dialogues, cutscenes, objects, verbs, actions, and scripts;
- `GameSession`, `RuntimeController`, and related runtime state/session types.

The new authoring project format and the native runtime model are not yet a single fully equivalent schema. The authoring export adapter bridges what is currently supported.

## Export / Package Status

`buildAuthoringRuntimeExport()` builds a runtime project object from the authoring project. As of the current implementation:

- room records are converted into runtime room arrays;
- only room entrypoints are accepted as runtime-exportable entrypoints;
- scene and dialogue records emit warnings that they are not runtime-compatible yet;
- assets are included either by reference discovery or by `includeAllProjectAssets` profile settings;
- shader/material metadata is built when shader or material records exist;
- runtime package options are generated for the native package writer.

## Scripting Status

Project Settings exposes `settings.startup.initScript` as the authoring project-level startup Lua field. Runtime execution/export handling for this field remains limited until the runtime startup schema consumes it. Component-specific Lua surfaces, such as layout Lua source and room enter/leave scripts, remain separate.

## Relationship To Other Entity Types

Project owns every authoring collection. Assets, variables, shaders, materials, layouts, characters, rooms, dialogues, scenes, and tests have typed V1 docs or will receive them. Objects, verbs, actions, maps, and scripts are collection-level placeholders until their dedicated new authoring schemas are implemented.

System layout role configuration belongs to project settings and either references layout records or uses built-in fallbacks per role. Default font similarly either references a font asset or uses the built-in fallback.

Startup behavior belongs to the project entrypoint and optional startup init script, but export support still depends on the referenced entrypoint type.

## Legacy Reference Notes

Legacy project behavior can be studied in `ProjectData`, `ProjectDataIdentifiers`, and `Settings` under `refs/NovelTea/`. Use those files to understand old entity categories, runtime arrays, and old project settings, not to preserve the old serialization as the new editor format.

The old Qt project settings widget is useful only as workflow reference. The new Electron editor should not duplicate Qt architecture.

## Recommended Authoring Patterns

Use project metadata for stable human-facing package information. Use entity records for actual content. Keep editor session preferences out of runtime content. Configure a room entrypoint for export until scene/dialogue startup export becomes runtime-compatible.

Prefer typed component settings over ad-hoc `settings` keys once a setting affects validation, preview, or export.

## Current Implementation Files

Primary editor files:

```text
editor/src/shared/project-schema/authoring-project.ts
editor/src/shared/project-schema/authoring-collections.ts
editor/src/shared/project-schema/editor-project-state.ts
editor/src/shared/project-schema/authoring-validation.ts
editor/src/shared/project-schema/authoring-export.ts
editor/src/shared/project-schema/authoring-runtime-export.ts
editor/src/shared/project-schema/authoring-project-settings.ts
editor/src/renderer/project/project-store.ts
editor/src/renderer/project/project-types.ts
editor/src/renderer/project/entity-operations.ts
editor/src/renderer/project/project-settings-operations.ts
editor/src/renderer/commands/builtin-commands.ts
editor/src/renderer/editors/project/ProjectSettingsEditor.tsx
editor/src/renderer/editors/utility/SettingsTabEditor.tsx
```

Primary engine files:

```text
engine/include/noveltea/core/project_document.hpp
engine/include/noveltea/core/project_model.hpp
engine/include/noveltea/core/project_validator.hpp
engine/include/noveltea/core/package_export.hpp
engine/include/noveltea/core/game_session.hpp
engine/include/noveltea/core/runtime_controller.hpp
engine/src/core/project_document.cpp
engine/src/core/project_model.cpp
engine/src/core/project_validator.cpp
engine/src/core/package_export.cpp
engine/src/core/game_session.cpp
engine/src/core/runtime_controller.cpp
```

Useful legacy references:

```text
refs/NovelTea/include/NovelTea/ProjectData.hpp
refs/NovelTea/include/NovelTea/ProjectDataIdentifiers.hpp
refs/NovelTea/include/NovelTea/Settings.hpp
refs/NovelTea/src/core/ProjectData.cpp
refs/NovelTea/src/core/Settings.cpp
refs/NovelTea/src/editor/Widgets/ProjectSettingsWidget.cpp
refs/NovelTea/res/forms/ProjectSettingsWidget.ui
```

## Known Gaps

- Project Settings V1 exists, but not every stored setting is consumed by runtime export/execution yet.
- The authoring schema and native runtime model are still bridged through partial export adapters.
- Runtime export currently accepts room entrypoints only.
- Scenes and dialogues are authored but not runtime-export compatible yet.
- Several collections exist before their dedicated typed component schemas are implemented.

## Future Work

- Expand typed project settings for feature toggles, package defaults, audio defaults, language defaults, and accessibility defaults as runtime consumers appear.
- Expand authoring-to-runtime conversion beyond rooms.
- Make scene/dialogue entrypoints runtime-exportable.
- Add stronger validation for project settings namespaces as they become stable.
- Keep this doc synchronized with every collection schema and runtime export expansion.

## Verification

This doc was written from the current authoring project schema, validation aggregator, generic entity operations, export adapter, and native project/runtime headers. No build is required for this documentation-only change.
