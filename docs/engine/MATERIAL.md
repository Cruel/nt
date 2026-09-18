# Material Entity

## Purpose

Materials are NovelTea's sole semantic rendering records. A Material describes authored rendering values, inheritance, texture assignments, optional project-owned shader-stage overrides, and preview metadata. Shader programs themselves are derived from built-in Material Presets plus source files; there is no authored Shader-record collection.

## Current Status

Materials are a typed authoring collection under `/materials/{materialId}`. Every Material resolves through exactly one built-in Material Preset, either directly or through a single chain of base Materials. Presets are engine-provided contracts rather than Project records.

The runtime continues to use internal shader/program metadata under `noveltea.shader-materials`. Those shader objects and compiled binaries are derived build/runtime artifacts and are not canonical authoring state.

Occurrence-local runtime Material Parameters support typed mutation and query, Property or standard engine-facet binding, Scene assignment/tweening, and Lua presentation APIs without mutating compiled Material definitions.

## Authoring Data Model

The canonical Material shape is:

```ts
interface MaterialData {
  kind: 'material';
  base:
    | { kind: 'preset'; preset: MaterialPresetId }
    | { kind: 'material'; material: { $ref: { collection: 'materials'; id: string } } };
  displayName?: string;
  shader?: {
    vertex?: MaterialShaderSource;
    fragment?: MaterialShaderSource;
    varying?: MaterialShaderSource;
  };
  blend?: 'premultiplied-alpha';
  postprocessScope?: 'world' | 'full-game-viewport';
  parameters: Record<string, MaterialParameterOverride>;
  textures: Record<string, MaterialTextureOverride>;
  preview?: {
    geometry?: 'quad' | 'rounded-rect' | 'sprite' | 'glyphs';
    background?: 'transparent' | 'checker' | 'dark' | 'light';
  };
}
```

Shader sources are source identities, not Asset or Shader references:

```ts
type MaterialShaderSource =
  | { kind: 'project'; path: 'shaders/...' }
  | { kind: 'engine'; path: 'engine:/...' };
```

Project shader files live beneath `shaders/`. Engine shader sources and varying definitions use the explicit read-only `engine:/` namespace. Canonical Material data never stores compiled binary paths, compiler fingerprints, or authored Shader IDs.

## Material Presets

Built-in Material Presets are stable engine contracts. Current preset IDs include `engine-2d`, `active-text`, `rmlui-decorator`, `postprocess-tint`, `hotspot-overlay-alpha`, and `hotspot-overlay-custom`.

A preset defines:

- rendering role;
- default engine vertex/fragment implementation;
- varying/interface definition;
- engine-owned versus author-settable parameter/sampler metadata;
- default blend/postprocess behavior;
- preview harness metadata.

Role is therefore derived from the terminal preset and is not an independently editable Material field. A preset-backed Material requires no project shader source files.

## Inheritance and Overrides

Material inheritance is single-parent. A Material's immediate base may be a preset or another Material, but every valid chain must terminate at a built-in preset. Cycles and missing bases are errors.

Inheritance uses sparse overrides. Parameter and texture slots are keyed by stable semantic names rather than array position. Shader-stage, blend, postprocess, and preview overrides are likewise sparse. Effective resolution records provenance so the editor can distinguish preset, inherited Material, and current-Material values. Resetting an override reveals the inherited value again.

A representative parameter override is:

```ts
parameters: {
  u_tint: {
    value: [1, 0.5, 0.5, 1],
    editor: { label: 'Tint' }
  }
}
```

Texture overrides may contain a source, filtering policy, binding metadata, and editor metadata. A missing `source` means the current Material does not override the inherited source; an empty URI is not a valid way to clear a texture.

## Shader Interface and Reflection

For custom-source Materials, shader compiler reflection is the structural source of truth for uniforms and sampled images. Material authoring data stores values, bindings, editor metadata, inheritance, and preview configuration; it does not redundantly declare the GPU interface.

Preset metadata decorates reflected inputs when semantic names match. Engine-bound reflected inputs remain runtime-owned and are not author-settable occurrence parameters. Reflected author-settable inputs are published into the compiled Material interface used by Scene/Lua/save-state validation.

If authored parameter or texture configuration no longer exists in the reflected interface, NovelTea retains that configuration and reports it as orphaned. It is not destructively removed during shader edits.

## Shader Compilation and Derived Identity

`buildShaderMaterialProject()` produces two derived contracts:

- `noveltea.shader-source-programs`: source-program compilation requests keyed by deterministic internal program identity;
- `noveltea.shader-materials`: runtime shader/material metadata using compiled program outputs.

Program identity derives from effective source inputs, interface/preset contract, target variant, compiler identity, and transitive source content. Compile outputs include exact dependency revisions. Runtime artifact preparation revalidates project shader dependency hashes before publishing binaries, so outputs compiled from a stale physical source generation are rejected.

Derived shader outputs never write into Material records and do not dirty canonical Project data.

## ActiveText Direct Programs

ActiveText retains its advanced low-level direct stage-pair path. Authored ActiveText shader markup names project shader files and/or engine stages rather than Shader records. Runtime preparation compiles those pairs through the same source-program seam and rewrites only the derived compiled artifact to an internal source-program token. The renderer resolves that token through the source-program resolver and program cache. No authored Shader ID is introduced.

## Texture Sources

Author-settable texture slots may use:

```ts
{ $ref: { collection: 'assets', id: 'image-asset' } }
{ alias: 'ui.panel' }
{ uri: 'project:/textures/panel.png' }
```

Asset references participate in Project reference validation. Engine-bound sampler slots cannot be overridden by Material authoring.

## Validation

Material validation and resolution cover:

- canonical Material schema;
- known preset IDs;
- valid single-parent Material inheritance and preset termination;
- inheritance cycles/missing bases;
- safe contained project shader paths and explicit engine shader identities;
- preset/engine binding ownership;
- parameter value compatibility;
- texture Asset existence/type compatibility;
- orphaned configuration diagnostics;
- reflected custom shader interface compatibility during build/export.

Old `shader` references, independently editable role fields, `baseMaterialId`, positional uniform/texture arrays, Shader records, and script/shader-source Assets are not compatibility shapes and are rejected by canonical readers.

## Editor Behavior

The Material editor edits effective values with sparse overrides and provenance. It exposes the base preset/Material, effective contract, optional shader-source overrides, parameters, textures, and preview metadata. Renderer-owned inputs are displayed as runtime supplied. Orphaned configuration remains visible until explicitly removed.

Custom-source Material previews compile the browser shader variant as derived state. Successful compiled outputs are staged into the preview filesystem; compilation failure retains the previous successful preview rather than pretending current invalid source rendered successfully.

Shader compiler diagnostics attempt to navigate to the affected Material/source context. Richer physical source-file tabs and Files-mode navigation are implemented by the source-authoring work under the parent Material/Files specification.

## Runtime and Package Behavior

Runtime artifact preparation:

- resolves effective Materials;
- compiles required custom source programs for requested target variants;
- validates compiler dependency revisions against current project bytes;
- publishes reflected Material interfaces into the compiled gameplay artifact;
- emits derived `noveltea.shader-materials` runtime metadata;
- stages required compiled binaries;
- normally strips project shader source;
- includes referenced shader entrypoints and transitive project shader dependencies when the developer `--include-shader-sources`/non-stripping option is selected.

Preset-backed Materials use trusted system shader binaries and do not require project shader source files.

## Commands

`material.replaceData` is the canonical full-data mutation used by the current editor. Generic record operations continue to handle record label/tags/color and deletion/duplication where applicable. Material base relationships participate in usage/dependency analysis so deletion of a referenced base cannot silently change descendants.

## Implementation Files

Primary editor/shared files:

```text
editor/src/shared/project-schema/authoring-material-presets.ts
editor/src/shared/project-schema/authoring-materials.ts
editor/src/shared/project-schema/shader-material-project.ts
editor/src/shared/runtime-artifact-preparation.ts
editor/src/renderer/editors/materials/MaterialEditor.tsx
editor/src/renderer/shaders/shader-compile-store.ts
```

Primary native files:

```text
engine/include/noveltea/render/material.hpp
engine/include/noveltea/render/shader.hpp
engine/include/noveltea/render/shader_manifest.hpp
engine/src/render/material.cpp
engine/src/render/material_codec.cpp
engine/src/render/shader_manifest.cpp
engine/src/render/bgfx/
tools/editor_tool/shader_compiler.cpp
```

Related current documentation:

```text
docs/engine/SHADER.md
docs/engine/ASSET.md
docs/engine/SCRIPT_MODULE.md
docs/editor/export/EXPORT_AND_PACKAGING.md
```

`docs/rendering/plans/SHADER_MATERIAL_PLAN.md` is historical planning context where it conflicts with this current component contract.
