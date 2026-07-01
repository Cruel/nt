# Asset Entity

## Purpose

Asset records describe imported project resources such as images, fonts, audio, scripts, shader sources, text/data files, and opaque binary files. Assets provide stable IDs, safe project-relative source paths, aliases, metadata, and preview information used by the editor and later runtime/package export.

This document covers the new authoring asset model. It does not describe the old NovelTea asset manager as a compatibility contract.

## Current Status

Assets are implemented as a typed authoring collection in the editor. The Assets editor can inspect asset metadata, manage aliases, show usage information, request previews/thumbnails, reimport asset metadata, and block deletion when references or alias usages exist unless forced.

The engine has a runtime `AssetManager` with namespace mounting, project/system/cache-style logical paths, typed loader bindings, and resource alias support for textures, materials, and audio. The editor authoring asset records are converted into package file entries during export; runtime alias metadata is still a separate lower-level system.

## Collection

Asset records live at:

```json
/assets/{assetId}
```

The record uses the standard authoring record wrapper. Asset-specific data lives in `record.data`.

```ts
interface AssetData {
  kind: AssetKind;
  source: {
    type: 'project-file';
    path: string;
  };
  aliases: string[];
  mimeType?: string;
  extension?: string;
  byteSize?: number;
  contentHash?: string;
  importedAt?: string;
  originalName?: string;
  originalPath?: string;
  preview?: {
    thumbnailRevision?: string;
    width?: number;
    height?: number;
    durationSeconds?: number;
  };
}
```

## Identity Rules

Asset IDs use the project entity ID format:

```text
lowercase kebab-case, starts with a letter, contains only letters, numbers, and hyphens
```

Asset IDs generated from filenames normalize the basename, remove accents, lower-case it, replace non-alphanumeric runs with hyphens, and prefix with `asset-` if needed to start with a letter.

Asset aliases use a separate alias format:

```text
starts with a lowercase letter; contains lowercase letters, numbers, dots, underscores, or hyphens
```

Examples:

```text
ui.click
character_iris.neutral
bg-opening
```

Aliases are project-global and must be unique across assets.

## High-Level Model

An asset record does not embed file contents. It points to a safe project-relative source path and stores metadata collected during import or reimport.

The editor uses assets as stable referenced records. Components may reference an asset directly with `$ref`, or they may use an alias string where a looser resource binding is appropriate.

At runtime, the asset manager works through logical asset paths and typed loaders. Export is responsible for copying project asset files into package paths and translating authoring references into runtime-usable paths or metadata.

## Data Model

`kind` is one of:

```text
image
font
audio
script
shader-source
text
data
binary
```

`source` is currently always a project file source. `source.path` must be safe and project-relative.

`aliases` are alternate stable logical names used by reference scanners and some runtime-facing resource workflows.

`mimeType`, `extension`, `byteSize`, `contentHash`, `importedAt`, `originalName`, and `originalPath` are metadata from import/reimport.

`preview` stores thumbnail/media metadata such as revision hash, image dimensions, or audio duration.

## References

Many component schemas reference assets directly with `$ref` objects, for example:

```ts
{ $ref: { collection: 'assets', id: 'opening-background' } }
```

Asset aliases are scanned separately by the authoring asset reference helpers. Alias rename operations rewrite known alias usages across the project.

Direct asset references currently appear in layouts, shader stages, material textures, characters, rooms, scenes, and tests. Additional components should use direct `$ref` records when delete/rename/reference safety matters.

## Defaults

Assets are normally created by import rather than by generic empty entity creation. `assetDataFromImportMetadata()` creates data from import metadata and preserves fields such as kind, project-relative path, aliases, MIME type, extension, size, hash, import timestamp, original name, original path, and preview thumbnail revision.

The import operation creates one authoring record per imported asset with:

- unique asset ID generated from filename;
- label based on filename without extension;
- tag containing the inferred asset kind;
- data produced from import metadata.

## Type Detection

Asset kind is inferred from extension:

