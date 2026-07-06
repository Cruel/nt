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
  input commands, Load/Settings placeholder diagnostics, trace diagnostics, and unknown-command
  diagnostics.
- RmlUi Layout activation uses ordinary Lua `onclick` handlers and dispatcher-backed `Game.*`
  helpers. Existing built-in gameplay attributes (`nt-option`, `nt-nav`, `nt-continue`,
  `nt-object`, `nt-action`, `nt-clear-selection`) are preserved only as temporary compatibility for
  the current gameplay document/custom component output.
- Built-in title Layout startup is implemented. Loading a runtime project mounts
  `system:/ui/title/default-title.rml`, binds the project title and Start label fallback, and defers
  loading `runtime_game` until `game.start`.
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
- Runtime Layout export/manifest support is still incomplete. `settings.ui.defaultLayout` is authored
  but not consumed, and project-authored title/default Layout export is deferred.
- Runtime entity start commands (`Game.start_room`, `Game.start_dialogue`, `Game.start_scene`, and
  `Game.run_script`) currently dispatch but return clear not-implemented diagnostics until those
  runtime flows are wired.
- Save/load screens, platform-specific save persistence, and user-facing autosave feedback remain
  incomplete.
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

Latest runtime title slice verification:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
./build/linux-debug/apps/sandbox/noveltea-sandbox --runtime-project project:/projects/runtime_phase9_package/game --frames 120 --no-imgui
```

`format-check` was rerun after formatting touched files and now fails only on the pre-existing
unrelated files listed above.
