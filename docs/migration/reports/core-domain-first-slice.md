# Core Domain First Slice

Date: 2026-06-18

## Old symbols and files inspected

- `include/NovelTea/ProjectDataIdentifiers.hpp`
  - Defines `NOVELTEA_VERSION` as `1.0f`.
  - Defines stable `NovelTea::EntityType` integer values: `Invalid=-1`, `CustomScript=0`, `Cutscene=1`, `Action=2`, `Room=3`, `Object=4`, `Dialogue=5`, `Script=6`, `Verb=7`, `Map=8`.
  - Defines project metadata keys, entity collection keys, selected-entity array indexes, entity array indexes, shader/texture keys, editor/test keys, and save-data keys.
- `include/NovelTea/ProjectData.hpp` and `src/core/ProjectData.cpp`
  - `ProjectData::newProject()` builds a single JSON object with project metadata, script hook strings, editor tab state, textures, shaders, system shaders, and system fonts.
  - Project package save/load uses a zip container with `game`, `image`, `fonts/*`, and `textures/*`.
  - `isValid()` only checks the entrypoint selected-entity array at index `1` for a non-empty id.
  - Rename behavior touches many domain objects and tests and is too coupled for this slice.
- `include/NovelTea/Entity.hpp` and `src/core/Entity.cpp`
  - Entity JSON is array-shaped with fixed indexes for id, parent id, and properties.
  - Selected entity references use `[type, id]`.
  - Runtime resolution depends on `Context`, `Game`, concrete entity subclasses, save data, `PropertyList`, and Duktape values.
- `include/NovelTea/Game.hpp` and `src/core/Game.cpp`
  - `Game` owns settings, project data, save data, object/property lists, current room/map, entity queue, and script/event/log interactions.
  - Initialization depends on global configuration/macros, asset loader, timer, script manager, save/profile directories, and text log.
- `include/NovelTea/json.hpp` and `src/core/json.cpp`
  - Old JSON is a bespoke `sj::JSON` value/parser/dumper with mutable object/array behavior.
  - It should not be exposed through new renderer/platform APIs.
- `include/NovelTea/SaveData.hpp`
  - Save data is JSON-backed and entity-aware, but load/save/profile behavior depends on `Game`, `Settings`, and old file utilities.
- `include/NovelTea/Settings.hpp`
  - Settings manages profiles and font-size/save flags, but depends on old `ContextObject`, `Profile`, file utilities, and `sj::JSON`.

## Current nt architecture inspected

- `AGENTS.md`
- `docs/migration/PLAN.md`
- `docs/migration/STATUS.md`
- root `CMakeLists.txt`
- `engine/CMakeLists.txt`
- `engine/include/noveltea/assets/*`
- `engine/include/noveltea/script/*`
- `tests/CMakeLists.txt`

The current engine already separates assets, platform, renderer, text, runtime UI, debug UI, and Lua scripting. Tests use Catch2 through `tests/CMakeLists.txt`. The first implementation briefly used a tiny internal JSON value, but that was removed in favor of a contained `nlohmann-json` vcpkg dependency for `noveltea_core` project-document/import APIs.

## Safe to port now

- Stable schema identifiers from `ProjectDataIdentifiers.hpp`.
- `EntityType` integer values.
- The selected-entity reference shape `[type, id]`.
- The old default project metadata/document keys and basic entrypoint requirement.
- Save/editor/test key names as constants only.

## Deferred

- Old `Game`, `Context`, `Subsystem`, `ScriptManager`, Duktape/dukglue values, `PropertyList`, `ObjectList`, save/load/profile behavior, zip package writing, entity rename traversal, SFML renderers, GUI widgets, Qt editor classes, runtime states, and concrete domain entity parsing.
- Full old JSON parser/importer and zip project package reader.
- Scripting migration. The migration plan still records the original "preserve Duktape initially" intent, but current `nt` already has Lua 5.5 plus sol2/sol3-style bindings. This slice deliberately avoids scripting behavior.

## Slice mapping

This slice adds `noveltea_core`, a backend-neutral C++20 target containing:

- `noveltea::core::EntityType`
- `noveltea::core::project_ids`
- `noveltea::core::EntityRef`
- `noveltea::core::ProjectDocument`
- `nlohmann::json` only at the project document and legacy import boundary

`ProjectDocument::new_project()` creates a normalized new in-memory document with old-compatible key names and defaults for metadata, script hook strings, keyed font/texture maps, shaders, editor/test placeholders, and empty entity collections. `ProjectDocument::validate_entrypoint()` intentionally mirrors the old basic rule: missing or empty entrypoint id is invalid; a selected entity with a non-empty id is valid. Exact old `game` JSON import now belongs to `noveltea::core::legacy::ProjectImporter`, which parses with `nlohmann::json`, validates the basic old project shape, reports structured diagnostics, and immediately returns a typed `ProjectDocument`.

## Risks and follow-up

- `ProjectImporter` currently imports old `game` JSON text/object data only. A future package importer must extract `game` from old zip projects and feed this importer without exposing `sj::JSON` broadly.
- Default shader values are placeholders rather than the old embedded GLSL strings because shader behavior is renderer-specific and should remain outside this backend-neutral slice.
- The old `ProjectData::newProject()` used `sj::Array()` for project `fonts` and `textures`. `ProjectDocument::new_project()` deliberately chooses object-shaped font/texture maps for sane domain modeling while preserving key names; `ProjectImporter` preserves exact old wire shapes when reading existing `game` JSON.
- Entity collection contents are empty objects only. Concrete action/cutscene/dialogue/map/object/room/script/verb schemas remain future slices.
- Save/settings constants are available for compatibility, but behavior is intentionally not ported.
