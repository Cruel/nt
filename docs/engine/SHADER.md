# Shader Entity

## Purpose

Shader records define runtime-safe shader metadata for NovelTea projects. They describe source stages, compiled platform variants, uniform declarations, sampler declarations, role compatibility, and standard engine input bindings.

This document covers the new shader authoring component. Legacy shader editor behavior and bundled GLSL examples are reference material only.

## Current Status

Shaders are implemented as a typed authoring collection in the editor. The Shader editor supports inline stage source, source-asset references, interface declarations, roles, compiled output metadata, helper compile actions, and a live material-style preview.

The engine has runtime shader/material metadata types and parsers under `noveltea.shader-materials.v1`, bgfx shader loading and program caching, and shader compiler/manifest support. Platform shader compilation remains a package/build workflow rather than runtime compilation on all targets.

## Collection

Shader records live at:

```json
/shaders/{shaderId}
```

The record uses the standard authoring record wrapper. Shader-specific data lives in `record.data`.

```ts
interface ShaderData {
  kind: 'shader';
  displayName?: string;
  stages: ShaderStageData[];
  uniforms: ShaderUniformData[];
  samplers: ShaderSamplerData[];
  roles: ShaderRole[];
  roleBindings: ShaderRoleBindingData[];
}
```

## Identity Rules

Shader IDs use the project entity ID format:

```text
lowercase kebab-case, starts with a letter, contains only letters, numbers, and hyphens
```

Examples:

```text
simple-tint
active-text-glow
rmlui-noise-panel
```

Shader uniform and sampler names are shader-language-facing names. They must be non-empty and should match the names expected by the shader source and material assignments.

## High-Level Model

A shader record is authoring metadata for one logical shader definition. It may contain vertex and fragment stage source, compiled binaries by variant, uniforms, samplers, supported roles, and optional role bindings.

Shader records do not directly define textures or uniform values for a game object. Materials bind concrete uniform values and textures to a shader.

## Data Model

### Roles

Shader roles currently include:

```text
engine-2d
active-text
rmlui-decorator
rmlui-filter
postprocess
```

Roles describe where a shader is compatible. Materials select one role and must reference a shader that supports that role.

### Stages

A stage has:

```ts
interface ShaderStageData {
  stage: 'vertex' | 'fragment';
  sourceMode: 'asset' | 'inline';
  sourceAsset?: { $ref: { collection: 'assets'; id: string } } | null;
  sourceText?: string;
  compiled: Record<string, string>;
}
```

Inline stages store `sourceText` directly. Asset stages point to an asset record, usually of kind `shader-source`. Compiled outputs map variant names to compiled binary paths.

### Uniforms

A uniform declaration has:

```ts
interface ShaderUniformData {
  name: string;
  type: 'float' | 'vec2' | 'vec3' | 'vec4' | 'color' | 'int' | 'bool';
  default?: unknown;
  range?: [number, number];
  label?: string;
  binding?: ShaderInputBinding | null;
}
```

Supported standard input bindings are:

```text
engine.time
engine.paint_dimensions
engine.reference_to_world_raster_scale
engine.context_logical_to_ui_raster_scale
engine.ui_media_query_resolution
engine.viewport_pixel_dimensions
engine.pointer_position
engine.pointer_valid
rmlui.paint_dimensions
rmlui.context_logical_to_ui_raster_scale
rmlui.media_query_resolution
rmlui.viewport_pixel_dimensions
```

Bound uniforms are intended to receive standard runtime inputs instead of manually authored material values. Scale and size bindings are domain-specific:

- `engine.reference_to_world_raster_scale` is a `vec2` conversion from project reference coordinates to the current world raster.
- `engine.context_logical_to_ui_raster_scale` is a `vec2` conversion from the active logical UI context to native UI raster pixels.
- `engine.ui_media_query_resolution` is the actual scalar UI media-query resolution in dppx.
- `engine.viewport_pixel_dimensions` is the actual fitted game viewport size in pixels as a `vec2`.
- The `rmlui.*` forms expose the decorator's own context-logical-to-UI-raster scale, media-query resolution, viewport pixel dimensions, and paint dimensions. They never derive UI density from the world raster scale.

