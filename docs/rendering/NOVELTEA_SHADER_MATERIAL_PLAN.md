# NovelTea Shader and Material Plan

Date: 2026-06-23

This plan defines how NovelTea should support user-provided shaders and materials while continuing to use bgfx as the rendering backend. It also defines how RmlUi's generic `shader(<string>)` decorator should map into NovelTea's material system.

The short version: NovelTea projects may contain user-authored shader/material assets, but the runtime should consume compiled bgfx shader binaries. Runtime source compilation through raw GL/GLES/WebGL/Metal APIs is not the portable path. Editor-time, import-time, package-time, and export-time shader compilation should use `shaderc` and produce platform/profile variants.

## Goals

- Support user-provided shaders/materials for NovelTea projects.
- Keep bgfx as the only graphics backend abstraction used by runtime rendering.
- Support Linux desktop GL, Web/WebGL, Android GLES, and later Metal targets through compiled shader variants.
- Allow editor hot reload and diagnostics during development.
- Package projects with all required compiled shader binaries so shipped games do not require a shader compiler.
- Provide a clean RmlUi `shader(<string>)` bridge by resolving the string to a NovelTea material, not by compiling arbitrary shader source at runtime.
- Keep the reusable `rmlui_bgfx` renderer core independent from NovelTea asset and material concepts.

## Non-Goals

- Do not bypass bgfx with direct OpenGL/WebGL/Metal shader compilation in the normal renderer.
- Do not require shader compilation inside Web, Android, or shipped desktop runtimes.
- Do not expose arbitrary raw render state through RmlUi RCSS in the first implementation.
- Do not let RmlUi custom shaders mutate the renderer's layer, clip, transform, or framebuffer ownership rules.
- Do not implement a full visual shader graph in the first pass. The initial editor can expose a material file, shader source path, uniforms, textures, and target variants.

## Core Constraint

bgfx runtime APIs create shaders and programs from bgfx shader binaries. Even though the raw underlying APIs can often compile shader source at runtime, bgfx's portable path is offline compilation through `shaderc` for the target renderer/profile.

NovelTea should therefore treat shader source as an authoring asset and compiled shader binaries as runtime assets.

```text
Authoring/input:
  project:/shaders/ui/noise_panel.sc
  project:/materials/ui/noise_panel.ntmat

Build/cache/export output:
  cache:/compiled-shaders/<hash>/linux-glsl/noise_panel.vs.bin
  cache:/compiled-shaders/<hash>/linux-glsl/noise_panel.fs.bin
  cache:/compiled-shaders/<hash>/web-essl100/noise_panel.vs.bin
  cache:/compiled-shaders/<hash>/web-essl100/noise_panel.fs.bin
  cache:/compiled-shaders/<hash>/android-essl/noise_panel.vs.bin
  cache:/compiled-shaders/<hash>/android-essl/noise_panel.fs.bin

Runtime/package input:
  project:/compiled-shaders/<platform-profile>/<shader-id>.*.bin
  project:/materials/**/*.ntmat
```

The exact platform-profile names should match the existing shader asset convention under `assets/shaders/bgfx/{linux-glsl,android-essl,web-essl100}` unless a later shader packaging refactor changes that convention globally.

## Material Types

NovelTea should distinguish material classes by render contract. They can share schema infrastructure, compiler infrastructure, and uniform binding code, but they should not pretend to be interchangeable.

NovelTea should also distinguish high-level materials from lower-level shader program references. Rich-text material tags resolve to `MaterialId` / `.ntmat`. ActiveText's low-level shader BBCode already preserves separate `fragment_shader_id` and `vertex_shader_id` fields on `RichTextStyle`; that path should resolve through the shader manifest/program cache directly, not by inventing an implicit material asset.

### Engine 2D Material

Used by the engine's own 2D draw path, `QuadCommand`, map overlays, ActiveText effects, room backgrounds, object sprites, and future non-RmlUi primitives.

Contract:

- Engine-defined vertex format.
- Engine-defined view/layer ordering.
- Engine-controlled render state.
- Optional texture slots.
- Premultiplied-alpha output for normal 2D blending.
- More flexible than RmlUi UI materials, but still constrained by the engine renderer.

### RmlUi Decorator Material

Used by RmlUi's generic `shader(<string>)` decorator.

Contract:

- Renders RmlUi-provided geometry.
- Uses RmlUi paint-area UVs normalized to `[0, 1]`.
- Uses current RmlUi translation and transform semantics.
- Respects RmlUi scissor, clip mask, layer, and composite behavior.
- Outputs premultiplied alpha.
- Cannot change framebuffer/layer ownership or issue additional passes in the first version.

### RmlUi Filter Material

Future extension for custom RmlUi filters.

Contract:

- Consumes a source layer texture or texture region.
- Executes over a bounded work rectangle.
- Produces premultiplied-alpha output.
- Must participate in WebGL feedback-loop protection and target-cache reuse.

This should not be part of the first implementation unless there is an immediate product need.

### Postprocess Material

Future extension for fullscreen or bounded postprocess effects outside RmlUi.

Contract:

- Operates on render targets, not ordinary sprite geometry.
- Explicitly declares required inputs, output size policy, and feedback-loop constraints.

## Material Asset Schema

Use a stable project asset format such as `.ntmat`. JSON is acceptable initially because the project format already uses JSON-like tooling. A future editor can wrap it with a friendlier UI.

Example RmlUi decorator material:

```json
{
  "schema": "noveltea.material.v1",
  "type": "rmlui-decorator",
  "display_name": "Noise Panel",
  "shader": {
    "vertex": "system:/shaders/materials/rmlui_decorator.vs.sc",
    "fragment": "project:/shaders/ui/noise_panel.fs.sc"
  },
  "uniforms": {
    "u_tint": {
      "type": "color",
      "default": "#66ccffff",
      "editor": { "label": "Tint" }
    },
    "u_amount": {
      "type": "float",
      "default": 0.25,
      "range": [0.0, 1.0],
      "editor": { "label": "Noise Amount" }
    },
    "u_time_scale": {
      "type": "float",
      "default": 1.0
    }
  },
  "textures": {
    "s_noise": {
      "source": "project:/textures/noise.png",
      "sampler": "clamp-linear"
    }
  },
  "inputs": {
    "u_time": "engine.time",
    "u_dimensions": "rmlui.paint_dimensions",
    "u_dpi_scale": "rmlui.dpi_scale"
  },
  "blend": "premultiplied-alpha"
}
```

Example engine 2D material:

```json
{
  "schema": "noveltea.material.v1",
  "type": "engine-2d",
  "display_name": "Water Sprite",
  "shader": {
    "vertex": "system:/shaders/materials/engine_2d.vs.sc",
    "fragment": "project:/shaders/world/water.fs.sc"
  },
  "uniforms": {
    "u_wave_strength": { "type": "float", "default": 0.15 },
    "u_tint": { "type": "color", "default": "#ffffffff" }
  },
  "textures": {
    "s_albedo": { "source": "$draw.texture", "sampler": "clamp-linear" },
    "s_noise": { "source": "project:/textures/water_noise.png", "sampler": "repeat-linear" }
  },
  "inputs": {
    "u_time": "engine.time"
  },
  "blend": "premultiplied-alpha"
}
```

## Uniform Policy

RmlUi RCSS should not be the primary uniform authoring language.

Initial policy:

- `shader(<string>)` names a material id or material asset path.
- Uniform declarations live in the `.ntmat` file.
- Default uniform values live in the `.ntmat` file.
- The editor exposes material uniforms through material-instance UI.
- Engine-provided values are bound through named inputs such as `engine.time`, `rmlui.paint_dimensions`, `rmlui.dpi_scale`, and eventually `runtime.state.*` where safe.
- Per-element RmlUi overrides are deferred until the material system and RmlUi bridge are stable.

