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
2. Build the NovelTea shader/material asset pipeline.
3. Bridge RmlUi `shader(<string>)` to NovelTea materials.
4. Add missing RmlUi feature fixtures.
5. Defer additional RmlUi bgfx optimization until a concrete fixture or profile proves the need.

## Retained Lessons From The Completed Refactor

Keep these lessons. They still matter for future renderer/material work.

### Reusable Boundary

The reusable `rmlui_bgfx` core must not depend on NovelTea engine headers, NovelTea `AssetManager`, NovelTea `SurfaceMetrics`, NovelTea shader-loader enums, NovelTea view IDs, SDL3, Lua, ImGui, runtime session objects, editor preview code, or NovelTea custom components.

NovelTea adapts to the renderer through providers. The renderer core should expose seams for texture loading, shader/program loading, diagnostics, perf logging, and future material shader submission. NovelTea owns project asset paths, `.ntmat` parsing, material registry lookup, shader variant selection, editor/package compilation policy, and runtime session integration.

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

### Action 2: Implement Material Plan Phase 0/1 `[implemented]`

Goal: establish the backend-neutral material data model before any bgfx program loading or RmlUi integration.

Implemented path:

- Audited and replaced the deferred `render/material.hpp` and `render/shader.hpp` stubs with backend-neutral material/shader-source-reference types.
- Added `MaterialId` normalization for project aliases and explicit `project:/` / `system:/` `.ntmat` asset paths.
- Added `MaterialType` for `engine-2d`, `rmlui-decorator`, and deferred `rmlui-filter` / `postprocess` types.
- Added material asset data for shader refs, uniforms, texture slots, engine/RmlUi input bindings, blend policy, structured diagnostics, and fallback records.
- Added `.ntmat` JSON parser/validator for schema `noveltea.material.v1`.
- Added diagnostics for invalid material ids, invalid JSON/schema, missing fields, unknown/deferred types, invalid shader refs, invalid uniforms/defaults, invalid texture slot names/sources/samplers, unknown input bindings, and unsupported blend policies.
- Added `tests/render/material_asset_tests.cpp` for valid and invalid material assets, id normalization, and fallback records.

Still intentionally not implemented:

- `shaderc` invocation.
- Runtime shader source compilation.
- bgfx program creation.
- RmlUi `shader(<string>)` bridge.
- Editor UI.

Acceptance:

- Valid `.ntmat` parses into a stable runtime model.
- Invalid `.ntmat` reports actionable diagnostics.
- Tests cover material id normalization and schema validation.
- Docs/status are updated.

### Action 3: Add Shader Manifest And Runtime Program Loading

Goal: teach runtime how to load precompiled bgfx shader variants for both high-level materials and NovelTea's lower-level ActiveText shader BBCode contract.

Important distinction:

- `MaterialId` / `.ntmat` is the validated, editor-friendly material path used by rich-text material tags, engine 2D materials, and later RmlUi `shader(<string>)` decorator materials.
- ActiveText's low-level shader BBCode is already preserved by `RichTextStyle::fragment_shader_id` and `RichTextStyle::vertex_shader_id`. Do not force this path to become a `.ntmat` material.
- Both paths still use precompiled bgfx shader binaries at runtime. Neither path compiles shader source at runtime.

Implement:

- Backend-neutral shader identifiers for direct shader refs, probably `ShaderId`, `ShaderStage`, and `ShaderProgramId` / `ShaderPairRef`, without reintroducing the old misleading mutable `Shader` stub.
- Shader manifest format that can resolve material-owned shader refs from a `MaterialId` plus active platform/profile/variant.
- Shader manifest format that can also resolve direct ActiveText shader pairs from preserved vertex/fragment shader ids plus active platform/profile/variant.
- Runtime `ShaderProgramCache` loading compiled binaries through `AssetManager`.
- bgfx shader/program handle creation for precompiled shader binaries.
- Program cache keys that distinguish material programs from direct shader-pair programs while still including shader hash, active backend/profile, and variant.
- Uniform/sampler reflection or declared-bind metadata sufficient for later material binding and direct ActiveText shader binding.
- Missing variant diagnostics for both callers:
  - material diagnostics name the material id, active profile, and expected compiled binary path;
  - direct shader-pair diagnostics name the vertex/fragment shader ids, active profile, and expected compiled binary paths.
- Visible fallback behavior:
  - missing material programs use material fallback records;
  - missing direct ActiveText shader pairs fall back to the default text/ActiveText shader path while preserving an actionable diagnostic.

Do not invoke `shaderc` at runtime.

Acceptance:

- Runtime can load a precompiled sample material program for the active backend.
- Runtime can load a precompiled direct shader-pair program for the ActiveText low-level shader BBCode contract.
- Missing profile or missing binary diagnostics name the correct caller context: material id for material programs, vertex/fragment shader ids for direct shader pairs.
- Existing non-material sprites/quads still render through the fast default path.
- Existing ActiveText without low-level shader metadata still renders through the normal/default text path.

### Action 4: Add Editor/Import/Export Shader Compilation

Goal: compile authoring shader source into runtime bgfx binaries during host/editor workflows.

Implement:

- Host-side `ShaderCompilerService` wrapper around `shaderc`.
- Compile active development profile first.
- Compile configured export profiles later.
- Cache outputs by shader source, includes, material schema, compiler version, target profile, and relevant flags.
- Capture diagnostics for editor display.
- Keep previous valid program alive after failed hot reload.

Acceptance:

- A sample `.ntmat` compiles for Linux GL and Web ESSL profiles.
- Failed shader compilation reports readable diagnostics.
- Re-running without source changes hits cache.
- Runtime packages do not require `shaderc`.

### Action 5: Bind Materials To Engine 2D Rendering

Goal: validate the material system on the simpler engine 2D draw contract before RmlUi integration.

Implement:

- Optional `MaterialId` or `MaterialInstanceId` on `QuadCommand` or equivalent 2D draw data.
- Material binder for bgfx program, uniforms, textures, and blend state.
- Sample engine 2D material-backed quad in sandbox.
- Fallback behavior for missing material/program/texture.

Acceptance:

- Existing colored/textured quad demos render unchanged without material ids.
- A sample custom material renders on Linux and Web release/profile.
- Missing material falls back visibly and logs actionable diagnostics.

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
- Generic RmlUi `shader(<string>)` resolves to a NovelTea material id/path.
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
cmake --build --preset linux-debug --target noveltea_tests --parallel
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

Begin Action 2 / docs/rendering/NOVELTEA_SHADER_MATERIAL_PLAN.md Phase 0-1: audit existing render/material.hpp and render/shader.hpp stubs, add the backend-neutral .ntmat material data model, MaterialId normalization, parser/validator, diagnostics, and tests. Do not add runtime shader source compilation, do not invoke shaderc yet, do not create bgfx programs yet, and do not wire RmlUi shader(<string>) yet.
```
