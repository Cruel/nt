# Architecture

This document describes the current `Cruel/nt` runtime architecture as it exists in the repository. It is implementation-facing: use it to understand ownership, startup order, runtime flow, and the migration boundary from the old `refs/NovelTea/` engine.

## Current Shape

The repository has separate application shells. `noveltea-sandbox` retains demos, preview
integration, and diagnostic controls. `noveltea-player` validates the shared bootstrap contract and
runtime package before engine initialization, discovers packaged inputs relative to the executable
or platform resource base, and supplies identity-scoped cache and save roots. Release configurations
disable Dear ImGui devtools by default, and the player does not link the sandbox application's C
preview command surface.

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

- `AssetManager`: logical asset namespaces and mounted sources for system, project, cache, and legacy package assets. It also acts as the public typed prepared-asset facade for runtime systems; fonts resolve through typed font requests backed by a registered text/font loader, and the bgfx renderer registers typed texture, shader-program, and material loaders for prepared render assets. The bgfx typed texture loader uses `bimg::imageParse` for ordinary image assets. Raw `open`/`read_binary`/`read_text` remain available for scripts, tools, and low-level loaders.
- `Platform`: SDL3 window, events, native window handles, timing, quit state, and surface metrics.
- `Renderer`: bgfx renderer ownership, view setup, demo drawing, screenshots, and resize handling.
- `ScriptRuntime`: Lua state, host bindings, asset-backed script execution helpers, and `bind_game_session`.
- `RuntimeUI`: RmlUi lifecycle, SDL3 input translation, bgfx RmlUi rendering, document management, and current runtime-game document updates.
- `core::RuntimeSessionHost`: backend-neutral loaded game session, controller, derived runtime view state, and last controller command batch.
- `DebugUI`: Dear ImGui developer/debug UI only.

`Engine` is intentionally the composition root. New runtime services should be wired explicitly from `Engine` or from a narrow facade owned by `Engine`, not discovered through a global service locator.

## Host Surface And Game Viewport

`Platform` reports the complete host surface: the SDL window, browser canvas, Android usable
surface, or editor iframe canvas. `Engine` combines those host metrics with its active
`DisplayProfile` and owns the resulting `PresentationMetrics`.

The current Phase 1-2 profile is the fallback 16:9 landscape profile. The fitted game viewport is
centered inside the host using deterministic integer contain fitting. The constrained dimension is
floored; centering floors the leading margin, leaving any odd spare pixel in the right or bottom
bar. Framebuffer edges are then rounded to nearest from the fitted logical edges rather than by
rounding an independent framebuffer size. Rendering and input therefore use the same boundaries at
fractional display scales.

`Renderer` resets the swapchain and captures screenshots at the full host framebuffer size. It
clears that full framebuffer to the presentation-bar color, then restricts game layers, direct text,
ActiveText, runtime transitions, and RmlUi's final backbuffer passes to the fitted game rectangle.
Game projections and responsive layout use the fitted game logical dimensions. Dear ImGui remains
a host-sized overlay and receives untransformed host input.

`RuntimeUI` receives host SDL events together with `PresentationMetrics`. Mouse and touch positions
are transformed into game logical coordinates before RmlUi dispatch. New input in presentation bars
is rejected, pointer exit clears hover state, captured mouse release remains deliverable, and active
touches are cancelled consistently when they leave the viewport. Wheel routing uses the coordinates
carried by the SDL wheel event rather than stale hover state.

## Initialization Order

`Engine::initialize` currently initializes in this order:

1. Store run options such as frame limit, demo mode, screenshot path, preview/debug UI flags.
2. Initialize `Platform`.
3. Configure asset mounts.
4. Query native window handles from `Platform`.
5. Resolve presentation metrics and initialize `Renderer` with native handles, host/game viewport
   metrics, vsync, and `AssetManager`.
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

If non-throwing JSON parsing reports invalid input, the engine falls back to legacy package loading:

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
[`docs/runtime/PACKAGE_EXPORT.md`](../runtime/PACKAGE_EXPORT.md).

The current `ProjectDocument`/`ProjectModel` load path and `noveltea.runtime.project` V1 export are
provisional migration scaffolding, not the target package or runtime model. Do not add runtime
features to their generic JSON, numeric-entity, or raw-cutscene representations. Phases 4--10 of
[`TYPED_RUNTIME_MODEL_AND_JSON_BOUNDARIES_IMPLEMENTATION_PLAN.md`](plans/TYPED_RUNTIME_MODEL_AND_JSON_BOUNDARIES_IMPLEMENTATION_PLAN.md)
replace them with compiled-project, typed-session, and explicit boundary models.

## Main Loop

`Engine::run` loops while `m_running` and calls `tick`.

Each `Engine::tick` performs:

1. `handle_events()`
2. `update(m_platform.delta_time())`
3. `render()`
4. quit and frame-limit checks

Event handling polls SDL events from `Platform`. Events are offered to `DebugUI` first when enabled,
then to `RuntimeUI`. Debug UI input remains in host coordinates. Runtime pointer and touch input is
mapped through the fitted viewport before RmlUi or game fallback handling sees it. If RmlUi consumes
key or pointer events, game/platform fallback handling for those events is skipped. Window size,
pixel size, and display scale changes refresh host metrics and call `Engine::resize_host`, which
recomputes presentation metrics before updating `Platform`, `Renderer`, and `RuntimeUI`.

