# NovelTea Rendering Action Plan

This document replaces the old completed Phase 4.5 RmlUi bgfx refactor checklist. The detailed stage-by-stage extraction plan is intentionally removed because it is now historical noise: the reusable `rmlui_bgfx` boundary, target cache, pass builder, draw context, filter pipeline, layer system, adapter cleanup, and resize/readback regression coverage are implemented.

Use this document as the current action plan for renderer work that crosses RmlUi, bgfx, NovelTea materials, shader packaging, and runtime/editor integration.

For detailed status and background, see:

- [`RMLUI_BGFX_STATUS.md`](RMLUI_BGFX_STATUS.md) for current RmlUi bgfx renderer status and perf truth.
- [`RMLUI_RENDER_INTERFACE_AUDIT.md`](RMLUI_RENDER_INTERFACE_AUDIT.md) for RmlUi render-interface feature coverage.
- [`NOVELTEA_SHADER_MATERIAL_PLAN.md`](NOVELTEA_SHADER_MATERIAL_PLAN.md) for user-provided shaders/materials and the RmlUi `shader(<string>)` bridge.
- [`RMLUI_BGFX_RENDERER_ARCHITECTURE.md`](RMLUI_BGFX_RENDERER_ARCHITECTURE.md) for reusable renderer architecture and ownership boundaries.

## Current Truth

The RmlUi bgfx renderer is no longer in a performance emergency state. The representative readback gallery reaches the browser/display cap in Web release/profile and keeps the bounded-compositor invariants:

```text
fps=120
passes=89 views=43 view_reuses=46
full_frame_child_layers=0
unbounded_layer_fallbacks=0
unbounded_no_scissor_fallbacks=0
unbounded_transform_fallbacks=0
unbounded_inverse_clip_fallbacks=0
full_frame_postprocess_passes=0
rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 after warmup
```

The old 5-7 FPS Web readings were debug/WebGL validation artifacts unless reproduced in an optimized release/profile build with render perf counters compiled in, runtime perf logging explicitly enabled, and ImGui disabled.

The next renderer work is therefore not more speculative pass-count reduction. The next work is:

1. Harden release/profile smoke coverage so this confusion does not happen again.
2. Build the NovelTea project-schema shader/material pipeline and compiled shader-binary asset path.
3. Bridge RmlUi `shader(<string>)` to NovelTea materials.
4. Add missing RmlUi feature fixtures.
5. Defer additional RmlUi bgfx optimization until a concrete fixture or profile proves the need.

## Retained Lessons From The Completed Refactor

Keep these lessons. They still matter for future renderer/material work.

### Reusable Boundary

The reusable `rmlui_bgfx` core must not depend on NovelTea engine headers, NovelTea `AssetManager`, NovelTea `SurfaceMetrics`, NovelTea shader-loader enums, NovelTea view IDs, SDL3, Lua, ImGui, runtime session objects, editor preview code, or NovelTea custom components.

NovelTea adapts to the renderer through providers. The renderer core should expose seams for texture loading, shader/program loading, diagnostics, perf logging, and future material shader submission. NovelTea owns project/game schema shader and material records, material registry lookup, inferred shader variant selection, editor/package compilation policy, shader-binary assets, and runtime session integration.

### Bounded Compositor Invariants

Do not regress these for bounded scenes:

```text
full_frame_child_layers=0
unbounded_layer_fallbacks=0
full_frame_postprocess_passes=0
rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 after warmup
max_child_layer and max_rt near affected content size, not framebuffer size
```

Full-frame work is legitimate only when the root presentation policy requires an offscreen base/final composite or when the actual content/effect is full-screen.

### TextureRegion Discipline

Any path that passes a texture plus bounds must keep the texture handle, global bounds, local/source rect, texture width, and texture height together. Do not reintroduce APIs that pass several unlabeled rectangles and texture dimensions separately.

This is especially important for:

- Layer composites.
- Filter inputs/outputs.
- Saved textures.
- Saved mask images.
- Future RmlUi material shader submission.
- Future custom filter materials.

### Target Cache Rules

