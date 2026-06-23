# NovelTea Shader and Material Plan

Date: 2026-06-23

This plan defines how NovelTea supports user-authored shaders and materials while continuing to use bgfx as the renderer abstraction. It also defines how RmlUi's generic `shader(<string>)` decorator maps into NovelTea materials.

## Current Direction

NovelTea has two related but distinct file/package concepts:

- A **project file** is the editor-authoring representation. It stores project schema records for shaders, materials, rooms, objects, scripts, UI, and other authoring data. Shader source may live in the project schema or be referenced as project assets, depending on editor implementation, but the project schema is the source of truth for shader and material definitions.
- A **game file** or exported runtime package is the shareable game representation. It is the project stripped of data not needed to run, such as shader source text, editor preview/cache data, and other authoring-only metadata. It contains the runtime game data, material records, shader interface/runtime metadata, and precompiled bgfx shader binaries.

Runtime shader source compilation is not part of the normal renderer. Editor/import/export workflows invoke `shaderc` and produce compiled bgfx shader binaries for the variants implied by the active build/export targets. Shipped runtimes load those binaries through `AssetManager`.

Materials are not stored as standalone `.ntmat` files in the intended NovelTea project model. Materials are project-schema records. Only compiled shader binaries are expected to be separate runtime binary assets.

## Goals

- Support user-authored shader source and material definitions in NovelTea projects.
- Keep bgfx as the only graphics backend abstraction used by runtime rendering.
- Support Linux desktop GL, Web/WebGL, Android GLES, and later Metal targets through compiled shader variants selected by build/export/runtime renderer policy.
- Allow editor shader editing, preview, hot reload, and diagnostics during development.
- Package games with all required runtime shader binaries and metadata so shipped games do not require `shaderc`.
- Resolve RmlUi `shader(<string>)` as a NovelTea material id, not as runtime shader source.
- Keep the reusable `rmlui_bgfx` core independent from NovelTea project schema, material registry, asset policy, and editor/package workflows.

## Non-Goals

- Do not bypass bgfx with direct OpenGL/WebGL/Metal shader compilation in the runtime renderer.
- Do not require shader compilation inside Web, Android, or shipped desktop runtimes.
- Do not use standalone material files as the primary NovelTea storage model unless a future explicit external-asset feature is added.
- Do not make RmlUi RCSS the first uniform-authoring language.
- Do not let RmlUi custom shaders mutate renderer layer, clip, transform, pass, or framebuffer ownership rules.
- Do not implement a full visual shader graph in the first pass.

## Core Runtime Constraint

bgfx runtime APIs create shaders and programs from bgfx shader binaries. Even though raw GL/GLES/WebGL/Metal APIs can often compile source at runtime, bgfx's portable path is offline compilation through `shaderc` for each target renderer/profile.

NovelTea therefore treats shader source as authoring data and compiled shader binaries as runtime assets.

```text
Authoring/project data:
  project schema: shaders.noise_panel, shaders.rmlui_decorator_default, materials.ui_noise_panel
  optional source assets: project:/shaders/ui/noise_panel.fs.sc

Build/cache/export output:
  cache:/compiled-shaders/<hash>/glsl-120/noise_panel.fs.bin
  cache:/compiled-shaders/<hash>/essl-100/noise_panel.fs.bin
  cache:/compiled-shaders/<hash>/essl-300/noise_panel.fs.bin

Runtime/package input:
  game schema records for shaders/materials needed at runtime
  project:/shaders/bgfx/<variant>/<shader-id>.<stage>.bin
```

The active compiled shader variant is inferred by engine policy from the current build/runtime renderer/export target. Individual shader or material records should not manually choose `glsl-120`, `essl-100`, `essl-300`, or equivalent future variants.

Current variants in code and staged assets:

```text
glsl-120  desktop OpenGL
essl-100  Web/WebGL
essl-300  Android/OpenGLES
```

Debug/profile/release build type is not itself the shader variant. For example, Linux debug and Linux release both normally use `glsl-120`; Web debug and Web profile both normally use `essl-100`.

## Project Schema Model

The project schema owns shader and material records. The exact JSON names can change with the project schema, but the division of responsibility should remain stable.

### Shader records

A shader record defines authoring and interface metadata. It should include:

