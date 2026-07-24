# Host Responsibility Inventory

Date: 2026-07-17

Status: Phase 1A characterization baseline for
`HOST_AND_MODULE_BOUNDARY_IMPLEMENTATION_PLAN.md`. This document records current ownership in the
repository and the target owner fixed by that plan. It does not introduce new host contracts or move
production code.

## Scope and interpretation

This inventory covers every broad responsibility currently implemented by `Engine` or
`RuntimeUI`. A responsibility may use an existing lower-level service while still being listed under
`Engine` or `RuntimeUI` when those classes currently own its orchestration, lifetime, or public
entrypoint.

The target-owner column uses the following plan terms:

- **Engine facade / Engine implementation**: the public lifecycle facade and its private composition
  root;
- **GameHost**: loaded-game, runtime dispatch, publication, presentation-service, and runtime-facing
  adapter coordination;
- **LayoutRealizer**: mounted Layout instance to RuntimeUI document realization;
- **HostInputRouter**: deterministic host event admission and routing;
- **PreviewHost**: editor preview, runtime debugger/recorder, preview-only scripting/audio, and
  preview diagnostics;
- **RmlUi host**: RmlUi global/context/render/input lifecycle inside the RuntimeUI implementation;
- **Document registry**: RuntimeUI document source, identity, order, policy, reload, and listener
  lifecycle;
- **Runtime UI binder**: publication/shell data binding, typed UI actions, and custom-component data;
- **ActiveText presenter**: ActiveText playback, layout, and render snapshot production;
- **Playback/test driver**: selector-based test interaction and other test-only RuntimeUI controls;
- **sandbox/dev harness**: behavior that is not part of the production player host.

Target module names such as `noveltea_content`, `noveltea_runtime`, and
`noveltea_presentation` describe the later physical placement. Phase 1A does not create those
targets.

## Current lifecycle anchors

The current `Engine::initialize()` order is:

1. platform/window;
2. asset namespace mounting;
3. renderer;
4. resource aliases, audio, and shader/material state;
5. `ScriptRuntime`;
6. `RuntimeUI` and its RmlUi/Lua integration;
7. optional `DebugUI`;
8. save-store selection and optional compiled-project/`RunningGame` load;
9. preview-ready publication and frame-loop enablement.

The current normal shutdown order is:

1. stop the frame loop and shut down `DebugUI`;
2. detach RuntimeUI runtime handlers and capabilities;
3. reset system/logical/realized Layout state and terminate presentation operations;
4. reset world presentation and destroy `RunningGame` bindings;
5. shut down `RuntimeUI` and RmlUi;
6. unbind and shut down audio, then shut down `ScriptRuntime`;
7. shut down the renderer and platform.

`RuntimeUI::cleanup_state()` unloads documents, removes contexts, destroys document/template
helpers, shuts down RmlUi, releases plane renderers, clears global RmlUi interfaces, and finally
deletes the private state. Later extraction must preserve that dependency order even if the work is
distributed among cohesive internal owners.

The current per-frame order is platform polling and routing, runtime/presentation/audio update,
world and RuntimeUI rendering, debug rendering, screenshot/checkpoint capture requests, and renderer
frame completion. Phase 1C is responsible for turning the important ordering claims below into
focused characterization tests.

## Ownership and lifecycle matrix