`Engine::update` is gated by the preview-running flag. When a runtime project is loaded, it ticks `RuntimeSessionHost` and forwards the host's latest controller commands to `RuntimeUI::apply_controller_commands`.

`Engine::render` begins debug UI if enabled, begins RmlUi, begins the renderer, draws the preview triangle and enabled demos, advances the frame count, renders RmlUi, ends debug UI, schedules screenshots when requested, and ends the renderer frame.

## Core Runtime

The backend-neutral runtime path is centered on `GameSession`, `RuntimeController`, `RuntimeSessionHost`, and `RuntimeUIViewAdapter`.

`GameSession` owns the loaded `ProjectModel`, `SaveDocument`, runtime event bus, timer scheduler, startup entrypoint, current entity/room/map state, navigation flags, entity queue, session commands, and play time. Loading validates the project document and save document, resolves the startup entrypoint from save data or project data, restores saved runtime state, and emits diagnostics plus initial session commands.

`RuntimeController` owns the active runtime mode. It drains queued entities, enters rooms, starts dialogue and cutscene controllers, tracks visit counts, receives runtime events, and emits `ControllerCommand` records. Script hooks, script entities, dialogue script lines, cutscene script lines, and action scripts are currently emitted as `ControllerCommandType::ScriptDeferred` commands.

`RuntimeSessionHost` combines one `GameSession`, one optional `RuntimeController`, one `RuntimeUIViewAdapter`, and the last controller command batch. It loads/reset/ticks the backend-neutral session and exposes direct input methods for navigation, dialogue option selection, continue, and room actions. It also derives room object/action lists from the project model when the controller is in room mode.

`RuntimeUIViewAdapter` converts controller commands into a simple backend-neutral `RuntimeUIViewState`: mode, title, body, notification, dialogue options, navigation labels, room objects, actions, text log, continue/page-break flags. It deliberately ignores `ScriptDeferred` commands today; script execution is not yet wired through this adapter.

## Runtime UI Bridge

`RuntimeUI` is the bridge from backend-neutral runtime state to the RmlUi document layer. It owns document loading/reload, runtime input routing, custom runtime components, and binding `RuntimeUIViewState` into project/theme/system UI templates.

NovelTea consumes the external `rmlui-bgfx` renderer package through a narrow adapter. The `nt` repository should document only that integration boundary: asset-backed texture loading, shader-program loading, diagnostics/perf forwarding, material-provider integration, and runtime view allocation. RmlUi renderer internals, parity probes, effects behavior, and optimization notes belong in the standalone `rmlui-bgfx` repository.

Runtime UI state still flows from backend-neutral runtime objects into `RuntimeUI`; RmlUi must not own game state. Input is routed back through the shared runtime input path rather than directly mutating controllers from document-specific code.

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

## Error Propagation Policy

Recoverable failures at project, asset, rendering, scripting, and platform boundaries use
`noveltea::core::Result<T, E>`. `Diagnostic` is the common cross-subsystem error when a narrower typed
error is not more useful; it preserves a stable code, user-facing message, severity, source path, JSON
pointer, and nested causes. Libraries return errors and add context, while application boundaries own
logging and presentation. `Fatal` is reserved for non-recoverable contract or process failures and is
never used merely because user-authored input is invalid. `Diagnostics` and `append_diagnostics` support
validation that must report multiple independent problems.

`Result` is a tagged success-or-error value; callers must test it before accessing `value()` or
`error()`. `transform`, `and_then`, and `transform_error` provide explicit propagation without hidden
control flow. A `Result<void, E>` represents successful completion without manufacturing a dummy value.
Deep libraries return diagnostics but do not log them; executable, editor-tool, preview, and platform
boundaries decide how and where diagnostics are presented. Nested failures use `Diagnostic::causes`,
and context is added with source paths and JSON pointers as errors cross subsystem boundaries.

Allocation exhaustion is a fatal runtime condition. NovelTea does not attempt recovery from
`std::bad_alloc`; a no-exceptions build may terminate when the allocator cannot satisfy a request.
Recoverable filesystem, parsing, conversion, and external-tool failures must instead use status codes,
`std::error_code`, or typed results. Runtime construction of `std::regex` and `std::locale` is
prohibited in shipped first-party code because their failure contracts depend on C++ exceptions.

This policy is unconditional for shipped C++ targets. NovelTea does not expose feature toggles such as
`NOVELTEA_NO_EXCEPTIONS` or `NOVELTEA_NO_RTTI`; there is only one first-party implementation path.
Compiler policy is applied through `noveltea_apply_runtime_compiler_policy`, and the generated compile
database plus source scanner are validated by the `cxx-policy` target.

Third-party libraries may retain their own custom type systems when compiler RTTI is disabled. The
RmlUi family uses `RMLUI_CUSTOM_RTTI` consistently across Core, Lua, Debugger, `rmlui-bgfx`, and all
consumers. This is an ABI requirement, not an optional per-target define.
