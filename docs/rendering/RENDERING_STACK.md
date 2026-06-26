# Rendering Stack

## Purpose

This document records NovelTea's rendering ownership boundaries. Detailed RmlUi renderer implementation notes live in the standalone `rmlui-bgfx` repository, not in this repository.

## Runtime Layers

- `Renderer` owns bgfx initialization, frame lifecycle, view setup, engine 2D draws, screenshots, resize handling, and shader/material resource caches.
- `RuntimeUI` owns RmlUi documents, input forwarding, runtime UI binding, and the NovelTea adapter around the external `rmlui-bgfx` renderer package.
- `DebugUI` owns Dear ImGui developer/debug overlay only.
- Engine-owned text rendering remains independent from RmlUi text. It now renders ActiveText glyph visuals produced by `ActiveTextLayout`, including per-glyph color/alpha/offset/scale metadata, object hit rectangles, reveal clipping, and deterministic effect state.

## External Renderer Package

NovelTea consumes `rmlui-bgfx` as an external package through `rmlui_bgfx::rmlui_bgfx`. The NovelTea side should only document and maintain the integration boundary:

- shader-program loading from NovelTea's staged bgfx shader assets;
- texture loading through NovelTea's asset system;
- diagnostics/perf forwarding into NovelTea logging;
- material shader provider integration for NovelTea project materials used by RmlUi decorators;
- runtime view-range assignment.

RmlUi renderer internals, effects probes, renderer refactor plans, and optimization notes belong in the `rmlui-bgfx` repository.

## Engine 2D Rendering

NovelTea keeps a small engine-owned 2D draw layer for sprites, quads, room/object presentation, render layers, clipping, and material-backed engine geometry. The shader/material asset pipeline is documented in [`NOVELTEA_SHADER_MATERIAL_PLAN.md`](NOVELTEA_SHADER_MATERIAL_PLAN.md).

Current view ownership:

- `Background`: room/background presentation.
- `Main`: primary scene/object presentation.
- `Foreground`: foreground overlays.
- `UIOverlay`: runtime UI and UI-adjacent presentation.
- debug UI uses its own high-numbered bgfx views.

## Shader and Material Runtime Policy

Runtime code loads compiled bgfx shader binaries from staged assets. It does not compile shader source. User-authored shader/material metadata is project/game schema data; exported packages include the compiled variants needed by the runtime.

Material-backed engine 2D quads use `ShaderRole::Engine2D`. RmlUi decorator materials use `ShaderRole::RmlUiDecorator` through the NovelTea adapter for `rmlui-bgfx`. ActiveText rich-text material tags attempt `ShaderRole::ActiveText` material resolution, and low-level vertex/fragment shader metadata attempts direct shader-pair resolution; both paths fall back to default text rendering with deduped diagnostics when unavailable.

## Runtime UI Usage

RmlUi is NovelTea's general runtime UI layer. Runtime visual slots such as cover, background, room, object, inventory, and action UI are exposed through backend-neutral view state and bound by `RuntimeUI`. Complex widgets such as ActiveText, MapView, and TextLog may be C++-backed RmlUi elements when ordinary RML/RCSS is insufficient.

For ActiveText, RmlUi hosts `nt-active-text` and continues to receive fallback RML. After RmlUi
updates layout, `RuntimeUI` collects a direct render snapshot with the resolved content box and a
FreeType/HarfBuzz-shaped glyph layout mapped back to rich-text metadata. `Engine::render()` submits
that snapshot through `Renderer::draw_active_text()` after RmlUi has rendered the runtime UI, so the
direct path overlays the fallback host instead of being hidden by it.

## Verification

For renderer or UI integration changes, use the relevant subset of:

```sh
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --build --preset web-debug
pnpm run web:smoke:debug
```

Use the sandbox for manual behavior checks:

```sh
./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 180
```

For detailed RmlUi renderer visual parity or effects debugging, work in the standalone `rmlui-bgfx` repository and compare against upstream RmlUi samples there.
