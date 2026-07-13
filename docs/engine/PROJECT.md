# Project Root

## Contract

The project root owns project identity, runtime settings, feature flags, localization, startup hook, entrypoint, collection indexes, and editor-owned source metadata. It is not an entity, property owner, or generic mutation target.

Authoring V2 is `noveltea.authoring.project` version 2. The editor owns it and compiles it; C++ never parses it. The normal V2 path does not accept V1 or legacy projects. The compiled gameplay document is strict `noveltea.compiled.project` version 1.

## Collections

V2 uses collection-specific records for assets, variables, shaders/materials, layouts, characters, rooms, interactables, verbs, interactions, dialogues, scenes, maps, script modules, and tests. It has no authoritative `data: Record<string, unknown>` wrapper.

Stable record IDs are unique within each collection. Nested IDs are unique within their owning record. Generic cross-collection `parent` is removed. Property-bearing definitions use optional same-collection `extends`; categories and tags remain editor-only organization.

The complete authoring/wire/runtime disposition is in [`DOMAIN_COLLECTIONS_AND_RELATIONSHIPS.md`](../architecture/DOMAIN_COLLECTIONS_AND_RELATIONSHIPS.md).

## Startup

Entrypoint is a strict union of Room, Scene, or Dialogue. Script is not an entrypoint. Project startup Lua is a separate synchronous hook that cannot yield and must succeed before the entrypoint starts.

Runtime-visible names/descriptions are explicit component fields. Record labels, notes, categories, tags, graph coordinates, selections, colors, collapsed state, sort keys, and preview state are editor metadata and are not gameplay output.

## Compilation and packages

One pure TypeScript compiler validates V2, validates inheritance/properties/references, lowers specialized programs, removes tooling data, and emits deterministic canonical gameplay JSON. Preview, tests, package export, and CLI export use that API.

The gameplay document is separate from the package manifest and shader/material metadata. C++ independently decodes those untrusted documents and assembles immutable `CompiledProject` plus prepared resource registries. JSON is not retained as runtime truth.

## Current implementation scaffold

Phases 3A--3E implement the strict `noveltea.authoring.project` V2 root infrastructure,
collection-specific record maps, `interactables`/`interactions`, same-type `extends`, declared typed
properties and assignments, variables, localization, editor-only record metadata, the strict
Room/Scene/Dialogue entrypoint plus separate startup hook, and complete Interactable, Verb,
Interaction, Map, and Script Module contracts. Phase 3 remains in progress until Phase 3F migrates
all fixtures and consumers through the final collection-wide strictness and authoritative-cutover
gate.

The native runtime still uses `ProjectDocument`, `ProjectModel`, numeric entity tags, and partial room-oriented export. Those paths remain build scaffolding only and do not alter the V2 authoring contract.

Current files include:

```text
editor/src/shared/project-schema/authoring-project.ts
editor/src/shared/project-schema/authoring-validation.ts
editor/src/shared/project-schema/authoring-runtime-export.ts
editor/src/renderer/editors/project/ProjectSettingsEditor.tsx
engine/include/noveltea/core/project_document.hpp
engine/include/noveltea/core/project_model.hpp
```

Phases 3--10 replace this scaffold. No legacy format, universal parent behavior, Script entrypoint, Object/Action naming, or generic runtime property mutation is preserved.

### Current V2 authoring document

The editor currently reads and writes the V2 scaffolding directly. V1 and legacy collection names are rejected by the normal parser, but this state remains transitional until every admitted collection has its complete schema. The Phase 3A root resembles:

```ts
interface AuthoringProject {
  schema: 'noveltea.authoring.project';
  schemaVersion: 2;
  project: {
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
  };
  settings: Record<string, unknown>;
  startupHook: { source: string } | null;
  entrypoint: { kind: 'room' | 'scene' | 'dialogue'; id: string } | null;
  properties: Record<PropertyId, PropertyDefinition>;
  localization: AuthoringLocalization;
  editor: EditorProjectState;
  assets: AuthoringCollection;
  variables: AuthoringCollection;
  shaders: AuthoringCollection;
  materials: AuthoringCollection;
  layouts: AuthoringCollection;
  characters: AuthoringCollection;
  rooms: AuthoringCollection;
  interactables: InteractableAuthoringCollection;
  verbs: AuthoringCollection;
  interactions: InteractionAuthoringCollection;
  dialogues: AuthoringCollection;
  scenes: AuthoringCollection;
  maps: AuthoringCollection;
  scripts: AuthoringCollection;
  tests: AuthoringCollection;
}
```

