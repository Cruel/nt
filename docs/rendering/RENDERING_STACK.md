# Rendering Stack

## Local References Compared

| Reference | Useful parts | Bootstrap decision |
| --- | --- | --- |
| `refs/RmlUi/Backends` | Clean separation of platform input/system and renderer interfaces; SDL event translation patterns; renderer examples for GL/VK/DX/SDL. | Use as API reference. Do not copy a backend wholesale. |
| `refs/rmlui-bgfx` | Compact bgfx RmlUi renderer concept and shader pair. | Adapt ideas later, but avoid its broad app/window wrapper API and xmake setup. |
| `refs/bgfx/examples/common/font` | Historical bgfx SDF font manager, text buffers, metrics, shader variants. | Reference only; NovelTea now uses FreeType grayscale glyph coverage for engine text. |
| `refs/bgfx/examples/common/imgui` | Proven bgfx ImGui debug overlay direction. | Keep Dear ImGui dev/debug only. |
| `refs/bgfx/examples/common/nanovg` | Canvas/vector drawing over bgfx. | Deferred unless future editor/runtime UI needs justify it. |
| `bgfx_utils` / bimg texture loading | Shader/program/texture helper patterns and `bimg::imageParse` texture creation flow. | Use next for real PNG/JPEG/etc. loading. Current pass only adds a tiny PPM disk proof to avoid copying the helper tree. |
| Small `nt` QuadBatch/SpriteBatch | Explicit ownership and simple game/world 2D draw path. | Implemented first as engine-owned `QuadBatch` / `QuadCommand` substrate. |
| Skia/heavier canvas | Rich 2D API but large integration surface. | Rejected/deferred for bootstrap. |

## Recommendation

- Use RmlUi for runtime UI, layout, forms, and ordinary UI text.
- Use Dear ImGui only for developer/debug UI.
- Use bgfx/bx/bimg utilities where practical, without vendoring broad external trees.
- Maintain a small `nt` 2D draw layer for sprites, materials, quads, render targets, clipping, and layer/depth ordering. The shader/material asset pipeline is planned in [`NOVELTEA_SHADER_MATERIAL_PLAN.md`](NOVELTEA_SHADER_MATERIAL_PLAN.md).
- Build future rich text spans/effects on top of the engine-owned `Text` layout data. RmlUi text remains independent and is not a replacement for per-glyph animation/effect metadata.

## View IDs

- `0`: game/world 2D.
- `1`: runtime UI.
- `2`: engine text.
- `250`: debug UI.

These IDs are documented early so RmlUi, text, and debug overlays do not compete for implicit renderer state.

## Implemented In Bootstrap

- Orthographic game/world 2D view.
- Alpha-blended colored quads through `QuadBatch`.
- Textured quads with UV rects, per-quad color/alpha, and layer/depth metadata.
- Disk texture proof using `apps/sandbox/assets/checker.ppm`, with procedural checker fallback.
- Engine-owned boxed text demo with Unicode shaping and grayscale glyph rendering.
- Deterministic sandbox smoke commands:
  - `./build/linux-debug/apps/sandbox/noveltea-sandbox --frames 180`
  - `./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 180`

## Implemented In This Slice

- RmlUi bgfx `RenderInterface` (`BgfxRenderInterface`) with vertex/index buffer compilation, texture generate/release, scissor support, and orthographic projection via custom shader pair.
- Minimal `BgfxSystemInterface` with SDL3 high-resolution timer.
- SDL3 event translation (mouse, keyboard, text input, window resize) into RmlUi context calls.
- Font loading and demo document/stylesheet loading from `apps/sandbox/assets/rmlui/`.
- RmlUi bgfx shader pair (`vs_rmlui.sc` / `fs_rmlui.sc`) compiled for glsl/essl/web profiles.
- Backend-neutral `AssetManager` with `system:/`, `project:/`, and `cache:/`
  mounts, currently backed by directories and ready for future `.ntzip` sources.
- bgfx shader source remains in `engine/shaders/bgfx`, while compiled shader
  binaries are build/runtime assets loaded from
  `assets/shaders/bgfx/{linux-glsl,android-essl,web-essl100}`. Runtime code does
  not include generated shader headers or compile shader source.
- User-provided project shaders/materials follow
  [`NOVELTEA_SHADER_MATERIAL_PLAN.md`](NOVELTEA_SHADER_MATERIAL_PLAN.md): `.ntmat`
  material assets now parse into a backend-neutral runtime model, shader source remains an
  authoring asset, `shaderc` will produce platform/profile variants during editor/import/export
  workflows, and shipped runtimes will load compiled bgfx binaries rather than compiling source.

## Deferred (Next Slice)

- bimg-backed PNG/JPEG/etc. texture loading for `BgfxRenderInterface::LoadTexture`.
- Clip mask, layer stack, filter/shader compilation (advanced RmlUi features).
- RmlUi Debugger integration.
- Rich text spans, BBCode semantics, per-glyph animation/effects, and font-family fallback.
- Web/Android RmlUi linkage (currently scaffold-only).
