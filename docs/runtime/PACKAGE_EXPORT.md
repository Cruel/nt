# Runtime Package Export

Phase 13 defines the v1 runtime package as a ZIP-based `.ntpkg` file. The public API is
`noveltea::core::ProjectPackageWriter`; ZIP/miniz details stay private to the implementation.

## Layout

Runtime packages use the existing runtime-compatible entry layout:

- `game`: normalized `ProjectDocument` JSON.
- `image`: optional package cover image.
- `fonts/*` and `textures/*`: project font and texture assets.
- `audio/`, `data/`, `music/`, `resources/`, `scripts/`, `shaders/`, `sounds/`, `text/`, and `texts/`: safe auxiliary project resources.
- `shaders/bgfx/<variant>/*.bin`: compiled bgfx shader variants for supported targets.
- `manifest.json`: additive NovelTea metadata.

Entry paths must be relative, slash-separated, non-empty, and must not contain `.`, `..`,
backslashes, duplicate separators, absolute roots, or namespace-style colons.

## Manifest

`manifest.json` uses format `noveltea.runtime-package` with `format_version` 1. It records package
kind, creator, project name/version, included shader variants, package entries, and stable
per-entry checksums when checksum generation is enabled. The manifest is additive metadata; current
runtime loading still consumes exported packages through the legacy-compatible package fallback.

## Editor Hook

Editor-facing tooling should call `core::editor::ProjectTooling::export_project_package()`. The
result includes success, diagnostics, byte count, manifest JSON, and checksum summary without
exposing archive-library types.
