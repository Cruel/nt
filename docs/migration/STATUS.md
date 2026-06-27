# Migration Status

Last updated: 2026-06-26.

## Completed Foundation

- Portable SDL3/bgfx runtime baseline for Linux, Web, and Android.
- RmlUi runtime UI integration and Dear ImGui developer/debug separation.
- Runtime UI rendering is provided through the external `rmlui-bgfx` package and a NovelTea adapter. Renderer implementation details live in the `rmlui-bgfx` repository.
- Backend-neutral core migration for legacy project data, typed domain models, validation, save/settings/profile documents, runtime sessions/controllers, runtime view-state adapter, editor preview/tooling APIs, and reduced compatibility fixtures.
- Runtime input/output contract around `RuntimeSessionHost`, including structured runtime diagnostics and shared headless/editor/RmlUi input routing.
- Lua runtime foundation and execution bridge. Lua is the only runtime scripting target.
- Save-backed Lua mutation APIs for global properties, entity property overrides, object locations, text logs, notifications, and timers.
- Backend-neutral save policy: save-slot abstraction, in-memory slot store, manual save/load/autosave host APIs, save snapshots, save-backed object placement, and editor preview save loading.
- Legacy `game` JSON import and read-only legacy package import.
- Backend-neutral rich-text semantics and engine-owned Unicode text implementation.
- RmlUi runtime UI baseline: project/theme/system template override policy, centralized document binding/template resolution, system fallback RML/RCSS files, reload lifecycle, and runtime UI docs.
- C++-backed runtime UI component foundation for `nt-active-text`, `nt-map-view`, and `nt-text-log`.
- `twink` tween integration. RuntimeUI uses it for deterministic ActiveText reveal progress when available.
- ActiveText Phase B v1: runtime view state preserves rich-text data, `nt-active-text` is now an RmlUi layout/input host only, RuntimeUI snapshots resolved RmlUi bounds after layout update, and the engine builds a shaped backend-neutral `ActiveTextLayout` that is drawn exclusively through the bgfx text renderer after RmlUi with length-scaled reveal progression, click-to-skip/continue behavior, rich-text color, alpha, offsets, scale, font style metadata, renderer-side synthetic bold/italic/underline/strike styling, deterministic effects, object hit rectangles, descendant-safe hit routing, and material/direct-shader metadata diagnostics. ActiveText no longer generates fallback RML glyph markup.
- MapView v1: runtime view state exposes map rooms/connections and `nt-map-view` renders deterministic fallback output with current-room highlighting.
- TextLog v1: runtime view state exposes structured log entries and `nt-text-log` renders deterministic fallback output.
- Object, inventory, and action presentation: runtime view state tracks selected/available room and inventory objects, predicts action enabled state, exposes clearable selection, and reports invalid selection/action diagnostics.
- Runtime visual presentation v1: runtime view state exposes cover/background/room/object image slots, resolves logical project asset paths, validates missing visual assets, and binds them through RuntimeUI.
- Engine 2D renderer layer system, scissor stack, frame timing integration for ActiveText reveal, and material-backed engine 2D quads.
- Backend-neutral project-schema shader/material records, runtime compiled bgfx binary loading, host/editor/import shader compilation, package export of compiled shader variants, and engine material binding.
- RmlUi decorator material bridge: `shader(<string>)` resolves to NovelTea material ids through the NovelTea adapter for `rmlui-bgfx`.
- Editor preview and recorded test playback: `RuntimePlaybackSession` runs backend-neutral specs and the Electron workspace can list/run playback tests and export packages through `noveltea-editor-tool`.
- Package writing/export: `.ntpkg` runtime packages include legacy-compatible entries, `manifest.json`, safe asset filtering, checksums, and compiled shader variants.
- Editor Integration V1: Electron/TanStack workspace talks to `noveltea-editor-tool` for project load/import, validation, raw entity edits, playback tests, package export, and preview controls.

## Active Gaps

- Invalid imported legacy script text should fail as Lua; no JavaScript, Duktape, dukglue, or JS compatibility layer will be added.
- Platform-specific save-slot persistence, runtime save/load screens, and richer autosave UI feedback remain incomplete.
- Lua-evaluated map visibility is deferred. `noveltea_core` must remain Lua-free, so this needs an engine-layer evaluation/result contract before implementation.
- Exact legacy ActiveText segment timing, outline/border text, high-quality glow, custom ActiveText shader uniform/sampler binding, real multi-face font-family resolution, FreeType-backed synthetic style rasterization, advanced mixed-font fallback, bgfx/custom-geometry map rendering, optional map transition animation, and per-object/per-room materials remain active.
- Editable/source package workflows and real old-project fixture coverage remain incomplete.
- Web browser and Android emulator runtime smoke coverage should be expanded where practical.
- Once the external renderer API stabilizes, switch `NOVELTEA_RMLUI_BGFX_GIT_TAG` from `master` to a pinned commit or release tag.

## Current Verification Commands

Use the smallest relevant subset for docs-only or narrow code changes:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --preset web-debug
cmake --build --preset web-debug
```

When testing local `rmlui-bgfx` changes before they are pushed, prefer CMake's standard FetchContent source override:

```sh
cmake --preset linux-debug -DFETCHCONTENT_SOURCE_DIR_RMLUI_BGFX=/path/to/rmlui-bgfx
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
```

Run the sandbox when runtime loop, UI, input, or rendering behavior changes:

```sh
./build/linux-debug/apps/sandbox/noveltea-sandbox
```

Run Web checks when browser/runtime asset behavior changes:

```sh
cmake --preset web-debug
cmake --build --preset web-debug
pnpm run web:smoke:debug
```

Run Android when platform, CMake, shader, asset packaging, JNI, or Gradle behavior changes:

```sh
cd android
./gradlew :app:assembleDebug
```

For documentation-only cleanup, a targeted stale-reference search is sufficient.

## Next Implementation Task

Review [`NEXT_STEPS_AFTER_RMLUI_BGFX.md`](NEXT_STEPS_AFTER_RMLUI_BGFX.md) before starting the next migration slice. With the first renderer-backed, shaped ActiveText path in place, the immediate recommended order is to make the updated `rmlui-bgfx` integration green/pinned if still outstanding, harden ActiveText visual parity, then move into MapView Lua visibility, project-authored room/object materials, and real old-project fixture coverage.

Future rendering work should start from a focused NovelTea plan only when it changes NovelTea's integration boundary, shader/material system, runtime presentation, or package/export behavior. RmlUi renderer internals, visual parity probes, refactor goals, and optimization work belong in the standalone `rmlui-bgfx` repository.