Allowed initial RmlUi syntax:

```css
.panel {
    decorator: shader("ui/noise_panel");
}

.alert {
    decorator: shader("project:/materials/ui/alert_panel.ntmat");
}
```

Deferred optional syntax:

```css
.panel {
    decorator: shader("ui/noise_panel?amount=0.35&tint=#66ccff");
}
```

Do not implement query-string overrides in the first pass. They mix material authoring into RCSS and make validation and editor tooling harder. Prefer material instances or a later NovelTea-specific custom decorator/property system.

Possible future custom syntax, only after the first material bridge is working:

```css
.panel {
    decorator: nt-material(noise_panel);
    nt-material-amount: 0.35;
    nt-material-tint: #66ccff;
}
```

## Runtime Architecture

Add engine-level material infrastructure that is independent from RmlUi.

```text
MaterialAsset
  parsed .ntmat data: type, shader refs, uniforms, textures, inputs, render state

MaterialId
  stable project/runtime id, usually a normalized project asset path or registry alias

MaterialRegistry
  resolves MaterialId -> MaterialAsset
  resolves MaterialAsset -> platform MaterialProgram
  owns material instances and default/fallback materials

ShaderCompilerService
  editor/import/export only
  invokes shaderc for configured target profiles
  emits compiled shader binaries and diagnostics
  writes shader manifest/cache metadata

ShaderProgramCache
  runtime
  loads compiled bgfx shader binaries through AssetManager
  creates bgfx ShaderHandle/ProgramHandle
  caches by shader hash/platform/profile/variant

MaterialBinder
  runtime
  binds bgfx program, uniforms, textures, and render state for a draw call

MaterialInstance
  overrides default uniforms/textures for a project object, style, or editor instance
```

The runtime side should not invoke `shaderc`. It should load compiled shader binaries or fail with a clear diagnostic that names the missing material id, platform profile, and expected compiled shader path.

## RmlUi Bridge Architecture

The reusable `rmlui_bgfx` core should not include NovelTea material headers. Instead, add a small provider interface to the reusable renderer core, and implement that provider in NovelTea's adapter.

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

The exact names can change, but the dependency direction cannot. NovelTea adapts materials to the reusable renderer; the reusable renderer must not learn about `project:/`, `.ntmat`, editor state, or NovelTea runtime session objects directly.

First implementation behavior in `CompileShader()`:

- If `name` is `linear-gradient`, `radial-gradient`, or `conic-gradient`, keep the existing built-in gradient path.
- If `name` is `shader`, read `parameters["value"]` and `parameters["dimensions"]`.
- Ask the material shader provider to resolve the value as a NovelTea material id/path.
- Return a RmlUi compiled shader handle that records the provider-owned material shader handle.
- If no provider is configured or resolution fails, log a clear diagnostic and return zero.
- Unknown names remain unsupported until a specific extension policy exists.

First implementation behavior in `RenderShader()`:

- Built-in gradient handles continue using the current gradient shader path.
- Material shader handles call the material provider submission path.
- The submission path receives current texture, geometry, translation, scissor, transform, clip/stencil state, layer projection, and paint dimensions as explicit state.
- The material provider binds the bgfx program, uniforms, textures, and declared render state, but it must not mutate layer stack or pass scheduling directly.

## Shader Source Conventions

User-authored shader source should use the bgfx shaderc language conventions, not raw per-platform GLSL/MSL source.

Initial constraints:

- Provide system vertex shaders for common contracts:
  - `rmlui_decorator.vs.sc`
  - `engine_2d.vs.sc`
  - later `postprocess_fullscreen.vs.sc`
- User-authored RmlUi decorator materials usually provide only a fragment shader.
- User-authored engine 2D materials may provide a fragment shader and optionally a specialized vertex shader after the first pass.
- All material shaders must use declared uniform and sampler names from the `.ntmat` file.
- RmlUi decorator shaders must output premultiplied-alpha color.
- Shader source includes should resolve only through explicit system/project shader include roots.