- Stable shader id.
- Display/editor metadata.
- One or more stage sources, either inline source text or source asset references.
- Compiled binary references or manifest entries for generated runtime outputs.
- Uniform declarations: name, type, default, editor range/label where appropriate, and optional engine binding.
- Sampler declarations: name, type, default source policy where appropriate.
- Supported shader roles or role-specific stage pairings.

Shader records declare the interface. They do not hold per-object/per-style material values except broad defaults that the editor can use when creating a material.

Example shape:

```json
{
  "shaders": {
    "soft_noise": {
      "display_name": "Soft Noise",
      "stages": {
        "fragment": {
          "source": "project:/shaders/ui/soft_noise.fs.sc",
          "compiled": {
            "glsl-120": "shaders/bgfx/glsl-120/soft_noise.fs.bin",
            "essl-100": "shaders/bgfx/essl-100/soft_noise.fs.bin",
            "essl-300": "shaders/bgfx/essl-300/soft_noise.fs.bin"
          }
        }
      },
      "uniforms": {
        "u_amount": { "type": "float", "default": 0.25, "range": [0.0, 1.0] },
        "u_time": { "type": "float", "binding": "engine.time" }
      },
      "samplers": {
        "s_noise": { "type": "texture2d" }
      },
      "roles": ["rmlui-decorator", "engine-2d"]
    }
  }
}
```

### Material records

A material record references one or more shader records, selects a shader role, and provides concrete values for the shader interface. It should include:

- Stable material id.
- Selected shader role.
- Referenced shader id or role-specific shader stage ids.
- Uniform values overriding shader defaults.
- Texture assignments for sampler declarations.
- Blend policy and limited render-state choices that are safe for the selected role.
- Optional material-instance/editor metadata.

Material records assign values. They should not be the source of truth for shader uniform declarations.

Example shape:

```json
{
  "materials": {
    "ui_noise_panel": {
      "role": "rmlui-decorator",
      "shader": "soft_noise",
      "uniforms": {
        "u_amount": 0.5
      },
      "textures": {
        "s_noise": "project:/textures/noise.png"
      },
      "blend": "premultiplied-alpha"
    }
  }
}
```

### Shader roles

A shader role is the renderer path that a shader definition is valid for. It covers:

- Vertex layout and available varyings.
- Coordinate space and texture-coordinate semantics.
- Required uniforms and samplers.
- Blend/output expectations, normally premultiplied alpha for 2D/UI.
- Whether the shader draws ordinary geometry, glyphs, RmlUi decorator geometry, or render-target/postprocess content.
- Restrictions on framebuffer, layer, pass, and render-target ownership.

Initial shader roles:

- `engine-2d`: engine sprites/quads/map overlays/room and object visuals.
- `active-text`: text glyph rendering and ActiveText effects.
- `rmlui-decorator`: RmlUi `shader(<string>)` decorators using RmlUi geometry and paint-area semantics.
- `rmlui-filter`: future custom RmlUi filters over bounded layer textures.
- `postprocess`: future fullscreen or bounded render-target effects.

A shader can support more than one role. The preferred flexible model is to allow role-specific stage pairings. For example, the same fragment shader can be used with the engine's default 2D vertex shader and the RmlUi decorator default vertex shader if it declares compatible inputs for both paths.

Example shape:

```json
{
  "shaders": {
    "soft_noise": {
      "roles": {
        "rmlui-decorator": {
          "vertex": "rmlui_decorator_default",
          "fragment": "soft_noise"
        },
        "engine-2d": {
          "vertex": "engine_2d_default",
          "fragment": "soft_noise"
        }
      }
    }
  }
}
```

Validation rule: a material may use a shader under a shader role only when the shader declares support for that role, or when the engine has an explicit adapter/default-stage policy that makes the stage combination valid.

## Material Types

### Engine 2D Material

Used by the engine's own 2D draw path, `QuadCommand`, map overlays, room backgrounds, object sprites, and future non-RmlUi primitives.

Role behavior:

- Engine-defined vertex format.
- Engine-defined view/layer ordering.
- Engine-controlled render state.
- Optional texture slots.
- Premultiplied-alpha output for normal 2D blending.

### ActiveText Material / Direct Shader Pair

Used by NovelTea rich text and ActiveText effects.

There are two paths:

- Rich-text material tags resolve to material ids and use the material/shader registry.
- ActiveText's lower-level shader BBCode preserves separate `fragment_shader_id` and `vertex_shader_id` fields on `RichTextStyle`; that path resolves directly through the shader registry/program cache and must not be forced into a material record.

