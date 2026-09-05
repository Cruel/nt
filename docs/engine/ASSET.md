# Asset Entity

## Purpose

Asset records describe imported project resources such as images, fonts, audio, scripts, shader sources, text/data files, and opaque binary files. Assets provide stable IDs, safe project-relative source paths, aliases, metadata, and preview information used by the editor and later runtime/package export.

This document covers the new authoring asset model. It does not describe the old NovelTea asset manager as a compatibility contract.

## Current Status

Assets are implemented as a typed authoring collection in the editor. The Assets editor can inspect asset metadata, manage aliases, show usage information, request previews/thumbnails, reimport asset metadata, and block deletion when references or alias usages exist unless forced. Image Asset details also inspect intrinsic metadata directly from the current source bytes through the active Project-session Asset authority; exhaustive embedded metadata is editor inspection state and is not copied into the Project document.

The engine has a runtime `AssetManager` with namespace mounting, project/system/cache-style logical
paths, typed loader bindings, asynchronous request/prefetch orchestration, residency accounting, and
resource alias resolution. Prepared font, texture, shader-program, material, and audio resources are
published as leases; the old synchronous prepared-resource facade is not a compatibility surface. The
editor authoring asset records are converted into package file entries during export; runtime alias
metadata is still a separate lower-level system.

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

Image assets additionally carry `sampling`, with `linear` as the authored/runtime default and
`nearest` for pixel art. New image imports write the default explicitly, older records that omit the
field resolve as `linear`, and reimport preserves the authored choice.

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

Assets are normally created by import rather than by generic empty entity creation. `assetDataFromImportMetadata()` creates data from import metadata and preserves fields such as kind, project-relative path, aliases, image sampling, MIME type, extension, size, hash, import timestamp, original name, original path, and preview thumbnail revision.

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

The Assets editor shows metadata, aliases, stable reference usages, alias usages, deletion safety information, and an asset preview panel. Image records also expose a Linear/Nearest sampling control. Alias management is local to the asset editor, with explicit assign/remove/rename operations.

The noncompact Asset preview asynchronously requests embedded-media metadata by Project session and Asset identity only. Main reuses the original-Asset containment, regular-file, byte-size, and SHA-256 authority before parsing. Image inspection normalizes useful image-container properties, PNG textual chunks, JPEG comments, parsed TIFF/EXIF fields, complete XMP packets, binary descriptors for embedded ICC/IPTC/Photoshop/gain-map payloads, and bounded C2PA/JUMBF assertions into ordered namespace groups with deterministic structural identities. Textual values that are valid JSON are identified for structured display, and parsed results are cached by content hash. Unsupported Asset kinds, empty metadata, trust/source failures, partial extraction, and loading are explicit UI states. The embedded metadata section remains separate from import/reimport bookkeeping such as original filename, MIME type, and import time.

C2PA recognition is conservative and separate from raw metadata extraction. Known OpenAI claims may identify provider `OpenAI` and model `gpt-image` when the claim generator and creation action provide that evidence; known Google claims may identify `Google Generative AI` and a later `SynthID` edit without inventing a model name. Recognition records stable provider/tool/model IDs and may retain multiple provenance stages. The built-in parser does not perform cryptographic C2PA verification, so its trust state is explicitly `unverified`; the UI may summarize such embedded claims but must not call them verified. A future validating backend can upgrade the trust state without changing the renderer-facing provenance shape.

ComfyUI identification and semantic recognition are deliberately separate. API-shaped `prompt` metadata and recognized ComfyUI UI-workflow shapes can identify the presence of ComfyUI workflow metadata without claiming that ComfyUI generated the media. Generation semantics are interpreted only from executed PNG `prompt` graphs carrying the fixed NovelTea-owned `noveltea.*` markers, with a narrow marked API-graph fallback for `workflow`. The executed graph is preferred when both are embedded, while both values remain independently visible as raw metadata. Recognized prompt and negative prompt are presented prominently and copyably; long values are compact by default and expandable. Marked model, seed, steps, CFG, width, and height may become compact generation facts. `noveltea.model` marks the node containing the primary generation-model identifier; bundled Flux 2 Klein workflows use it on their UNET loader. Unmarked third-party ComfyUI graphs are not traversed heuristically for prompts or models.

The initial audio-inspection path supports MP3 Assets through the same Project-session Asset authority and normalized metadata contract. It exposes ID3v2.3/v2.4 text frames (including exact `TXXX:<description>` names), retains non-text or otherwise undecoded ID3 frames as binary descriptors instead of dropping them, detects JSON-valued user text such as embedded ComfyUI `prompt` and `workflow` payloads, and reports MPEG codec/version/layer/sample rate/channels/average bitrate/duration properties from parsed audio frames. Generic ComfyUI workflow presence in audio is identified only as workflow metadata; it does not create generation provenance or introduce an audio-specific `noveltea.*` semantic vocabulary. Recoverable malformed ID3 data yields the successfully decoded metadata plus a partial-decode warning.

The exhaustive inspector is read-only and designed for metadata-heavy files. Groups stay visible while a compact filter matches namespace, exact key/tag, and textual values. Rows remain single-line until an expandable value is selected; ordinary text then uses a bounded scrollable region, while JSON is pretty-printed into a read-only vertically resizable textarea with internal scrolling. Expanded values expose Copy without placing permanent actions on every collapsed row. Binary fields remain represented as type/byte-size descriptors rather than byte dumps. Individual decoded text values are capped at 8 MiB and aggregate decoded text returned to the renderer is capped at 16 MiB; entries beyond those limits remain present as stable rows with byte size and limit reason instead of being silently dropped. EXIF decoding reserves a conservative budget before allocating text or numeric arrays, including repeated references to the same payload; oversized values remain descriptors even when their encoded bytes are small. Partial-decode and aggregate-limit conditions are explicit normalized warnings.

