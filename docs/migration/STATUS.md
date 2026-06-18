# Migration Status

Last updated: 2026-06-18.

## Current RmlUi bgfx State

The RmlUi 6.2 bgfx renderer is no longer a basic scaffold. It has implemented paths for compiled geometry, file and generated textures, scissor state, clip masks, offscreen layers, layer composition, saved layer textures, saved mask images, standard filters, and standard gradient shaders. Linux shader verification and the RmlUi readback capture/verify tests pass in the current local worktree.

Current local verification:

- `cmake --preset linux-debug -G Ninja`: passed after the NovelTea text subsystem replacement.
- `cmake --build --preset linux-debug`: passed after the NovelTea text subsystem replacement.
- `ctest --test-dir build/linux-debug --output-on-failure`: passed 51/51 after text tests were added.
- `./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 180`: passed with the boxed grayscale text demo.
- `cmake --preset web-debug -G Ninja`: passed with Emscripten FreeType/HarfBuzz ports and source-built SheenBidi/libunibreak.
- `cmake --build --preset web-debug`: passed.
- `cd android && ./gradlew --no-daemon :app:assembleDebug`: passed.
- `cmake --preset linux-debug`: passed before edits.
- `cmake --preset linux-debug -DNOVELTEA_COMPILE_SHADERS=ON`: passed after shader edits.
- `cmake --preset linux-debug -DNOVELTEA_COMPILE_SHADERS=ON '-DNOVELTEA_SHADER_VARIANTS=glsl-120;essl-100;essl-300'`: passed after shader-root/list fixes.
- `cmake --build --preset linux-debug`: passed before and after edits.
- `ctest --test-dir build/linux-debug -R noveltea_shader_verify --output-on-failure`: passed.
- `ctest --test-dir build/linux-debug -R 'rmlui|RmlUi' --output-on-failure`: passed 18/18.
- `ctest --test-dir build/linux-debug -R 'rmlui|RmlUi' --output-on-failure`: passed 19/19 after stencil overflow planning coverage was added.
- `ctest --test-dir build/linux-debug --output-on-failure`: passed 43/43 after the stencil overflow fix.
- Latest checked GitHub Actions Build run: `27728367992`, SHA `dfe4557f45990a31ff6360b9fa2a9f5855d956bd`, conclusion `success`.

Changes made in this pass:

- Clip-mask commands now capture whether a transform was active and the full transform matrix, and pushed-layer replay uses the captured transform instead of the renderer's current transform.
- Stencil overflow no longer clears/discards the accumulated mask. The renderer normalizes the active mask to reference 1 with stencil-only decrement passes, applies the new intersection at reference 2, and preserves the complete clip-command history for pushed-layer replay.
- `ReleaseFilter` now detects `FilterKind::MaskImage`, releases and erases the owned saved texture exactly once, clears the resource handle, and then erases the filter.
- Fixed the bgfx color-matrix shader to apply row-major filter matrices in the same direction as the CPU parity helper.
- Fixed generated shader asset root and semicolon-list passing so all requested shader variants compile and verify as separate `shaders/bgfx/<variant>` directories.
- Expanded the readback gallery and verifier to assert transformed clipping, individual standard color filters, and repeating gradient output.
- `docs/migration/RMLUI_GL3_COMPLETION.md` was rewritten to separate verified behavior from implemented-but-unverified behavior.

Known RmlUi gaps that remain open:

- Stencil overflow normalization has deterministic unit coverage but still needs the requested visual equivalence readback against a non-overflow mask.
- Large-radius blur still uses the fixed four-weight/seven-tap shader path. GL3-style downsample, reduced-resolution blur, and upsample are not implemented.
- Capability-aware 2x MSAA layer targets and resolve scheduling are not implemented; current runtime coverage is single-sample.
- Hardware blit and shader-copy fallback both exist, but tests do not force the fallback path.
- RuntimeUI facade integration coverage is incomplete beyond event-consumption polarity and file-interface tests.
- Web headless-browser runtime smoke is not implemented.
- Android packaged shader checks exist in CI, but local Android assemble and emulator runtime smoke were not run in this pass.

## Non-RmlUi Migration Context

The repository remains the new NovelTea runtime/framework targeting SDL3, bgfx, RmlUi for runtime UI, and Dear ImGui for developer/debug UI only.

Implemented foundation outside the advanced RmlUi renderer:

- Backend-neutral asset layer with logical `system:/`, `project:/`, and `cache:/` mounts.
- Runtime-loaded bgfx shader assets with CMake shader compilation and verification.
- SDL3 platform/input/windowing integration.
- bgfx renderer organization with shader loader, 2D quad path, engine-owned Unicode text path, and runtime asset staging.
- Engine-owned text subsystem with boxed `Text`, backend-neutral HarfBuzz/SheenBidi/libunibreak layout, FreeType grayscale glyph rasterization, bgfx atlas/page rendering, and CPU text tests. See `docs/migration/NOVELTEA_TEXT_IMPLEMENTATION.md`.
- Lua 5.5.0 plus sol2 scripting runtime with hardened public API, exception conversion, traceback reporting, unsafe library removal, AssetManager-backed script execution, and RmlUi Lua plugin integration.
- Engine lifecycle rollback and shutdown ordering for Platform, Renderer, ScriptRuntime, RuntimeUI, and DebugUI.
- Electron editor preview scaffold and Web preview packaging hooks.

Deferred migration areas:

- Old NovelTea game-domain migration into backend-neutral models and controllers.
- BBCode/TextTypes/ActiveText migration, rich text spans, per-glyph animation, pagination, hit-testing, and render-target text caching.
- Font-family fallback, color emoji, SVG glyphs, script-specific justification, selection/caret UI, and Lua bindings for the new text API.
- RmlUi Debugger integration.
- Android emulator runtime automation and Web browser smoke automation.

## Next Recommended Prompt

Fix the remaining RmlUi semantic gates in order: stencil overflow normalization, GL3-quality blur downsample/upsample, portable MSAA/resolve planning, forced shader-copy tests, expanded readback pixel assertions, RuntimeUI facade tests, Web browser smoke, and Android runtime smoke. Do not mark the renderer complete until those gates pass.
