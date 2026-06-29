# Migration Status

Last updated: 2026-06-29.

## Completed Foundation

- Portable SDL3/bgfx runtime baseline for Linux, Web, and Android.
- RmlUi runtime UI integration and Dear ImGui developer/debug separation.
- Runtime UI rendering is provided through the external `rmlui-bgfx` package and a NovelTea adapter. Renderer implementation details live in the `rmlui-bgfx` repository.
- Backend-neutral runtime foundation for project data experiments, typed domain models, validation, save/settings/profile documents, runtime sessions/controllers, runtime view-state adapter, editor preview/tooling APIs, and reduced historical fixtures.
- Runtime input/output contract around `RuntimeSessionHost`, including structured runtime diagnostics and shared headless/editor/RmlUi input routing.
- Lua runtime foundation and execution bridge. Lua is the only runtime scripting target.
- Save-backed Lua mutation APIs for global properties, entity property overrides, object locations, text logs, notifications, and timers.
- Backend-neutral save policy: save-slot abstraction, in-memory slot store, manual save/load/autosave host APIs, save snapshots, save-backed object placement, and editor preview save loading.
- Historical `game` JSON/package import experiments exist as optional migration aids, not active compatibility requirements.
- Backend-neutral rich-text semantics and engine-owned Unicode text implementation.
- RmlUi runtime UI baseline: project/theme/system template override policy, centralized document binding/template resolution, system fallback RML/RCSS files, reload lifecycle, and runtime UI docs.
- C++-backed runtime UI component foundation for `nt-active-text`, `nt-map-view`, and `nt-text-log`.
- `twink` tween integration. RuntimeUI uses it for deterministic ActiveText reveal and alpha playback when available.
- ActiveText Phase B v1: runtime view state preserves rich-text data, `nt-active-text` is now an RmlUi layout/input host only, RuntimeUI snapshots resolved RmlUi bounds after layout update, and the engine builds a shaped backend-neutral `ActiveTextLayout` that is drawn exclusively through the bgfx text renderer after RmlUi with length-scaled reveal progression, click-to-skip/continue behavior, local rich-text page/wait segmentation, renderer-backed prompt metadata, playback alpha fade-in/fade-out, rich-text color, alpha, offsets, scale, glow metadata, font style metadata, renderer-side synthetic bold/italic/underline/strike styling, deterministic V1 effects, object hit rectangles, descendant-safe hit routing, typed `AssetManager` font requests for ActiveText system/default font setup, and material/direct-shader metadata diagnostics. ActiveText no longer generates fallback RML glyph markup.
- MapView v1: runtime view state exposes map rooms/connections and `nt-map-view` renders deterministic fallback output with current-room highlighting.
- TextLog v1: runtime view state exposes structured log entries and `nt-text-log` renders deterministic fallback output.
- Object, inventory, and action presentation: runtime view state tracks selected/available room and inventory objects, predicts action enabled state, exposes clearable selection, and reports invalid selection/action diagnostics.
- Runtime visual presentation v1: runtime view state exposes cover/background/room/object image slots, resolves logical project asset paths, validates missing visual assets, and binds them through RuntimeUI.
- Engine 2D renderer layer system, scissor stack, frame timing integration for ActiveText reveal, and material-backed engine 2D quads.
- Backend-neutral project-schema shader/material records, runtime compiled bgfx binary loading, host/editor/import shader compilation, package export of compiled shader variants, and engine material binding.
- Typed audio asset foundation: backend-neutral audio handles/descriptors, AssetManager `load_audio()` facade, AudioSystem SFX/track/bus policy, miniaudio backend hidden behind `AudioBackend`, project MP3 loading through AssetManager bytes, sandbox `--audio-sfx` / `--audio-track` smoke hooks, Web/Emscripten and Android miniaudio include support, browser-callable audio entry points for user-gesture playback, Lua `audio` bindings demonstrated from RmlUi with a pitch slider, generic typed resource aliases for audio/textures/materials with Lua audio alias helpers, explicit `--no-audio`, backend pause/resume lifecycle hooks, runtime audio command outputs, neutral audio stats, and in-memory stream decoding for music-style assets.
- RmlUi decorator material bridge: `shader(<string>)` resolves to NovelTea material ids through the NovelTea adapter for `rmlui-bgfx`.
- Editor preview and recorded test playback: `RuntimePlaybackSession` runs backend-neutral specs and the Electron workspace can list/run playback tests and export packages through `noveltea-editor-tool`.
- Package writing/export: `.ntpkg` runtime packages include `manifest.json`, safe asset filtering, checksums, and compiled shader variants; package shape may evolve with the new authoring/runtime schema split.
- Editor Integration V1: Electron/TanStack workspace talks to `noveltea-editor-tool` for project load/import, validation, raw entity edits, playback tests, package export, and preview controls.
- Editor planning baseline: `docs/editor/EDITOR_IMPLEMENTATION_PLAN.md` defines the new workbench, command/undo, preview, schema, and phased editor rollout plan, and `docs/editor/EDITOR_TECH_STACK.md` defines standard editor-side component/dependency choices.
- Editor Milestone 1 workbench shell: the Electron workspace now uses a tab/group/split workbench model, editor registry, tab-hosted primary preview, fallback raw JSON record tabs, project explorer record opening, and a global bottom panel for problems/output/preview/test/export/command-history surfaces.
- Editor Milestone 2 command foundation: the Electron workspace now has a dedicated project store, tested JSON pointer/patch helpers, a command bus with history/transactions/undo/redo, command-backed raw JSON record editing, explicit save/save-as IPC through the main process, dirty-state tracking from command history, and bottom-panel command history diagnostics.
- Editor Milestone 3 authoring schema skeleton: the Electron workspace now has a new-engine-first authoring project schema v1 in shared TypeScript/zod code, `layouts` collection naming, empty project creation, local authoring validation diagnostics, authoring project tree grouping, unsaved new-project dirty state, disabled playback/export until authoring-to-runtime conversion exists, and a reference-index skeleton for entrypoint/parent/inherits/explicit references.
- Editor Milestone 4 project explorer and entity operations: the Electron workspace now supports command-backed authoring record create, rename ID, duplicate, reference-aware delete, metadata update, same-collection parent assignment, Find Usages, a References bottom panel, and raw JSON fallback opening for new schema records.
- Editor Milestone 5 PreviewManager foundation: the Electron workspace now has renderer-side preview session records, capability tracking, manager diagnostics, primary runtime replay state, bounded entity preview request policy, authoring-preview protocol messages, preview diagnostics panel integration, and a thumbnail request/cache skeleton.