The direct shader-pair path still uses precompiled bgfx binaries at runtime and falls back to the default ActiveText/text shader path if the requested pair is unavailable.

### RmlUi Decorator Material

Used by RmlUi's generic `shader(<string>)` decorator.

Role behavior:

- Renders RmlUi-provided geometry.
- Uses RmlUi paint-area UVs normalized to `[0, 1]`.
- Uses current RmlUi translation and transform semantics.
- Respects RmlUi scissor, clip mask, layer, and composite behavior.
- Outputs premultiplied alpha.
- Cannot change framebuffer/layer ownership or issue additional passes in the first version.

### RmlUi Filter Material

Future extension for custom RmlUi filters.

Role behavior:

- Consumes a source layer texture or texture region.
- Executes over a bounded work rectangle.
- Produces premultiplied-alpha output.
- Participates in WebGL feedback-loop protection and target-cache reuse.

### Postprocess Material

Future extension for fullscreen or bounded postprocess effects outside RmlUi.

Role behavior:

- Operates on render targets, not ordinary sprite/RmlUi geometry.
- Explicitly declares required inputs, output size policy, and feedback-loop constraints.

## Uniform and Sampler Policy

Shader records declare uniforms and samplers. Materials provide values.

Initial policy:

- Uniform declarations live on shader/interface records.
- Shader records may provide defaults for editor material creation and fallback behavior.
- Material records override uniform values and texture assignments.
- Engine-provided values use explicit bindings such as `engine.time`, `rmlui.paint_dimensions`, `rmlui.dpi_scale`, and later safe runtime-state bindings.
- Material records must not assign values for undeclared uniforms/samplers.
- Shader records must not rely on undeclared uniforms/samplers.

RmlUi RCSS should not be the first uniform override language. Initial RmlUi syntax only references a material id:

```css
.panel {
    decorator: shader("ui_noise_panel");
}
```

Deferred syntax, not part of the first bridge:

```css
.panel {
    decorator: shader("ui_noise_panel?amount=0.35&tint=#66ccff");
}
```

Prefer explicit material instances or a NovelTea-specific property system before adding query-string overrides to RCSS.

## Runtime Architecture

```text
ShaderDefinition
  project/game schema record: stage source references, compiled binary refs, uniforms, samplers, shader roles

MaterialDefinition
  project/game schema record: material id, selected shader role, shader reference, uniform values, textures, blend policy

ShaderRegistry
  resolves shader ids and direct ActiveText shader pairs
  selects compiled binary refs for the inferred active variant
  exposes uniform/sampler/role metadata

MaterialRegistry
  resolves material ids to material definitions
  validates material values against shader declarations and selected shader role
  provides fallback materials/instances

ShaderCompilerService
  editor/import/export only
  invokes shaderc for variants implied by active build/export targets
  emits compiled shader binaries and diagnostics
  writes generated runtime metadata / manifest entries as needed

ShaderProgramCache
  runtime
  loads compiled bgfx shader binaries through AssetManager
  creates bgfx ShaderHandle/ProgramHandle
  caches by shader ids, active backend, inferred compiled variant, and shader hash/binary refs

MaterialBinder
  runtime
  binds bgfx program, uniforms, textures, and render state for a draw call

MaterialInstance
  optional runtime/editor override layer for project objects, styles, or UI elements
```

The runtime side should not invoke `shaderc`. It should infer the active compiled variant from the renderer/platform policy, load compiled shader binaries, or fail with a diagnostic that names the material id or shader ids, inferred variant, and expected compiled binary path.

## RmlUi Bridge Architecture

The reusable `rmlui_bgfx` core must not include NovelTea project-schema or material headers. Add a provider seam to the reusable renderer core and implement that provider in the NovelTea adapter.

Conceptual reusable-core interface:

```cpp
namespace rmlui_bgfx {

struct RmlUiMaterialShaderRequest {
    std::string_view value;          // parameters["value"] from shader(<string>)
    Rml::Vector2f dimensions;        // parameters["dimensions"]
};

struct RmlUiMaterialShaderHandle {
    uint64_t id = 0;
};

class MaterialShaderProvider {
public:
    virtual ~MaterialShaderProvider() = default;

    virtual RmlUiMaterialShaderHandle compile_decorator_shader(
        const RmlUiMaterialShaderRequest& request) = 0;

    virtual void release_decorator_shader(RmlUiMaterialShaderHandle shader) = 0;

    virtual bool submit_decorator_shader(
        const RmlUiMaterialShaderHandle& shader,
        const RmlUiDrawContextForMaterial& draw_context) = 0;
};

}
```

