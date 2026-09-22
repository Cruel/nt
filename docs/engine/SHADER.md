# Shader Source and Material Programs

## Purpose

NovelTea does not expose Shader as an authored Project record. Materials are the semantic rendering resources; shaders are source files and derived runtime programs.

Built-in Material Presets provide the default rendering contract for ordinary Materials. A preset defines the Material role, engine shader stages, interface/binding metadata, default render state, and preview harness. Presets are engine-owned stable contracts and are not Project records.

The canonical engine-owned registry is `engine/material-contracts/material-contract-registry.json`. It defines the five current roles and six current preset contracts, including reserved renderer interface slots, standard-semantic availability, sampler stages and policies, pipeline state, deterministic preview fixtures, and the inputs used to derive each contract fingerprint. `scripts/generate-material-contract-registry.mjs` deterministically produces checked-in TypeScript and C++ projections; normal native builds consume the C++ projection directly and do not require Node. CI runs the generator in drift-check mode.

Each preset keeps its stable `noveltea.material-preset:<preset>:1` identity and also has a derived `sha256:` contract fingerprint. The identity names the V1 contract while the fingerprint changes when its canonical resolved ABI inputs change. Source-program compilation carries both values so cache/program identity cannot silently reuse a program compiled against a different resolved contract.

During the staged #333 Material-contract cutover, the generated TypeScript preset projection intentionally preserves the currently authorable preset fields consumed by existing editor/project code. Renderer-owned strict ABI data already comes from the canonical registry; later role-specific tickets remove the obsolete authoring compatibility fields as their runtime paths migrate.

When a Material uses custom shader source, its stages reference normalized source paths directly. Project-owned shader files live beneath `shaders/`; engine-owned stages use `engine:/...` identities. Reuse happens through source files and `#include`, not through shared authored Shader IDs.

## Canonical authoring model

There is no `/shaders` collection and no Shader `$ref` in canonical authoring data.

A Material has exactly one immediate base:

```ts
{ kind: 'preset', preset: 'engine-2d' }
```

or:

```ts
{ kind: 'material', material: { $ref: { collection: 'materials', id: 'base-material' } } }
```

Material inheritance is single-parent and must terminate at a built-in preset. Cycles and missing bases are invalid. Parameters, textures, render-state fields, preview metadata, and shader-stage overrides are sparse overrides. Resolution preserves provenance so the editor can distinguish preset values, inherited Material values, and local overrides.

A Material may override shader stages with project or engine source paths:

```ts
shader: {
  vertex?: { kind: 'project' | 'engine'; path: string };
  fragment?: { kind: 'project' | 'engine'; path: string };
  varying?: { kind: 'project' | 'engine'; path: string };
}
```

Project shader paths are contained project-relative files beneath `shaders/`. Engine paths use the explicit `engine:/` namespace. Preset-backed Materials require no project shader source.

## Interface ownership

The shader compiler's reflected interface is the structural source of truth for custom-source programs. Reflection reports uniforms and sampled images from compiled stage output. Runtime shader metadata is generated from that reflected interface rather than from an authored Shader declaration.

Material and preset metadata may decorate compatible reflected inputs with authoring semantics such as defaults, labels, ranges, and engine bindings. Engine-bound inputs are runtime-owned and cannot be occurrence-authored. Ordinary reflected inputs may receive authored Material values or texture assignments.

If an authored Material parameter or texture key no longer exists in reflection, NovelTea preserves it as orphaned configuration and emits a diagnostic. It is not deleted automatically. Unsupported reflected uniform types are also diagnosed.

Built-in preset programs use the preset's engine-owned interface contract. Custom programs use reflection from the compiled outputs. This keeps ordinary engine rendering stable while ensuring project shader structure cannot drift from the compiler-visible program.

## Source compilation

Editor/native shader compilation consumes the canonical source-program request:

```text
noveltea.shader-source-programs
```

Each requested program identifies vertex source, fragment source, varying definition, the stable interface-contract identity, and its derived interface fingerprint. Source inputs may mix project files and engine-provided stages. Project includes are contained to approved project shader roots; engine includes resolve through explicit embedded engine/bgfx roots. Relative escapes are rejected.

The standalone native tooling embeds the NovelTea engine shader source bundle required to resolve `engine:/...` stages. A source checkout is therefore not required merely to compile a Material program.

Compiler output includes the target variant, derived runtime path/hash/size, dependency fingerprint information, reflected inputs, and browser payload where applicable. Compiled outputs and compiler fingerprints are derived build/runtime artifacts only; they are never written into canonical Material records.

Program/cache identity is derived from effective source inputs, dependencies, interface contract and fingerprint, compiler identity, and target variant. Authored Shader IDs do not participate in runtime identity or deduplication.

## Runtime metadata

