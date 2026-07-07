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
- Layout-aware runtime UI playback V0 is implemented in the engine layer. `RuntimeUiPlaybackSession`
  can mount the shell title Layout, replay `ui-click` steps by stable selector, dispatch real RmlUi
  click events into Layout Lua/`Game.*`, drain host/script/UI work, and report click, Lua command,
  runtime command, and runtime output traces.
- Phase I UI-click test integration is implemented. Authoring tests can now define `ui-click` steps
  with stable document/target/selector fields, serialize them to native UI playback specs, run them
  through the editor helper/Electron/TestsEditor path, and inspect clickability diagnostics plus
  UI/Lua/runtime traces in the test playback report.
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
- Preview recording remains incomplete. Runtime UI playback now provides the replay foundation and
  TestsEditor can run authored `ui-click` steps, but live preview still does not record
  user-visible `ui-click` steps.
- Runtime Layout export/manifest support is still incomplete. The editor now authors named system
  Layout roles under `settings.ui.systemLayouts` (`title`, `game-hud`, `pause-menu`, `load-menu`,
  `settings-menu`, `modal`, and `debug-overlay`) with built-in fallbacks. Runtime export and
  consumption of project-authored system Layouts are still deferred.
- Runtime Script entrypoints, `Game.run_script`, and `Game.start_room`/`Game.go_to_room` now route
  through `RuntimeCommandDispatcher` into `RuntimeSessionHost`/`RuntimeController`.
- Runtime Dialogue export/start/progression is implemented for the current safe subset: authoring
  Dialogue records export to runtime-compatible dialogue arrays, Dialogue entrypoints load, and
  `Game.start_dialogue` routes through the dispatcher into `RuntimeSessionHost`/`RuntimeController`.
  Continue and choice selection work through Lua-first generated controls while preserving temporary
  compatibility attributes.
- Runtime Scene V0 export/start/progression is implemented through the existing cutscene-style
  runtime controller path. Authoring Scene records export to runtime `cutscene` records, Scene
  entrypoints load as `EntityType::Cutscene`, and `Game.start_scene` routes through the dispatcher
  into `RuntimeSessionHost`/`RuntimeController`. The supported subset is text-like scene steps,
  continue/page-break waits, dispatcher-backed dialogue/layout hooks, and simple next targets;
  unsupported step types emit export diagnostics.
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

Latest Phase 10 UI playback foundation verification:

```sh
cmake --build --preset linux-debug --target noveltea_runtime_shell_tests
./build/linux-debug/tests/noveltea_runtime_shell_tests "RuntimeUI playback click*","RuntimeUiPlaybackSession*"
ctest --test-dir build/linux-debug --output-on-failure -R "runtime_shell|ui"
cmake --build --preset linux-debug --target format-check
```

The focused playback build/tests and filtered runtime/UI CTest pass. `format-check` still fails only
on pre-existing unrelated formatting debt in `engine/src/render/bgfx/bgfx_typed_asset_loader.cpp`,
`tests/core/editor_api_tests.cpp`, and `tests/core/project_document_tests.cpp`; touched files were
formatted with clang-format.

Latest Phase 8 script-entrypoint slice verification:

```sh
./node_modules/.bin/vitest run src/renderer/test/authoring-runtime-export.test.ts
clang-format --dry-run --Werror <touched C++ files>
git diff --check
```

The focused native targets `noveltea_runtime_shell_tests` and `noveltea_script_tests` could not
build in `build/linux-debug` because CMake re-ran FetchContent for `rmlui_bgfx` and failed while
rebasing the generated dependency checkout under `build/linux-debug/_deps/rmlui_bgfx-src`.

Latest Phase 8 dialogue runtime/export slice verification:

```sh
cmake --preset linux-debug-local-rmlui-bgfx
cmake --build --preset linux-debug-local-rmlui-bgfx --target noveltea_runtime_shell_tests noveltea_script_tests
./build/linux-debug/tests/noveltea_runtime_shell_tests
./build/linux-debug/tests/noveltea_script_tests
./node_modules/.bin/vitest run src/renderer/test/authoring-runtime-export.test.ts
clang-format --dry-run --Werror <touched C++ files>
git diff --check
```

Latest Phase 8 scene runtime V0 slice verification:

```sh
cmake --build --preset linux-debug-local-rmlui-bgfx --target noveltea_runtime_shell_tests noveltea_script_tests
./build/linux-debug/tests/noveltea_runtime_shell_tests
./build/linux-debug/tests/noveltea_script_tests "Game bindings: dispatcher-backed gameplay helpers build valid payloads"
ctest --test-dir build/linux-debug -R "RuntimeShell start_game supports a scene entrypoint|RuntimeCommandDispatcher starts and progresses scenes" --output-on-failure
./node_modules/.bin/vitest run src/renderer/test/authoring-runtime-export.test.ts
clang-format --dry-run --Werror <touched C++ files>
git diff --check
```