Initial built-in RmlUi decorator fragment inputs should include:

```text
v_texcoord0        normalized paint-area UV from RmlUi
v_color0           RmlUi vertex color, already normalized by bgfx
s_texColor         optional RmlUi texture if the geometry has one
u_materialParams*  material-declared uniforms packed according to reflection/manifest
u_time             optional engine time input when declared
u_dimensions       paint dimensions when declared
u_dpiScale         dpi scale when declared
```

Do not promise arbitrary uniform names unless the material compiler/manifest has a reliable way to preserve and bind them on every target.

## Compiler and Cache Pipeline

### Editor/import path

1. Parse `.ntmat`.
2. Validate type, shader source paths, uniform declarations, texture slots, blend policy, and input bindings.
3. Compute a stable hash from shader source, includes, material schema, compiler version, target profile, and relevant flags.
4. Invoke `shaderc` for each configured target profile.
5. Store compiled shader binaries under a cache path keyed by hash/profile.
6. Store diagnostics in a form the editor can display inline.
7. Write/update a shader manifest that maps material id + profile -> compiled binary paths and reflection metadata.

### Runtime path

1. Load `.ntmat` and shader manifest.
2. Select the active platform/profile.
3. Load the compiled vertex/fragment shader binaries through AssetManager.
4. Create bgfx shader handles and program handles.
5. Bind uniforms and textures for each draw.
6. If anything is missing, use a visible fallback material and log an actionable diagnostic.

### Package/export path

1. Compile all project materials for selected export targets.
2. Fail export by default if required material variants fail to compile.
3. Include compiled binaries and the material manifest in the package.
4. Do not include `shaderc` or source shader compiler dependencies in the runtime package unless explicitly exporting an editor/dev build.

## Hot Reload

Editor hot reload should be host-only.

- Watch `.ntmat` files, shader source files, and included shader files.
- Recompile affected target profiles for the active preview backend.
- Replace bgfx programs safely at frame boundaries.
- Keep the previous valid program alive until the replacement compiles and links successfully.
- Surface diagnostics in the editor and runtime debug overlay.
- Never require hot reload on Web/Android packaged runtime.

## Fallbacks and Diagnostics

Every material resolution or compilation failure must report:

- Material id/path.
- Material type.
- Referencing asset or RmlUi document if known.
- Target platform/profile.
- Missing shader source or compiled binary path.
- `shaderc` command line and stderr for compile failures.
- Fallback material used.

Fallback materials:

- RmlUi decorator fallback: magenta/black checker or obvious error tint constrained to the element geometry.
- Engine 2D fallback: visible checker quad with object/material id logged.
- Missing texture fallback: existing checker texture or a material-specific fallback texture.

Do not silently return zero for project-authored materials after the material system exists. Returning zero is acceptable for RmlUi unsupported names before the provider is configured, but once a material id is explicitly requested, diagnostics should be clear.

## Security and Portability Notes

NovelTea user-provided shaders are project code/assets. They are not safe sandboxed scripts. The editor should treat them like source files that can fail compilation or render badly, not like untrusted code that can be executed safely everywhere.

Portability rules:

- Prefer bgfx shaderc source conventions over raw GLSL/MSL/HLSL.
- Avoid target-specific preprocessor branches in user materials unless the editor can validate all target profiles.
- Keep the first material contract small so WebGL/GLES2 limitations are respected.
- Avoid dynamic sampler arrays, unsupported texture formats, and platform-specific precision assumptions in initial templates.

## Implementation Phases

### Phase 0: Policy and Inventory `[implemented]`

- Confirm target platform/profile names and shader asset layout.
- Audit existing `render/material.hpp` and `render/shader.hpp` stubs.
- Decide the initial material schema location and extension, likely `.ntmat`.
- Decide whether material ids are normalized project paths, aliases, or both.
- Add documentation links from RmlUi status/audit docs and migration docs.