The runtime continues to use internal shader/program structures and the `noveltea.shader-materials` metadata document. That document is a derived runtime representation, not an authoring schema.

`buildShaderMaterialProject()` resolves effective Materials and emits:

- engine preset programs for preset-backed Materials;
- custom derived programs for source-overridden Materials;
- reflected uniforms/samplers for compiled custom programs;
- Material values, textures, blend state, role, and postprocess scope;
- diagnostics for unresolved inheritance, invalid bindings, unsupported reflection, and orphaned configuration.

Preset programs resolve to shipped system shader binaries. Custom source programs must have the required compiled target variants before runtime package export succeeds.

## Material roles and standard bindings

Current Material roles include ordinary 2D rendering, ActiveText, RmlUi decoration, postprocess rendering, and hotspot overlay roles. A Material's role comes from its root preset; it is not an independently editable enum.

Standard engine bindings remain typed runtime-owned inputs. Examples include time, paint dimensions, raster/UI scale values, viewport dimensions, pointer state, and role-specific hotspot/RmlUi inputs. A reflected input can be author-settable or engine-bound, but not both.

Postprocess Materials retain the closed composition scopes `world` and `full-game-viewport`. Hotspot and RmlUi presets retain their role-specific sampler/uniform ownership rules.

## ActiveText

ActiveText retains its advanced direct shader-pair path without authored Shader records. Direct vertex/fragment programs reference project shader files and/or engine stages, with varying/interface source handled through the same source-program compiler seam. ActiveText direct pairs remain lower-level than Material inheritance and do not introduce authored Shader IDs.

## Editor behavior

The semantic Project tree contains Materials, not Shaders. Material editing exposes the effective preset/base chain, sparse parameter and texture overrides, shader source overrides, and provenance. Shader compilation diagnostics refer to source paths and derived programs.

Physical shader-source navigation and richer source-tab workflows belong to the Files/source-editor portion of the Material redesign. Built-in preset source is engine-owned/read-only; project-customized shader files are Project-owned source.

There is no Shader entity wizard, Shader detail editor registration, Shader delete/rename command, or command that applies compiled outputs back into authoring data.

## Assets and source files

Shader source is not an Asset kind. `.sc`, `.glsl`, `.vert`, `.frag`, `.vs`, `.fs`, and varying/include files are source files under the shader source root rather than semantic Asset records.

Lua follows the same source-code boundary: Lua source is not a script Asset. Script Modules reference `scripts/*.lua` project files, and canonically owned Layout Lua lives in its workspace source file. Asset records remain for imported/runtime content such as images, fonts, audio, video, text/data resources, and binary resources.

## Export/package behavior

Runtime artifact preparation performs exhaustive compilation for the requested platform variants, validates reflection/interface ownership, and publishes the derived shader/material document plus binary paths. Runtime package export may strip project shader source while retaining the compiled outputs required by the package.

`--include-shader-sources` is a developer export override that preserves project shader source files; it does not reintroduce shader-source Assets or authored Shader records.

## Compatibility policy

The cutover is canonical and atomic:

- authored Shader collections are obsolete and rejected;
- `script` and `shader-source` Asset kinds are obsolete and rejected;
- native shader compilation accepts the source-program compile envelope, not the old authored-Shader compile envelope;
- compiled outputs/fingerprints are derived state;
- no authoring alias, migration reader, or fallback Shader record path is retained.

Internal runtime shader/program types may continue to use shader-oriented terminology because they model renderer implementation details rather than authored Project identity.

## Primary implementation files

```text
engine/material-contracts/material-contract-registry.json
scripts/generate-material-contract-registry.mjs
engine/include/noveltea/render/material_contract.hpp
engine/src/render/material_contract_registry.generated.hpp
editor/src/shared/project-schema/material-contract-registry.generated.ts
editor/src/shared/project-schema/authoring-material-presets.ts
editor/src/shared/project-schema/authoring-materials.ts
editor/src/shared/project-schema/authoring-shaders.ts
editor/src/shared/project-schema/shader-material-project.ts
editor/src/shared/shader-compile-contract.ts
editor/src/shared/runtime-artifact-preparation.ts
tools/editor_tool/shader_compiler.cpp
tools/editor_tool/tooling_native.cpp
engine/src/render/material_codec.cpp
engine/src/render/bgfx/bgfx_shader_loader.cpp
engine/src/render/bgfx/bgfx_shader_program_cache.cpp
engine/shaders/bgfx/
```

`authoring-shaders.ts` now contains shared shader vocabulary/value/binding types used by Materials and runtime lowering; it is not a Shader-record schema.

## Related documentation

```text
docs/engine/ASSET.md
docs/engine/SCRIPT_MODULE.md
docs/rendering/plans/SHADER_MATERIAL_PLAN.md
docs/rendering/RENDERING_STACK.md
docs/editor/export/EXPORT_AND_PACKAGING.md
```
