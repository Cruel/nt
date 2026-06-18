# Core Domain Package Reader Slice

Date: 2026-06-18

## Files inspected

- `refs/NovelTea/include/NovelTea/ProjectDataIdentifiers.hpp`
- `refs/NovelTea/include/NovelTea/ProjectData.hpp`
- `refs/NovelTea/src/core/ProjectData.cpp`
- `refs/NovelTea/include/NovelTea/Zip/Zip.hpp`
- `refs/NovelTea/src/core/Zip/Zip.cpp`
- `refs/NovelTea/src/core/Zip/zip.c`

## Compatibility fixes

- `legacy::ProjectImporter` now accepts both old empty array placeholders and object maps for `fonts` and `textures`.
- The importer preserves the original imported `game` JSON shape in `ProjectDocument`; it does not normalize old wire data.
- Scalar `fonts`/`textures` values and non-empty arrays are rejected with messages that include the key and actual JSON kind.
- Validation remains intentionally shallow: root object, required metadata keys, basic metadata/script hook types, entity collection object maps, and selected-entity shape when `entrypoint` exists. Unknown extra keys are allowed, and import does not require an entrypoint.

## Old package layout

Old project packages are ZIP files. `ProjectData::saveToFile()` wrote:

- `game`: JSON text from `ProjectData::toJson().dump()`
- `image`: project image data string
- `fonts/<stored filename>`: one entry per project font map entry; alias is the JSON object key and stored filename is the JSON value
- `textures/<texture key>`: one entry per texture map entry; old code uses the texture object key as the package entry suffix

`ProjectData::loadFromFile()` reads the whole file into memory, opens it as a ZIP stream, reads `game`, imports JSON, then reads font, texture, and image entries. Old `ZipReader::read()` returned an empty string for missing entries.

## ZIP strategy

The new reader uses `miniz` 3.1.1:

- Desktop gets `miniz` from vcpkg via `find_package(miniz CONFIG QUIET)`.
- Web uses a `FetchContent` fallback for the same upstream tag.
- `miniz` is linked privately to `noveltea_core`.
- No ZIP library types appear in public NovelTea headers.
- No old `refs/NovelTea` ZIP source is copied or linked.

## Implemented API

- `noveltea::core::legacy::ProjectPackageReader`
- `noveltea::core::legacy::ProjectPackage`
- `noveltea::core::legacy::PackageError`

The public API accepts `std::span<const std::byte>`, `std::span<const std::uint8_t>`, or a `std::filesystem::path`. It extracts `game`, `image`, `fonts/*`, and `textures/*`, ignores unrelated entries, and feeds `game` into `ProjectImporter`.

## Deferred

- ZIP writing remains deferred.
- Old `Game`, `Context`, save/profile behavior, concrete entity loading, scripting runtime behavior, renderer/UI/state code, SFML, and Qt remain out of scope.
- Entity/schema validation beyond shallow project shape is still a later validation layer.

## Verification

- `cmake --preset linux-debug`: passed.
- `cmake --build --preset linux-debug`: passed.
- `ctest --test-dir build/linux-debug --output-on-failure`: passed 78/78.
- `cmake --preset web-debug`: passed.
- `cmake --build --preset web-debug`: passed with the existing Emscripten SDL3 experimental warning.