Asset-detail workbench tab state owns metadata-viewer presentation state rather than Project content. It captures the outer Asset-editor scroll plus metadata filter text, prompt/negative-prompt expansion, expanded metadata item IDs, each expanded viewer's inner scroll position, and resized JSON textarea heights. Metadata-specific state is tagged with the Asset content hash and is restored only when that hash still matches; a changed Asset revision discards the nested metadata state while general Asset-tab state such as outer scroll can still restore independently. Outer scroll restoration stays pending until asynchronous metadata and restored viewer heights have rendered; wheel, touch, pointer, or keyboard interaction cancels the pending restoration. Metadata item IDs are structural and deterministic for identical bytes, so restored expansion and scroll state do not depend on display labels.

The editor distinguishes stable `$ref` usages from string alias usages. Delete warnings include both kinds.

The asset preview surface uses the PreviewManager thumbnail request path where possible. Asset kind determines what preview behavior can eventually be shown; not every asset kind has a rich preview yet.

## Editor Preview

Asset preview is represented by `AssetPreview`. It asks the preview manager for thumbnails and uses asset metadata such as dimensions, duration, kind, and content hash where available. The full Asset preview also hosts the read-only embedded metadata inspector; compact Asset cards continue to use the thumbnail contract and do not request embedded metadata.

Other component preview builders include asset metadata in their preview payloads so the engine preview can resolve image/font/script/material dependencies.

## Runtime Status

The native runtime `AssetManager` supports:

- mounting named asset sources;
- mounting directories;
- mounting indexed ZIP package sources;
- opening logical paths;
- reading binary and text data;
- checking existence and namespaces;
- describing mounts;
- typed loader bindings for fonts, textures, shader programs, materials, and audio;
- asynchronous typed `request_*()` and speculative `prefetch_*()` entry points;
- owner-thread publication and lookup of residency-managed `AssetLease<T>` values;
- resource-alias resolution into typed requests.

Image preparation can retain one-bit source-alpha occupancy beside the shared texture lease when a
sprite-alpha hotspot requires it. The exact CPU charge is `ceil(width / 8) * height`; it is prepared
once per source texture generation, shared by every owner using that texture, and evicted with the
texture residency.

Custom hotspot highlighting uses a typed owner-derived binary `R8` mask request. Preparation
rasterizes the owner-union rectangles at source texel centers through the existing worker/cooperative
executor, request coalescing, prefetch, reservation, telemetry, owner-thread bgfx finalization,
mandatory publication, and eviction paths. Distinct owners may share one source texture while
retaining different masks. CPU hit testing remains analytic and does not read the generated mask.

Runtime logical paths are handled by `AssetPath` and `AssetSource` implementations. The authoring asset source path is not itself a runtime path until export/preview translates it.

Production consumers do not synchronously prepare typed resources. Mandatory world/material/Layout
and runtime-audio publication retains the required leases; missing leases remain loading failures or
cause rollback. ActiveText and editor-preview audio use asynchronous request handles. `MemoryAssetSource`
is retained for tests and explicit tooling fixtures, not for expanding production `.ntpkg` files.

Compiled image sampling is carried into typed texture requests and draw commands. Linear typed image
loads generate a complete RGBA8 mip chain when the image has more than one texel; nearest loads keep
only the base level. Material draws preserve the material's clamp/repeat address mode while using the
image asset's linear/nearest filter.

## Focused editor preview staging

Room, Layout, and Shader focused documents carry an explicit manifest containing only consumed
authoring Assets and compiled Shader outputs. The editor-facing entry separates the privileged
project-relative fetch path from the native logical `project:/` mount path. Every response is bounded
while streaming, checked against declared length when present, checked for exact bytes and SHA-256,
and written into a project-instance/generation namespace only after verification.

Logical links for a candidate generation publish as one rollback-capable transaction. Failure restores
the previous committed links; success removes resources omitted by the new manifest. Native apply
starts only after staging commits, and typed leases remain owned by the committed focused presenter.
Ordinary Assets and compiled Shader outputs keep distinct source kinds so authoring source paths are
never confused with generated runtime Shader paths.

Focused font entries retain both the authoring Asset ID used as the family alias and the staged
logical source path. The font cache key includes that direct path, and the text loader can register a
private runtime family from it without requiring separately published project font configuration.
This keeps focused Layout and Room fonts inside the same candidate/commit/rollback lease lifecycle as
textures, materials, and Shader programs.

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

Alpha occupancy and custom hotspot masks are runtime-derived residency, not package files or
authoring assets. They are never exported, written to the filesystem, or retained in a
cross-generation content cache.

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
editor/src/shared/runtime-artifact-preparation.ts
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
- Runtime resource aliases remain a lower-level registry rather than a unified authoring/runtime
  alias model.

The lower-level manifest is nevertheless strict: `resources/aliases.json` must use
`noveltea.resource-aliases` version 1, a wrapped `resources` object, and object-valued audio,
texture, and material entries. Unwrapped roots, string shorthand, alternate field names, and
noncanonical enum casing are rejected as unsupported shapes.

## Future Work

- Stabilize alias export semantics for textures, audio, materials, and layout dependencies.
- Expand preview generation for fonts, audio, text, shaders, and binary/data assets.
- Document exact package manifest entries once package format stabilizes.
- Add migration notes for importing legacy projects into new asset records when that importer is intentionally scoped.

## Verification

This doc is reconciled with the current asset schema, export/package pipeline, asynchronous runtime
request/residency API, lease-only prepared-resource consumers, and permanent source-policy test.