The former `engine.dpi_scale` and `rmlui.dpi_scale` bindings are not accepted because they did not identify a coordinate or raster domain.

### Samplers

A sampler declaration has a name and currently supports `texture2d`.

### Role Bindings

Role bindings may specify role-specific vertex/fragment shader references. If no explicit bindings exist, the shader's `roles` array is used as the runtime role declaration.

## References

Shader references use:

```ts
{ $ref: { collection: 'shaders', id: 'shader-id' } }
```

Shader stage source assets use:

```ts
{ $ref: { collection: 'assets', id: 'shader-source-asset-id' } }
```

Materials reference shaders directly. Role bindings can also reference shader records.

## Defaults

`defaultShaderData()` creates a simple `engine-2d` shader with inline vertex and fragment stages.

The default vertex stage passes position, texcoord, and color through bgfx-style shader inputs. The default fragment stage declares `uniform vec4 u_tint` and outputs `v_color0 * u_tint`.

The default uniform list contains:

```ts
{ name: 'u_tint', type: 'color', default: [1, 1, 1, 1], label: 'Tint' }
```

The default roles list is:

```ts
['engine-2d']
```

## Validation

Shader validation checks:

- `record.data` parses as `ShaderData`;
- duplicate stage kinds;
- asset source mode requires a source asset;
- source asset exists;
- source asset data is valid;
- non-`shader-source` stage source assets produce warnings;
- duplicate uniform names;
- uniform default value compatibility;
- uniform range minimum is not greater than maximum;
- duplicate sampler names;
- at least one supported role.

Uniform value compatibility accepts numbers for `float`, integer numbers for `int`, booleans for `bool`, fixed-length numeric arrays for vector types, and either RGBA arrays or `{ r, g, b, a }` objects for colors.

## Command Behavior

Shader-specific commands include:

- `shader.replaceData` for validated full data replacement;
- `shader.applyCompiledOutputs` for writing compiled output paths into matching stage `compiled` maps.

Generic entity commands handle creation, rename, duplication, metadata edits, parent assignment, and deletion. Shader deletion should be preflighted through the reference index because materials may reference the shader.

## Editor Behavior

The Shader editor exposes source stages, shader interface metadata, role declarations, compiled outputs, helper compile action, and preview. It opens shader compiler diagnostics in the bottom panel when compile is triggered.

Shader source may be inline or asset-backed. Asset-backed source preserves inline text so users can switch back without losing draft text.

The editor keeps shader authoring metadata separate from material instance values. A shader preview is generated by building temporary shader/material preview document data.

## Editor Preview

Shader preview uses `buildShaderPreviewDocumentData()` and the `noveltea.shader-preview.v1` preview schema. The preview payload includes:

- the generated shader/material metadata project;
- shader/material diagnostics;
- the shader ID;
- a generated preview material ID;
- internal RML/RCSS template paths for a square preview;
- preview geometry/background settings.

The preview depends on the same shader/material metadata builder used for export-facing metadata.

## Runtime Status

Native runtime shader types include:

- `ShaderId`;
- `ShaderRole`;
- `ShaderStage`;
- `ShaderUniformType`;
- `ShaderInputSemantic`;
- `ShaderStandardInputs`;
- `ShaderStageDefinition`;
- `ShaderUniformDeclaration`;
- `ShaderSamplerDeclaration`;
- `ShaderRoleBinding`;
- `ShaderDefinition`.

The bgfx renderer has shader loader and shader program cache code for runtime resource binding. Shader compilation is not assumed to be available at runtime on every platform; Web and packaged builds rely on precompiled shader variants.

## Export / Package Status

