# Material Entity

## Purpose

Material records bind shader definitions to concrete uniform values, texture sources, blend policy, preview settings, and role-specific usage. Materials are the authoring layer that lets characters, rooms, layouts, text, and runtime UI reuse shader programs safely without duplicating shader interface data.

This document covers the new material authoring component. Legacy shader/material behavior is reference material only.

## Current Status

Materials are implemented as a typed authoring collection in the editor. The Material editor supports shader selection, role selection, inheritance, uniform overrides, texture slots, preview geometry/background, and a live engine preview.

The engine has runtime material metadata parsing under `noveltea.shader-materials.v1`, fallback material definitions, bgfx material binding, and typed material asset loading. Export builds shader/material metadata from authoring shader and material records.

## Collection

Material records live at:

```json
/materials/{materialId}
```

The record uses the standard authoring record wrapper. Material-specific data lives in `record.data`.

```ts
interface MaterialData {
  kind: 'material';
  displayName?: string;
  shader: { $ref: { collection: 'shaders'; id: string } } | null;
  role: ShaderRole;
  blend: 'premultiplied-alpha';
  uniforms: MaterialUniformOverride[];
  textures: MaterialTextureData[];
  preview: {
    geometry: 'quad' | 'rounded-rect' | 'sprite' | 'glyphs';
    background: 'transparent' | 'checker' | 'dark' | 'light';
  };
}
```

## Identity Rules

Material IDs use the project entity ID format:

```text
lowercase kebab-case, starts with a letter, contains only letters, numbers, and hyphens
```

Examples:

```text
ui-panel
iris-sprite
room-background-glow
```

Uniform override names must match uniforms declared by the referenced shader. Texture sampler names must match samplers declared by the referenced shader.

## High-Level Model

A material selects one shader and one role, then supplies values for the shader interface. Uniform overrides provide concrete values. Texture assignments bind shader samplers to asset refs, aliases, or URIs. The blend mode is currently fixed to premultiplied alpha.

Materials can inherit from another material through the explicit material-domain field `data.baseMaterialId`. This is resource composition, not gameplay-definition `extends` and not a generic record relationship. Resolved material data merges base and child material data, with child uniform/texture entries overriding entries with the same uniform or sampler name.

## Data Model

`kind` is always `material`.

`displayName` is an optional authoring/runtime display name.

`shader` is required for a valid material. It may be null while authoring an incomplete material, but validation treats missing shader as an error.

`role` must be one of the shader roles defined by the shader component.

`blend` currently supports only `premultiplied-alpha`.

`uniforms` is a list of `{ name, value }` overrides.

`textures` is a list of sampler assignments:

```ts
interface MaterialTextureData {
  sampler: string;
  source: MaterialTextureSource;
  filtering: 'clamp-nearest' | 'clamp-linear' | 'repeat-nearest' | 'repeat-linear';
}
```

`preview` controls editor preview geometry and background.

## Texture Sources

A material texture source may be:

```ts
{ $ref: { collection: 'assets', id: 'image-asset' } }
{ alias: 'ui.panel' }
{ uri: 'project:/textures/panel.png' }
```

Asset refs participate in editor reference validation. Aliases and URIs are looser runtime-style sources.

## References

Materials reference shaders with:

```ts
{ $ref: { collection: 'shaders', id: 'shader-id' } }
```

Texture asset references use:

```ts
{ $ref: { collection: 'assets', id: 'texture-asset-id' } }
```

Materials may inherit from another material through `MaterialData.baseMaterialId`:

```ts
{ collection: 'materials', id: 'base-material' }
```

Characters, rooms, layouts, text/active-text systems, and UI components may reference materials where they need custom rendering.

## Defaults

`defaultMaterialData()` creates a material with:

- kind `material`;
- display name from the record label;
- optional shader ref if a shader ID is provided;
- role `engine-2d`;
- blend `premultiplied-alpha`;
- no uniform overrides;
- no texture assignments;
- preview geometry `quad`;
- preview background `checker`.

## Validation

Material validation checks:

- `record.data` parses as `MaterialData`;
- material references a shader;
- referenced shader exists;
- referenced shader data is valid;
- selected material role is supported by the shader;
- material inheritance targets another material;
- inherited material exists;
- duplicate uniform override names;
- uniform overrides target declared shader uniforms;
- uniform override values match declared shader uniform types;
- duplicate texture sampler assignments;
- texture assignments target declared shader samplers;
- texture asset refs exist;
- texture asset data is valid;
- non-image texture assets produce warnings.

Inheritance cycle detection is handled by generic project validation and by material resolution diagnostics.

## Command Behavior

Material-specific commands include:

- `material.replaceData` for validated full data replacement;
- `material.setBase` for setting or clearing the explicit base material.

Generic entity commands handle creation, rename, deletion, metadata updates, duplication, and gameplay-definition `extends` where supported. Material inheritance remains a material-specific command and schema field.