| ID | Responsibility | Current owner and evidence | Target owner | Public caller or consumer | Lifetime, prerequisites, and shutdown ordering | Migration phase |
| --- | --- | --- | --- | --- | --- | --- |
| H01 | Public host facade and concrete composition | `Engine` public header value-owns platform, renderer, assets, audio, scripts, runtime, presentation, Layout, preview, and debug objects. | Thin `Engine` facade plus private Engine implementation/composition root. | `App`, `apps/player`, platform launchers, and tests/tools that construct the player host. | Process/player-host lifetime. Construct concrete services before exposing a running host; destroy loaded-game/tooling state before backend services. | 2A, 2G, 6A |
| H02 | Platform/window lifecycle and event collection | `Engine` initializes `Platform`, obtains native handles, polls SDL events, and requests quit. | Engine implementation retains platform lifecycle; `HostInputRouter` receives collected events. | `App`, `apps/player`, SDL/Emscripten entrypoints. | First initialized, last shut down. Renderer and RuntimeUI require its native window/surface; no routed event may outlive the frame. | 2A, 4A |
| H03 | Asset roots, namespaces, aliases, loader bindings, and font configuration | `Engine::configure_assets()`, package remounting, alias loading, audio/font loader binding, and `RuntimeUiAssetResolver`; `AssetManager` performs storage operations. | Engine implementation owns host roots and concrete `AssetManager`; existing content loader/GameHost coordinates package project mounts; backend adapters own temporary loader bindings. | `EngineConfig`, package loader, renderer, audio, scripts, RuntimeUI, text, preview, and sandbox fixtures. | Host assets exist before renderer/audio/scripts/UI. Package assets are replaced before a new `RunningGame` is published. Audio/font loader pointers must be detached before their owners are destroyed. | 2C, 3A, 4G |
| H04 | Shader/material project loading and renderer binding | `Engine` parses loose-project metadata, accepts package shader/material data, stores `ShaderMaterialProject`, and points `Renderer`/RuntimeUI at it. | Existing content codecs/loaders own decoding; GameHost coordinates loaded-package state; Engine renderer/UI adapters own backend binding. | Renderer, RuntimeUI RmlUi backend, sandbox demo materials, package/player load. | Renderer exists before binding. Loaded-project material state is replaced during project load and remains valid through RuntimeUI/renderer use. | 2C, 5A-5C |
| H05 | Renderer lifecycle, frame submission, world/UI composition, and final present | `Engine::initialize()`, `render()`, `resize_host()`, and `shutdown()` coordinate `Renderer`, world batches, RuntimeUI planes, transitions, ActiveText, debug UI, and frame completion. | Engine implementation retains top-level frame submission; GameHost/presentation adapters provide realized game output; renderer remains a concrete engine backend. | Main loop, world presentation backend, RuntimeUI, DebugUI, screenshots/readback. | Requires platform native handles and assets. Starts before RuntimeUI and shuts down after RuntimeUI/scripts. Each frame owns temporary render ordering and framebuffer selection. | 2E, 4E-4F |
| H06 | Audio backend lifecycle and runtime audio realization | `Engine` initializes/updates/pauses/resumes/shuts down `AudioSystem`; `RuntimeAudioAdapter` realizes desired operations; direct preview/demo methods remain public on `Engine`. | Engine implementation owns `AudioSystem`; GameHost coordinates runtime-facing adapter; PreviewHost owns preview-only direct audio. | Runtime presentation service, preview browser exports, sandbox CLI fixtures. | Requires assets. Runtime adapter is usable only while audio and package asset resolution are bound. Stop/terminate runtime operations before audio shutdown. | 2B, 2E, 4D |
| H07 | Lua runtime initialization, certification support, runtime binding, and preview execution | `Engine` initializes `ScriptRuntime`, passes it to running-game loaders and RuntimeUI, and executes preview Lua directly. Existing loaders/runtime perform certification and invocation. | `noveltea_script_lua` implementation constructed by Engine; GameHost coordinates the runtime script port; PreviewHost owns tooling-profile execution. | RunningGame loader/session, RuntimeUI RmlUi Lua, editor preview exports, editor tool. | Requires assets; must initialize before RuntimeUI and RunningGame creation. RuntimeUI must detach and shut down before `ScriptRuntime`. | 2B-2C, 4B, 5B |
| H08 | Compiled project/package reading, extraction, decoding, and load orchestration | `Engine::load_compiled_project()` reads assets, distinguishes loose JSON from package ZIP, remounts package assets, calls running-game loaders, and performs all post-load binding. | Existing content/package loader remains authoritative; GameHost owns host-side load orchestration and publication of a successfully created running game. | Player CLI/config, RuntimePreviewController, browser runtime-load export, automatic sandbox fixture load. | Requires assets, ScriptRuntime, presentation/storage ports, renderer/UI adapters. A failed load must not expose partial bindings. Old runtime/Layout/presentation state is torn down before replacement. | 2C |
| H09 | Save-slot storage injection, shell slot reads, and checkpoint thumbnail attachment | `Engine` chooses internal/external `TypedSaveSlotStore`, passes it to RunningGame, reads slots for shell views, and coordinates renderer captures with session thumbnail attachment. | Engine injects storage; GameHost coordinates runtime/shell storage use; renderer capture adapter owns pixels; save codecs stay in content/runtime owners. | Runtime checkpoint service, RuntimeSystemLayouts, player-provided store, save/load UI. | Store must outlive the loaded game; an external pointer must outlive Engine use. Pending thumbnail capture must be invalidated before RunningGame/renderer teardown. | 2B-2C, 4F |
| H10 | `RunningGame` creation, ownership, replacement, reset, stop, and destruction | `Engine` owns `std::unique_ptr<runtime::RunningGame>` and RuntimePreviewController accesses it through friendship. | GameHost. | Engine load path, RuntimePreviewController, RuntimeUI handlers/capabilities, presentation bridge, DebugUI observations. | Exists only after complete loader success. Runtime/UI/presentation bindings are established after assignment and detached before destruction on reload/shutdown. | 2B-2C, 2F |
| H11 | Runtime input dispatch, deferred completion queue, time advancement, and disposition handling | `Engine::dispatch_runtime_input*()`, `m_pending_runtime_inputs`, `update()`, and presentation/audio polling. | GameHost using final `RunningGame`/session contracts. | RuntimeUI actions, RuntimeSystemLayouts, RuntimePreviewController, frame clock, presentation/audio completions. | Requires RunningGame. Deferred inputs are drained before the new external input and cleared on reload/shutdown. Dispatch must not recurse through UI or backend callbacks. | 2D-2E |
| H12 | Runtime publication, events, observations, and diagnostic application | `Engine` stores the latest publication, applies it to RuntimeUI, delivers events, refreshes shell Layouts, and appends diagnostics to Engine/UI/preview channels. | GameHost owns one deterministic application path; Runtime UI binder and presentation adapters consume typed outputs. | RuntimeUI, RuntimeSystemLayouts, preview/debug snapshots, shell save/text-log views. | Publication/event application occurs within one dispatch result while bindings are valid. Stored observations are cleared before running-game replacement. | 2D |
| H13 | Concrete presentation service and finite operation lifecycle | `RuntimePresentationBridge` is value-owned and configured by `Engine`; Engine flushes it, polls audio, queues completion inputs, and terminates it during reload/shutdown. | GameHost owns/coordinates the concrete presentation service; lower presentation module retains backend-neutral operation semantics; engine adapters realize operations. | RuntimeSession presentation port, audio adapter, world transition backend, RuntimeUI ActiveText phase. | Constructed with Engine adapters; bound to current RunningGame ID allocation/snapshot backend only during a load. Terminate before Layout/world/game teardown. | 2B, 2D-2F |
| H14 | World presentation resource resolution, snapshot realization, and transitions | `Engine` value-owns resource resolver, world backend, and transition backend; reconciles snapshots, advances transitions, and composes render paths. | GameHost coordinates snapshot application; presentation module owns backend-neutral resolver/coordinator state; engine renderer adapters own concrete realization. | Presentation bridge, renderer, RuntimeUI world-overlay planes, checkpoint revision checks. | Project resources bind after successful load. Reset/terminate before package assets and RunningGame disappear. Render frames/revisions live only while retained by current/active transitions. | 2B, 2E, 5A-5C |
| H15 | Logical mounted Layout policy and system-shell workflow | `Engine` owns `RuntimeLayoutManager` and `RuntimeSystemLayouts`, implements `RuntimeSystemLayoutHost`, and derives shell views/settings. | Logical mounted policy remains in presentation; GameHost coordinates runtime/system Layout workflows; backend realization is delegated to LayoutRealizer. | RuntimeSystemLayouts, presentation snapshots, RuntimeUI input admission, shell commands. | RuntimeLayoutManager binds after RuntimeUI init and resets before RuntimeUI shutdown or project replacement. System layouts require a RunningGame/project. | 2B, 3A |
| H16 | Layout source preparation, document realization, instance bookkeeping, visibility/order/policy reconciliation | `Engine::prepare_runtime_layout_document()`, `reconcile_presentation_layouts()`, realized/retained maps, plus RuntimeLayoutManager's RuntimeUI document host. | LayoutRealizer. | GameHost/presentation snapshots, RuntimeSystemLayouts, RuntimeUI document facade, world transitions. | Requires RunningGame project definitions, AssetManager, RuntimeUI, and logical mounted IDs. Unrealize/unmount before RuntimeUI or package assets are released. | 3A |
| H17 | Deterministic input routing, pointer transform, escape handling, Layout admission, and gameplay pause admission | `Engine::handle_events()` orders debug UI, RuntimeUI, Layout policy, platform handling, and demo clicks; `RuntimeUI` also performs context-level routing; Engine derives effective pause. | HostInputRouter owns host ordering; RmlUi host owns context translation; logical Layout manager remains policy source; GameHost receives typed runtime input. | SDL platform events, DebugUI, RuntimeUI, RuntimeSystemLayouts, gameplay runtime. | Per-frame/event lifetime. Router requires current surface metrics, mounted Layout policy, and valid optional UI/debug sinks. It must detach before those sinks shut down. | 4A |
| H18 | Host/runtime clocks, update stages, suspension-aware deltas, FPS pacing, and FPS samples | `Engine::tick()`, `throttle_frame_start()`, `finish_frame_timing_sample()`, `RuntimeClock`, and `update()`. | Engine implementation owns host cadence/stages; GameHost owns runtime update integration; RuntimeClock remains its named backend-neutral service. | Native/Emscripten main loops, RunningGame, presentation, audio, RuntimeUI, preview FPS bridge. | Initialized/reset with Engine. Pause/suspension state is sampled before clock advance. Frame state is invalidated before runtime/backend shutdown. | 2E, 4A |
| H19 | Resize, display profile, host suspension/resume, and backend reset propagation | `Engine` updates Platform surface metrics, presentation metrics, Renderer, RuntimeUI, world presentation, audio pause/resume, and preview display override. | Engine implementation owns host surface/lifecycle notifications; explicit backend reset/reload seams feed GameHost, RuntimeUI host, and presentation adapters. | SDL window events, preview resize/display exports, readback fixture, player launch settings. | Requires initialized platform/backends. Resize updates all consumers coherently; suspend state affects pause/clock before update. Reset consumers before backend shutdown. | 1B, 2E, 4A |
| H20 | Editor preview protocol adaptation, runtime preview/debugger commands, preview virtual content, and preview state | `Engine` exposes raw RML/Lua/JSON methods and preview state; `RuntimePreviewController` is an Engine friend; `app.cpp` exports browser C functions. | PreviewHost with typed requests/results after editor-protocol decoding and explicit GameHost/Layout/UI/audio dependencies. | Electron preview host/browser exports, RuntimePreviewController, preview bridge, sandbox preview widget. | Exists only for tooling-enabled hosts. Requires initialized UI/scripts and optionally a loaded game. Must invalidate callbacks/bindings before GameHost/UI teardown. | 4B |
| H21 | Sandbox demo drawing, fixture audio, resize/readback runs, and automatic demo project | `SandboxDemoHarness`, sandbox `App` configuration, and sandbox assets/CMake own demo drawing, fixture audio, automatic project selection, and resize/readback orchestration. Production `EngineConfig` and frame rendering carry none of that state. | Implemented in `apps/sandbox` and dev/test-only harnesses; production Engine receives only production host configuration. | Sandbox CLI, CI/readback verifiers, editor preview smoke paths. | Harness lifetime wraps an Engine host. Fixture state is not required by player initialization or production rendering. | 4C, 4F-4G |
| H22 | Dear ImGui debug UI lifecycle, event handling, observations, and rendering | `Engine` initializes, routes events to, frames, and shuts down `DebugUI`; DebugUI receives RuntimeUI directly. | Optional engine devtools owner using typed observations/capabilities; not part of production input/runtime authority. | Sandbox/development builds and render-perf diagnostics. | Initializes after RuntimeUI, shuts down before RuntimeUI. Event/render hooks are active only when enabled. | 4E |
| H23 | User screenshots, readback capture, and checkpoint thumbnail capture | `Renderer` owns backend capture and file output; Engine/PreviewHost expose narrow screenshot commands; `CheckpointThumbnailCaptureCoordinator` binds asynchronous captures to checkpoint identity; sandbox `App` owns screenshot scheduling and resize/readback fixtures. Production `EngineConfig` has no screenshot or readback fields. | PreviewHost/dev harness owns user/test screenshots; the renderer capture adapter serves GameHost checkpoint requests. | Sandbox CLI/readback tests, editor preview, checkpoint service/save UI. | Requests are frame-bound and renderer-dependent. Pending IDs/revisions must be invalidated before reload, RunningGame destruction, or renderer shutdown. | 4F |
| H24 | Host logging, typed diagnostic aggregation, preview diagnostic conversion, and status publication | `Engine` combines `bool`, stderr/SDL logs, `core::Diagnostics`, RuntimeUI typed diagnostics, and preview bridge events. | Typed host result/diagnostic seams in GameHost and host contracts; PreviewHost converts typed diagnostics at the editor boundary; backend owners retain backend logs. | Player/sandbox console, RuntimeUI debug display, editor preview protocol, tests. | Diagnostic sinks must not retain references to destroyed runtime/backend state. Reload/shutdown clears runtime-scoped aggregates. | 1B, 2D, 4B |
| U01 | RmlUi global initialization and SDL/file/render/Lua interface installation | `RuntimeUI::initialize()` and `cleanup_state()` allocate interfaces, call `Rml::Initialise`, initialize RmlUi Lua against ScriptRuntime, and call `Rml::Shutdown`. | RmlUi host internal to RuntimeUI. | Engine implementation and headless RuntimeUI integration tests. | Requires AssetManager, initialized ScriptRuntime/Lua state, window or headless mode, and renderer-ready assets/materials. Shut down after documents/contexts and before ScriptRuntime/renderer. | 3C |
| U02 | RmlUi contexts, plane renderers, clock domains, world-overlay framebuffers, update, and render | `RuntimeUI::State` owns context/plane records and RuntimeUI frame methods. | RmlUi host/context implementation. | Engine render loop, Layout document policy, world transition renderer. | Base context follows RmlUi init; additional contexts are lazy by Layout policy. Destroy documents first, contexts second, render interfaces after RmlUi shutdown preparation. | 3C |
| U03 | Document identity, source, load/unload, show/hide, opacity, order, policy migration, reload, and listener lifetime | RuntimeUI facade plus `State` maps/vectors/listeners; RuntimeLayoutManager calls this facade through a document host. | Document registry/lifecycle implementation behind RuntimeUI; LayoutRealizer is the host-side caller for mounted Layouts. | LayoutRealizer/RuntimeLayoutManager, Engine preview, DebugUI, built-in shell UI, tests. | Requires an appropriate context. Documents/listeners/data models are removed before contexts. Reload recreates documents while preserving logical desired Layout state outside RuntimeUI. | 3D, 3H |
| U04 | Built-in/template resolution and preview virtual files | RuntimeUI owns built-in document methods and forwards virtual-file mutation to the RmlUi file interface/template resolver. | Document registry owns source resolution; PreviewHost owns preview virtual-file policy/content. | RuntimeSystemLayouts, LayoutRealizer, editor preview, sandbox demo. | File/template interfaces require AssetManager and outlive all documents. Preview files must be cleared on preview reset/reload before source owners disappear. | 3D, 4B |
| U05 | Runtime publication/shell view storage, document data binding, and typed UI refresh | RuntimeUI stores `TypedRuntimeUIViewState`, shell view, notification/diagnostics, refreshes documents, and uses `RuntimeUiDocumentBinder`. | Runtime UI binder. | GameHost publication application, RuntimeSystemLayouts shell views, RmlUi custom components/documents. | Requires initialized documents/components and a valid typed publication/view. Runtime handlers/views detach before RunningGame destruction and document shutdown. | 3B, 3E |
| U06 | Typed runtime/shell callbacks, RmlUi event actions, Lua `Game.ui`, capability replacement, and event delivery | RuntimeUI stores callback functions/capability sets, installs typed Lua API, interprets RmlUi actions, and dispatches to Engine. | Runtime UI binder emits typed actions to HostInputRouter/GameHost; GameHost provides scoped capabilities; RuntimeUI does not own runtime settlement. | RmlUi documents/custom components/Lua, Engine runtime dispatch, RuntimeSystemLayouts. | Bind only while the corresponding GameHost generation is valid. Clear callbacks/capabilities before runtime replacement and before RuntimeUI/ScriptRuntime shutdown. | 3B, 3E, 4A |
| U07 | ActiveText view interpretation, reveal/page playback, text layout, phase reporting, and direct render snapshot | RuntimeUI `State` owns playback/layout/font/text-engine state; RuntimeUI exposes phase and render snapshot to Engine/presentation. | ActiveText presenter internal to RuntimeUI; presentation service remains operation owner. | Engine render loop, RuntimePresentationBridge, typed runtime publication, ActiveText RmlUi components. | Requires AssetManager/font/text engine and current clocks/publication. Destroy before RuntimeUI font/text loader state and assets are detached. | 3F |
| U08 | Selector-based playback clicks and UI test-driving | RuntimeUI public playback request/result and selector/event simulation helpers. | Playback/test driver, private to preview/test integrations. | No current repository caller outside the RuntimeUI declaration/implementation; the exposed surface is reserved for preview/test use. | Requires initialized visible documents and contexts. No production runtime authority; detach with PreviewHost/test harness. | 3G, 4B |
| U09 | Borrowed raw RmlUi document/element/data-model access | RuntimeUI public `void*` methods and data-model map expose backend implementation details. | Private RuntimeUI/document-registry APIs or narrow typed adapters; generic public access is removed. | RuntimeLayoutManager currently probes `document()`; RuntimeUI integration tests use `document()`/`element()`; no current caller uses the generic data-model methods. | Borrowed pointers are valid only until unload/reload/shutdown. No pointer may cross a document generation boundary. | 3H, 6B |
| U10 | SDL-to-RmlUi translation, pointer/touch transform, context ordering, input-interest reporting, and consumption state | `RuntimeUI::process_event()`, pointer/touch tracking, context policy, and `wants_*` methods. | RmlUi host owns translation/context routing; HostInputRouter owns ordering relative to debug/platform/gameplay. | Engine event loop, mounted Layout policy, RmlUi contexts. | Per-event state requires current presentation metrics and contexts. Resize cancels active pointer/touch state; shutdown clears all state before contexts disappear. | 3C, 4A |