- images: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.bmp`, `.svg`;
- fonts: `.ttf`, `.otf`, `.woff`, `.woff2`;
- audio: `.mp3`, `.ogg`, `.wav`, `.flac`, `.m4a`;
- scripts: `.lua`;
- shader sources: `.sc`, `.glsl`, `.vert`, `.frag`, `.vs`, `.fs`;
- text: `.txt`, `.md`, `.rml`, `.rcss`, `.css`;
- data: `.json`, `.toml`, `.yaml`, `.yml`, `.csv`;
- otherwise `binary`.

Asset kind also maps to default project folders such as `assets/images`, `assets/fonts`, `assets/audio`, `assets/scripts`, `assets/shaders`, `assets/text`, `assets/data`, and `assets/binary`.

## Validation

Asset validation currently checks:

- asset data parses as `AssetData`;
- `source.path` is a safe project-relative path;
- aliases are non-empty and match the alias pattern;
- aliases are not duplicated within the asset;
- aliases are not assigned to multiple assets.

Component validators perform kind-specific warnings. For example, character sprite refs and room background refs warn when the target asset is not an image; shader stage source refs warn when the target is not a `shader-source`; layout source refs warn on unexpected extensions or non-text-like asset kinds.

## Command Behavior

Asset-specific commands are command-backed and produce JSON patches:

- `asset.importFiles` adds imported asset records.
- `asset.assignAlias` validates and adds an alias to an asset.
- `asset.removeAlias` refuses removal when alias usages exist.
- `asset.renameAlias` rewrites the alias owner and known alias usages.
- `asset.reimportFile` replaces asset metadata while preserving aliases.
- `asset.deleteAsset` refuses deletion when stable references or alias usages exist unless forced.

Generic entity commands can still update metadata such as label, tags, color, parent, and sort key.

## Editor Behavior

The Assets editor shows metadata, aliases, stable reference usages, alias usages, deletion safety information, and an asset preview panel. Alias management is local to the asset editor, with explicit assign/remove/rename operations.

The editor distinguishes stable `$ref` usages from string alias usages. Delete warnings include both kinds.

The asset preview surface uses the PreviewManager thumbnail request path where possible. Asset kind determines what preview behavior can eventually be shown; not every asset kind has a rich preview yet.

## Editor Preview

Asset preview is represented by `AssetPreview`. It asks the preview manager for thumbnails and uses asset metadata such as dimensions, duration, kind, and content hash where available.

Other component preview builders include asset metadata in their preview payloads so the engine preview can resolve image/font/script/material dependencies.

## Runtime Status

The native runtime `AssetManager` supports:

- mounting named asset sources;
- mounting directories;
- mounting legacy packages;
- opening logical paths;
- reading binary and text data;
- checking existence and namespaces;
- describing mounts;
- typed loader bindings for fonts, textures, shader programs, materials, and audio;
- loading typed resources directly or by alias where supported.

Runtime logical paths are handled by `AssetPath` and `AssetSource` implementations. The authoring asset source path is not itself a runtime path until export/preview translates it.

## Export / Package Status

Authoring export maps asset kinds to package prefixes:

- images to `textures/`;
- fonts to `fonts/`;
- audio to `audio/`;
- scripts to `scripts/`;
- text to `text/`;
- data to `data/`;
- shader source to `resources/shaders/`;
- binary to `resources/`.

Runtime packages can include all project assets or only assets discovered from currently supported references. Runtime package export omits shader source assets when building a runtime package profile that strips shader sources.

## Scripting Status

Assets are indirectly available to Lua through runtime systems that load audio, materials, textures, layouts, and other resources. The asset record itself does not yet define a standalone Lua API. Audio alias resolution is currently exposed through the runtime asset/audio systems where wired.

## Relationship To Other Entity Types

Assets are dependencies for:

- shaders, when stage source is stored in a shader-source asset;
- materials, when texture slots point to image assets;
- layouts, for RML/RCSS/Lua sources and dependency lists;
- characters, for pose and expression sprites;
- rooms, for backgrounds;
- scenes, for backgrounds/audio/etc. as scene support expands;
- scripts, once standalone script records are stabilized;
- package export, which copies asset files into runtime packages.

## Legacy Reference Notes

Legacy reference files `AssetManager.hpp`, `AssetLoader.hpp`, `AssetManager.cpp`, and `AssetLoader.cpp` are useful for understanding old resource loading intent. They should not dictate new authoring asset serialization.

The new engine splits authoring asset records, package/export file entries, runtime logical paths, and typed loader bindings more explicitly than the old engine.

## Recommended Authoring Patterns

Use direct asset references for schema-owned dependencies that should participate in rename/delete safety. Use aliases for stable runtime-like resource names where a component expects a loose resource binding.

Keep imported files under kind-specific asset folders. Reimport rather than replacing IDs when the asset's logical identity should remain stable.

Use content hashes to drive preview thumbnail revisions and export cache invalidation where available.

## Current Implementation Files

Primary editor files:

```text
editor/src/shared/project-schema/authoring-assets.ts
editor/src/shared/project-schema/authoring-asset-references.ts
editor/src/shared/project-schema/authoring-validation.ts
editor/src/renderer/project/asset-operations.ts
editor/src/renderer/editors/assets/AssetEditor.tsx
editor/src/renderer/editors/assets/AssetPreview.tsx
editor/src/renderer/editors/assets/asset-editor-utils.ts
editor/src/renderer/commands/builtin-commands.ts
editor/src/shared/project-schema/authoring-runtime-export.ts
```

Primary engine files:

```text
engine/include/noveltea/assets/asset_manager.hpp
engine/include/noveltea/assets/asset_path.hpp
engine/include/noveltea/assets/asset_source.hpp
engine/include/noveltea/assets/resource_aliases.hpp
engine/include/noveltea/assets/typed_assets.hpp
engine/src/assets/asset_manager.cpp
engine/src/assets/resource_aliases.cpp
engine/src/render/bgfx/bgfx_typed_asset_loader.cpp
engine/src/text/text_asset_loader.cpp
engine/src/audio/audio_system.cpp
```

Useful legacy references:

```text
refs/NovelTea/include/NovelTea/AssetManager.hpp
refs/NovelTea/include/NovelTea/AssetLoader.hpp
refs/NovelTea/src/core/AssetManager.cpp
refs/NovelTea/src/core/AssetLoader.cpp
```

## Known Gaps

- Authoring asset records and runtime resource alias registries are related but not yet unified as one fully documented export/runtime resource model.
- Rich preview support varies by asset kind.
- Import/reimport file copying and thumbnail generation are editor-service concerns and should be documented further with the asset pipeline.
- Runtime packages currently include assets through the partial authoring export adapter, not a complete full-project runtime compiler.

## Future Work

- Stabilize alias export semantics for textures, audio, materials, and layout dependencies.
- Expand preview generation for fonts, audio, text, shaders, and binary/data assets.
- Document exact package manifest entries once package format stabilizes.
- Add migration notes for importing legacy projects into new asset records when that importer is intentionally scoped.

## Verification

This doc was written from the current asset schema, asset validation, asset operations, asset editor files, authoring runtime export code, and runtime asset manager headers. No build is required for this documentation-only change.