`resolveMaterialData()` follows `data.baseMaterialId` and merges inherited material data before preview/export. Uniforms and textures are keyed by `name` and `sampler` respectively during merge.

## Editor Behavior

The Material editor shows the selected material, inherited data diagnostics, shader/role controls, uniforms, textures, preview options, and an embedded engine preview.

Material inheritance is edited through a material-only inheritance selector. Invalid inheritance targets are rejected by operation-level diagnostics.

The editor uses `material.replaceData` for data edits and updates preview data through the shader/material project builder.

## Editor Preview

Material preview uses `buildMaterialPreviewDocumentData()` and the shared `noveltea.shader-materials.v1` metadata. The preview payload includes:

- generated shader/material metadata;
- diagnostics from shader/material conversion;
- target material ID;
- preview geometry/background settings.

The revision includes material data, referenced shader data, and texture dependency revisions so the preview can refresh when dependencies change.

## Runtime Status

Native runtime material types include:

- `MaterialId`;
- `MaterialTextureSampler`;
- `MaterialBlendMode`;
- `MaterialUniformAssignment`;
- `MaterialTextureAssignment`;
- `MaterialDefinition`;
- `ShaderMaterialProject`;
- parser diagnostics and fallback material factories.

The bgfx renderer has a material binder and typed asset loader for material definitions. Runtime material loading depends on shader program loading and texture resolution.

## Export / Package Status

`buildShaderMaterialProject()` converts resolved authoring material records into `noveltea.shader-materials.v1` material metadata. It emits:

- display name;
- selected role;
- shader ID;
- uniform override map;
- texture assignment map;
- blend policy.

Texture sources are converted to runtime strings. Asset refs become `project:/...` paths. Alias sources remain aliases. URI sources remain URI strings.

Runtime package export includes shader/material metadata when shader or material records exist. Referenced material texture assets can be included by asset reference discovery.

## Scripting Status

Materials do not currently define a direct Lua authoring surface. Scripts may eventually select or adjust materials through runtime APIs, but current material records are primarily authoring/rendering data.

Standard shader input bindings should be preferred for runtime-provided values instead of script-updated uniform state.

## Relationship To Other Entity Types

Materials depend on shaders. Material textures may depend on image assets or resource aliases. Layouts can declare material dependencies. Characters use material overrides on poses and expressions. Rooms use a material override for backgrounds. Future text/active-text and RmlUi components may use materials for effects and decorators.

## Legacy Reference Notes

The legacy editor shader widget and bundled shader resources provide workflow and visual-effect reference. They do not define a new engine material schema.

The new engine separates shader declarations from material instances and uses explicit runtime metadata. Old SFML-era assumptions should not leak into this component.

## Recommended Authoring Patterns

Create reusable base materials for common shader settings, then inherit and override uniforms/textures for specific characters, rooms, or UI elements.

Keep material roles aligned with where the material will be used. A character sprite material should normally use an `engine-2d`-compatible shader; an RmlUi decorator material should use the appropriate RmlUi role.

Use direct asset refs for texture sources that should participate in reference validation and package inclusion. Use aliases only when runtime indirection is intentional.

## Current Implementation Files

Primary editor files:

```text
editor/src/shared/project-schema/authoring-materials.ts
editor/src/shared/project-schema/shader-material-project.ts
editor/src/renderer/editors/materials/MaterialEditor.tsx
editor/src/renderer/project/shader-material-operations.ts
editor/src/renderer/commands/builtin-commands.ts
```

Primary engine files:

```text
engine/include/noveltea/render/material.hpp
engine/include/noveltea/render/shader.hpp
engine/src/render/material.cpp
engine/src/render/bgfx/bgfx_material_binder.cpp
engine/src/render/bgfx/bgfx_typed_asset_loader.cpp
engine/src/render/bgfx/bgfx_shader_loader.cpp
engine/src/render/bgfx/bgfx_shader_program_cache.cpp
```

Related docs:

```text
docs/rendering/plans/SHADER_MATERIAL_PLAN.md
docs/rendering/RENDERING_STACK.md
docs/engine/SHADER.md
```

Useful legacy references:

```text
refs/NovelTea/src/editor/Widgets/ShaderWidget.cpp
refs/NovelTea/res/pixelate.frag
refs/NovelTea/res/wave.vert
```

## Known Gaps

- Blend policy is currently limited to premultiplied alpha.
- Material inheritance exists, but advanced inheritance UI and conflict visualization can improve.
- Runtime mutation of material uniforms/textures from scripts is not yet a documented contract.
- Preview coverage is strongest for simple material swatches and should expand for role-specific use cases.

## Future Work

- Add more blend/render-state policies when the renderer needs them.
- Add richer material thumbnails and role-specific preview fixtures.
- Add optional script/runtime APIs for material parameter changes if gameplay needs them.
- Expand package validation around missing compiled shaders, missing textures, and alias resolution.

## Verification

This doc was written from the current material authoring schema, material validation/resolution helpers, shader/material project builder, Material editor, material operation helpers, and native material/render headers. No build is required for this documentation-only change.
