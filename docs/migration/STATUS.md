# Migration Status

Last updated: 2026-07-06.

This file is durable project memory for the next implementation session. Keep it short and current.
Move historical analysis to `docs/archive/` and detailed implementation plans to the relevant
`docs/*/*_PLAN.md` file.

## Current Baseline

- The runtime stack is SDL3 for platform/input/windowing, bgfx for rendering, RmlUi for runtime UI,
  Dear ImGui for developer UI, and Lua for runtime scripting.
- `RuntimeSessionHost` owns backend-neutral gameplay state, runtime inputs/outputs, structured
  diagnostics, save/load/autosave hooks, runtime view state, and controller command capture.
- `RuntimeShell` owns high-level app mode (`Boot`, `Title`, `Game`, `Paused`, `Error`), keeps project
  load on the title side of the shell, gates frame updates, and starts gameplay only through the
  explicit shell start path.
- `RuntimeCommandDispatcher` is the shared semantic command path for UI/Lua/preview/playback-facing
  commands. It currently handles `game.start`, `game.pause`, `game.resume`, `menu.close`, gameplay
  input commands, Load/Settings/Save/TextLog/Return-to-title/Quit placeholder diagnostics, trace
  diagnostics, and unknown-command diagnostics.
- `RuntimeLayoutManager` V0 is shell-owned and wraps RuntimeUI document load/show/hide/unload for
  mounted Layout metadata. Initial layers are Title, GameHud, MenuOverlay, Modal, and Debug. The
  built-in title Layout mounts as Title, `runtime_game` mounts as GameHud, and additional gameplay
  Layouts can be stacked in GameHud with explicit `z_index` metadata or default top insertion.
  `game.start` removes the Title layer while keeping gameplay available below future overlays.
- Lua can request stacked gameplay Layouts with `Game.add_layer(layout_id, z_index?)`, which routes
  through the dispatcher as `layout.add-layer`. Until runtime Layout manifests are implemented, V0
  resolves non-path IDs to project layout RML files under `project:/layouts/`.
- RmlUi Layout activation uses ordinary Lua `onclick` handlers and dispatcher-backed `Game.*`
  helpers. Existing built-in gameplay attributes (`nt-option`, `nt-nav`, `nt-continue`,
  `nt-object`, `nt-action`, `nt-clear-selection`) are preserved only as temporary compatibility for
  the current gameplay document/custom component output.
- Built-in title Layout startup is implemented. Loading a runtime project mounts
  `system:/ui/title/default-title.rml` through the shell layout manager, binds the project title and
  Start label fallback, and defers loading `runtime_game` until `game.start`.
- Built-in pause menu overlay is implemented at `system:/ui/menu/pause-menu.rml`. `game.pause`
  mounts it as a modal MenuOverlay, adds the shell pause token, and gates gameplay `Tick` without
  unloading gameplay state. `game.resume`, `menu.close`, Resume, and Escape while paused remove the
  overlay and return to Game mode.
- Runtime UI has C++-backed RmlUi components for ActiveText, MapView, and TextLog. ActiveText is
  rendered by the engine text/bgfx path after RmlUi layout provides bounds and input routing.
- Runtime project/package export, playback specs, editor preview/tooling, typed assets, audio, shader
  materials, and save-backed Lua mutation APIs exist as foundations. Treat legacy NovelTea import
  support as optional migration tooling, not a compatibility contract.
- The Electron/TanStack editor has a workbench shell, command/undo foundation, authoring schema
  skeleton, project explorer/entity operations, preview manager foundation, and assets editor v1.

## Active Gaps

- Next runtime work should follow
  [`../runtime/RUNTIME_SHELL_LAYOUT_PLAYBACK_IMPLEMENTATION_PLAN.md`](../runtime/RUNTIME_SHELL_LAYOUT_PLAYBACK_IMPLEMENTATION_PLAN.md):
  default/title Layout startup, menu overlays, pause UI, transitions, Layout-aware preview/playback,
  and command bridges from Lua/editor/test surfaces.
- Runtime Layout export/manifest support is still incomplete. The editor now authors named system
  Layout roles under `settings.ui.systemLayouts` (`title`, `game-hud`, `pause-menu`, `load-menu`,
  `settings-menu`, `modal`, and `debug-overlay`) with built-in fallbacks. Runtime export and
  consumption of project-authored system Layouts are still deferred.
- Runtime entity start commands (`Game.start_room`, `Game.start_dialogue`, `Game.start_scene`, and
  `Game.run_script`) currently dispatch but return clear not-implemented diagnostics until those
  runtime flows are wired.
- Save/load/settings/text-log screens, return-to-title, quit flow, platform-specific save
  persistence, and user-facing autosave feedback remain incomplete.
- Lua-evaluated map visibility is deferred because `noveltea_core` must stay Lua-free; implement this
  through an engine-layer evaluation/result contract.
- ActiveText/MapView presentation hardening remains: richer font-family fallback, higher-quality glow,
  project-authored room/object materials, bgfx/custom-geometry map rendering, and optional map
  transitions.
- Editable/source package workflows, broader Web runtime smoke coverage, and Android emulator smoke
  coverage remain incomplete.
- Pin `NOVELTEA_RMLUI_BGFX_GIT_TAG` once the external renderer API stabilizes.

## Verification

Use the smallest relevant subset for the touched area:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --preset web-debug
cmake --build --preset web-debug
```

For runtime loop, input, UI, or rendering changes:

```sh
./build/linux-debug/apps/sandbox/noveltea-sandbox
```

For Android/platform/CMake/shader/asset packaging/JNI/Gradle changes:

```sh
cd android
./gradlew :app:assembleDebug
```

For local `rmlui-bgfx` integration work:

```sh
cmake --preset linux-debug-local-rmlui-bgfx
cmake --build --preset linux-debug-local-rmlui-bgfx
ctest --test-dir build/linux-debug --output-on-failure
```

`format-check` currently reports unrelated formatting debt in `engine/src/render/bgfx/` and
`tests/core/`. Keep touched C/C++ files clang-format clean even if the global target is not clean.

Latest runtime layout/title slice verification:

```sh
cmake --build --preset linux-debug --target noveltea_runtime_shell_tests
cmake --build --preset linux-debug --target noveltea_script_tests
ctest --test-dir build/linux-debug -R "RuntimeShell|Game bindings: dispatcher|built-in title" --output-on-failure
ctest --test-dir build/linux-debug -R "layout layer" --output-on-failure
```

`format-check` was rerun after formatting touched files and now fails only on the pre-existing
unrelated files listed above.

Latest pause menu slice verification:

```sh
cmake --build --preset linux-debug
./build/linux-debug/tests/noveltea_runtime_shell_tests
ctest --test-dir build/linux-debug --output-on-failure -R "RuntimeShell|Game bindings"
cmake --preset web-debug
cmake --build --preset web-debug
```
