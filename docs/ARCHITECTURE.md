# Architecture

This document describes the current `Cruel/nt` runtime architecture as it exists in the repository. It is implementation-facing: use it to understand ownership, startup order, runtime flow, and the migration boundary from the old `refs/NovelTea/` engine.

## Current Shape

The sandbox executable enters through `apps/sandbox/main.cpp`, constructs `noveltea::App`, and calls `App::run(argc, argv)`. `App` owns one `Engine` instance. `Engine` owns the runtime subsystems directly and is the current composition root.

The top-level path is:

```text
main -> noveltea::App -> noveltea::Engine
```

`main` is only SDL3-compatible process entry glue. `App` handles command-line and environment options, maps them into `PlatformConfig` plus `EngineRunConfig`, and delegates lifecycle to `Engine`. `Engine` creates, wires, ticks, renders, and shuts down the subsystems.

## App

`App::parse_options` currently accepts:

- `NOVELTEA_SMOKE_FRAMES` or `--frames <n>` for frame-limited smoke runs.
- `--demo none|render2d|rmlui|text|all` for demo rendering selection.
- `--system-assets <path>`, `--project-assets <path>`, and `--cache-assets <path>` for asset mount roots.
- `--rmlui-document <logical-asset-path>` for loading an additional RmlUi document.
- `--runtime-project <logical-asset-path>` for loading a runtime project through the asset system.
- `--screenshot <path>` for a later renderer screenshot request.
- `--no-imgui` to disable developer debug UI.

`App::initialize` hard-codes the sandbox title, copies parsed options into `EngineRunConfig`, initializes `Engine`, and stores a process-local preview pointer used by the exported preview bridge functions.

Native and web runs differ at the final loop handoff:

- Native builds call `Engine::run()`, then explicitly call `Engine::shutdown()` before returning.
- Emscripten builds register `App::web_tick` with `emscripten_set_main_loop_arg`. Each browser tick calls `Engine::tick()`. When ticking returns false, the main loop is cancelled and the engine is shut down.

The exported `noveltea_preview_*` functions forward preview controls and resize events to the current preview engine pointer when present.

## Engine Ownership

`Engine` owns these subsystems as members, in this order:

```cpp
assets::AssetManager m_assets;
Platform m_platform;
Renderer m_renderer;
script::ScriptRuntime m_scripts;
RuntimeUI m_runtime_ui;
core::RuntimeSessionHost m_runtime_host;
DebugUI m_debug_ui;
```

That member order matters for lifetime. `Engine::initialize` also performs explicit rollback in reverse initialization order if a later step fails.

The owned subsystems have these current responsibilities:

- `AssetManager`: logical asset namespaces and mounted sources for system, project, cache, and legacy package assets.
- `Platform`: SDL3 window, events, native window handles, timing, quit state, and surface metrics.
- `Renderer`: bgfx renderer ownership, view setup, demo drawing, screenshots, and resize handling.
- `ScriptRuntime`: Lua state, host bindings, asset-backed script execution helpers, and `bind_game_session`.
- `RuntimeUI`: RmlUi lifecycle, SDL3 input translation, bgfx RmlUi rendering, document management, and current runtime-game document updates.
- `core::RuntimeSessionHost`: backend-neutral loaded game session, controller, derived runtime view state, and last controller command batch.
- `DebugUI`: Dear ImGui developer/debug UI only.

`Engine` is intentionally the composition root. New runtime services should be wired explicitly from `Engine` or from a narrow facade owned by `Engine`, not discovered through a global service locator.

## Initialization Order

`Engine::initialize` currently initializes in this order:

1. Store run options such as frame limit, demo mode, screenshot path, preview/debug UI flags.
2. Initialize `Platform`.
3. Configure asset mounts.
4. Query native window handles from `Platform`.
5. Initialize `Renderer` with native handles, surface metrics, vsync, and `AssetManager`.
6. Initialize optional Lua `ScriptRuntime` with `AssetManager`.
7. Resize and initialize `RuntimeUI`, passing `AssetManager`, native SDL window, demo-document flag, and optional `ScriptRuntime`.
8. Optionally load the requested RmlUi document.
9. Optionally initialize `DebugUI` with SDL window and `AssetManager`.
10. Optionally load the runtime project.
11. Mark the engine running/initialized and emit the preview-ready event.

Shutdown runs the active graph in the opposite direction: debug UI, runtime UI, Lua scripts, renderer, then platform.

## Assets And Project Loading

The active asset namespaces are:

- `system:/`: read-only engine/system assets.
- `project:/`: read-only project assets.
- `cache:/`: writable cache assets.

Desktop defaults prefer packaged `assets` beside the executable when present, otherwise compiled default asset roots. Web defaults use `/assets`. Android uses SDL packaged assets for read-only mounts unless an override path is provided, and writable cache data goes through SDL preference storage.

`Engine::load_runtime_project(logical_path)` reads the project through `AssetManager`, so callers pass logical paths such as `project:/projects/runtime_phase8.json` rather than native file paths.

The load path first treats the bytes as normalized JSON:

1. Read bytes from the logical asset path.
2. Parse as JSON with `nlohmann::json`.
3. Construct `core::ProjectDocument`.
4. Load it into `RuntimeSessionHost`, which validates and builds a `ProjectModel`.

If JSON parsing throws, the engine falls back to legacy package loading:

1. Try `core::legacy::ProjectPackageReader::read` over the same bytes.
2. Mount extracted package assets into the `project` namespace with `AssetManager::mount_legacy_package`.
3. Load the package's imported `ProjectDocument` into `RuntimeSessionHost`.

After a successful runtime project load, `Engine` binds `RuntimeUI` to the current `RuntimeController` pointer and logs the loaded project.

Runtime visual presentation uses the same logical asset paths. The backend-neutral view state exposes cover, background, room, and object image slots; the RmlUi runtime layer validates them against `AssetManager` and lets the bgfx RmlUi renderer decode/upload image bytes. Legacy package covers are mounted as `project:/image`, and package textures are mounted under `project:/textures/`.

Runtime package export is backend-neutral core functionality. `core::ProjectPackageWriter` writes
ZIP-based `.ntpkg` files using the legacy-compatible runtime layout plus additive
`manifest.json` metadata, safe asset-path filtering, per-entry checksums, and compiled bgfx shader
variant inclusion. Editor-facing callers use `core::editor::ProjectTooling::export_project_package`
so archive-library types do not leak through public APIs. The v1 package contract is documented in
[`docs/runtime/PACKAGE_EXPORT.md`](runtime/PACKAGE_EXPORT.md).

## Main Loop

`Engine::run` loops while `m_running` and calls `tick`.

Each `Engine::tick` performs:

1. `handle_events()`
2. `update(m_platform.delta_time())`
3. `render()`
4. quit and frame-limit checks

Event handling polls SDL events from `Platform`. Events are offered to `DebugUI` first when enabled, then to `RuntimeUI`. If RmlUi consumes key or pointer events, game/platform fallback handling for those events is skipped. Window size, pixel size, and display scale changes refresh surface metrics and call `Engine::resize`, which updates `Platform`, `Renderer`, and `RuntimeUI`.

`Engine::update` is gated by the preview-running flag. When a runtime project is loaded, it ticks `RuntimeSessionHost` and forwards the host's latest controller commands to `RuntimeUI::apply_controller_commands`.

`Engine::render` begins debug UI if enabled, begins RmlUi, begins the renderer, draws the preview triangle and enabled demos, advances the frame count, renders RmlUi, ends debug UI, schedules screenshots when requested, and ends the renderer frame.

## Core Runtime

The backend-neutral runtime path is centered on `GameSession`, `RuntimeController`, `RuntimeSessionHost`, and `RuntimeUIViewAdapter`.

`GameSession` owns the loaded `ProjectModel`, `SaveDocument`, runtime event bus, timer scheduler, startup entrypoint, current entity/room/map state, navigation flags, entity queue, session commands, and play time. Loading validates the project document and save document, resolves the startup entrypoint from save data or project data, restores saved runtime state, and emits diagnostics plus initial session commands.

`RuntimeController` owns the active runtime mode. It drains queued entities, enters rooms, starts dialogue and cutscene controllers, tracks visit counts, receives runtime events, and emits `ControllerCommand` records. Script hooks, script entities, dialogue script lines, cutscene script lines, and action scripts are currently emitted as `ControllerCommandType::ScriptDeferred` commands.

`RuntimeSessionHost` combines one `GameSession`, one optional `RuntimeController`, one `RuntimeUIViewAdapter`, and the last controller command batch. It loads/reset/ticks the backend-neutral session and exposes direct input methods for navigation, dialogue option selection, continue, and room actions. It also derives room object/action lists from the project model when the controller is in room mode.

`RuntimeUIViewAdapter` converts controller commands into a simple backend-neutral `RuntimeUIViewState`: mode, title, body, notification, dialogue options, navigation labels, room objects, actions, text log, continue/page-break flags. It deliberately ignores `ScriptDeferred` commands today; script execution is not yet wired through this adapter.