## Diagnostics, dependencies, and existing coverage

The test entries identify existing evidence, not a claim that the final host boundary is already
fully characterized. “Indirect” means the lower-level service is tested while the current Engine or
RuntimeUI orchestration is not isolated. Missing host-order and partial-initialization coverage is
intentionally left for Phase 1C.

| ID | Current error or diagnostic channel | Platform/backend dependencies | Existing tests or evidence |
| --- | --- | --- | --- |
| H01 | `bool` initialization, integer run result, stderr/SDL logs. | All concrete backends through the public header. | Player/sandbox build and smoke paths; no direct thin-facade test yet. |
| H02 | Platform `bool`, `should_quit`, stderr/SDL logs. | SDL3 and native window handles. | `tests/surface_tests.cpp`; platform builds/smoke runs; host event-order coverage deferred to 1C. |
| H03 | Asset `Result`/error strings plus logs. | Filesystem, Android assets, in-memory package sources, backend loader pointers. | `tests/assets/*`, `tests/ui/rmlui_file_interface_tests.cpp`, `tests/text/text_engine_tests.cpp`. |
| H04 | Material parse diagnostics and fatal `bool` load result. | JSON codec, bgfx renderer material binding, RmlUi bgfx adapter. | `tests/render/material_*`, `shader_*`, `compiled_package_tests.cpp`. |
| H05 | Renderer `bool`, SDL/bgfx logs, transition diagnostics. | SDL native handles, bgfx, RmlUi bgfx, ImGui. | Render/material/shader tests and RmlUi/world readback verifiers; no isolated Engine frame-stage test yet. |
| H06 | Audio backend status/logs and typed presentation diagnostics. | miniaudio and asset streams. | `tests/script/runtime_audio_adapter_tests.cpp`; direct Engine preview-audio path is not isolated. |
| H07 | `core::Result<..., ScriptError>`, loader diagnostics, preview bridge diagnostics. | Lua/sol2 and AssetManager. | `tests/script/script_runtime_tests.cpp`, typed execution/session tests, compiled runtime tests. |
| H08 | Loader `core::Diagnostics`; ZIP/JSON errors currently become stderr/SDL/preview diagnostics and `false`. | AssetManager, miniz, nlohmann JSON, ScriptRuntime, save/presentation ports. | `tests/core/compiled_package_tests.cpp`, `tests/script/compiled_runtime_tests.cpp`, typed session tests. Partial host binding failure is deferred to 1C. |
| H09 | Typed store `Result`, shell omission on read failure, checkpoint attachment diagnostics/logs. | Save storage implementation and renderer PNG capture. | `typed_save_slot_store_tests.cpp`, `runtime_checkpoint_service_tests.cpp`, `runtime_system_layouts_tests.cpp`, presentation checkpoint contract tests. |
| H10 | Running-game loader diagnostics, `false` from host load/reset methods. | Runtime, Lua, presentation/storage ports. | `compiled_runtime_tests.cpp` and typed session tests; Engine replacement/cleanup ordering deferred to 1C. |
| H11 | `RuntimeDispatchResult` disposition/diagnostics plus Engine `bool`. | RuntimeSession and presentation/audio completion sources. | Typed execution/session tests and runtime contract tests; host deferred-input ordering needs 1C coverage. |
| H12 | Typed diagnostics appended to Engine/RuntimeUI and SDL/preview output. | Runtime contracts, RuntimeUI, presentation bridge. | `tests/runtime/runtime_contracts_tests.cpp`, editor protocol tests, typed session tests; one-publication host application test deferred to 1C. |
| H13 | Typed presentation flush/poll diagnostics and cancellation reasons. | Runtime audio adapter, world transition backend. | `presentation_coordinator_tests.cpp`, `runtime_presentation_tests.cpp`, `runtime_audio_adapter_tests.cpp`, presentation checkpoint contracts. |
| H14 | `core::Result` diagnostics; transition failures are fed back to operation state. | Renderer/world resources, bgfx-facing batches, Layout overlays. | `world_presentation_tests.cpp`, `world_transition_tests.cpp`, world/transition readback verifiers. |
| H15 | `core::Result` diagnostics for system Layouts and `bool` manager operations. | RuntimeUI document host but otherwise backend-neutral policy. | `runtime_layout_manager_tests.cpp`, `runtime_system_layouts_tests.cpp`, gameplay pause tests. |
| H16 | Typed Layout diagnostics plus RuntimeUI/manager `bool` failures. | AssetManager, RuntimeUI/RmlUi, compiled Layout definitions. | RuntimeLayoutManager and RuntimeUI lifecycle tests; end-to-end realized Layout rollback/reload coverage remains a 1C target. |
| H17 | Consumption booleans, typed dispatch diagnostics, logs. | SDL3, ImGui, RmlUi, surface transforms. | RuntimeLayoutManager input-policy tests and RmlUi event-disposition tests; full host routing order deferred to 1C. |
| H18 | RuntimeClock `Result`, logs, preview FPS events. | SDL performance counters/delay and Emscripten main-loop cadence. | `runtime_clock_tests.cpp`, gameplay pause tests; frame-stage integration coverage deferred to 1C. |
| H19 | Resize/presentation `Result` diagnostics and logs. | SDL window metrics, bgfx resize, RmlUi contexts, audio suspend/resume. | `surface_tests.cpp`, runtime clock tests, world presentation/transition tests, sandbox resize-readback fixture. |
| H20 | `bool`/JSON strings, typed diagnostics converted to preview bridge events. | Emscripten C exports, nlohmann JSON at editor boundary, RuntimeUI, Lua. | `editor_runtime_protocol_tests.cpp`, RuntimeUI lifecycle tests, sandbox/editor preview smoke; isolation coverage deferred to 1C/4B. |
| H21 | CLI parse errors, logs, readback verifier exit status. | Sandbox app, bgfx readback, optional Web/browser exports. | RmlUi/presentation/world/transition readback verifiers and sandbox CMake smoke targets. |
| H22 | Non-fatal initialization `bool`, logs, perf status. | Dear ImGui, SDL3, bgfx, RuntimeUI borrowed access. | Build/sandbox smoke only; no focused DebugUI ownership test. |
| H23 | Renderer request acceptance, optional capture result, checkpoint attach diagnostics, verifier exit status. | bgfx readback and PNG encoding. | Presentation checkpoint contracts and UI readback verifiers; stale capture invalidation needs 1C/4F coverage. |
| H24 | Mixed stderr/SDL logs, `core::Diagnostics`, RuntimeUI diagnostics, preview protocol events. | SDL logging and editor preview bridge. | Diagnostic behavior is exercised across runtime/presentation/editor protocol tests; unified host result is Phase 1B. |
| U01 | `bool` plus stderr and RmlUi initialization status. | RmlUi, RmlUi Lua, SDL system interface, asset file interface, bgfx/headless renderer. | `runtime_ui_lifecycle_integration_tests.cpp`, `rmlui_lifecycle_tests.cpp`, file-interface tests. |
| U02 | Context/renderer creation `nullptr`/`bool`, backend logs. | RmlUi contexts and bgfx framebuffers/view ranges. | RmlUi lifecycle/readback tests and world transition readback verifier. |
| U03 | Mostly `bool`/borrowed pointer results; reload logs. | RmlUi documents/elements and RuntimeLayoutManager adapter. | RuntimeUI lifecycle integration, RmlUi lifecycle/document binder tests, RuntimeLayoutManager tests. |
| U04 | `bool`/missing-resource logs. | Asset Rml file interface, template resolver, virtual in-memory files. | RmlUi file-interface/template-resolver tests, title Layout asset tests, RuntimeUI lifecycle integration. |
| U05 | Typed diagnostics stored for display; binding methods are largely `void`. | RmlUi data models/elements and custom components. | RmlUi document binder/custom component tests, RuntimeUI lifecycle integration, typed runtime session tests. |
| U06 | Typed diagnostic appended when handlers/capabilities are unavailable; callback `bool`. | RmlUi events, Lua/sol2 capability replacement, runtime contracts. | Custom component/document binder tests, typed session tests, RuntimeUI lifecycle integration. Runtime authority detachment is Phase 3B. |
| U07 | Layout/font failures degrade to empty/disabled snapshots; phase is typed. | TextEngine, FreeType/HarfBuzz stack through text module, AssetManager fonts, RmlUi. | ActiveText layout/playback/component tests and typed dialogue/session tests. |
| U08 | `RuntimeUiPlaybackClickResult` status/message. | RmlUi document/element geometry and event dispatch. | RuntimeUI lifecycle integration; dedicated extraction remains Phase 3G. |
| U09 | `nullptr`/`bool`; lifetime documented only by comments. | Raw RmlUi backend types hidden behind `void*`. | RuntimeUI lifecycle/document tests; public-header and consumer probes are later Phase 5/6 work. |
| U10 | Event consumed booleans and input-interest booleans. | SDL3 event structures, surface transforms, RmlUi context ordering. | RmlUi event-disposition/lifecycle tests and RuntimeLayoutManager policy tests; full host order deferred to 1C. |