First implementation behavior in `CompileShader()`:

- If `name` is `linear-gradient`, `radial-gradient`, or `conic-gradient`, keep the existing built-in gradient path.
- If `name` is `shader`, read `parameters["value"]` and `parameters["dimensions"]`.
- Ask the material shader provider to resolve the value as a NovelTea material id.
- Return a RmlUi compiled shader handle that records the provider-owned material shader handle.
- If no provider is configured or resolution fails, log a clear diagnostic and return zero.
- Unknown names remain unsupported until a specific extension policy exists.

First implementation behavior in `RenderShader()`:

- Built-in gradient handles continue using the current gradient shader path.
- Material shader handles call the provider submission path.
- The submission path receives current texture, geometry, translation, scissor, transform, clip/stencil state, layer projection, and paint dimensions as explicit state.
- The material provider binds the bgfx program, uniforms, textures, and declared render state, but it must not mutate layer stack or pass scheduling directly.

## Shader Source Conventions

User-authored shader source should use bgfx shaderc language conventions.

Initial constraints:

- Provide system/default vertex shaders for common shader roles:
  - `rmlui_decorator_default`
  - `engine_2d_default`
  - `active_text_default`
  - later `postprocess_fullscreen`
- User-authored RmlUi decorator materials usually provide only a fragment shader and use an engine-provided RmlUi decorator vertex/interface shader.
- User-authored engine 2D materials may initially provide a fragment shader and use an engine-provided 2D vertex/interface shader.
- All shader source must use declared uniform and sampler names from the shader definition.
- RmlUi decorator shaders must output premultiplied-alpha color.
- Shader includes should resolve only through explicit system/project shader include roots.

Initial built-in RmlUi decorator fragment inputs should include:

```text
v_texcoord0        normalized paint-area UV from RmlUi
v_color0           RmlUi vertex color, already normalized by bgfx
s_texColor         optional RmlUi texture if the geometry has one
u_time             optional engine time input when declared
u_dimensions       paint dimensions when declared
u_dpiScale         dpi scale when declared
```

Do not promise arbitrary uniform names unless the shader definition/manifest has a reliable way to preserve and bind them on every target.

## Compiler and Cache Pipeline

### Editor/import path

1. Read shader and material records from the project schema.
2. Validate shader source refs, stage declarations, uniform declarations, sampler declarations, shader roles, material shader refs, material uniform values, texture assignments, and blend policy.
3. Compute a stable hash from shader source, includes, shader definition metadata, compiler version, inferred target variant, and relevant flags.
4. Invoke `shaderc` for each variant implied by the active build/export targets.
5. Store compiled shader binaries under a cache/output path keyed by hash and inferred target variant.
6. Store diagnostics in a form the editor can display inline.
7. Write/update generated runtime metadata that maps shader ids, shader roles, and inferred variants to compiled binary paths and binding metadata.

### Runtime path

1. Load game/project schema shader and material records plus generated runtime shader metadata.
2. Infer the active compiled shader variant from the runtime renderer/platform policy.
3. Validate material records against shader declarations and selected shader roles.
4. Load the compiled vertex/fragment shader binaries through AssetManager.
5. Create bgfx shader handles and program handles.
6. Bind uniforms and textures for each draw.
7. If anything is missing, use a visible fallback material or default shader path and log an actionable diagnostic.

### Package/export path

1. Compile all referenced shaders/materials for selected export targets.
2. Fail export by default if required compiled variants fail to build.
3. Include runtime schema records, compiled binaries, and generated shader metadata in the game package.
4. Strip shader source and editor-only metadata unless explicitly exporting an editable/dev package.
5. Do not include `shaderc` or source shader compiler dependencies in the runtime package.

## Hot Reload

Editor hot reload should be host-only.

- Watch project shader records, material records, shader source files, and included shader files.
- Recompile affected variants for the active preview backend.
- Replace bgfx programs safely at frame boundaries.
- Keep the previous valid program alive until the replacement compiles and links successfully.
- Surface diagnostics in the editor and runtime debug overlay.
- Never require hot reload on Web/Android packaged runtime.

## Fallbacks and Diagnostics

Every material or shader resolution/compilation failure must report the relevant context:

- Material id, if a material was requested.
- Shader id or direct ActiveText vertex/fragment shader ids, if a direct shader pair was requested.
- Selected shader role.
- Referencing asset, RmlUi document, rich-text run, or project object if known.
- Inferred compiled shader variant.
- Missing shader source or compiled binary path.
- `shaderc` command line and stderr for compile failures.
- Fallback material or default shader path used.

Fallbacks:

- RmlUi decorator fallback: obvious error tint/checker constrained to the element geometry.
- Engine 2D fallback: visible checker quad with object/material id logged.
- ActiveText direct shader-pair fallback: default text/ActiveText shader path with an actionable diagnostic.
- Missing texture fallback: existing checker texture or a material-specific fallback texture.

Do not silently return zero for project-authored materials after the material system exists. Returning zero remains acceptable for unsupported RmlUi shader names before a provider is configured.

## Security and Portability Notes

NovelTea user-provided shaders are project code/assets. Treat them like source files that can fail compilation or render badly, not like sandboxed scripts.

Portability rules:

- Prefer bgfx shaderc source conventions over raw GLSL/MSL/HLSL.
- Avoid target-specific preprocessor branches in user materials unless the editor validates all variants implied by the build/export targets.
- Keep the first shader roles small so WebGL/GLES2 limitations are respected.
- Avoid dynamic sampler arrays, unsupported texture formats, and platform-specific precision assumptions in initial templates.

## Implementation Phases

### Phase 0: Policy and Inventory `[implemented, revised]`

- Confirm that runtime shader source compilation is not the normal path.
- Confirm inferred compiled shader variant names and shader asset layout.
- Confirm that materials are project-schema records, not standalone material files.
- Confirm that shader records declare interfaces and materials assign values.
- Add documentation links from RmlUi status/audit docs and migration docs.

Acceptance:

- The docs agree that runtime shader source compilation is not the normal path.
- RmlUi `shader(<string>)` is defined as a material id reference.
- Shader/material storage is defined around project/game schema records.

### Phase 1: Project Shader/Material Runtime Data Model `[implemented]`

Implemented model:

- `engine/include/noveltea/render/material.hpp` now defines backend-neutral `ShaderDefinition` and `MaterialDefinition` records.
- `ShaderId` and `MaterialId` normalize as stable project schema ids/aliases, not file paths.
- Shader records declare stages, authoring source refs/source text placeholders, compiled binary refs, uniforms, samplers, supported shader roles, and role-specific stage-pair bindings.
- Material records reference a shader, select one shader role, assign uniform values, assign texture sources/samplers, define blend policy, and carry fallback flags.
- Uniform/sampler declarations live on shader records; material records validate values/textures against the referenced shader.
- Shader-role validation rejects material/shader combinations unless the shader declares support for the selected role.
- Fallback material records now use schema ids such as `system/fallback/engine_2d_error`, not material asset paths.
- `tests/render/material_asset_tests.cpp` now covers valid project-schema records, schema id validation, shared fragment shader role bindings, representative diagnostics, deferred roles, and fallback records.

Acceptance:

- Valid shader/material schema records parse into stable runtime models.
- Invalid schema records report specific errors.
- Material ids normalize consistently as project ids/aliases, not file paths.
- Tests cover shader declarations, material values, and shader-role compatibility.
- `noveltea_render_tests`, CTest `material`, and CTest `shader` checks pass.

### Phase 2: Shader Metadata and Runtime Program Loading `[implemented]`

Implemented model:

- `engine/include/noveltea/render/shader_manifest.hpp` defines backend-neutral runtime shader-program resolution records, diagnostics, direct shader-pair support, and stable cache keys.
- `ShaderDefinition::stages[].compiled` is the first runtime metadata source for compiled binary paths. A future generated manifest can feed the same resolver without changing renderer-facing call sites.
- `resolve_material_shader_program()` maps material id + selected shader role + inferred compiled variant to resolved vertex/fragment shader binary refs.
- `resolve_direct_shader_pair_program()` maps ActiveText's preserved vertex/fragment shader ids + inferred compiled variant to resolved binary refs without requiring a material record.
- Role-specific stage bindings are required when the material shader record does not itself contain both vertex and fragment stages.
- Resolved programs carry uniform and sampler declarations forward for later material binding and direct ActiveText shader binding.
- `BgfxShaderProgramCache` loads resolved compiled binaries through `AssetManager`, creates bgfx programs, caches them by material-vs-direct context plus variant and binary paths, and owns program lifetimes.
- Tests cover material metadata selection, direct ActiveText shader-pair selection, missing inferred-variant diagnostics, role-binding requirements, shared fragment shaders across roles, and cache-key separation.