`buildShaderMaterialProject()` converts authoring shaders into `noveltea.shader-materials.v1` metadata. Stage source is emitted either as inline `source_text` or as a `project:/...` source path derived from a shader-source asset. Compiled maps are emitted when present.

Runtime package export includes shader/material metadata when shader or material records exist. It computes required shader binary paths for the selected export shader variants.

Runtime package profiles may strip shader sources from runtime packages while still requiring compiled binaries.

## Scripting Status

Shaders are not directly script-authored at runtime. Scripts may indirectly select or influence materials, layouts, or runtime UI that use shaders. Standard input bindings are intended to reduce the need for scripts to manually feed time, domain-specific raster scales, viewport dimensions, media resolution, or pointer state into shader uniforms.

## Relationship To Other Entity Types

Shaders are used primarily by materials. Shader source may be stored as assets of kind `shader-source`. Layouts, characters, rooms, active text, and RmlUi custom components may use materials whose shaders support the needed role.

## Legacy Reference Notes

Legacy `ShaderWidget` and bundled shader examples such as `pixelate.frag` and `wave.vert` can be used to understand old workflow expectations. They are not a required schema or shader-language compatibility layer.

The new engine uses bgfx shader source/compiled variants and explicit material metadata. It should not assume that runtime GLSL compilation is available everywhere.

## Recommended Authoring Patterns

Declare all uniforms and samplers explicitly. Keep shader roles narrow so invalid material usage can be caught. Prefer standard input bindings for engine-provided values such as time and paint dimensions.

Use asset-backed shader source when the shader is meant to be shared or externally edited. Use inline source for small tests and editor-created shaders.

Ensure compiled output maps are populated for every target variant needed by package export.

## Current Implementation Files

Primary editor files:

```text
editor/src/shared/project-schema/authoring-shaders.ts
editor/src/shared/project-schema/shader-material-project.ts
editor/src/renderer/editors/shaders/ShaderEditor.tsx
editor/src/renderer/project/shader-material-operations.ts
editor/src/renderer/commands/builtin-commands.ts
```

Primary engine files:

```text
engine/include/noveltea/render/shader.hpp
engine/include/noveltea/render/shader_compiler.hpp
engine/include/noveltea/render/shader_manifest.hpp
engine/include/noveltea/render/material.hpp
engine/src/render/shader_compiler.cpp
engine/src/render/shader_manifest.cpp
engine/src/render/material.cpp
engine/src/render/bgfx/bgfx_shader_loader.cpp
engine/src/render/bgfx/bgfx_shader_program_cache.cpp
engine/shaders/bgfx/
```

Related docs:

```text
docs/rendering/plans/SHADER_MATERIAL_PLAN.md
docs/rendering/RENDERING_STACK.md
docs/editor/export/EXPORT_AND_PACKAGING.md
```

Useful legacy references:

```text
refs/NovelTea/src/editor/Widgets/ShaderWidget.cpp
refs/NovelTea/src/editor/Widgets/ShaderWidget.hpp
refs/NovelTea/res/forms/ShaderWidget.ui
refs/NovelTea/res/pixelate.frag
refs/NovelTea/res/wave.vert
```

## Known Gaps

- Shader compile workflow still depends on helper tooling and platform variants.
- The editor can record compiled output paths, but package/runtime handling must continue to mature around variant manifests.
- Role binding behavior is represented in schema but should be expanded as real role-specific shader composition is implemented.
- Shader diagnostics are schema/interface diagnostics; shader compiler diagnostics are a separate bottom-panel/tooling path.

## Future Work

- Stabilize shader variant naming and package manifest semantics.
- Expand standard input binding docs as renderer/UI integrations mature.
- Add role-specific preview fixtures for active text, RmlUi decorators, filters, and postprocess shaders.
- Improve validation between declared shader interface and compiled source reflection if feasible.

## Verification

This doc was written from the current shader authoring schema, shader/material project builder, shader editor, shader operation helpers, and native shader/render headers. No build is required for this documentation-only change.