## Phase 1A conclusions

1. `Engine` is currently both a valid composition root and the implementation owner for loading,
   runtime dispatch, presentation application, Layout realization, input, frame staging, preview,
   demo, and capture workflows. Later phases must extract workflows without replacing its explicit
   construction responsibility with a service locator.
2. `RuntimeUI::State` is useful scaffolding and should be retained as the implementation-hiding
   boundary, but its internals need the five cohesive owners fixed by the plan: RmlUi host, document
   registry, runtime UI binder, ActiveText presenter, and playback/test driver.
3. `RuntimeLayoutManager`, `RuntimeSystemLayouts`, existing RmlUi helper classes, the typed runtime
   publication/capability contracts, the running-game loaders, and the presentation/audio adapters
   are appropriate scaffolding. The later work should move orchestration around them rather than
   duplicate them.
4. The largest unprotected boundaries are partial initialization/load rollback, full host input
   order, one-publication application, deferred completion ordering, resize/suspend clock behavior,
   preview/player isolation, and stale screenshot/callback invalidation. Those are Phase 1C test
   obligations, not Phase 1A implementation work.
5. No semantic ownership conflict discovered during the inventory requires reopening the runtime,
   Room/world, presentation, checkpoint, or transition specifications. There is no blocker to Phase
   1B.