## RmlUi Bridge

`RuntimeUI` is the current bridge from backend-neutral runtime state to RmlUi. With RmlUi and bgfx enabled it:

- Installs an asset-backed RmlUi file interface and SDL3-backed system interface.
- Initializes RmlUi, optionally initializes the RmlUi Lua plugin against the engine Lua state, and installs host `print`.
- Creates a bgfx RmlUi render interface and a single RmlUi context named `main`.
- Loads `project:/rmlui/LiberationSans.ttf`.
- Optionally loads the demo document `project:/rmlui/demo.rml`.
- Always attempts to load `project:/rmlui/runtime_game.rml` as document ID `runtime_game`, initially hidden.

The current runtime-game update path is direct and fixed-ID based. `RuntimeUI::apply_controller_commands` applies commands to an internal `RuntimeUIViewAdapter`, finds document `runtime_game`, then calls `SetInnerRML` on known element IDs:

- `rt_mode`
- `rt_title`
- `rt_body`
- `rt_notification`
- `rt_prompt`
- `rt_options`
- `rt_navigation`
- `rt_objects`
- `rt_actions`
- `rt_log`

Text content is escaped before insertion, and body/log text is wrapped as simple paragraph RML. Buttons are generated with attributes such as `nt-option`, `nt-nav`, `nt-continue`, `nt-object`, and `nt-action`.

`RuntimeUI::bind_runtime_controller` stores a borrowed raw `core::RuntimeController*` in `RuntimeUI::State`. It adds one click listener to the `runtime_game` document. That listener directly calls controller methods for dialogue option selection, navigation, continue/cutscene clicks, object selection, and action processing.

This is the current bridge, not the final component model. There is no production RmlUi data model for runtime-game state yet, and complex widgets are not yet custom RmlUi elements.

## Lua Runtime Status

Lua is the only runtime scripting target in this repository.

`Engine` initializes `ScriptRuntime` after `Renderer` and before `RuntimeUI`. `ScriptRuntime` opens a restricted Lua state, removes direct OS/file/package entry points, registers NovelTea host bindings, installs host `print`, and can execute source strings or logical asset paths through `AssetManager`.

`ScriptRuntime` exposes `bind_game_session(core::GameSession*)` and `clear_game_bindings()`. The binding implementation registers game compatibility globals and wraps the current `GameSession` pointer. Many mutation APIs are intentionally still stubs, including property mutation, save/load/autosave/quit behavior, script text input, and some save helpers.

### Tween Service

`twink` is an optional animation backend controlled by `NOVELTEA_ENABLE_TWINK`. When enabled, `TweenService` wraps `twink::TweenManager`, advances from the same deterministic delta used for runtime ticks, and exposes owner/channel pause, resume, kill, reset, and debug snapshot operations. When twink is disabled, tweens resolve as immediate value changes. `noveltea_core` does not include or link `twink`; core may carry declarative presentation values such as ActiveText reveal progress, while runtime/UI owns active tween instances.

The runtime controller does not yet execute emitted runtime scripts through `ScriptRuntime`. Script hooks and script entities are still represented as `ScriptDeferred` controller commands. `RuntimeUIViewAdapter` ignores those commands, and `Engine::update` currently forwards the command batch only to the RmlUi bridge.

## Contrast With Old NovelTea Context

The old engine under `refs/NovelTea/` centered runtime access on a `Context`/`Subsystem` service-locator pattern with process-wide access macros for systems such as game, save/project data, and scripting. That code is reference material only. It is helpful for understanding behavior and data formats. Do not bring that pattern into `nt`.

The active architecture uses:

- `Engine` as the explicit composition root.
- Backend-neutral `core` runtime objects for project/save/session/controller behavior.
- Logical asset paths through `AssetManager`.
- Explicit runtime input and output methods on `RuntimeSessionHost`, `RuntimeController`, and view-state adapters.
- Runtime UI as a bridge over backend-neutral state rather than as the owner of game state.
- A narrow script-service facade owned and wired by `Engine`, instead of exposing arbitrary process-wide subsystem access.

Keep backend-neutral core code free of SDL3, bgfx, RmlUi, Dear ImGui, Lua, Electron, Android, Emscripten, SFML, and Qt types. Runtime scripting stays Lua-only.

Legacy script text imported from old projects is either valid Lua or fails as Lua with diagnostics surfaced by the runtime/tooling layer.