Do not allocate/destroy child layer or postprocess targets every frame. Child layer targets and postprocess targets must be reused after warmup.

Postprocess target caches must be keyed by at least kind and dimensions. A single resizable target per kind caused churn and native instability.

Do not return pointers into containers that can invalidate during later target acquisitions in the same frame.

### Pass Builder Rules

bgfx view setup belongs in one pass builder/scheduler path. Avoid scattering raw `setViewRect`, `setViewFrameBuffer`, `setViewClear`, and view naming policy across feature code.

Pass/view count is useful diagnostic data, but it is no longer the primary blocker for the current gallery. Do not chase pass-count reductions by dropping semantics.

### Layer Clear Rules

Bounded child-layer clears are not automatically redundant. They are often required because replay uses alpha blending, transparent regions, stencil/clip state, and previously reused targets. Skipping clears must be proven with a focused fixture, not assumed from the perf counter.

### Filter Copy Rules

Remaining blur/drop-shadow copies are conservative and bounded. Removing them safely requires a larger UV-aware filter shader/input refactor with visual regression coverage. Do not remove them opportunistically.

### WebGL Feedback-Loop Rules

Do not sample from a texture attached to the destination framebuffer. Same-layer or same-target composition paths must use scratch targets, direct-source-safe paths, or fail clearly. This rule applies to future material and custom filter work too.

## Current Action Plan

### Action 0: Land The Current Cleanup

Before beginning another implementation slice, commit the current profiling/docs cleanup in coherent commits.

Recommended split:

```text
1. Fix release profiling controls
2. Document renderer status and shader/material plan
```

This avoids mixing the material-system implementation with run-script, DebugUI, and planning changes.

Acceptance:

- Working tree is clean before material implementation begins.
- The commits preserve the distinction between runtime perf support being compiled in and runtime perf logging being explicitly enabled.

### Action 1: Add Release/Profile Web Smoke `[implemented]`

Goal: make release/profile Web measurement repeatable and prevent debug WebGL validation overhead from being mistaken for renderer cost.

Implemented path:

- `web-profile` CMake preset builds an optimized Web profile into `build/web-profile` with `NOVELTEA_ENABLE_RENDER_PERF=ON`.
- `pnpm run web:smoke:profile` runs `scripts/web-smoke.mjs` against `build/web-profile` with the `readback_gallery_profile` thresholds.
- `pnpm run web:smoke:debug` remains the debug structural smoke against `build/web-debug`; `pnpm run web:smoke` is the debug alias.
- Runtime URL flags are explicit: `renderPerf=1`, `noImgui=1`, `demo=none`, and `rmlui-document=project:/rmlui/readback_gallery.rml`.
- Structural threshold checks match the current bounded shape, including exact zero allocation/destroy counters on the warmed profile perf line.
- FPS is captured and displayed as informational only.

Gate these counters:

```text
full_frame_child_layers=0
unbounded_layer_fallbacks=0
unbounded_no_scissor_fallbacks=0
unbounded_transform_fallbacks=0
unbounded_inverse_clip_fallbacks=0
full_frame_postprocess_passes=0
full_frame_postprocess_target_uses=0
rt_alloc=0 rt_destroy=0
layer_alloc=0 layer_destroy=0
max_child_layer scaled to framebuffer/content fixture
max_rt scaled to framebuffer/content fixture
```

Acceptance:

- Existing debug web smoke remains useful for structural correctness.
- New release/profile web smoke reports the optimized bounded shape.
- FPS is displayed/logged but does not decide pass/fail.
- The smoke documents which build preset/profile it uses.

### Action 2: Realign Material Plan Phase 0/1 To Project Schema `[implemented]`

Goal: establish the backend-neutral shader/material data model before any bgfx program loading or RmlUi integration.

Implemented path:

- Replaced the standalone `.ntmat`-oriented model with backend-neutral `ShaderDefinition` and `MaterialDefinition` records.
- Added `ShaderId` and revised `MaterialId` so both normalize as stable project schema ids/aliases instead of material asset paths.
- Added shader records with stages, authoring source refs/source text placeholders, compiled binary refs, uniform declarations, sampler declarations, supported shader roles, and role-specific stage-pair bindings.
- Added material records with selected shader role, shader reference, uniform assignments, texture assignments, blend policy, and fallback records.
- Moved uniform/sampler declarations to shader records; material records now assign values/textures and validate them against the referenced shader.
- Added shader-role compatibility validation so materials can use a shader only under a declared or explicitly adapted role.
- Added diagnostics for invalid shader ids, invalid material ids, unknown shader refs, invalid uniform values, undeclared uniforms/samplers, unsupported/deferred shader roles, incompatible shader/material roles, invalid compiled binary refs, and invalid source refs.
- Updated `tests/render/material_asset_tests.cpp` to cover project-schema shader/material records instead of standalone material files.

Still intentionally not implemented:

- `shaderc` invocation outside the existing system-shader build path.
- Runtime shader source compilation.
- bgfx program creation for user/project shaders.
- RmlUi `shader(<string>)` bridge.
- Editor UI.

Acceptance:

- Valid project-schema shader/material records parse into a stable runtime model.
- Invalid shader/material records report actionable diagnostics.
- Tests cover material id normalization as project ids, shader interface declarations, material value validation, and shader-role compatibility.
- `noveltea_render_tests`, CTest `material`, and CTest `shader` checks pass.

### Action 3: Add Shader Manifest And Runtime Program Loading `[implemented]`

Goal: teach runtime how to resolve and load precompiled bgfx shader variants for both high-level materials and NovelTea's lower-level ActiveText shader BBCode contract.

Implemented path:

- Added backend-neutral runtime shader-resolution types in `noveltea/render/shader_manifest.hpp` without introducing a mutable renderer-owned `Shader` object.
- Added `resolve_material_shader_program()` for `MaterialId` + selected `ShaderRole` + inferred active variant.
- Added `resolve_direct_shader_pair_program()` for ActiveText's preserved `vertex_shader_id` / `fragment_shader_id` path without forcing that path through material records.
- Reused `ShaderDefinition::stages[].compiled` as the first runtime manifest source. A future generated manifest can feed the same resolver model.
- Role-specific stage bindings are honored first. If a material shader record has only a fragment stage, it must declare a role binding to an appropriate vertex shader instead of guessing.
- Added uniform/sampler metadata propagation from resolved shader definitions for later material binding and direct ActiveText shader binding.
- Added material-vs-direct cache keys that include request kind, ids, role, inferred variant, and resolved binary paths.
- Added `BgfxShaderProgramCache`, which consumes resolved program metadata, loads compiled binaries through `AssetManager`, creates bgfx programs, owns program lifetimes, and preserves the existing system-shader fast paths.
- Added focused tests in `tests/render/shader_manifest_tests.cpp` covering material role bindings, shared fragment shaders across roles, direct ActiveText shader-pair resolution, missing variant diagnostics, missing role-binding diagnostics, and cache-key separation.

Still intentionally not implemented:

- Runtime shader source compilation.
- Editor/import/export `shaderc` service.
- Uniform/texture binding into draw calls.
- Engine 2D material-backed quad rendering.
- RmlUi `shader(<string>)` bridge.
- Replacing existing default sprite/quad/text/RmlUi system shader paths with material paths.

Acceptance:

- Runtime metadata resolution can select a precompiled material program for the active backend variant.
- Runtime metadata resolution can select a precompiled direct shader-pair program for ActiveText low-level shader metadata.
- The bgfx program cache can load the resolved compiled binaries through `AssetManager` and create/cache bgfx programs when called from an initialized bgfx runtime.
- Missing inferred variant diagnostics name the correct caller context: material id for material programs, vertex/fragment shader ids for direct shader pairs.
- Existing non-material sprites/quads still render through the fast default path.
- Existing ActiveText without low-level shader metadata still renders through the normal/default text path.

### Action 4: Add Editor/Import/Export Shader Compilation `[implemented]`

Goal: compile authoring shader source into runtime bgfx binaries during host/editor workflows.

Implemented path:

- Added host-side `ShaderCompilerService` in `noveltea/render/shader_compiler.hpp`.
- Added current compile-variant mapping for `glsl-120`, `essl-100`, and `essl-300` using the existing bgfx shaderc platform/profile conventions.
- Compiles project `ShaderDefinition::stages` from either `source` refs or `source_text` temporary source files.
- Emits runtime binary paths matching the existing package/runtime layout: `shaders/bgfx/<variant>/<shader-id>.<vs|fs>.bin`.
- Updates returned shader metadata with compiled refs for successful outputs without mutating project files implicitly.
- Adds cache metadata under `<cacheRoot>/shader-cache/manifest.json`; unchanged source/interface/variant combinations report cache hits and skip compilation.
- Captures command line, output path, source path, exit code, and compiler stdout/stderr in diagnostics.
- Adds `noveltea-editor-tool compile-shaders` so editor/import/export workflows can invoke the service through JSON.
- Adds fake-compiler tests for source refs, `source_text`, cache hits, missing source/tool diagnostics, failed compiler diagnostics, and variant mapping.

Still intentionally not implemented:

- Runtime shader source compilation.
- Automatic package-export compilation.
- Hot-reload program swapping.
- Engine 2D material binding.
- RmlUi `shader(<string>)` material bridge.

Acceptance:

- Project-schema shader stages can compile for the Linux/Web/Android variant names known to the build.
- Failed shader compilation reports readable diagnostics with command context and compiler output.
- Re-running without source changes hits cache.
- Runtime packages still do not require `shaderc`.

### Action 5: Bind Materials To Engine 2D Rendering `[implemented]`

Goal: validate the material system on the simpler engine 2D draw contract before RmlUi integration.

Implemented path:

- `QuadCommand` now carries an optional `MaterialId` while existing colored/textured quad helpers continue to emit commands with no material id.
- `QuadBatch` has explicit material-backed quad helpers for colored and textured material quads.
- `Renderer` can receive a parsed `ShaderMaterialProject` through `set_shader_material_project()`.
- `BgfxMaterialBinder` resolves `ShaderRole::Engine2D` material ids, loads programs through `BgfxShaderProgramCache`, binds packed vec4 uniforms, binds material sampler assignments, maps sampler filtering to bgfx sampler flags, and falls back to the existing default quad path if material binding fails.
- The Render2D sandbox demo now includes a material-backed textured quad using the existing compiled `quad` shader binaries through material metadata.
- Tests cover default-command no-material preservation, material command metadata, sampler flag mapping, and uniform packing.

Still intentionally not implemented:

- RmlUi `shader(<string>)` bridge.
- ActiveText custom shader rendering.
- Full image decoding for material textures beyond the current PPM/runtime texture path.
- Package export auto-compilation.
- Runtime shader source compilation.

Acceptance:

- Existing colored/textured quad commands remain material-free by default.
- The material-backed Render2D sandbox smoke runs on Linux/Xvfb without material diagnostics.
- Missing material/program/texture paths fall back to the default quad path and log diagnostics.

### Action 6: Bridge RmlUi `shader(<string>)` To NovelTea Materials

Goal: close the generic RmlUi shader gap using the material system.

Implement:

- A provider seam in reusable `rmlui_bgfx` core for material decorator shaders.
- NovelTea adapter/provider that resolves `shader(<string>)` through `MaterialRegistry`.
- Shader records that distinguish built-in gradients from provider-backed material shader handles.
- Material shader submission with explicit RmlUi state:
  - geometry
  - translation
  - current transform
  - layer projection
  - scissor
  - clip/stencil state
  - optional texture
  - paint dimensions
- RML/RCSS fixture using `decorator: shader("ui/noise_panel")`.

Do not put NovelTea material headers in reusable `rmlui_bgfx` files.

Acceptance:

- Built-in gradients still render as before.
- Generic RmlUi `shader(<string>)` resolves to a NovelTea project material id.
- The sample material respects scissor, transforms, clip masks, layers, and premultiplied-alpha output.
- Linux readback, resize-readback, and Web release/profile smoke pass.
- `RMLUI_RENDER_INTERFACE_AUDIT.md` moves generic `shader(<string>)` from planned/unsupported to implemented or verified as appropriate.

