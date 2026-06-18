# Core Domain Import Slice

Date: 2026-06-18

## Files inspected

- `refs/NovelTea/include/NovelTea/ProjectDataIdentifiers.hpp`
- `refs/NovelTea/include/NovelTea/ProjectData.hpp`
- `refs/NovelTea/src/core/ProjectData.cpp`
- `refs/NovelTea/include/NovelTea/Entity.hpp`
- `refs/NovelTea/src/core/Entity.cpp`
- `refs/NovelTea/include/NovelTea/json.hpp`
- `refs/NovelTea/src/core/json.cpp`
- `refs/NovelTea/include/NovelTea/Zip/Zip.hpp`
- `refs/NovelTea/src/core/Zip/Zip.cpp`
- `refs/NovelTea/src/core/Zip/zip.c`

## Implemented

- `noveltea_core` now explicitly requires C++20 and links `nlohmann_json::nlohmann_json`.
- `EntityType::CustomScript` is treated as a known selected-entity type but not as a project-backed entity collection.
- `entity_type_collection_key()` now returns `std::optional<std::string_view>` and returns no collection for `Invalid` and `CustomScript`.
- `EntityRef` remains the old `[type, id]` selected-entity array. It rejects malformed arrays, unknown type integers, non-integer type values, and non-string ids. `CustomScript` with non-empty inline script text is structurally valid because old `Entity::fromEntityJson()` constructs a script object directly from the id/content string.
- `ProjectDocument::new_project()` is documented as a normalized new in-memory model using old-compatible key names. It is not exact legacy wire output.
- `noveltea::core::legacy::ProjectImporter` imports old `game` JSON text/object data with `nlohmann::json`, preserves the original key names and collection data, and returns structured errors instead of throwing across the public API.

## Legacy `game` JSON findings

`ProjectData::newProject()` built a root object with:

- number: `engine`
- strings: `name`, `version`, `author`, `website`, `fontDefault`, script hook fields such as `sba`, `sua`, `sbl`, `sbe`
- arrays: `fonts`, `startInv`, `tabs`, `textures`, `systemShaders`
- objects: `shaders`, `sysfonts`

Entity collections are stored as object maps under old keys: `action`, `cutscene`, `dialogue`, `map`, `object`, `room`, `script`, and `verb`.

## Old package layout

Old project save/load used a ZIP container:

- `game`: JSON text produced by `ProjectData::toJson().dump()`
- `image`: project image data string, written even when empty
- `fonts/<stored filename>`: for every project font entry, save iterated `j[ID::projectFonts].ObjectRange()` and wrote the font data keyed by alias but named by the JSON value
- `textures/<texture key>`: for every texture entry, save iterated `j[ID::textures].ObjectRange()` and wrote data by texture key

Load reads the full package into memory, opens it as a ZIP stream, reads `game`, then conditionally reads font, texture, and image entries. Missing ZIP entries return an empty string in the old reader.

## Deferred package reader

No ZIP reader was added in this slice. The old tree uses bundled `zip.c`, but directly copying or linking it would add another third-party surface to `noveltea_core`. Recommended next slice: choose a small read-only ZIP dependency or isolate a minimal reader behind `noveltea::core::legacy::ProjectPackageReader`, return the `game` entry as text, and feed it into `ProjectImporter`.

## Verification

- `cmake --preset linux-debug`: passed.
- `cmake --build --preset linux-debug`: passed.
- `ctest --test-dir build/linux-debug --output-on-failure`: passed 72/72.
- `cmake --preset web-debug`: passed.
- `cmake --build --preset web-debug`: passed with the existing Emscripten SDL3 experimental warning.
