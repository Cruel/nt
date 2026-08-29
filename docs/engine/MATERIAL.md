# Material Entity

## Purpose

Material records bind shader definitions to concrete uniform values, texture sources, blend policy, preview settings, and role-specific usage. Materials are the authoring layer that lets characters, rooms, layouts, text, and runtime UI reuse shader programs safely without duplicating shader interface data.

This document covers the new material authoring component. Legacy shader/material behavior is reference material only.

## Current Status

Materials are implemented as a typed authoring collection in the editor. The Material editor supports shader selection, role selection, inheritance, uniform overrides, texture slots, preview geometry/background, and a live engine preview.

The engine has runtime material metadata parsing under `noveltea.shader-materials`, fallback material definitions, bgfx material binding, and typed material asset loading. Export builds shader/material metadata from authoring shader and material records.

Occurrence-local runtime Material Parameters support typed mutation and query, Property or standard
engine-facet binding, Scene assignment/tweening, and Lua presentation APIs without mutating compiled
Material definitions.

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

Generic entity commands handle creation, rename, deletion, metadata updates, and duplication. Material inheritance remains a material-specific command and schema field; it is unrelated to the retired universal gameplay-definition `extends` relationship.

`resolveMaterialData()` follows `data.baseMaterialId` and merges inherited material data before preview/export. Uniforms and textures are keyed by `name` and `sampler` respectively during merge.

## Editor Behavior

The Material editor shows the selected material, inherited data diagnostics, shader/role controls, uniforms, textures, preview options, and an embedded engine preview.

Material inheritance is edited through a material-only inheritance selector. Invalid inheritance targets are rejected by operation-level diagnostics.

The editor uses `material.replaceData` for data edits and updates preview data through the shader/material project builder.

## Editor Preview

Material preview uses `buildMaterialPreviewDocumentData()` and the shared `noveltea.shader-materials` metadata. The preview payload includes:

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

The bgfx renderer has a material binder and typed asset loader for material definitions. Runtime
material loading depends on shader program loading and texture resolution. Hotspot-overlay materials
use engine-bound image and optional binary-mask samplers plus the standard bounds, hover, pressed,
image-dimension, and mask-dimension uniforms. Material records cannot assign static textures to those
bound samplers; additional unbound sampler assignments remain ordinary mandatory material texture
dependencies. Native package assembly validates alpha and custom hotspot interfaces separately.

The engine also supplies `system/fallback/hotspot_alpha` and
`system/fallback/hotspot_custom` built-in materials backed by renderer-owned, renderer-variant system
shader programs. The alpha built-in derives a moving border/sheen from neighboring source-alpha
samples. The custom built-in samples the source image and binary owner mask, clips the effect to the
active bounds, and derives the same border/sheen from neighboring mask samples. The material binder
has a system-material path that uses these owned program handles without requiring package material
or shader-program leases.

### Occurrence-local Material Parameters

Compiled Material resources remain immutable. Runtime mutation is represented separately as typed
Desired Presentation State attached to one concrete presentation occurrence: background, actor
pose/expression, presentation prop, environment, mounted Layout Material dependency, or postprocess
effect. Two occurrences using the same Material therefore do not share mutable uniform state.

The authoring compiler publishes a compact Material interface for runtime validation. Each exposed
parameter records its uniform name, declared type, and optional renderer binding. Occurrence-local
writes must name a declared uniform, match its exact type and compatible Material role, belong to a
live owner/occurrence, and target a uniform that is not renderer-bound. Renderer-owned bindings remain
authoritative and cannot be overwritten by occurrence state.

A parameter contains either a concrete typed value or one explicit binding, never both. Bindings can
reference a compatible Property or one standard engine facet (`occurrence-time`, paint width/height,
viewport width/height, or camera zoom). Once bound, the binding is the sole authority until it is
explicitly removed or replaced; a direct assignment does not silently break the binding. Material
time uses either gameplay or unscaled-presentation clock policy.

Scene `material-parameter` steps support immediate assignment and finite tween operations. A tween
requires an existing occurrence-local concrete source value, commits its desired target before
realization begins, carries typed easing/clock/skip/completion metadata, and never exposes backend
tween progress as authoritative state. Boolean and integer parameters are not interpolated.

Mounted RmlUi Layout occurrences receive their own Material parameter set. The currently admitted
custom Material shader integration realizes occurrence-local `rmlui-decorator` parameters per RmlUi
context. `rmlui-filter` remains a valid Material resource role, but occurrence-local filter-parameter
control is intentionally not admitted until the RmlUi backend has a corresponding custom filter
Material provider.

### Postprocess Effects

Postprocess effects are stable owner-scoped Desired Presentation State, not an arbitrary render graph.
Each instance selects a `postprocess` Material, a `world` or `full-game-viewport` scope, deterministic
integer order, Material clock policy, visibility, and occurrence-local typed parameters. A scope is
bounded to four active effects. World effects run after world composition and before Game UI;
full-game effects run after Game UI. Multiple passes use bounded ping-pong render targets and preserve
the deterministic desired-state order.

Postprocess identity is semantic and survives renderer reconstruction. Removing an effect also
removes Material Parameters owned by that postprocess occurrence. Runtime package/resource residency
includes visible postprocess Materials as mandatory dependencies.

## Export / Package Status

`buildShaderMaterialProject()` converts resolved authoring material records into `noveltea.shader-materials` material metadata. It emits:

- display name;
- selected role;
- shader ID;
- uniform override map;
- texture assignment map;
- blend policy.

Texture sources are converted to runtime strings. Asset refs become `project:/...` paths. Alias sources remain aliases. URI sources remain URI strings.

Runtime package export includes shader/material metadata when shader or material records exist. Referenced material texture assets can be included by asset reference discovery.

## Scripting Status

Lua exposes semantic presentation APIs for occurrence-local Material state:

- `noveltea.presentation.set_material_parameter`, `bind_material_parameter`,
  `clear_material_parameter`, and `material_parameter`;
- `noveltea.presentation.set_postprocess`, `clear_postprocess`, and `postprocess`.

Targets use semantic IDs and owner scopes only. Shader programs, bgfx uniforms, textures,
framebuffers, render targets, and tween handles are never exposed to Lua. Standard shader input
bindings remain preferred for values intrinsically owned by the renderer; explicit standard-facet
bindings are preferred when an occurrence-local semantic parameter should follow engine state.

Occurrence-local Material Parameters and postprocess desired instances are saved and reconstructed.
Finite Material operation progress, renderer epochs, ping-pong targets, shader handles, and other GPU
realization are not save state.

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
- Runtime Material Parameter mutation/query/binding covers typed uniform parameters; runtime texture
  reassignment is not part of that parameter contract.
- Preview coverage is strongest for simple material swatches and should expand for role-specific use cases.

## Future Work

- Add more blend/render-state policies when the renderer needs them.
- Add richer material thumbnails and role-specific preview fixtures.
- Expand Material Parameter realization to additional backend-specific roles when those providers
  expose typed parameters.
- Expand package validation around missing compiled shaders, missing textures, and alias resolution.

## Verification

This doc was written from the current material authoring schema, material validation/resolution helpers, shader/material project builder, Material editor, material operation helpers, and native material/render headers. No build is required for this documentation-only change.
