# Migration Status

Last updated: 2026-06-20.

## Completed Foundation

- Portable SDL3/bgfx runtime baseline for Linux, Web, and Android.
- RmlUi runtime UI integration and Dear ImGui developer/debug separation.
- Backend-neutral core migration for legacy project data, typed domain models, validation, save/settings/profile documents, runtime sessions/controllers, runtime view-state adapter, editor preview/tooling APIs, and reduced compatibility fixtures.
- Phase 1 runtime input/output contract around `RuntimeSessionHost`, including structured runtime diagnostics and shared headless/editor/RmlUi input routing.
- Phase 2 Lua runtime execution bridge. Runtime script requests can be executed through the engine-layer Lua executor while `noveltea_core` stays Lua-free.
- Save-backed Lua mutation APIs for global properties, entity property overrides, object locations, text logs, notifications, and timers.
- Phase 3 backend-neutral save policy: save-slot abstraction, in-memory slot store, manual save/load/autosave host APIs, save snapshots, save-backed object placement, and editor preview save loading.
- Legacy `game` JSON import and read-only legacy package import.
- Backend-neutral rich-text semantics and engine-owned Unicode text implementation.
- Lua runtime foundation. Lua is the only runtime scripting target.
- Phase 4 RmlUi runtime UI baseline: project/theme/system template override policy, centralized `RuntimeUiDocumentBinder`, `RuntimeUiTemplateResolver`, system fallback RML/RCSS files, hardened document reload lifecycle with input listener reattachment, and updated runtime UI docs.
- Phase 5 RmlUi custom component foundation: `nt-active-text`, `nt-map-view`, and `nt-text-log` register as C++-backed runtime UI elements with deterministic fallback binding from `RuntimeUIViewState`.
- Phase 6 tween integration: `twink` is resolved as an external package or pinned FetchContent fallback, `TweenService` owns engine-side tween instances, and RuntimeUI uses it for deterministic ActiveText reveal progress.
- Phase 7 ActiveText: runtime view state preserves `RichTextDocument` data, the engine builds deterministic per-glyph ActiveText frames with reveal/effect state, and `nt-active-text` renders fallback RML with object/style/effect/shader metadata, page-break prompts, and semantic shader stubs.
- Phase 8 MapView v1: runtime view state exposes typed map rooms/connections, derives current-room and direct-path click targets from `ProjectModel`/runtime state, editor preview can inspect map state, and `nt-map-view` renders deterministic RmlUi fallback DOM with current-room highlighting.
- Phase 9 TextLog v1: runtime view state exposes structured text-log entries with rich-text snapshots, speaker/source/category metadata, deterministic sequence ids, save-loaded string restoration, and structured `TextLogEntry` output payloads; `nt-text-log` renders deterministic RmlUi fallback markup.
- Current runtime ownership and data flow are documented in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).

## Active Gaps

- Invalid imported legacy script text should fail as Lua; no JavaScript, Duktape, dukglue, or JS compatibility layer will be added.
- Platform-specific save-slot persistence, runtime save/load screens, and richer autosave UI feedback remain incomplete.
- Phase 8 Lua-evaluated map visibility is explicitly deferred. `noveltea_core` must remain Lua-free, so this needs an engine-layer evaluation/result contract before implementation.
- Shader-backed ActiveText rendering, bgfx/custom-geometry map rendering, and optional map transition animation remain active.
- Editor preview/test playback needs hardening around real workflows.
- Packaging/export workflows and real old-project fixture coverage remain incomplete.
- Web browser and Android emulator runtime smoke coverage should be expanded where practical.

## Current Verification Commands

Latest Phase 9 implementation — use these commands to verify:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --preset web-debug
cmake --build --preset web-debug
cmake --build --preset linux-debug --target format-check
```

Use the smallest relevant subset for a docs-only or narrow code change:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --preset web-debug
cmake --build --preset web-debug
```

Run the sandbox when runtime loop, UI, input, or rendering behavior changes:

```sh
./build/linux-debug/apps/sandbox/noveltea-sandbox
```

Run Android when platform, CMake, shader, asset packaging, JNI, or Gradle behavior changes:

```sh
cd android
./gradlew :app:assembleDebug
```

For documentation-only cleanup, a targeted `rg` check for stale active-doc instructions is sufficient.

Latest Phase 9 verification completed:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --preset web-debug
cmake --build --preset web-debug
cmake --build --preset linux-debug --target format-check
timeout 5s ./build/linux-debug/apps/sandbox/noveltea-sandbox
```

The sandbox launch initialized and loaded the runtime document; `timeout` ended the long-running
app after startup with exit code 124.

## Next Implementation Task

Start Phase 10 Object, Inventory, and Action Presentation from [`PLAN.md`](PLAN.md), unless the
explicitly deferred Phase 8 Lua map-visibility bridge is selected first.
