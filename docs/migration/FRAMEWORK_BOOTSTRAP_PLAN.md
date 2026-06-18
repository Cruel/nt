# Framework Bootstrap Plan

## Current nt Architecture Summary

`nt` currently has a small SDL3 platform layer, a bgfx renderer, a runtime UI facade, a Dear ImGui debug facade, and `apps/sandbox` as the smoke-test application. The renderer owns bgfx initialization and shutdown. CMake generates bgfx shader headers from `engine/shaders/bgfx` and keeps Web/Android cross-build paths.

Bootstrap additions in this slice create engine-owned seams for math primitives, assets, render resources, 2D drawing, runtime UI, and future text work without importing old NovelTea runtime code.

## Old NovelTea Systems To Eventually Support

- Project, save, profile, and settings JSON data.
- Entity/object/action/verb/room/map/dialogue/cutscene models.
- Duktape/dukglue scripting behavior.
- Timers, events, text log, notifications, and runtime context/game loop integration.
- BBCode/TextTypes semantics, animated text layout, per-glyph effects, hit metadata, and page/wait markers.
- Dialogue, cutscene, map, navigation, inventory, and settings flows.
- Runtime UI through RmlUi adapters, not Dear ImGui.
- Future editor preview/API integration for Electron/TanStack/Vite.

## Out Of Scope For Bootstrap

- Porting `ActiveText`, renderers, GUI widgets, game states, or the Qt editor.
- Adding SFML or old renderer assumptions.
- Full scene graph or asset database.
- Full RmlUi bgfx backend feature parity.
- Font fallback, rich text spans, and advanced text effects.
- NovelTea project loading.

## Dependency Decisions

| Area | Decision | Reason |
| --- | --- | --- |
| SDL3 | Keep | Existing platform/input/window baseline. |
| bgfx | Keep behind `NOVELTEA_ENABLE_BGFX` | Required cross-platform renderer target. |
| Render2D | Add `NOVELTEA_ENABLE_RENDER2D` seam | Small engine-owned quad/sprite substrate before migration. |
| RmlUi | Add `NOVELTEA_ENABLE_RMLUI`, optional package | Runtime UI/layout/forms/ordinary text path. |
| Dear ImGui | Keep `NOVELTEA_ENABLE_DEVTOOLS` | Dev/debug only. |
| Text | Add `NOVELTEA_ENABLE_TEXT` seam | Engine-owned Unicode shaping/layout/rendering separate from RmlUi text. |
| bimg/bgfx_utils | Defer direct copy | Useful later for texture loading, but bootstrap uses procedural texture proof. |
| NanoVG/Skia | Defer/reject for now | Too broad for current needs. |

## Staged Implementation Plan

1. Add backend-neutral math, asset, render-resource, render-command, and text headers.
2. Add bgfx RAII handle wrappers and logging/file helpers.
3. Extend renderer with view IDs, orthographic 2D setup, alpha-blended quads, and a procedural texture proof.
4. Keep RuntimeUI feature-gated with RmlUi package detection and document the missing render/system/file backend.
5. Replace the text scaffold with boxed `Text`, HarfBuzz/SheenBidi/libunibreak layout, and FreeType grayscale bgfx rendering.
6. Verify Linux, Web, and Android build paths where the local environment allows.
7. Only after bootstrap builds, write the old-engine migration plan.

## Verification Commands

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
./build/linux-debug/apps/sandbox/noveltea-sandbox
cmake --preset web-debug
cmake --build --preset web-debug
cd android && ./gradlew :app:assembleDebug
```

## Risks And Rollback

- Shader generation can fail per target if shader profiles need adjustment. Roll back only `vs_quad.sc`, `fs_quad.sc`, and the CMake shader outputs.
- RmlUi may not be packaged locally. Runtime UI must continue compiling as a scaffold.
- Full texture loading is deferred; future bimg integration must avoid copying large helper trees blindly.
- Web/Android dependency fetches are pre-existing behavior and may fail without network/cache.

Rollback strategy: disable new behavior with `NOVELTEA_ENABLE_RENDER2D`, `NOVELTEA_ENABLE_RMLUI`, or `NOVELTEA_ENABLE_TEXT`, or revert the bounded files listed in `STATUS.md`.
