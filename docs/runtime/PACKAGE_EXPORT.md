# Runtime Package Export

Phase 13 defines the v1 runtime package as a ZIP-based `.ntpkg` file. The public API is
`noveltea::core::ProjectPackageWriter`; ZIP/miniz details stay private to the implementation.

## Layout

Runtime packages use the existing runtime-compatible entry layout:

- `game`: normalized runtime game schema, derived from the editor project schema and stripped of authoring-only data.
- `image`: optional package cover image.
- `fonts/*` and `textures/*`: project font and texture assets.
- `audio/`, `data/`, `music/`, `resources/`, `scripts/`, `sounds/`, `text/`, and `texts/`: safe auxiliary project resources.
- `shaders/bgfx/<variant>/*.bin`: compiled bgfx shader variants for supported targets.
- Runtime shader/material metadata: shader interface records, material records, generated binary references, and binding metadata needed to run material-backed content.
- `manifest.json`: additive NovelTea metadata.

Runtime game packages should not include shader source text, editor shader-preview data, or shader compilation cache data unless explicitly exporting an editable/dev package. Materials are runtime schema records, not standalone material files.

Entry paths must be relative, slash-separated, non-empty, and must not contain `.`, `..`,
backslashes, duplicate separators, absolute roots, or namespace-style colons.

## Manifest

`manifest.json` uses format `noveltea.runtime-package` with `format_version` 1. It records package
kind, creator, project name/version, included shader variants, package entries, and stable
per-entry checksums when checksum generation is enabled. It may also record which runtime shader
metadata set is included. The manifest is additive metadata; current runtime loading still consumes
exported packages through the legacy-compatible package fallback.

## Editor Hook

Editor-facing tooling should call `core::editor::ProjectTooling::export_project_package()`. The
result includes success, diagnostics, byte count, manifest JSON, and checksum summary without
exposing archive-library types.
