# Rendering Stack

## Local References Compared

| Reference | Useful parts | Bootstrap decision |
| --- | --- | --- |
| `refs/RmlUi/Backends` | Clean separation of platform input/system and renderer interfaces; SDL event translation patterns; renderer examples for GL/VK/DX/SDL. | Use as API reference. Do not copy a backend wholesale. |
| `refs/rmlui-bgfx` | Compact bgfx RmlUi renderer concept and shader pair. | Adapt ideas later, but avoid its broad app/window wrapper API and xmake setup. |
| `refs/bgfx/examples/common/font` | SDF font manager, text buffers, metrics, shader variants. | Strong future text-render reference; too large for bootstrap copy. |
| `refs/bgfx/examples/common/imgui` | Proven bgfx ImGui debug overlay direction. | Keep Dear ImGui dev/debug only. |
| `refs/bgfx/examples/common/nanovg` | Canvas/vector drawing over bgfx. | Deferred unless future editor/runtime UI needs justify it. |
| `bgfx_utils` / bimg texture loading | Shader/program/texture helper patterns and `bimg::imageParse` texture creation flow. | Use next for real PNG/JPEG/etc. loading. Current pass only adds a tiny PPM disk proof to avoid copying the helper tree. |
| Small `nt` QuadBatch/SpriteBatch | Explicit ownership and simple game/world 2D draw path. | Implemented first as engine-owned `QuadBatch` / `QuadCommand` substrate. |
| Skia/heavier canvas | Rich 2D API but large integration surface. | Rejected/deferred for bootstrap. |

## Recommendation

- Use RmlUi for runtime UI, layout, forms, and ordinary UI text.
- Use Dear ImGui only for developer/debug UI.
- Use bgfx/bx/bimg utilities where practical, without vendoring broad external trees.
- Maintain a small `nt` 2D draw layer for sprites, materials, quads, render targets, clipping, and layer/depth ordering.
- Build a separate future `nt` rich text layer for NovelTea-specific animated BBCode semantics. RmlUi text is not a replacement for per-glyph animation/effect metadata.

## View IDs

- `0`: game/world 2D.
- `1`: runtime UI.
- `2`: text lab.
- `3`: debug UI.

These IDs are documented early so RmlUi, text, and debug overlays do not compete for implicit renderer state.

## Implemented In Bootstrap

- Orthographic game/world 2D view.
- Alpha-blended colored quads through `QuadBatch`.
- Textured quads with UV rects, per-quad color/alpha, and layer/depth metadata.
- Disk texture proof using `apps/sandbox/assets/checker.ppm`, with procedural checker fallback.
- Renderer debug text for text-lab status.
- Deterministic sandbox smoke commands:
  - `./build/linux-debug/apps/sandbox/noveltea-sandbox --frames 180`
  - `./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 180`

## Deferred

- RmlUi bgfx `RenderInterface`, `SystemInterface`, file interface, font loading, document loading, and SDL3 input translation.
- bimg-backed PNG/JPEG/etc. texture loading from disk.
- SDF/MSDF font atlas and rich text draw buffers.
- Scissor/clip masks beyond later RmlUi backend needs.