Records use collection-specific strict schemas. Common record identity is limited to `id`, label, optional description, and typed collection data. Property-bearing definitions may contain a same-collection `extends` ID and declared property assignments. Categories, tags, color, sort order, and collapsed state live under `editor.recordMetadata` or the existing editor category/tag registries, never on runtime-content records.

Project IDs and record IDs currently use lowercase kebab-case. Map keys must match `record.id`.
`createAuthoringProject()` creates schema version 2, default project metadata and localization, a null startup hook and entrypoint, empty property declarations, default editor state, and empty collection maps. Collection-specific creation uses
`defaultDataForCollection()` where a typed schema already exists.

### Current settings and validation

Current typed settings include:

- startup init Lua under `settings.startup.initScript`;
- system Layout role references;
- default font;
- title-screen configuration;
- application icon metadata.

The editor-wide Settings tab remains separate from Project Settings. ComfyUI connection/default
workflow preferences are editor settings; project-local workflow files and game/package settings are
project data.

Current validation covers strict V2 schema identity, record IDs and map-key consistency, non-empty labels, strict entrypoint existence, same-type `extends` references and cycles, property declarations and assignments, localization shape, asset aliases, system Layout roles, startup/default-font/title-screen/icon settings, and all component validators currently wired into the project validator. The minimal Phase 3A content shells for later collection slices are strict and do not permit unknown fields.

### Current commands and editor behavior

The current command surface includes generic JSON-patch commands and record operations such as:

```text
project.applyPatch
project.replaceAtPath
project.addAtPath
project.removeAtPath
entity.createRecord
entity.replaceRecord
entity.renameId
entity.duplicateRecord
entity.deleteRecord
entity.updateMetadata
entity.setExtends
```

Record rename rewrites indexed references, deletion performs reference-use preflight, and component
editors use command-backed operations so dirty state, undo, redo, and save remain coherent. The
Project explorer is driven by collection metadata, while project-wide diagnostics feed the workbench
problems surfaces.

`ProjectSettingsEditor` is a distinct workbench utility tab opened from the Project menu or package
export blockers. It edits game metadata, startup, entrypoint, runtime Layout/font defaults,
title-screen settings, and icon data; `SettingsTabEditor` edits application preferences.

### Current runtime and export bridge

The native runtime currently contains `ProjectDocument`, legacy-shaped `ProjectModel`, `GameSession`,
and `RuntimeController`. The editor compiler/export bridge is partial and remains useful scaffolding:

- Room records can be lowered into the current runtime Room representation.
- Dialogue and Scene have transitional export/execution subsets documented in their component docs
  and migration status.
- Asset discovery can include only referenced assets or all project assets by export-profile policy.
- Shader/material metadata is emitted through its dedicated path when required.
- Runtime package options are produced for the native package writer.

These behaviors should be migrated behind the final compiler, not deleted before equivalent typed
paths exist.

### Current files and retained gaps

```text
editor/src/shared/project-schema/authoring-project.ts
editor/src/shared/project-schema/authoring-collections.ts
editor/src/shared/project-schema/editor-project-state.ts
editor/src/shared/project-schema/authoring-validation.ts
editor/src/shared/project-schema/authoring-runtime-export.ts
editor/src/shared/project-schema/authoring-project-settings.ts
editor/src/renderer/project/project-store.ts
editor/src/renderer/project/entity-operations.ts
editor/src/renderer/project/project-settings-operations.ts
editor/src/renderer/editors/project/ProjectSettingsEditor.tsx
engine/include/noveltea/core/project_document.hpp
engine/include/noveltea/core/project_model.hpp
engine/include/noveltea/core/project_validator.hpp
engine/include/noveltea/core/package_export.hpp
```

Retained gaps are the V2 schema cutover, complete semantic compilation, Scene/Dialogue/Interaction
runtime equivalence, compiled Character/Map/Script Module tables, strict project settings, and final
replacement of the partial adapter with one compiler path shared by preview, tests, package export,
and CLI export.
