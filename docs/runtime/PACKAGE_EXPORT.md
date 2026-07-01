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
- `shader-materials.json`: runtime shader/material metadata, including shader interface records, material records, generated binary references, and binding metadata needed to run material-backed content.
- `manifest.json`: additive NovelTea metadata.

Runtime game packages include `shader-materials.json` only when material metadata is provided during export. Runtime exports strip shader stage `source`, `source_text`, editor preview data, and compile-cache fields from this metadata. Editable/dev packages may keep authoring fields later, but runtime game packages should only ship runtime-safe metadata plus compiled shader binaries. Materials are runtime schema records, not standalone material files.

Entry paths must be relative, slash-separated, non-empty, and must not contain `.`, `..`,
backslashes, duplicate separators, absolute roots, or namespace-style colons.

## Manifest

`manifest.json` uses format `noveltea.runtime-package` with `format_version` 1. It records package
kind, creator, project name/version, included shader variants, package entries, and stable
per-entry checksums when checksum generation is enabled. If shader/material metadata is included,
`shader_materials.entry` points at `shader-materials.json` and records the schema and whether source
fields were stripped. The manifest is additive metadata; current runtime loading still consumes
exported packages through the legacy-compatible package fallback.

## Editor Hook

Editor-facing tooling should call `core::editor::ProjectTooling::export_project_package()` or the
`noveltea-editor-tool export-package` command. Export options can pass `shaderMaterialMetadata`,
`requiredShaderBinaryPaths`, `shaderAssetRoot`, `shaderVariants`, `assetRoots`, and explicit
`fileEntries`. Required shader paths are validated against the package payload so missing material
variants fail during export instead of silently falling back at runtime. The result includes
success, diagnostics, byte count, manifest JSON, and checksum summary without exposing
archive-library types.

`fileEntries` are the preferred editor-authoring path for referenced assets because they avoid
copying broad project asset directories into runtime packages. Each entry provides an absolute
source file and a runtime package path, for example:

```json
{
  "source": "/project/assets/images/foyer.png",
  "packagePath": "textures/foyer.png"
}
```

The package writer applies the same safe-path and allowed-prefix checks to explicit file entries as
it does to collected asset roots.