## Active Gaps

- Imported script text must be Lua; no JavaScript, Duktape, dukglue, or JS compatibility layer will be added.
- Platform-specific save-slot persistence, runtime save/load screens, and richer autosave UI feedback remain incomplete.
- Lua-evaluated map visibility is deferred. `noveltea_core` must remain Lua-free, so this needs an engine-layer evaluation/result contract before implementation.
- Web/editor UI still needs production controls wired to the exported browser audio entry points; the current visible RmlUi audio control is a sandbox demo.
- ActiveText Phase B hardening remains active: high-quality halo/blur glow, richer project font-family records beyond regular-only aliases, advanced mixed-font fallback, bgfx/custom-geometry map rendering, optional map transition animation, and per-object/per-room materials. CPU-side Fade/FadeAcross/Pop/Nod/Shake/Tremble/Glow/Test visuals, simple renderer glow, playback lifecycle, prompt presentation, alpha show/hide, typed font requests, typed texture/shader/material facade registration, bimg-backed typed texture loading, typed material-binder texture/shader/material routing, legacy-compatible `sys` fallback, `fontDefault` ingestion, and synthetic style fallback are implemented; text outline/border metadata is intentionally sidelined until an authored fixture requires it.
- Editable/source package workflows remain incomplete.
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

When testing local `rmlui-bgfx` changes before they are pushed, use NovelTea's explicit local renderer dependency mode:

```sh
cmake --preset linux-debug-local-rmlui-bgfx
cmake --build --preset linux-debug-local-rmlui-bgfx
ctest --test-dir build/linux-debug --output-on-failure
```

The equivalent manual form is `cmake --preset linux-debug -DNOVELTEA_USE_LOCAL_RMLUI_BGFX=ON`. If the checkout is not at `${CMAKE_SOURCE_DIR}/rmlui-bgfx`, also set `NOVELTEA_LOCAL_RMLUI_BGFX_DIR=/path/to/rmlui-bgfx`.

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

Review [`NEXT_STEPS_AFTER_RMLUI_BGFX.md`](NEXT_STEPS_AFTER_RMLUI_BGFX.md) before starting the next migration slice. With the first renderer-backed, shaped ActiveText path in place, the immediate recommended order is to implement the font-family resolver and styled-span ActiveText shaping plan in [`../rendering/ACTIVE_TEXT_FONT_RESOLVER_IMPLEMENTATION_PLAN.md`](../rendering/ACTIVE_TEXT_FONT_RESOLVER_IMPLEMENTATION_PLAN.md), then complete ActiveText material/shader binding and effect visuals, then move into MapView Lua visibility and project-authored room/object materials.

Future rendering work should start from a focused NovelTea plan only when it changes NovelTea's integration boundary, shader/material system, runtime presentation, or package/export behavior. RmlUi renderer internals, visual parity probes, refactor goals, and optimization work belong in the standalone `rmlui-bgfx` repository.