Still intentionally not implemented:

- Runtime shader source compilation.
- Editor/import/export `shaderc` service.
- Binding material uniform/texture assignments into actual draw calls.
- Engine 2D material-backed quad rendering.
- RmlUi `shader(<string>)` material bridge.

Acceptance:

- Runtime metadata resolution can select a precompiled material program for the active backend.
- Runtime metadata resolution can select a precompiled direct shader-pair program for ActiveText low-level shader metadata.
- `BgfxShaderProgramCache` can load/create/cache bgfx programs from resolved compiled binary refs when called inside an initialized bgfx runtime.
- Missing material program diagnostics name the material id, selected shader role, inferred active variant, and expected path.
- Missing direct shader-pair diagnostics name the vertex/fragment shader ids, inferred active variant, and expected paths.

### Phase 3: Editor/Import Shader Compilation `[implemented]`

Implemented model:

- `ShaderCompilerService` wraps host-side `shaderc` invocation for project-authored shader stages.
- Current compile variants are mapped to existing bgfx shaderc conventions: `glsl-120`, `essl-100`, and `essl-300`.
- Stage source can come from `source` refs resolved under the project root or from `source_text` written to a generated cache source file.
- Compiled outputs are written to runtime-compatible paths under `shaders/bgfx/<variant>/<shader-id>.<vs|fs>.bin`.
- The returned shader project metadata is updated with compiled refs for successful stage outputs; project files are not mutated implicitly.
- A simple content/interface/variant cache manifest under `<cacheRoot>/shader-cache/manifest.json` skips unchanged compiles.
- Diagnostics capture shader id, stage, variant, source path, output path, command line, exit code, and compiler output.
- `noveltea-editor-tool compile-shaders` exposes the compiler service for editor/import/export workflows.
- Tests cover variant mapping, source refs, `source_text`, cache hits, missing source/tool errors, and compiler failure diagnostics.

Still intentionally not implemented:

- Runtime shader source compilation.
- Automatic package-export compilation.
- Hot-reload program swapping.
- Material binding into draw calls.
- RmlUi `shader(<string>)` material bridge.

Acceptance:

- Project-schema shader stages can compile for Linux/Web/Android variant names, currently `glsl-120`, `essl-100`, and `essl-300`.
- Failed shader compilation produces readable diagnostics.
- Re-running without source changes hits the cache.

### Phase 4: Engine 2D Material Binding `[implemented]`

Implemented model:

- `QuadCommand` has an optional `MaterialId`; existing colored/textured quad helpers still produce commands without materials.
- New `QuadBatch` helpers submit material-backed colored and textured quads.
- `Renderer::set_shader_material_project()` supplies parsed shader/material records without making the renderer own project schema loading.
- `BgfxMaterialBinder` resolves `ShaderRole::Engine2D` material ids, obtains programs from `BgfxShaderProgramCache`, packs schema uniform values into bgfx vec4 uniforms, binds material texture assignments, maps material sampler policy to bgfx sampler flags, and reports diagnostics.
- The existing default quad path remains the fallback when a material id is absent or material binding fails.
- The Render2D sandbox demo includes a material-backed textured quad that uses the existing compiled `quad` shader through material metadata.
- Tests cover default material-free commands, material command metadata, sampler flag mapping, and uniform packing.

Still intentionally not implemented:

- RmlUi `shader(<string>)` material bridge.
- ActiveText custom shader rendering.
- Full PNG/JPEG material texture decoding; material texture assets currently use the same limited PPM path as the existing 2D demo loader.
- Runtime shader source compilation.

Acceptance:

- Existing sprite/quad commands remain unchanged when no material id is present.
- A material-backed Render2D demo path runs on Linux/Xvfb.
- Missing material/program/texture paths fall back to the existing quad path and log diagnostics.

### Phase 5: RmlUi `shader(<string>)` Material Bridge `[implemented]`

Implemented model:

- `rmlui_bgfx::MaterialShaderProvider` is the reusable-core extension seam. It compiles/releases provider-owned decorator shader handles and submits material shader draws from explicit RmlUi state.
- Reusable `ShaderRecord` values distinguish built-in gradients from provider-backed material handles, so gradients stay on the existing built-in path.
- `CompileShader("shader", ...)` resolves the RmlUi decorator `value` as a NovelTea `MaterialId`; the NovelTea adapter currently uses the bound `ShaderMaterialProject` as the material registry source.
- The NovelTea provider requires `ShaderRole::RmlUiDecorator`, resolves the active compiled shader variant through `resolve_material_shader_program()`, loads programs through `BgfxShaderProgramCache`, and binds material uniforms/samplers.
- RmlUi material submission receives explicit geometry buffers, projection, translation, transform, layer-local scissor, clip/stencil state, optional draw texture, paint dimensions, DPI scale, and premultiplied-alpha blend state.
- Demo shader/material records now include `ui/noise_panel`, backed by compiled `rmlui_noise_panel` bgfx shader variants.
- Added `project:/rmlui/material_shader.rml` and `material_shader.rcss` using `decorator: shader("ui/noise_panel")`.

Still intentionally not implemented:

- Runtime shader source compilation.
- RCSS/query-string material uniform overrides.
- Custom RmlUi filter materials.
- Material-controlled layer/pass/framebuffer ownership.

Acceptance:

- Built-in gradients still render exactly as before.
- Generic RmlUi `shader(<string>)` resolves to a NovelTea material id with role `rmlui-decorator`.
- The sample material respects scissor, transform, clip mask, layers, and premultiplied-alpha output through the existing RmlUi draw state.
- Linux fixture smoke, readback, and resize-readback pass; Web smoke remains the final cross-platform gate.

### Phase 6: Editor Material UI and Instances

- Add editor UI for project shader records, material records, uniforms, texture slots, and preview.
- Add material instances for project objects/styles without duplicating shader source.
- Add validation indicators for missing compiled variants implied by the current build/export targets.
- Add hot reload for desktop/editor preview.

Acceptance:

- A designer can edit material uniform values and see preview changes.
- Invalid shader source reports errors without crashing runtime preview.
- Previous valid program remains active after a failed hot reload.

### Phase 7: Package and Export Integration

- Compile all referenced shaders/materials during export.
- Include runtime shader/material records, compiled shader variants, and generated metadata in packages.
- Strip shader source and editor-only data from runtime game packages.
- Fail release export on missing required variants by default.
- Add CI/export smoke for material-backed project content.

Acceptance:

- Web package contains required compiled shader binaries and runtime material metadata.
- Android package contains required compiled shader binaries and runtime material metadata.
- Runtime package does not require `shaderc` or shader source.

## Deferred Work

- RmlUi uniform overrides in RCSS.
- Material query-string overrides.
- Visual shader graph.
- Custom RmlUi filter materials.
- Postprocess materials.
- Runtime raw GL/GLES/WebGL/Metal shader source compilation.
- Physical extraction of `rmlui_bgfx` to a separate repository.

## Docs To Keep In Sync

- `docs/rendering/RMLUI_BGFX_RENDERER_REFACTOR_PLAN.md`: current action order and acceptance gates.
- `docs/rendering/RMLUI_BGFX_STATUS.md`: next implementation task and support status.
- `docs/rendering/RMLUI_RENDER_INTERFACE_AUDIT.md`: track material shader fixture/readback coverage and any remaining under-verified RmlUi shader behavior.
- `docs/rendering/RENDERING_STACK.md`: shader/material pipeline summary.
- `docs/runtime/PACKAGE_EXPORT.md`: runtime package contents and source stripping policy.
- `docs/migration/STATUS.md` and `docs/migration/PLAN.md`: durable migration state.

## Prompt For The Next Implementation Session

```text
Start from docs/rendering/NOVELTEA_SHADER_MATERIAL_PLAN.md and docs/rendering/RMLUI_BGFX_RENDERER_REFACTOR_PLAN.md.

Action 6 / Phase 5 is implemented: RmlUi `shader(<string>)` decorator usage resolves to NovelTea material ids through a provider seam in reusable `rmlui_bgfx` and a NovelTea adapter for `ShaderRole::RmlUiDecorator` materials. Materials are not standalone files. Shader binaries remain runtime assets under shaders/bgfx/<variant>/, and runtime game packages strip shader source/editor data.

Next continue with renderer Action 8 Android and package verification for material-backed content. Do not add runtime shader source compilation, and keep built-in gradients unchanged.
```