### Action 7: Add Missing RmlUi Feature Fixtures

Goal: turn under-verified render-interface features into concrete regression coverage.

Priority order:

1. `backdrop-filter` fixture.
2. CSS `box-shadow` fixture.
3. Perspective/3D transform fixture.
4. `BlendMode::Replace` fixture if reachable through RmlUi markup/property behavior.
5. Nested `PopLayer()` state restoration test with scissor, transform, and clip mask.
6. Lifecycle tests for `ReleaseGeometry()`, `ReleaseTexture()`, `ReleaseFilter()`, and `ReleaseShader()`.

Acceptance:

- Each fixture either verifies support or records a precise unsupported limitation.
- The audit/status docs are updated after each fixture.
- No feature fixture is allowed to weaken existing bounded-compositor gates.

### Action 8: Android And Package Verification

Goal: prove material and renderer behavior outside Linux/Web desktop development loops.

Implement:

- Android packaging check for compiled material shader binaries.
- Android runtime smoke if practical.
- Package/export smoke for material-backed project content.
- Diagnostics for missing material variants in packages.

Acceptance:

- Web package includes required compiled material variants.
- Android package includes required compiled material variants.
- Missing variant failure is caught before or during export, not after a silent runtime fallback in release packages.

## Explicitly Deferred Work

Do not start these until the above actions or a concrete profile/fixture justifies them:

- More RmlUi pass/view count reduction.
- Direct base presentation tuning.
- Filter per-valid-rect pixel tightening.
- Blur downsample/large-sigma quality work.
- Custom RmlUi filter materials.
- Postprocess materials.
- Runtime raw GL/GLES/WebGL/Metal shader source compilation.
- Physical extraction of `rmlui_bgfx` to a separate repository.

## Verification Commands

Use narrow checks during small doc or schema-only changes:

```sh
git diff --check
cmake --build --preset linux-debug --target noveltea_render_tests --parallel
ctest --test-dir build/linux-debug -R "material|shader|rmlui|RmlUi" --output-on-failure
```

Use renderer checks when touching RmlUi/bgfx rendering behavior:

```sh
cmake --build --preset linux-debug --target noveltea-sandbox --parallel
ctest --test-dir build/linux-debug -R noveltea_rmlui --output-on-failure
./build/linux-debug/apps/sandbox/noveltea-sandbox --demo none --rmlui-document project:/rmlui/readback_gallery.rml --frames 180 --no-imgui --render-perf
cmake --preset web-profile
cmake --build --preset web-profile --parallel
pnpm run web:smoke:profile
```

Use package/export checks when touching material compilation or shader variants:

```sh
cmake --build --preset linux-debug --target noveltea-editor-tool --parallel
ctest --test-dir build/linux-debug -R "package|export|shader|material" --output-on-failure
```

Adjust exact target names if the build graph changes, but keep the intent: schema-only changes need parser/validator tests; renderer behavior changes need readback/smoke; packaging changes need export/package verification.

## Prompt For The Next Implementation Session

```text
Start from docs/rendering/RMLUI_BGFX_RENDERER_REFACTOR_PLAN.md, which is now the current NovelTea rendering action plan rather than the old completed Phase 4.5 checklist.

Action 1 is implemented: use `cmake --preset web-profile`, `cmake --build --preset web-profile --parallel`, and `pnpm run web:smoke:profile` for optimized Web measurement. Preserve the current bounded readback-gallery invariants: full_frame_child_layers=0, unbounded_layer_fallbacks=0, full_frame_postprocess_passes=0, full_frame_postprocess_target_uses=0, rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 after warmup. FPS should remain informational only.

Begin Action 6 / docs/rendering/NOVELTEA_SHADER_MATERIAL_PLAN.md Phase 5: build on the implemented project-schema ShaderDefinition/MaterialDefinition records, runtime shader-program resolver/cache, host shader compiler service, and engine 2D material binder. Bridge RmlUi shader(<string>) decorator usage to NovelTea material ids through a provider seam in reusable rmlui_bgfx and a NovelTea adapter. Keep built-in gradients unchanged, and do not add runtime shader source compilation.
```