Acceptance:

- The docs agree that runtime shader source compilation is not the normal path.
- RmlUi `shader(<string>)` is defined as a material reference.
- Deferred material/shader stubs point at this plan.

### Phase 1: Runtime Material Data Model `[implemented]`

- Add `MaterialId`, `MaterialType`, `MaterialAsset`, `MaterialUniform`, `MaterialTextureSlot`, `MaterialInputBinding`, and `MaterialBlendMode` types.
- Parse `.ntmat` into the runtime model.
- Validate schema and emit diagnostics.
- Add fallback material records.
- Add tests for schema parsing and validation.

Acceptance:

- Valid material JSON parses.
- Invalid material JSON reports specific errors.
- Material ids normalize consistently across project paths and aliases.

Implemented model:

- `engine/include/noveltea/render/material.hpp` now defines the backend-neutral `.ntmat` runtime model, including `MaterialId`, `MaterialType`, shader source refs, uniforms, texture slots, input bindings, blend policy, structured diagnostics, and fallback material records.
- `engine/src/render/material.cpp` parses `.ntmat` JSON using schema `noveltea.material.v1` and validates supported material types, shader refs, uniform declarations/defaults, texture slot names/sources/samplers, input bindings, and blend policy.
- Material id aliases such as `ui/noise_panel` normalize to `project:/materials/ui/noise_panel.ntmat`; explicit project/system material asset paths are preserved when they already target `materials/*.ntmat`.
- `rmlui-filter` and `postprocess` are recognized but rejected as deferred material types until the later custom filter/postprocess phases.
- Tests live in `tests/render/material_asset_tests.cpp` and cover valid engine 2D/RmlUi decorator materials, invalid schema cases, material id normalization, diagnostics, and fallback records.

### Phase 2: Shader Manifest and Runtime Program Loading

- Add backend-neutral shader identifiers for direct shader refs, likely `ShaderId`, `ShaderStage`, and `ShaderProgramId` / `ShaderPairRef`.
- Add a shader manifest format mapping material id/profile/variant to compiled shader binaries.
- Extend the shader manifest format so it can also resolve direct ActiveText shader pairs from preserved vertex/fragment shader ids.
- Add runtime `ShaderProgramCache` that loads compiled binaries through AssetManager and creates bgfx programs.
- Add program-cache keys that distinguish material-owned programs from direct shader-pair programs.
- Add uniform/sampler reflection or declared-bind metadata for later material binding and direct ActiveText shader binding.
- Add clear fallback behavior for missing compiled variants:
  - missing material programs use material fallback records;
  - missing direct ActiveText shader pairs fall back to the default text/ActiveText shader path.
- Add tests for manifest selection and missing variant diagnostics for both material programs and direct shader-pair programs.

Acceptance:

- Runtime can load a precompiled material program for the active backend.
- Runtime can load a precompiled direct shader-pair program for ActiveText low-level shader metadata.
- Missing material program diagnostics name the material id, active profile, and expected profile/path.
- Missing direct shader-pair diagnostics name the vertex/fragment shader ids, active profile, and expected profile/paths.

### Phase 3: Editor/Import Shader Compilation

- Add a host-side `ShaderCompilerService` wrapper around `shaderc`.
- Compile source for active development profile first, then configured export profiles.
- Cache outputs by content hash.
- Capture diagnostics for editor display.
- Add a small command-line or CMake-invoked tool path for CI/package builds.

Acceptance:

- A sample `.ntmat` compiles for linux-glsl and web-essl100.
- Failed shader compilation produces readable diagnostics.
- Re-running without source changes hits the cache.

### Phase 4: Engine 2D Material Binding

- Extend `QuadCommand` or the 2D render path with optional `MaterialId` / `MaterialInstanceId`.
- Bind material program, uniforms, textures, and blend state for engine-owned 2D primitives.
- Keep default textured/colored quad path fast and unchanged for ordinary sprites.
- Add a sample material-backed quad in sandbox.

Acceptance:

- Existing sprite/quad demos render unchanged without custom materials.
- A sample custom material renders in Linux and Web release/profile.
- Missing material falls back visibly and logs diagnostics.

### Phase 5: RmlUi `shader(<string>)` Material Bridge

- Add a material shader provider interface to reusable `rmlui_bgfx` core without NovelTea dependencies.
- Implement NovelTea adapter provider that resolves `shader(<string>)` values through `MaterialRegistry`.
- Extend shader records to distinguish built-in gradients from material shader handles.
- Submit material shaders through explicit RmlUi draw state and material binder.
- Add sample RML/RCSS fixture using `decorator: shader("ui/noise_panel")`.

Acceptance:

- Built-in gradients still render exactly as before.
- Generic RmlUi `shader(<string>)` resolves to a NovelTea material.
- The sample material respects scissor, transform, clip mask, layers, and premultiplied-alpha output.
- Readback and web smoke continue to pass.

### Phase 6: Editor Material UI and Instances

- Add editor UI for material assets, uniforms, texture slots, and preview.
- Add material instances for project objects/styles without duplicating shader source.
- Add validation indicators for missing compiled profiles.
- Add hot reload for desktop/editor preview.

Acceptance:

- A designer can edit material uniform defaults and see preview changes.
- Invalid shader source reports errors without crashing runtime preview.
- Previous valid program remains active after a failed hot reload.

### Phase 7: Package and Export Integration

- Compile all referenced materials during export.
- Include compiled shader variants, material assets, and manifest metadata in packages.
- Fail release export on missing required variants by default.
- Add CI/export smoke for material-backed project content.

Acceptance:

- Web package contains all required material shader binaries.
- Android package contains all required material shader binaries.
- Runtime package does not require `shaderc`.

### Phase 8: Custom Filters and Postprocess Materials

Only start this after decorator and engine 2D materials are stable.

- Define `rmlui-filter` material contract for custom filters.
- Define `postprocess` material contract for fullscreen/bounded effects.
- Integrate with target cache, feedback-loop protection, and perf counters.
- Add fixtures for custom filter material and postprocess material.

Acceptance:

- Custom filters preserve RmlUi layer/filter ordering.
- No WebGL feedback-loop errors.
- Perf counters classify material filter/postprocess passes.

## Documentation Updates Required With Implementation

When this plan is implemented, keep these docs in sync:

- `docs/rendering/RMLUI_RENDER_INTERFACE_AUDIT.md`: move generic `shader(<string>)` from unsupported to implemented/verified when Phase 5 passes.
- `docs/rendering/RMLUI_BGFX_STATUS.md`: update acceptance gates and next implementation task.
- `docs/rendering/RMLUI_BGFX_RENDERER_ARCHITECTURE.md`: document the material provider boundary once interface names settle.
- `docs/rendering/RENDERING_STACK.md`: update shader/material asset pipeline and remove stale deferred notes.
- `docs/migration/PLAN.md`: replace the Phase 11 deferred material/shader note with the implemented phase or point to this plan.
- `docs/migration/STATUS.md`: update the deferred material/shader status.

## First Implementation Prompt

```text
Implement Phase 0 and Phase 1 of docs/rendering/NOVELTEA_SHADER_MATERIAL_PLAN.md.

Do not add runtime shader source compilation. Do not bypass bgfx. Start by auditing existing render/material.hpp and render/shader.hpp stubs, then add a backend-neutral material data model and .ntmat parser/validator. RmlUi shader(<string>) should be defined as a material reference, but do not wire it into rmlui_bgfx yet.

Keep the first implementation runtime-safe: parse material assets, normalize MaterialId values, validate material type/shader refs/uniforms/textures/inputs/blend policy, and provide clear diagnostics. Add tests for valid and invalid .ntmat data. Update docs/status when complete.
```
