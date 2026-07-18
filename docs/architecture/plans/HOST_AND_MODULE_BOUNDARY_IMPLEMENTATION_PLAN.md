# Host and Module Boundary Implementation Plan

Date: 2026-07-15
Last revised: 2026-07-18

Status: Proposed implementation plan. This plan is sequenced after the runtime, world/Room, and
presentation contracts have stabilized. It reorganizes host orchestration and physical module
boundaries without reopening those semantic contracts.

## Purpose

NovelTea now has substantially stronger semantic architecture than its physical code organization
suggests. The immutable compiled model, authoritative runtime session, typed Flow execution, retained
checkpoint service, desired-presentation model, presentation coordinator, mounted Layout policy, and
backend-neutral operation contracts establish clear logical ownership. However, most concrete engine
work is still concentrated in two broad implementation surfaces:

- `Engine`, which currently owns platform lifecycle, asset configuration, package loading, runtime
  creation, runtime dispatch, presentation coordination, Layout reconciliation, input routing,
  rendering, audio, preview behavior, demos, screenshots, and frame pacing;
- `RuntimeUI`, which currently owns RmlUi contexts, documents, lifecycle, input, runtime dispatch,
  presentation brokerage, data binding, ActiveText, shell documents, test playback, virtual files,
  event listeners, and direct backend access.

The current CMake graph reinforces that concentration. `noveltea_core` combines domain/runtime-neutral
contracts with package codecs, editor protocols, save codecs, materials, and shader tooling. `engine`
then combines runtime execution, Lua, SDL, bgfx, RmlUi, miniaudio, text, preview, devtools, and the host
facade. Public linkage propagates backend dependencies to consumers even where only backend-neutral
contracts are required.

This plan defines the migration to a small explicit host facade over cohesive internal components and
a bounded module-target graph that enforces the dependency direction already fixed by the normative
specifications.

The goal is not to maximize the number of classes, files, or libraries. The goal is to make ownership
visible, prevent accidental dependency leakage, reduce the cost of continued runtime/presentation
development, and keep every implementation slice buildable on Linux and Web.

## Normative references

This plan implements and must not contradict:

- [`RUNTIME_AND_PRESENTATION_ARCHITECTURE_CONSOLIDATION_OVERVIEW.md`](RUNTIME_AND_PRESENTATION_ARCHITECTURE_CONSOLIDATION_OVERVIEW.md);
- [`RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md`](../RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md);
- [`WORLD_AND_ROOM_PRESENTATION_SPEC.md`](../WORLD_AND_ROOM_PRESENTATION_SPEC.md);
- [`PRESENTATION_STATE_AND_TRANSITION_SPEC.md`](../../rendering/PRESENTATION_STATE_AND_TRANSITION_SPEC.md);
- [`RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md`](../RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md);
- [`PRESENTATION_COORDINATOR_AND_RUNTIME_LAYOUT_IMPLEMENTATION_PLAN.md`](../../rendering/plans/PRESENTATION_COORDINATOR_AND_RUNTIME_LAYOUT_IMPLEMENTATION_PLAN.md);
- [`ENGINE_ARCHITECTURE.md`](../ENGINE_ARCHITECTURE.md);
- [`CXX_RUNTIME_DEPENDENCY_POLICY.md`](../CXX_RUNTIME_DEPENDENCY_POLICY.md);
- [`JSON_BOUNDARY_POLICY.md`](../JSON_BOUNDARY_POLICY.md);
- repository-wide no-exceptions/no-compiler-RTTI policy and platform build documentation.

Where current code or older architecture documentation conflicts with the normative specifications,
the specifications win.

## Prerequisites and implementation timing

This plan deliberately follows semantic implementation rather than preceding it.

The runtime execution/capability implementation, including final consumer migration and namespace
cleanup, is complete. Before beginning Phase 2, the remaining semantic prerequisites are:

- the final `runtime::RuntimeSession`, `runtime::RunningGame`, semantic capability gateway, internal
  command queue, direct presentation runtime port, and coherent runtime publication boundary are
  implemented or have stable final interfaces;
- `RuntimeUI` no longer owns public runtime transaction settlement or presentation/audio operation
  acceptance;
- the world/Room implementation has a stable `RoomPresentationResolver` and complete world
  projection contracts;
- scoped desired presentation and final mounted Layout identity/policy contracts are stable;
- the active presentation implementation plan has established the final presentation service and
  backend adapter seams needed by the host.

Phase 1 may be implemented earlier because it is characterization and boundary preparation. Later
phases must not race semantic refactors by repeatedly moving files whose contracts are still changing.

The module-target split in Phase 5 must occur only after the classes being separated already obey the
desired dependency direction in source. CMake libraries are an enforcement mechanism, not a tool for
discovering architecture through linker failures.

## Scope

This plan covers:

- reducing `Engine` to a public host facade and explicit composition root;
- extracting loaded-game/runtime/presentation orchestration from `Engine`;
- extracting Layout realization from both `Engine` and `RuntimeUI`;
- decomposing the internal implementation of `RuntimeUI` while retaining one host-facing facade;
- establishing deterministic host input routing;
- isolating editor preview, sandbox demo, test/readback, and developer-tool behavior from production
  game orchestration;
- hiding backend implementation dependencies from public engine headers where practical;
- reorganizing runtime source directories and namespaces after semantic names are final;
- splitting the current `noveltea_core` and `engine` targets into a bounded target graph;
- adding dependency-boundary policy checks and target-specific compile/link probes;
- retargeting tests and tools to the narrowest required library;
- deleting obsolete aliases, broker paths, direct backend leaks, and stale documentation.

## Non-goals

- Do not change Room, Character, Interactable, Scene, Flow, presentation lifetime, checkpoint, or
  transition semantics defined by the normative specifications.
- Do not introduce a service locator, global context, dependency-injection framework, plugin
  registry, or name-based subsystem discovery.
- Do not replace explicit ownership with shared global singleton services.
- Do not create one CMake target per source directory, feature, class, or backend helper.
- Do not make every extracted helper a public virtual interface.
- Do not move backend types into domain/runtime contracts merely to avoid adapters.
- Do not expose bgfx, RmlUi, miniaudio, sol2, Lua, ImGui, SDL event internals, or backend resource
  handles through runtime/domain modules.
- Do not rewrite the external `rmlui-bgfx` package or move it into NovelTea production sources.
- Do not edit read-only `refs/` trees.
- Do not preserve old target names or broad APIs solely for compatibility after all repository
  consumers have migrated.
- Do not redesign the text, asset, audio, renderer, or package subsystems beyond the boundary changes
  required by this plan.
- Do not keep demo/readback behavior in production orchestration merely because the sandbox currently
  depends on it.
- Do not split physical modules before representative behavior is characterized and protected by
  tests.

## Existing implementation baseline

### Engine

`engine/include/noveltea/engine.hpp` exposes one broad `Engine` class and includes concrete headers
for platform, renderer, preview, audio, RuntimeUI, assets, Layout management, typed presentation,
Lua, and the running compiled runtime.

`Engine` currently value-owns or directly coordinates:

- `AssetManager`;
- `AudioSystem` and `RuntimeAudioAdapter`;
- SDL-backed `Platform`;
- bgfx `Renderer`;
- `ScriptRuntime`;
- in-memory/default save-slot storage;
- runtime clocks;
- the loaded `CompiledRuntime`/runtime session;
- runtime outputs and diagnostics;
- shader/material project state;
- runtime asset resolution;
- `RuntimePresentationBridge`;
- `RuntimeUI`;
- `RuntimeLayoutManager`;
- title and game-HUD Layout identities;
- realized presentation Layout bookkeeping;
- `RuntimePreviewController`;
- `DebugUI`;
- frame pacing, FPS sampling, resize, pointer state, preview state, demo state, and screenshot state.

`engine/src/engine.cpp` is currently approximately 2,000 lines. It contains project loading, asset
configuration, frame setup, event handling, input routing, update sequencing, render submission,
shutdown, preview handling, demo behavior, and direct audio convenience methods.

The class is a valid composition root but is also the implementation home of too many workflows.

### RuntimeUI

`RuntimeUI` already uses a private `State` implementation, which is a useful boundary to retain. Its
current public surface and `State` implementation nevertheless combine several distinct domains:

- RmlUi initialization, system/file/render interfaces, contexts, and rendering;
- context selection by plane, clock, input policy, and composition group;
- document source tracking, loading, unloading, ordering, recreation, focus, listeners, and policy
  migration;
- SDL event translation and input-interest reporting;
- typed runtime input dispatch and diagnostics;
- runtime-view data binding;
- title, runtime-game, and pause built-ins;
- Layout document loading and policy application;
- ActiveText layout/playback integration;
- presentation-operation brokerage;
- virtual preview files;
- selector-based playback clicking;
- public borrowed `void*` document/element/data-model access.

Several lower-level RmlUi helpers already exist under `engine/src/ui/rmlui/`, including document
binding, file access, template resolution, custom components, SDL input translation, lifecycle
helpers, and bgfx/system adapters. The plan must build on these rather than folding them back into one
new class.

### Preview, sandbox, and devtools

Preview and test behavior currently crosses production host boundaries:

- `Engine` directly exposes raw RML preview loading, preview Lua execution, editor preview JSON
  application, demo positions, and direct audio fixture controls;
- `RuntimePreviewController` is a friend of `Engine` and can rely on private engine ownership;
- `EngineRunConfig` includes demo mode, fixture audio paths, screenshot path, preview-widget flags,
  and production run settings in one struct;
- sandbox/demo rendering and runtime game rendering share `Engine::render()` orchestration;
- debug UI and production input routing are coordinated in the same event loop;
- RuntimeUI playback helpers are part of the primary RuntimeUI public API.

These facilities are valuable but should be explicit tooling/preview adapters rather than hidden
requirements of every production host path.

### Build graph

The current production graph contains two broad targets.

`noveltea_core` currently includes immutable compiled domain, package/save codecs, package export,
editor runtime protocol, Flow execution, session state, runtime messages/clocks, presentation
coordination/projectors, property/evaluator services, material codecs, and shader tooling.

`engine` currently includes host/app code, assets, audio/miniaudio, SDL, bgfx, RmlUi, RuntimeUI,
runtime Layout/presentation/audio adapters, Lua/sol2, runtime session/executor/checkpoint code,
preview/devtools, text, and tweening.

`engine` publicly links several backend libraries, causing application/tool/test consumers to inherit
dependencies they may not semantically require.

### Existing verification

The repository already contains focused coverage for runtime session/Lua/checkpoint behavior,
presentation coordination, runtime presentation projection, audio adapters, RuntimeLayoutManager,
RuntimeUI lifecycle/document migration, RmlUi helpers/readback, ActiveText, and Linux/Web policy and
platform builds.

The implementation should migrate and extend these tests rather than replacing them with only
end-to-end sandbox coverage.

## Current architectural problems

### Public Engine header exposes implementation ownership

The public `Engine` definition includes and value-owns most backend and subsystem types. Consumers
compile against backend-heavy headers, public links propagate backend dependencies, and the facade
cannot remain stable while implementation owners move.

### Loaded-game orchestration is distributed

Loading and running a game spans Engine, content loading, ScriptRuntime, save storage, RuntimeUI,
presentation, Layout setup, title/shell setup, shader/material loading, assets, and preview state.
There is no one internal host owner for the loaded package, RuntimeSession, presentation service,
backend adapters, and coherent publication/event application.

### Layout realization is split across owners

`RuntimeLayoutManager` owns logical mounted identity/policy, Engine owns realized instance maps and
reconciliation, RuntimeUI owns document realization/context/order/visibility, and asset resolution is
another adjacent object.

### RuntimeUI retains obsolete runtime authority

The current RuntimeUI manually begins/settles runtime transactions, recursively processes generated
inputs, accepts presentation/audio operations, and stores the current runtime view. Those
responsibilities are assigned elsewhere by the runtime specification.

### Input routing is implicit

SDL events, debug UI, RmlUi, pointer transforms, Layout admission, gameplay pause, and runtime input
are coordinated across Engine and RuntimeUI rather than by one deterministic host router.

### Tooling and production paths are entangled

Sandbox demos, preview JSON/RML/Lua, playback selector clicks, direct audio fixture controls,
screenshots, and debug overlays are mixed into the same facade and frame orchestration used by the
player.

### Physical targets cannot enforce logical dependency direction

Because almost everything lives in `noveltea_core` or `engine`, invalid includes and dependency edges
often compile and link successfully.

## Fixed implementation decisions

### Engine remains the public host facade

`Engine` remains the application-facing lifecycle facade and explicit composition root. It continues
to construct concrete platform, rendering, UI, audio, script, runtime, presentation, and tooling
implementations, but it does not remain their workflow implementation home.

The final public header hides implementation members through `Engine::Impl` or an equivalent private
implementation boundary. The exact construction API may retain `initialize()` during migration, but
the final public surface uses backend-neutral config/result types.

### GameHost owns the loaded-game host lifecycle

One internal `GameHost` owns the current `runtime::RunningGame` and runtime-facing host integration.

It owns or coordinates:

- running-game creation/destruction;
- runtime script/presentation/storage/external ports;
- the concrete presentation service associated with the running game;
- runtime-facing audio and Layout adapters;
- runtime input dispatch;
- coherent publication/event application;
- later completion input routing;
- reset/load/stop/project-reload ordering;
- typed diagnostics and observations.

It does not own SDL polling, bgfx frame submission, RmlUi internals, miniaudio voices, or editor JSON.

### Existing loaders remain authoritative

Host orchestration uses the final content/package loader and `runtime::RunningGame::create(...)`.
Decoding, validation, Lua certification, and save codecs remain in their named owners.

### LayoutRealizer owns backend Layout realization

One internal `LayoutRealizer` maps stable mounted Layout instance IDs to RuntimeUI documents and owns
resource source resolution, built-in/path/fragment/memory realization, policy/order/visibility
application, reconciliation, recreation, and deterministic diagnostics.

It does not own desired Layout state, checkpoint persistence, input policy derivation, or RmlUi
context implementation.

### RuntimeUI remains one facade with cohesive internals

RuntimeUI remains the host-facing RmlUi adapter. Its private implementation is segmented into:

1. RmlUi host/context/render/input lifecycle;
2. document registry and reload/migration lifecycle;
3. runtime UI data/custom-component binder;
4. ActiveText presenter;
5. playback/test driver.

Closely related items may remain together where splitting would produce trivial wrappers.

### HostInputRouter owns event admission order

One internal router preserves deterministic routing:

```text
platform/window lifecycle
  -> debug/devtool UI when enabled
  -> RuntimeUI/RmlUi
  -> mounted Layout/gameplay admission
  -> typed runtime input
```

The router does not mutate SessionState or dispatch recursively.

### PreviewHost owns editor/preview integration

One internal PreviewHost or equivalently scoped preview controller owns typed editor preview requests,
preview virtual documents, tooling-profile Lua, reset/reload/fast-forward/recording, screenshots,
display overrides, and preview diagnostics.

Raw JSON stays at the approved editor protocol boundary. RuntimePreviewController no longer requires
friend access to Engine.

### Sandbox/demo behavior is not production Engine state

`DemoMode`, demo positions, fixture audio lists, and special-case demo draws move to apps/sandbox or a
dev/test-only harness. Production Engine rendering does not branch on sandbox fixture mode.

Direct Engine audio methods used only by preview/demo tooling move to a tooling adapter and do not
remain on the production game facade.

### Physical module graph is bounded

The target production libraries are:

```text
noveltea_domain
noveltea_content
noveltea_runtime
noveltea_presentation
noveltea_script_lua
noveltea_engine
```

Existing specialized text/dependency libraries may remain.

The dependency direction is:

```text
noveltea_domain
  <- noveltea_content
  <- noveltea_runtime <- noveltea_script_lua
                      <- noveltea_presentation

noveltea_engine -> all required lower modules and concrete backends
```

`noveltea_presentation` may depend on runtime-defined abstract port contracts in order to implement
them; `noveltea_runtime` must not link to presentation implementation. Small cross-domain value
contracts may live in domain/runtime contracts to avoid cycles.
Do not create a generic `noveltea_common` dumping ground.

### Target responsibilities

- `noveltea_domain`: backend-neutral IDs, definitions/programs, mutable state values, Flow/state
  contracts, properties, diagnostics, and shared values;
- `noveltea_content`: project/package/save/editor-protocol/material/shader boundary codecs,
  validation/export, and approved JSON/ZIP implementations;
- `noveltea_runtime`: RuntimeSession/Executor, Flow execution implementation, commands,
  capabilities, checkpoint service, publication, and abstract script/presentation/storage ports;
- `noveltea_presentation`: Room resolver, desired presentation assembly/projector, coordinator,
  mounted Layout logical policy/manager, and backend-neutral operation lifecycle;
- `noveltea_script_lua`: ScriptRuntime, Lua/sol2 binding/value conversion/certification/invocation,
  and RuntimeScriptApi adaptation;
- `noveltea_engine`: SDL, bgfx, RmlUi, miniaudio, AssetManager, text/backend adapters, preview,
  devtools, LayoutRealizer, GameHost, HostInputRouter, and Engine.

### Dependencies are private unless public contracts require them

bgfx, bimg, SDL, RmlUi, rmlui-bgfx, miniaudio include paths, Lua, sol2, ImGui, nlohmann JSON, and miniz
must not be propagated publicly merely because an implementation uses them.

### Module policy is enforceable

Add a normal `module-boundary-policy` target that rejects forbidden include/dependency edges and stale
exceptions. At minimum:

- domain cannot include runtime/content codec/Lua/presentation implementation/Engine/backends;
- runtime cannot include Lua/sol2/SDL/bgfx/RmlUi/miniaudio/ImGui/JSON/Engine;
- presentation cannot include Lua/sol2/SDL/bgfx/RmlUi/miniaudio/ImGui/JSON/Engine;
- content may use approved codec dependencies but not Engine/backends or mutable runtime
  implementation;
- Lua adapter may use runtime/domain and Lua/sol2 but not Engine/renderer/RuntimeUI/audio/platform;
- engine may depend on lower layers and concrete backends.

## Target source organization

Exact paths may adapt to repository conventions, but the target shape is approximately:

```text
engine/include/noveltea/domain/...
engine/include/noveltea/content/...
engine/include/noveltea/runtime/...
engine/include/noveltea/presentation/...
engine/include/noveltea/script/...
engine/include/noveltea/engine.hpp

engine/src/domain/...
engine/src/content/...
engine/src/runtime/...
engine/src/presentation/...
engine/src/script/lua/...
engine/src/host/engine.cpp
engine/src/host/game_host.*
engine/src/host/host_input_router.*
engine/src/host/layout_realizer.*
engine/src/host/preview_host.*
engine/src/ui/rmlui/...
engine/src/audio/...
engine/src/render/bgfx/...
engine/src/platform/sdl/...
```

The plan does not require renaming every `core` header. Move files where final ownership is clear and
the move improves dependency enforcement.

## Migration rules

1. Preserve one buildable path after every phase.
2. Add characterization tests before moving broad behavior.
3. Move ownership before moving files; move files before enforcing final target edges.
4. Do not keep old and new owners active in parallel beyond one bounded cutover phase.
5. Do not create forwarding facades that permanently duplicate authority.
6. Transitional type/target aliases are allowed only while migrating all repository consumers.
7. Preserve Linux and Web throughout; run Android after target/link/platform lifecycle changes when
   available.
8. Apply no-exceptions/no-RTTI policy to every new target.
9. Keep JSON dependencies private to approved content/protocol boundaries.
10. Preserve the external rmlui-bgfx package boundary and read-only refs.
11. Do not stage changes unless explicitly requested.

## Affected consumers

The implementation affects apps/player, apps/sandbox, tools/editor_tool, tools/benchmark, editor
preview protocol adapters, runtime preview/debugger/recorder integration, all C++ test targets, root
and engine CMake policy helpers, platform builds, runtime asset staging, and architecture/build/runtime/
rendering/UI/preview documentation.

Before each phase, search for every consumer of moved headers, target names, Engine/RuntimeUI methods,
runtime/presentation bridges, and preview helpers.

## Phase summary

| Phase | Boundary | Primary outcome |
| --- | --- | --- |
| 1 | Characterization and host contracts | Current behavior and target host seams are protected |
| 2 | GameHost and Engine facade | Loaded-game/runtime/presentation orchestration leaves Engine |
| 3 | Layout realization and RuntimeUI | Layout backend realization and RmlUi internals become cohesive |
| 4 | Input, preview, demo, devtools | Production host loop is separated from tooling behavior |
| 5 | Source and CMake modules | Bounded libraries enforce final dependency direction |
| 6 | Cleanup and conformance | Transitional paths are deleted and consumers use final modules |

The phases are not required to contain uniform subphase counts. Split only where one task would cross
substantively different domains or leave the tree unbuildable.

## Implementation progress

This checklist is the authoritative completion ledger for this plan. Mark a subpart complete only
after its phase-local verification passes. Mark a main phase complete only after every listed
subpart and the phase gate are complete.

- [x] Phase 1 — Characterization and final host contracts
  - [x] 1A — Host responsibility inventory
  - [x] 1B — Final internal host contracts
  - [x] 1C — Characterization matrix
  - [x] 1D — Dependency inventory
- [x] Phase 2 — GameHost extraction and Engine facade cutover
  - [x] 2A — Engine implementation boundary
  - [x] 2B — GameHost owner
  - [x] 2C — Running-game load orchestration
  - [x] 2D — Runtime dispatch and publication application
  - [x] 2E — Frame update integration
  - [x] 2F — Lifecycle and cleanup
  - [x] 2G — Engine member reduction
- [x] Phase 3 — LayoutRealizer and RuntimeUI internal decomposition
  - [x] 3A — LayoutRealizer
  - [x] 3B — RuntimeUI runtime detachment
  - [x] 3C — RmlUi host/context split
  - [x] 3D — Document registry/lifecycle split
  - [x] 3E — Runtime UI binder
  - [x] 3F — ActiveText presenter
  - [x] 3G — Playback/test driver
  - [x] 3H — RuntimeUI facade contraction
- [x] Phase 4 — Input, preview, demo, and developer-tool isolation
  - [x] 4A — HostInputRouter
  - [x] 4B — PreviewHost
  - [x] 4C — Sandbox demo extraction
  - [x] 4D — Direct preview audio
  - [x] 4E — Debug UI isolation
  - [x] 4F — Screenshot/readback ownership
  - [x] 4G — Engine configuration cleanup
- [x] Phase 5 — Source organization and CMake module cutover
  - [x] 5A — File classification
  - [x] 5B — Target creation order
  - [x] 5C — Public/private link visibility
  - [x] 5D — Miniz/bimg/Android handling
  - [x] 5E — Source/namespace moves
  - [x] 5F — Module boundary policy
  - [x] 5G — Public-header probes
  - [x] 5H — Test target retargeting
  - [x] 5I — Asset/shader staging
- [ ] Phase 6 — Public-surface cleanup, obsolete-path deletion, and final conformance
  - [x] 6A — Engine public API finalization
  - [x] 6B — RuntimeUI visibility
  - [ ] 6C — Obsolete path deletion
  - [ ] 6D — Dependency audit
  - [ ] 6E — Documentation reconciliation
  - [ ] 6F — Final source-size review

## Phase 1 — Characterization and final host contracts

### Objective

Freeze observable host behavior and introduce the narrow internal seams required for extraction,
without changing semantic ownership or reorganizing CMake targets.

### Retain

- current Engine lifecycle and platform behavior;
- current RuntimeUI context/document behavior proven by completed presentation phases;
- final runtime dispatch/publication API from the runtime implementation plan;
- final Room/presentation service interfaces from their implementation plans;
- current AssetManager, renderer, audio, platform, and backend implementations;
- existing editor preview protocol and sandbox workflows.

### Implement

#### 1A — Host responsibility inventory

Create a durable owner/consumer inventory covering every responsibility currently in Engine and
RuntimeUI.

For each responsibility record:

- current owner;
- target owner;
- public caller/consumer;
- lifetime and initialization prerequisites;
- shutdown ordering;
- error/diagnostic channel;
- platform/backend dependencies;
- existing tests;
- migration phase.

At minimum include asset roots, package loading, Lua initialization/certification, RunningGame
lifecycle, save storage, runtime dispatch, publication/event routing, presentation service, audio
realization, Layout realization, RuntimeUI contexts/documents/data, ActiveText, input routing,
pause/admission, preview/editor protocol, demo/readback, debug UI, frame timing, resize/suspension,
rendering, and screenshots.

#### 1B — Final internal host contracts

Introduce or finalize narrow contracts required by later phases:

- a host result carrying publication/events/diagnostics from one runtime dispatch;
- typed runtime input sink/source for RuntimeUI and preview adapters;
- typed RuntimePublication application seam for RuntimeUI;
- typed Layout realization request/result;
- typed preview request/result after protocol decoding;
- explicit host lifecycle state and shutdown reasons;
- backend reset/reload notifications;
- deterministic host frame stage identifiers for diagnostics/tests.

Do not introduce a universal host bus, generic callback registry, or service locator.

#### 1C — Characterization matrix

Add focused tests proving behavior later extractions must retain:

- initialization failure is cleanup-safe;
- running-game creation failure leaves no partial RuntimeUI/presentation binding;
- start/reset/load/project-reload ordering is deterministic;
- one runtime publication is applied consistently to UI and presentation;
- completion inputs are scheduled later rather than recursively dispatched;
- input routing among debug UI, RuntimeUI, and gameplay is deterministic;
- Layout reconciliation preserves stable identity/order/visibility/policy;
- RmlUi reload recreates realized Layouts without changing desired state;
- resize/suspend/resume do not create clock jumps;
- shutdown works after partial and complete initialization;
- preview load/reset does not contaminate player state;
- sandbox demo behavior is distinguishable from loaded-game behavior.

#### 1D — Dependency inventory

Produce a reproducible source-to-target mapping and record known hard edges:

- Flow/SessionState implementation currently in `noveltea_core`;
- runtime code currently compiled into `engine` beside Lua;
- RuntimeUI references to runtime/session/presentation;
- material/shader contracts and codecs mixed with core;
- editor protocol and JSON boundaries;
- miniz/bimg duplicate-symbol constraints on Android;
- public backend link propagation;
- tests that include private engine source paths.

### Expected file areas

- architecture ownership documentation;
- provisional internal host contract headers;
- focused host/RuntimeUI tests;
- optional report-only module inventory tooling;
- no broad production file moves yet.

### Required verification

- new characterization tests;
- existing runtime, presentation, RuntimeLayoutManager, RuntimeUI, RmlUi, audio adapter, and preview
  tests;
- Linux build/full CTest;
- Web build/policy targets;
- format, C++ policy, and JSON-boundary checks.

### Phase gate

Phase 1 is complete when every broad Engine/RuntimeUI responsibility has a target owner, later phases
can use typed seams, observable behavior is protected, and no semantic contract remains unresolved by
this plan.

### Explicitly deferred

- Engine::Impl and GameHost cutover;
- RuntimeUI source split;
- demo/preview API deletion;
- CMake target split;
- final namespace/file moves.

## Phase 2 — GameHost extraction and Engine facade cutover

### Objective

Move loaded-game, runtime dispatch, publication/event application, and presentation-service
orchestration into one internal GameHost, leaving Engine responsible for top-level host lifecycle and
concrete subsystem construction.

### Implement

#### 2A — Engine implementation boundary

Introduce `Engine::Impl` or an equivalent private implementation owner. Move concrete subsystem
members out of the public Engine definition. The final public header should retain only
backend-neutral configuration/result types and an implementation pointer.

Preserve current construction/lifecycle calls during migration. Final construction may use a
Result-returning factory if that matches final application conventions.

#### 2B — GameHost owner

Create internal `GameHost` with explicit construction dependencies.

It owns:

- current `runtime::RunningGame`;
- runtime-facing presentation service/bridge state;
- presentation checkpoint-status port implementation;
- runtime-facing audio operation adapter state;
- runtime-facing Layout logical/reconciliation coordination;
- current publication/events/diagnostics/observations where host retention is required;
- session generation used to reject stale completions;
- loaded-game lifecycle state.

It borrows content loading, ScriptInvocationPort, save storage, RuntimeUI, LayoutRealizer, AudioSystem,
preview/observation sinks, and host clock/admission values.

It does not own SDL polling, bgfx frame submission, RmlUi internals, miniaudio voices, or editor JSON.

#### 2C — Running-game load orchestration

Move `Engine::load_compiled_project` orchestration to GameHost or one tightly scoped helper it owns.

The path must:

1. resolve/read the logical package through approved asset/content boundaries;
2. decode/validate through content owners;
3. certify scripts without executing gameplay;
4. construct a new RunningGame with explicit ports;
5. prepare presentation/Layout asset resolution against the new project;
6. prepare an initial complete publication/presentation off to the side;
7. atomically replace the old running game only after success;
8. terminate/detach old script/presentation/preview bindings before destruction;
9. preserve the old game on recoverable load failure where the product contract permits.

Do not duplicate package sniffing, decoding, validation, or certification in the host.

#### 2D — Runtime dispatch and publication application

Move runtime dispatch out of RuntimeUI and Engine into GameHost.

For one host input:

1. call `RuntimeSession::dispatch()` once;
2. process its settled publication/events;
3. submit presentation snapshot/revision to the presentation service;
4. bind gameplay UI to RuntimeUI;
5. route observations to preview/debug consumers;
6. deliver user communication and true external requests in order;
7. enqueue later completion inputs without recursive dispatch;
8. retain diagnostics with host-stage context.

GameHost does not reopen runtime transactions or inspect mutable SessionState.

#### 2E — Frame update integration

Split current `Engine::update()` so GameHost owns only loaded-game/runtime advancement.

Target flow:

```text
Engine::tick
  -> platform/input routing
  -> host clocks
  -> GameHost::advance(runtime clock input)
  -> presentation/audio backend update
  -> Layout realization/UI binding
  -> render submission
```

Do not force RmlUi or drawing into GameHost merely because they follow runtime advancement.

#### 2F — Lifecycle and cleanup

Define idempotent ordering for new game, start, stop, reset, save load, project reload, host
suspend/resume, backend reset, and Engine shutdown. Old operation/request/capability generations must
fail safely after replacement.

#### 2G — Engine member reduction

At phase end Engine::Impl no longer directly owns runtime output queues, transaction state,
publication state, presentation correlation, or realized game Layout maps.

### Expected affected files

- public Engine header and host implementation;
- new `engine/src/host/game_host.*`;
- final RunningGame/session headers;
- presentation/audio/Layout host integration;
- RuntimeUI dispatch call sites;
- player, sandbox, tools, and host tests.

### Required tests

- successful loaded-game creation/start;
- failure-atomic load/reload;
- old completion/script generation rejection;
- at most one applied publication per runtime input;
- UI/presentation receive the same publication revision;
- nonrecursive completion delivery;
- deterministic reset/load/shutdown cancellation;
- headless GameHost tests with fake ports;
- player/sandbox representative package smoke.

### Phase gate

Phase 2 is complete when Engine is a thin facade over Impl, one GameHost owns loaded-game host
lifecycle, RuntimeUI is not runtime dispatcher/settler, and Linux/Web build without old Engine-owned
runtime queues/brokerage.

### Completion audit — 2026-07-17

The full 2A–2G implementation was re-audited against the repository after the subpart cutovers. The
audit confirmed the Engine implementation boundary, GameHost ownership, failure-atomic load path,
single-dispatch publication application, frame-stage ordering, lifecycle generations, and final
Engine member reduction.

One integration inconsistency was corrected: rebinding generation-scoped RuntimeUI input and shell
handlers no longer clears an independently applied gameplay publication or shell view. Explicit
handler unbinding still clears those values during detach/replacement. The GameHost publication test
also now proves that a publication callback queues a later runtime input without recursively
dispatching it.

Validation completed with the Linux Debug configure/build, all 503 Linux tests including automated
player/sandbox package and readback smoke coverage, Linux formatting/C++/JSON boundary policy
targets, and the Web Debug configure/build plus C++ and JSON boundary policy targets. No Phase 3 work
was included.

### Explicitly deferred

- RuntimeUI internal decomposition;
- final LayoutRealizer extraction if a minimal bridge remains;
- HostInputRouter;
- preview/demo API cleanup;
- CMake target split.

## Phase 3 — LayoutRealizer and RuntimeUI internal decomposition

### Objective

Give logical Layout realization one host adapter and divide RuntimeUI implementation into cohesive
RmlUi/document/binding/ActiveText/test responsibilities without changing mounted Layout semantics.

### Implement

#### 3A — LayoutRealizer

Create LayoutRealizer as the only owner converting desired mounted Layout records into concrete
RuntimeUI documents.

It consumes immutable Layout resources, mounted desired state, stable IDs/planes/policies, logical
asset resolution, and shell built-in descriptors.

It produces deterministic create/replace/show/hide/policy/order/remove/recreate actions and owns the
mapping between mounted instance ID and document ID. The map must leave Engine.

Reconciliation must be failure-aware: validate before destroying old realization where possible,
replace atomically, remove idempotently, reject stale session instances, and report Layout/instance/
source/owner/plane/operation diagnostics.

Completion note (2026-07-17): `host::LayoutRealizer` now exclusively prepares immutable project
Layout resources and shell descriptors, resolves logical asset sources, assigns concrete document
IDs, owns mounted-instance-to-document mappings, and emits deterministic RuntimeUI realization
actions. `RuntimeLayoutManager` retains only logical desired mounted state, while Engine and GameHost
retain mounted instance records without document IDs. Reconciliation validates desired sources before
retiring prior documents, stages replacement documents before removal, preserves prior realization on
failed replacement, removes idempotently, rejects stale host/backend generations, recreates documents
after backend reset, and reports operation/Layout/instance/source/owner/plane diagnostics. Validation
passed the Linux debug build, all 508 Linux tests, focused LayoutRealizer/GameHost/Layout tests, Linux
format and C++ policy gates, and the Web debug build and C++ policy gates. Subparts 3B through 3H
remain intentionally unimplemented.

#### 3B — RuntimeUI runtime detachment

Remove RuntimeUI dependencies on RunningGame/RuntimeSession pointers, presentation handlers,
transaction control, and running-game asset discovery.

RuntimeUI receives immutable gameplay UI values, a typed input sink, concrete document commands from
LayoutRealizer, ActiveText state through its presenter, and explicit UI asset services where needed.

Completion note (2026-07-17): RuntimeUI now consumes revisioned immutable
`RuntimeUiGameplayValues`, a typed `RuntimeUiInputSink`, concrete document realization commands, and
an explicit `RuntimeUiAssetService`. It no longer accepts `RunningGame` or `RuntimeSession` pointers,
whole runtime publications/events, presentation handlers, runtime capability sets, transaction
control, or running-game asset discovery. GameHost adapts settled publications and notification
events into UI-specific values, owns generation-scoped input adapters, scopes gameplay/shell Layout
event capabilities around each concrete UI dispatch, and explicitly binds project-backed asset
services. Stale gameplay UI revisions and input adapters from replaced session generations fail
safely. Existing ActiveText presentation remains on its established presenter path; the broader
RmlUi source split, binder/presenter extraction, playback adapter, and facade contraction in subparts
3C through 3H remain intentionally unimplemented. Validation passed the Linux and Web debug builds,
all 508 serial Linux tests, focused RuntimeUI/GameHost/LayoutRealizer/audio tests, and Linux/Web
format, C++ runtime/dependency, and JSON-boundary policy gates.

#### 3C — RmlUi host/context split

Move initialization, system/file/render interfaces, contexts, clocks, SDL input translation,
rendering, and resize into focused private sources. Preserve lifecycle-domain context keys,
composition groups, per-context clocks, modal/input behavior, view ordering, headless support, and the
external rmlui-bgfx boundary.

Completion note (2026-07-17): the private `ui::rmlui::RmlUiHost` now owns RmlUi initialization and
shutdown, system/file/render interfaces, lifecycle-keyed contexts, presentation metrics and clocks,
SDL pointer/touch translation and routed input dispatch, resize, frame update/render submission, and
world-overlay framebuffer routing. Those responsibilities are split across focused host, input, and
frame sources under `engine/src/ui/rmlui/`. Context identity still includes plane, composition group,
clock domain, input mode, and mounted owner; context sorting, per-context absolute clock selection,
modal/consumed input stopping, block-gameplay fallthrough, reserved view ranges, headless rendering,
and the existing `BgfxRenderInterface` boundary to the external `rmlui-bgfx` library are preserved.

`RuntimeUI` now delegates the host/context lifecycle rather than owning those backend details. Its
application-facing header no longer exposes generic borrowed `void*` document, element, or data-model
APIs; LayoutRealizer uses an ID-based existence query, while lifecycle integration tests use a narrow
private typed RmlUi access seam. Selector playback remains on the existing facade path, so the broader
playback/test-driver extraction in 3G and document/binder/presenter/facade work in 3D–3H remain
intentionally unimplemented. Validation passed the Linux and Web debug builds, all 508 serial Linux
tests including RmlUi readback/resize and sandbox package smoke coverage, Linux formatting, and the
complete Linux/Web C++ runtime, dependency, and JSON-boundary policy gates.

#### 3D — Document registry/lifecycle split

Centralize document sources, path/memory/built-in loading, virtual files, order, visibility, focus,
listeners, context assignment, reload/recreation, and deferred-unload safety.

Preserve the completed lifecycle regression behavior, especially listener detach/rebind ordering and
custom-document restoration.

Completion note (2026-07-17): the private `ui::rmlui::RmlUiDocumentRegistry` now owns document
identity and source records, path/memory/built-in creation, preview virtual files, lifecycle-context
assignment, visibility, opacity, ordering, focus capture/restoration, custom listener ownership, and
runtime-input listener attachment. `RuntimeUI` delegates document realization, migration, reload,
replacement, and unload operations to that registry instead of retaining parallel document maps and
listener state in its facade implementation.

Replacement and context migration instantiate and validate the new document before retiring the old
one. Listener targets are validated first, then detached before the old document is hidden/closed,
and rebound only after the registry points at the replacement. Full reload records every custom
path/memory/built-in source, visibility state, context key, focus target, and deterministic order;
it detaches listeners before `UnloadAllDocuments`, recreates all registered documents, reattaches
listeners, and restores focus and ordering. Registry cleanup runs before host/context shutdown so
deferred RmlUi document unload cannot retain listeners owned by destroyed facade state. A focused
regression now also proves failed replacement preserves the current custom document and that virtual
path, memory, and built-in documents survive reload with hidden state, focus, and listeners intact.

Validation passed the Linux and Web debug engine builds, all 509 serial Linux tests including the
existing lifecycle migration/reload regression, the new registry recreation regression, RmlUi
readback coverage, and sandbox package smoke tests, plus formatting and C++ runtime/dependency and
JSON-boundary policy gates. Binder, ActiveText presenter, playback/test-driver, and facade contraction
work in subparts 3E through 3H remain intentionally unimplemented.

#### 3E — Runtime UI binder

Extract gameplay UI data/custom-component binding. It consumes one gameplay UI subview and revision,
does not query SessionState/Flow/Room/presentation, and emits typed inputs/capabilities through the
final host seam.

Completion note (2026-07-17): the private `ui::rmlui::RuntimeUiBinder` now owns the single revisioned
`RuntimeUiGameplayValues` subview, stale-revision rejection, gameplay document and custom-component
binding, explicit UI asset-service use, `Game.ui.*` installation and stable-ID validation, mounted-
Layout gameplay admission, typed gameplay/shell output, and mounted-owner capability dispatch through
`RuntimeUiInputSink`. `RuntimeUI::State` no longer stores a duplicate gameplay view/revision, input
sink, asset service, Layout admission callback, or document binder; it delegates those seams while
retaining shell document binding and the existing ActiveText playback/layout path. The binder has no
`SessionState`, `Flow`, `RunningGame`, `RuntimeSession`, runtime-publication, Room-resolution, or
presentation-service dependency. Focused regressions cover revision retention, admission, typed input,
and mounted-owner capability dispatch. Playback/test-driver and facade contraction work in 3G and 3H
remain intentionally unimplemented.

Validation passed the complete Linux debug build and all 511 Linux tests, including the focused
RuntimeUiBinder revision/input/capability regressions, RuntimeUI lifecycle/reload coverage, RmlUi
readback/resize fixtures, and player/sandbox compiled-package smoke tests. The Web debug player and
sandbox builds also passed. Linux and Web formatting, C++ runtime/dependency, and JSON-boundary policy
gates are green.

#### 3F — ActiveText presenter

Move ActiveText layout/playback/direct-render snapshot into a named internal presenter. It may use
final presentation completion seams but cannot dispatch recursively, settle checkpoints, own desired
state, or use arbitrary RmlUi state as authoritative completion.

Completion note (2026-07-17): the private `ui::rmlui::ActiveTextPresenter` now owns ActiveText
playback phase, reveal/fade timing, local page progression, prompt animation, text-engine/font-backed
layout, object hit testing, and the direct-render snapshot. It consumes the binder's current immutable
gameplay UI view and an explicit typed surface containing only bounds, text color, and language; it
does not retain or own desired gameplay state. Missing or changed RmlUi document state may clear or
reshape the render snapshot, but presentation completion remains derived exclusively from presenter
playback state advanced by the gameplay clock.

ActiveText activation returns either a presenter-local skip/page transition or one typed
`RuntimeInputMessage`. The presenter never calls the binder, input sink, GameHost, runtime session, or
itself through a dispatch callback; `RuntimeUI` submits a returned input once through the existing
mounted-Layout binder seam. The existing `RuntimeUI` phase query continues through GameHost into the
final `RuntimePresentationBridge` completion correlation. The presenter has no `SessionState`, `Flow`,
`RunningGame`, `RuntimeSession`, checkpoint, transaction-settlement, or RmlUi object dependency.

Focused presenter regressions cover RmlUi-independent completion phase, typed activation return,
local page playback, and non-ownership of desired state. A RuntimeUI integration regression covers
presenter-backed direct-render snapshot, stable completion, and fade. Validation passed the complete
Linux debug build and all 515 Linux tests, including RuntimeUI lifecycle, RmlUi readback/resize,
presentation/world-transition readback, and player/sandbox compiled-package smoke tests. The Web
debug player and sandbox builds passed. Linux and Web formatting, C++ runtime/dependency, and
JSON-boundary policy gates are green. RuntimeUI facade contraction in 3H remains intentionally
unimplemented.

#### 3G — Playback/test driver

Move selector click targeting and native document inspection into an internal test/playback adapter.
The main RuntimeUI facade must not expose generic borrowed `void*` document/element/data-model APIs to
applications.

Completion note (2026-07-17): the private `ui::rmlui::RuntimeUiPlaybackDriver` now owns selector
resolution, target visibility/bounds/disabled/hit validation, interactive-listener detection,
context-clock selection, synthetic pointer dispatch, result diagnostics, and native RmlUi document
and element inspection. `RuntimeUI::State` owns the adapter with the host and document registry and
destroys it before either dependency. The adapter is reachable only through its private engine
header for playback/test integrations; it is not part of the application-facing include surface.

The prior `RmlUiTestAccess` seam and the public `RuntimeUiPlaybackClick*` vocabulary plus
`RuntimeUI::playback_click()` were removed. The main RuntimeUI facade continues to expose no generic
borrowed document, element, or data-model APIs. Focused regressions prove the public playback member
is absent, native document/element inspection is adapter-only, selector clicks dispatch through the
adapter with stable target metadata, hidden documents are rejected, and adapter access is invalidated
across shutdown.

Validation passed the complete Linux debug build and all 516 Linux tests, including the 88-case
RuntimeUI/RmlUi suite, RmlUi resize/readback, presentation/world-transition readback, and
player/sandbox compiled-package smoke coverage. The Web debug player and sandbox builds passed.
Linux and Web formatting, C++ runtime/dependency, and JSON-boundary policy gates are green. RuntimeUI
facade contraction was deferred to 3H and is completed below.

#### 3H — RuntimeUI facade contraction

Final host-facing operations should be initialization/shutdown, resize/frame, host event processing,
gameplay UI publication application, concrete document realization commands, ActiveText render
snapshot where required, backend reload/reset, and diagnostics/status.

Completion note (2026-07-17): the application-visible `RuntimeUI` member surface is now contracted to
host lifecycle/frame/event processing, immutable gameplay and shell UI publication application,
typed host binding, ID-based concrete document realization, ActiveText snapshot/phase reporting,
backend document/style reload and reset, and diagnostics/status. Generic path/memory document
loading, preview virtual-file mutation, built-in/template conveniences, direct runtime input
dispatch, generic event-listener registration, and tooling compatibility/density controls are no
longer `RuntimeUI` members.

The existing preview, fixture, shell-template, and lifecycle-test callers temporarily use the private
engine-only `ui::rmlui::RuntimeUiFacadeAccess` compatibility surface. This preserves completed
behavior without exposing those operations to applications or prematurely implementing the Phase 4
PreviewHost/demo extraction. The explicit backend-reset operation clears transient RmlUi pointer and
per-frame render state, then recreates registered documents and styles through the document registry,
preserving source, context policy, order, visibility, focus, and listeners.

Compile-time regressions prove the removed generic/document/preview/listener/direct-dispatch/tooling
members are absent while backend reset remains present. RuntimeUI lifecycle coverage also proves
backend reset preserves focus and listener behavior. Validation passed the complete Linux debug
build and all 516 Linux tests, including RuntimeUI/RmlUi, LayoutRealizer, headless/readback/resize,
presentation/world-transition readback, and player/sandbox compiled-package smoke coverage. The Web
debug player and sandbox builds passed. Linux and Web formatting, C++ runtime/dependency, and
JSON-boundary policy gates are green. Phase 4 and later remain intentionally unimplemented.

### Expected affected files

- RuntimeUI header or replacement private host header;
- `ui_runtime_rmlui.cpp` split into `engine/src/ui/rmlui/` sources;
- existing RmlUi helpers;
- new `engine/src/host/layout_realizer.*`;
- Engine/GameHost/Layout manager integration;
- RuntimeUI/Layout/ActiveText/playback/readback tests.

### Required tests

- all current RuntimeUI lifecycle and RmlUi tests;
- LayoutRealizer add/update/remove/reorder/reload;
- path/memory/fragment/built-in recreation;
- listener/focus/visibility preservation;
- stale session/instance rejection;
- publication revision application;
- proof RuntimeUI cannot dispatch runtime transactions;
- exact ActiveText completion correlation;
- playback selector via test adapter;
- headless RmlUi and Linux/Web smoke/readback.

### Phase gate

Phase 3 is complete when one LayoutRealizer owns all backend reconciliation, Engine has no realized
Layout map, RuntimeUI has no runtime/presentation authority, its implementation is cohesive, public
callers do not use borrowed `void*` RmlUi objects, and completed Layout/context behavior remains green.

### Completion audit — 2026-07-17

The full 3A–3H implementation was re-audited against the repository after all subpart cutovers. The
audit confirmed that LayoutRealizer exclusively owns mounted-layout realization and its instance-to-
document map, Engine retains no realized-layout map, RuntimeUI contains no RunningGame/session/
presentation authority or public borrowed native-object surface, and Phase 4 ownership remains
unimplemented.

The audit closed four remaining consistency gaps. Document replacement now validates and rebinds
registered listeners while preserving focus and order instead of silently dropping listener records.
Runtime UI and playback layout events can no longer bypass the typed host capability seam when no
input sink is bound, and successful project installation rebinds that sink after committing the new
session generation. ActiveText local pagination resets when the presented content changes. Preview
document visibility commands now use the private engine compatibility surface rather than leaking
generic document operations through production callers. Focused regressions cover each correction.

Final validation passed the Linux debug build and all 517 Linux tests, including LayoutRealizer,
RuntimeUI/RmlUi lifecycle, readback/resize, presentation/world-transition readback, and player/
sandbox compiled-package smoke coverage. Linux formatting plus C++ runtime/dependency and JSON-
boundary policy gates passed. The Web debug player and sandbox builds, Web C++/JSON policy gates, and
browser structural smoke passed. Sanitizer validation passed 19 ownership-focused Phase 3 tests with
leak detection enabled and 14 GPU/readback/package-smoke tests with leak detection disabled for the
documented Mesa/EGL driver-retained allocations. Phase 3 and its gate are complete; Phase 4 and later
remain intentionally unimplemented.

### Explicitly deferred

- final HostInputRouter if event code remains temporarily in Engine;
- preview/demo cleanup;
- CMake target split and broad moves.

## Phase 4 — Input, preview, demo, and developer-tool isolation

### Objective

Separate production host lifecycle and gameplay presentation from editor preview, sandbox fixture,
recording/test, and developer-tool behavior while preserving all current workflows.

### Implement

#### 4A — HostInputRouter

Extract deterministic routing from Engine event handling, pointer handling, RuntimeUI, and debug UI
coordination.

The router receives normalized platform events, presentation coordinate transforms, RuntimeUI/debug
input results, mounted Layout admission, effective pause, and runtime/preview mode.

It emits host lifecycle/window actions, typed runtime inputs, tooling actions, and consumed/unhandled
disposition with diagnostics.

It does not mutate SessionState or recursively dispatch runtime work.

Cover mouse, keyboard, touch, modal, BlockGameplay, debug overlay, pause, hidden preview, resize, and
focus-loss behavior.

Completion note (2026-07-17): `host::HostInputRouter` now owns normalized SDL event classification,
platform/window lifecycle ordering, optional DebugUI and RuntimeUI admission, presentation-space
pointer projection and touch tracking, mounted-Layout and effective-pause gameplay admission,
runtime-versus-preview visibility policy, Escape fallback ordering, typed runtime/tooling outputs,
consumed/unhandled disposition, and route diagnostics. Engine applies emitted lifecycle, tooling, and
typed runtime actions only after routing. RuntimeUI event callbacks are captured as typed event
outputs rather than invoking the host sink during routing, so the router neither mutates SessionState
nor dispatches runtime work recursively. The prior three-boolean characterization helper and
monolithic Engine SDL switch were removed. Focused tests cover mouse, keyboard, touch, modal,
BlockGameplay, debug capture, RuntimeUI capture/output deferral, pause, hidden preview, resize, focus
loss/gain, pointer bars, lifecycle ordering, and Escape. Validation passed for the full Linux build,
format/C++/JSON policy gates, all 530 Linux tests under serialized Xvfb, Web Debug plus policy gates,
Android x86_64 Debug, and Android dependency compiler policy. Subparts 4C through 4G remain
intentionally unimplemented.

#### 4B — PreviewHost

Replace RuntimePreviewController friend/private Engine access with explicit dependencies.

Move behind PreviewHost or the final controller:

- typed editor preview protocol application;
- typed document/asset preview requests;
- preview-only Lua using tooling capabilities;
- preview reset/reload/fast-forward/recording;
- preview publication/observation access;
- screenshot requests and display overrides;
- preview errors surfaced to the editor.

Raw editor JSON is decoded only in approved protocol/content adapters. Engine/GameHost receive typed
requests.

Completion note (2026-07-18): `host::PreviewHost` now owns preview project load/reset/reload,
generation-aware typed runtime dispatch, gameplay preview commands, playback recording controls,
presentation fast-forwarding, typed document and shader-material preview application, scoped
Tooling-profile preview Lua, publication/observation/event access, display overrides, renderer
screenshot requests, and editor-facing preview diagnostics. `RuntimePreviewController` delegates to
that host through explicit dependencies and no longer receives `Engine`, includes `Engine::Impl`, or
uses friend/private access. Engine's raw preview document, Lua, and display-override entry points were
removed; its implementation constructs PreviewHost with narrow GameHost, RuntimeUI, ScriptRuntime,
Renderer, material-project, project-load, display, and preview-state dependencies.

Editor preview documents, debugger scalar values, and interaction subjects are decoded by the
approved editor protocol adapter into JSON-free typed contracts before reaching PreviewHost,
RuntimePreviewController, Engine, or GameHost. Preview Lua receives only a generation-bound Tooling
capability set for the duration of execution and clears it before runtime settlement. Preview-owned
failures are retained alongside runtime diagnostics and emitted through the preview bridge. Focused
tests cover valid and invalid typed preview decoding, unresolved source rejection, stale-handle
rejection across reload, and Tooling-capability availability and cleanup without backend pointers.
Validation passed the complete Linux core and host test binaries, focused 4B tests, Linux sandbox
linking, formatting, Linux C++/dependency and JSON-boundary policy gates, the complete Web debug
player/sandbox build, Web C++/dependency and JSON-boundary policy gates, and the Android arm64-v8a
Debug APK build. At that checkpoint, subparts 4C through 4G remained intentionally unimplemented.

#### 4C — Sandbox demo extraction

Move DemoMode, demo coordinates, fixture audio lists, and special demo draw submission out of
production Engine config/frame logic.

Preferred destinations are apps/sandbox orchestration or a dev/test-only SandboxDemoHarness linked
only by the sandbox. Do not create a generic production plugin API solely for demos.

The `--demo` workflow may remain, but player/engine production paths must not carry its state.

**Completion note (2026-07-18):** Complete. `App` and all sandbox command-line/browser-export
orchestration moved from the production `engine` target into `apps/sandbox`. A sandbox-only
`SandboxDemoHarness` now owns `DemoMode`, normalized demo coordinates, triangle resources and hit
testing, fixture audio lists/startup, and 2D/text/triangle frame submission. `EngineRunConfig`,
`Engine`, `Engine::Impl`, and `Renderer` no longer store demo mode/coordinates or expose/execute
demo draw paths; the player does not reference or link the harness. The existing `--demo` and
editor preview exports remain implemented by the sandbox. Host characterization tests enforce the
absence of production demo configuration/API, Linux and Web debug sandbox/player builds pass,
the Linux host suite and `--demo all` smoke workflow pass, Linux/Web C++ and JSON-boundary policy
gates and formatting pass, and a player symbol audit finds no harness or special demo-draw
implementation. Subparts 4D through 4G remain intentionally unimplemented, so the Phase 4 gate
remains open.

#### 4D — Direct preview audio

Move direct SFX/track preview methods from Engine to PreviewHost/sandbox or a narrow audio preview
adapter. Gameplay audio continues through runtime/presentation desired state and operations. Tooling
bypass must be explicit and cannot mutate gameplay audio intent.

**Completion note (2026-07-18):** Complete. Direct SFX/track controls were removed from the public
`Engine` facade and moved behind `RuntimePreviewController`/`PreviewHost`. A narrow internal
`AudioPreviewAdapter` now owns the explicit tooling bypass, tracks preview SFX handles, and assigns
private backend track identities so preview replacement/stop operations cannot target gameplay track
identities with the same caller-visible name. Sandbox fixture startup and browser audio exports use
the preview controller, and sandbox shutdown clears tooling-owned preview audio. Gameplay audio
continues exclusively through `GameHost`, `RuntimeAudioAdapter`, runtime/presentation desired state,
and typed audio operations. Focused host tests cover API relocation, same-name gameplay/preview track
isolation, and tooling-only cleanup. At that checkpoint, subparts 4F and 4G remained intentionally
unimplemented, so the Phase 4 gate remained open.

#### 4E — Debug UI isolation

Dear ImGui remains developer-only. DebugUI may remain owned by Engine::Impl, but production gameplay
UI does not depend on it, disabled-devtools builds use the same host seams, input treats it as an
optional consumer, observations are typed, and commands use Tooling capabilities.

**Completion note (2026-07-18):** Complete. `DebugUI` remains owned by `Engine::Impl` but is now an
internal devtools adapter rather than a public engine header. It receives one typed observation
snapshot containing host surface/backend facts plus immutable runtime observations, events, and
diagnostics; it no longer stores or calls `RuntimeUI`, queries bgfx globals, or mutates gameplay state
during rendering. Frame output is a closed typed command set queued until the next host boundary.
Host-local render-perf logging is applied explicitly by Engine, while runtime-facing debug commands
are executed only through a `RuntimeCapabilityProfile::Tooling` capability set and republished by a
later typed runtime dispatch. The ImGui implementation and disabled-devtools stub implement the same
interface, ImGui linkage/compile definitions are private, and `HostInputRouter` continues to treat
devtools as an optional input consumer. Focused tests cover the typed observation contract, absent
RuntimeUI binding, Tooling capability selection, unavailable-runtime rejection, and host-local
commands. At that checkpoint, subparts 4F and 4G remained intentionally unimplemented, so the Phase
4 gate remained open.

#### 4F — Screenshot/readback ownership

Renderer retains backend capture. Production screenshot requests may remain a narrow Engine or
PreviewHost command. Fixture/readback verification stays under tests/sandbox. Runtime saves and
presentation state never depend on screenshot completion.

**Completion note (2026-07-18):** Complete. Renderer continues to own bgfx screenshot submission,
callback readback, PNG encoding, and file output. A private `ScreenshotCaptureBackend` and
`CheckpointThumbnailCaptureCoordinator` now own in-memory checkpoint capture request identities,
host-generation/checkpoint binding, completion polling, and stale-result draining. Engine no longer
stores renderer request IDs or directly polls renderer capture. A capture starts only for the exact
settled presentation revision requested by the retained checkpoint; after submission, gameplay and
presentation may continue independently. Completion attaches only when the same host generation and
exact pending checkpoint request still exist. Replaced or stale captures are drained without
attachment and cannot block a later request.

`GameHost` exposes narrow typed checkpoint-thumbnail request and attachment seams, while the runtime
checkpoint service remains the owner of retained save bytes, metadata, optional thumbnail
association, and stale-token validation. Slot writes continue to succeed without a thumbnail and
are updated only if an optional capture later attaches. The production `EngineRunConfig` no longer
carries a screenshot path. `Engine` and `PreviewHost` retain narrow screenshot commands, while the
sandbox owns `--screenshot`, final-frame scheduling, resize-readback timing, and all fixture/readback
verification. Focused capture tests cover stable-revision admission, non-blocking presentation
progress, stale-generation draining, and retry after backend rejection. Validation passed the full
Linux build and all 543 Linux tests under Xvfb, including all RmlUi, resize, presentation, world, and
transition readbacks; Linux formatting and C++/dependency/JSON-boundary policy gates; and the full
Web Debug player/sandbox build with Web C++/dependency/JSON-boundary policy gates. Subpart 4G remains
intentionally unimplemented, so the Phase 4 gate remains open.

#### 4G — Engine configuration cleanup

Split final production EngineConfig from preview/sandbox/test configuration. Demo fixture lists,
positions, raw preview documents, editor-only payloads, and readback switches leave the production
config.

**Completion note (2026-07-18):** Complete. The public production bootstrap type is now
`EngineConfig`, containing only asset roots, compiled-project startup policy, audio availability, and
save-slot storage. Frame limits, fixed-delta timing, FPS controls, preview-only document loading,
runtime-retention behavior, DebugUI enablement, preview-widget routing, render diagnostics, RmlUi
readback compatibility, and the FPS overlay moved to the separately included `EngineToolingConfig`
and opt-in `EngineTooling::initialize(...)` adapter. The player uses the production initializer for
normal startup; its debug-only smoke-frame hook explicitly opts into tooling initialization. The
sandbox owns and passes tooling configuration while demo fixtures, positions, audio lists, screenshot
scheduling, and resize/readback orchestration remain sandbox-owned. Focused host characterization
checks enforce that production `EngineConfig` has no sandbox timing, preview document/mode, demo,
fixture-audio, screenshot-path, or readback-compatibility fields. Phase 4 is complete; Phase 5 remains
intentionally unimplemented.

### Expected affected files

- Engine public/private headers and host sources;
- new `host_input_router.*` and `preview_host.*`;
- RuntimePreviewController and preview bridge;
- editor runtime protocol adapters;
- apps/sandbox and apps/player config/command code;
- debug UI integration;
- audio preview helpers;
- input/preview/playback/sandbox tests.

### Required tests

- deterministic input priority/admission matrix;
- modal versus BlockGameplay;
- paused gameplay with active menu/UI;
- typed preview decoding and failure diagnostics;
- preview reset/reload stale-handle rejection;
- tooling-profile preview Lua without backend pointers;
- sandbox demos with production Engine demo state removed;
- player does not link demo-only implementation;
- devtools enabled/disabled;
- preview audio isolated from runtime desired audio;
- screenshot/readback remains green.

### Phase gate

Phase 4 is complete when one HostInputRouter owns ordering, preview uses explicit dependencies, Engine
no longer exposes demo fixture or gameplay-bypassing audio controls, raw editor JSON stays at protocol
boundaries, and debug/preview commands use typed tooling capabilities.

### Completion audit (2026-07-18)

A complete 4A-through-4G repository audit found two residual cleanup inconsistencies. First,
`HostInputRouter` still declared and emitted a demo-era `PointerPressedToolingAction` that had no host
consumer after sandbox demo extraction. The dead tooling action and emission path were removed while
preserving presentation-space pointer state updates. Second, `RuntimeUI::initialize(...)` still
exposed an implicit `load_demo_document` switch and retained a production-path reference to the
sandbox demo document even though every real caller disabled it. The switch, implicit demo loading,
and demo asset constant were removed; sandbox-owned explicit document loading remains unchanged.
Callers and focused tests were updated for the contracted RuntimeUI initialization surface.

The audit confirmed the remaining Phase 4 requirements: HostInputRouter is the sole deterministic
input-ordering owner; PreviewHost uses explicit typed dependencies and generation-aware requests;
raw editor JSON terminates at approved protocol/content adapters; sandbox demos and fixture/readback
orchestration do not add production Engine state or frame branches; preview audio uses a tooling-only
adapter isolated from gameplay desired audio; DebugUI uses typed observations and Tooling
capabilities through the same optional host seam in enabled and disabled builds; renderer capture and
checkpoint-thumbnail coordination remain non-blocking and generation-safe; and production
`EngineConfig` contains no preview, demo, fixture, timing, editor-payload, screenshot-path, or readback
configuration.

Final validation passed the complete Linux Debug build and all 543 Linux tests under serialized
Xvfb, including input, preview, audio, DebugUI, screenshot/readback, RuntimeUI, player, and sandbox
coverage. The 31 ownership-focused Phase 4/RuntimeUI tests passed independently. Linux formatting,
C++ runtime/dependency policy, and JSON-boundary policy gates passed. The complete Web Debug player
and sandbox build, Web C++/dependency and JSON-boundary policy gates, and browser structural smoke
passed. A disabled-devtools Linux sanitizer build linked both player and sandbox through the DebugUI
stub. The native `--demo all` smoke passed, and a player symbol audit found no sandbox demo harness or
demo-triangle implementation. Android x86_64 Debug APK assembly and Android dependency compiler
policy passed. Phase 4 and its gate are complete; Phase 5 remains intentionally unimplemented.

### Explicitly deferred

- final namespace/source moves;
- CMake target split;
- deletion of target/include aliases.

## Phase 5 — Source organization and CMake module cutover

### Objective

Move already-correct ownership into a bounded physical target graph, make dependency violations
detectable, and retarget consumers to the narrowest module.

### Preconditions

- runtime implementation plan complete;
- world/Room/presentation interfaces stable;
- Phases 2 through 4 complete;
- broad classes already obey intended dependencies in source;
- Linux/Web baseline green.

### Implement

#### 5A — File classification

Classify every production source/header currently in `noveltea_core` and `engine` into one primary
target based on semantic authority and allowed dependencies.

Examples:

- IDs/definitions/state/Flow contracts/diagnostics -> domain;
- package/project/save codecs, editor protocol, export -> content;
- RuntimeSession/Executor, Flow execution, commands/capabilities/checkpoint -> runtime;
- Room resolver, presentation assembly/projector/coordinator, Layout logical manager -> presentation;
- Lua VM/bindings/invoker/certification -> script_lua;
- SDL/bgfx/RmlUi/miniaudio/assets/text backends/host/preview/devtools -> engine.

Material/shader files require deliberate classification: backend-neutral contracts may live in
domain/presentation, codecs/compiler/manifest in content/tooling, and bgfx realization in engine.

Do not create a miscellaneous seventh broad library.

**Completion note (2026-07-18):** Complete. The exhaustive machine-readable ownership map now lives
in `cmake/NovelTeaModuleFileClassification.cmake`, with rationale and cutover prerequisites in
`docs/architecture/HOST_MODULE_FILE_CLASSIFICATION.md`. All 285 production C/C++ sources and headers
under `engine/include` and `engine/src`, including conditional implementation variants, have exactly
one primary owner across the six approved targets: 43 domain, 41 content, 37 runtime, 14 presentation,
11 script_lua, and 139 engine. Backend-neutral material/shader definitions are domain-owned,
codec/compiler/manifest behavior is content-owned, and bgfx realization is engine-owned. A
classification-only validator rejects missing, duplicate, nonexistent, out-of-scope, or seventh-target
entries. Phase 5A performed classification only; Phase 5B subsequently resolved the documented mixed
edges and created the final target graph. Phase 5F through 5I remain unimplemented.

#### 5B — Target creation order

Create targets incrementally:

1. `noveltea_domain`;
2. `noveltea_content`;
3. `noveltea_runtime` after forbidden dependencies are removed;
4. `noveltea_presentation` after host-backend dependencies are removed;
5. `noveltea_script_lua` with private Lua/sol2 linkage;
6. `noveltea_engine` from host/backend code;
7. retarget apps/tools/tests;
8. delete temporary broad targets/aliases.

Each step must compile before the next.

Status: complete. The six production static libraries were created in the required order, and each
target compiled successfully before work began on the next. Shared presentation records moved into
domain-owned contracts while resolver/projector/operation assembly remained presentation-owned.
Runtime now crosses presentation modeling, save serialization, script certification, and script-source
loading through narrow ports; content owns the JSON/save adapters, `noveltea_script_lua` implements the
Lua-side ports with private Lua/sol2 linkage, and the engine-owned running-game loader composes the
concrete adapters. Editor JSON framing was separated from engine-owned runtime adaptation to remove the
content-to-runtime implementation edge.

Applications, tools, and existing test binaries now reference the final targets, and the temporary
`noveltea_core` and `engine` broad targets were deleted without compatibility aliases. Test binaries
are only migrated off the removed targets here; the per-test ownership decomposition required by 5H
remains intentionally deferred. The classification manifest now covers all 285 production files with
exactly one owner. Linux debug configuration, every incremental target gate, and the full repository
build pass. Phase 5F and later work remains unimplemented.

#### 5C — Public/private link visibility

Audit every target link edge.

- implementation dependencies are PRIVATE;
- NovelTea lower-layer contracts required by public headers may be PUBLIC;
- normal apps link `noveltea_engine`;
- headless tools link domain/content/runtime as appropriate;
- runtime tests use fake ports without engine;
- presentation tests avoid SDL/RmlUi/bgfx unless adapter-specific;
- Lua tests link script_lua plus runtime/domain;
- backend/UI/render tests link engine.

The public Engine header must not require public propagation of bgfx, RmlUi, Lua, sol2, ImGui, or
miniaudio.

**Completion note (2026-07-18):** Complete. The production target interfaces now publish only the
NovelTea lower-layer contracts required by public headers: content publishes domain, runtime publishes
domain/content, presentation publishes domain/runtime, script_lua publishes domain/runtime, and engine
publishes domain/content/runtime/presentation. JSON, Lua/sol2, SDL, bgfx/bimg/bx, RmlUi, ImGui,
miniaudio, text backends, Twink, platform libraries, feature macros, and generated asset-root
definitions are implementation-private. Static-library `$<LINK_ONLY:...>` closure remains where CMake
must carry implementation symbols to final executables, without propagating backend include paths or
compile definitions to consumers. The Engine facade and public NovelTea headers contain no direct SDL,
bgfx, RmlUi, Lua, sol2, ImGui, or miniaudio includes.

Player and sandbox continue to link `noveltea_engine` and declare SDL/bgfx privately only where their
own sources use those APIs. The benchmark is a headless lower-layer consumer of content/script_lua;
the editor tool remains engine-linked because it exercises the engine-owned editor runtime adapter.
Core/runtime/presentation integration tests use lower targets and test-only fake ports without engine;
the Lua-only test target links script_lua/runtime/content/domain without presentation or engine; host,
asset, text, tween, render, and UI adapter tests remain engine-linked, with direct adapter libraries
declared where their own sources include those APIs. The audit also removed two hidden mixed edges:
script_lua logging no longer depends on SDL, and RoomCompositionDraftAccess mutation definitions now
live in runtime rather than presentation.

Linux native targets, the opt-in benchmark, and the Web debug build pass. C++ dependency/runtime and
JSON boundary policies pass, including private nlohmann-json linkage and the explicit editor protocol
boundary. The non-GPU CTest run passed 529 of 531 tests; the two sandbox process smoke tests could not
initialize SDL because no X11 display was available, while all affected test executables and
player/sandbox links built successfully. Phase 5F through 5I remain unimplemented.

#### 5D — Miniz/bimg/Android handling

Preserve current duplicate-symbol avoidance around miniz and bimg/TinyEXR.

Verify content codecs receive required symbols, final player/shared links avoid duplicate `mz_*`,
content-only tests link standalone miniz where needed, Android ABIs remain valid, and Web links remain
deterministic.

Do not change compression implementation merely to simplify target wiring.

**Completion note (2026-07-18):** Complete. Miniz compile usage is now represented by the
header-only `noveltea_miniz_headers` target, which forwards the standalone package's include paths and
compile definitions without forwarding its archive. `noveltea_content` and the engine-owned package
loader use that target privately. The module-owned `noveltea_content_tests`, which have no bimg
provider, keep an explicit standalone `miniz::miniz` link; engine-linked backend integration tests do
not add a second miniz provider and resolve engine ZIP symbols from the same bimg/bimg-decode provider
as the player. No compression code or ZIP behavior changed.

The pinned bgfx.cmake patch still retains its normal vendored miniz source while removing TinyEXR's
second direct `miniz.c` inclusion, and now fails closed if either upstream integration shape changes.
Linux content/package tests and all final native links pass. Symbol/link audits show no standalone
miniz archive in Android/Web production link commands and a single resolved `mz_*` implementation in
the final artifacts. Web Debug links reproducibly without an incremental relink. Android Debug APKs
and native shared objects pass for both supported ABIs, arm64-v8a and x86_64. Phase 5F through 5I are
outside this subpart and were not changed by this implementation.

#### 5E — Source/namespace moves

Move general runtime out of script paths/namespaces according to the completed runtime plan. Move
presentation implementation from mixed core/host paths as needed. Keep Lua adapters under
`script/lua` and `noveltea::script`.

Avoid unrelated mass renames. Temporary forwarding headers may exist for one consumer migration
window only.

**Completion note (2026-07-18):** Complete. Runtime-owned Flow execution, runtime clock, restore,
shared evaluator, and typed save-slot implementation files now live under `engine/src/runtime`
instead of the mixed `engine/src/core` implementation path. Their existing `noveltea::core` value and
contract headers remain deliberately unchanged: this follows the plan's instruction not to rename
every `core` header, while `RuntimeSession`, `RuntimeExecutor`, `RuntimeCheckpointService`, and
`RunningGame` were already under `noveltea::runtime` before this physical cutover.

All Lua-facing implementation now lives under `engine/src/script/lua`, including
`RuntimeScriptApi`; Lua VM, binding, invocation, result/value adaptation, and capability binding
remain under `noveltea::script`. Presentation coordinator, operation-target assembly, Room
resolution, snapshot projection/publication, runtime presentation-model adaptation, and logical
Layout management now live under `engine/include/noveltea/presentation` and
`engine/src/presentation`. The logical `RuntimeLayoutManager` and `RuntimeSystemLayouts` surface moved
from the root namespace into `noveltea::presentation`; shared presentation value contracts remain
domain-owned under `noveltea::core`.

Every repository consumer was migrated directly to the final paths and namespace. No forwarding
headers, obsolete-owner aliases, duplicate implementations, or compatibility target paths were
introduced. The classification manifest remains complete at 285 of 285 files with exactly one
primary owner. Linux Debug, Web Debug, and Android Debug builds pass; Linux and Web C++/JSON policy
targets pass; and the complete non-GPU Linux suite passes 529 of 529 tests. The repository-wide CTest
run passes 534 of 543 tests, with the nine display/readback-chain failures caused by unavailable X11
in the validation environment. All files changed by 5E pass clang-format; the repository-wide format
target remains blocked by pre-existing violations in files outside this subpart. Phase 5F through 5I
remain intentionally unimplemented.

#### 5F — Module boundary policy

Add `cmake/CheckModuleBoundaryPolicy.cmake` or equivalent plus normal target:

```text
module-boundary-policy
```

The checker must reject forbidden includes/target edges, stale or duplicate allowlist entries, and
undocumented exceptions. Add positive/negative checker fixtures and run it in Linux/Web policy CI.

Do not scan generated/build trees or rely on fragile unrestricted patterns.

**Completion note (2026-07-18):** Complete. `cmake/CheckModuleBoundaryPolicy.cmake` now consumes the
exact Phase 5A production classification and enforces both resolved NovelTea include direction and
explicit `target_link_libraries` direction for the six production modules. It also prevents backend
families from entering lower modules: content admits only its JSON/miniz dependencies, script_lua
admits only Lua/sol2, and domain/runtime/presentation remain backend-free. The checker parses include
directives and target-link command arguments rather than unrestricted source substrings. It rejects an
unclassified production file before scanning, and its scan set is limited to `engine/include`,
`engine/src`, plus source-owned root/engine/apps/tools/tests CMake files; generated, build, dependency,
reference, and baseline sibling trees are not traversed.

The normal `module-boundary-policy` target runs the checker and
`VerifyModuleBoundaryPolicyChecker.cmake`. Positive fixtures cover the approved graph, exact
documented include/target-edge exceptions, and explicit build-tree exclusion. Negative fixtures cover
forbidden module/backend includes, forbidden or dynamically hidden target edges, malformed or wildcard
allowlist entries, duplicates, stale entries, and undocumented exceptions. The checked-in allowlist
has no approved exceptions; future entries require exact keys, owner, rationale, removal condition,
and a live docs/ record containing the exact exception key. `cxx-policy` depends on the new target, so
existing Linux and Web policy CI runs enforce it, while the source-policy job also executes the checker
fixtures directly. Phase 5G and later work remains intentionally unimplemented.

#### 5G — Public-header probes

Add compile probes for domain, content, runtime with fake ports/no Lua/backends, presentation without
host backends, script_lua with private Lua exposure, and a consumer including only the Engine facade.

**Completion note (2026-07-18):** Complete. The `public-header-probes` target now compiles every
dependency-clean public header in domain, runtime, presentation, and script_lua, plus the intentional
content consumer surface, as its own clean translation unit against only that module's published CMake
usage requirements. The content probe covers package/model, editor-preview contract, player bootstrap,
shader compiler, and shader manifest headers; JSON codec/adapter headers remain source-facing content
boundaries with private nlohmann-json implementation usage and are explicitly deferred to Phase 6
public-surface cleanup rather than being made public here. The probes make header self-containment and
transitive lower-layer closure explicit instead of relying on production source include order. A
runtime-specific probe supplies concrete fake script invocation, presentation model, presentation
runtime, save codec, and save-slot ports, proving the runtime surface remains usable without Lua or
host/backend adapters. The presentation probe links only presentation and its published lower layers;
the script_lua probe sees its public C++ surface while Lua/sol2 remain compile-private.

The Engine consumer has exactly one NovelTea include, `noveltea/engine.hpp`, and compiles against the
facade target without directly including backend or lower-layer headers. All probes reject leaked
engine feature, backend, platform, asset-root, or Lua compile definitions. Probe source generation is
driven by the Phase 5A classification for dependency-clean modules; the narrower content surface is
declared explicitly beside the target. The probes are normal build targets and are also dependencies of
`cxx-policy`, covering Linux and Web policy builds. Phase 5H and later work remains intentionally
unimplemented.

#### 5H — Test target retargeting

Link each test to its owning modules. Do not keep broad test targets on engine for convenience.
Backend integration tests remain separate.

**Completion note (2026-07-18):** Complete. The former broad lower-layer test binary was replaced by
five module-owned suites: `noveltea_domain_tests`, `noveltea_content_tests`,
`noveltea_runtime_tests`, `noveltea_presentation_tests`, and `noveltea_script_lua_tests`. Each suite
links only its owning module and the lower NovelTea contracts or direct test-only dependencies its
sources actually consume. Content-owned material, shader compiler, shader manifest, and package
export tests moved out of the engine-linked render suite. Logical Layout-manager tests moved out of
the RmlUi suite and now validate `noveltea_presentation` without host backends. Lua execution tests
link `noveltea_script_lua` and its lower layers directly rather than reaching Lua through Engine.

Engine-owned host, asset, text, and tween tests remain distinct owner-specific binaries. Concrete
bgfx/world-realization tests are isolated in `noveltea_render_backend_tests`, while ActiveText,
RmlUi, and RuntimeUI adapter tests are isolated in `noveltea_ui_backend_tests`; the capture/readback
executables remain separate integration verifiers. No lower-layer test executable links
`noveltea_engine` for transitive convenience. Owner-private implementation headers are exposed only
to the content and script_lua suites that intentionally test those internals. The content suite keeps
the standalone miniz provider required when bimg is absent, without changing production compression
linkage.

Linux Debug configuration and the complete build pass, including all retargeted test binaries,
player, sandbox, editor tool, and public-header probes. The non-display suite passes 529 of 529 tests,
and the complete repository suite passes 543 of 543 under Xvfb, including all GPU/readback and sandbox
checks. Web Debug and its complete `cxx-policy` graph pass, including module, JSON,
dependency/runtime, and public-header policies. Android Debug assembles successfully for the
configured arm64-v8a ABI. Phase 5I remains intentionally unimplemented. The repository-wide
`format-check` target remains blocked by existing clang-format violations in production C++ files
outside this CMake/documentation-only subpart; the 5H diff contains no C/C++ source changes and passes
whitespace validation.

#### 5I — Asset/shader staging

Attach runtime asset and generated shader staging to final targets/apps that need them. Domain/runtime
libraries must not depend on staged shaders or demo assets.

Implemented 2026-07-18. Runtime/demo asset staging is no longer a dependency of
`noveltea_engine` or any lower production module. The final `noveltea-player` and
`noveltea-sandbox` targets explicitly depend on `noveltea-runtime-assets` when CMake staging is
enabled; that staging target retains its dependency on generated shaders. The render-backend test
target depends directly on `noveltea-shaders`, preserving standalone shader verification when both
applications are disabled without pulling sandbox/demo assets into module-owned tests. Android
continues to use the existing Gradle-owned shader and runtime-asset staging pipeline. Root CMake
configuration now rejects any manual dependency from the six production libraries to either staging
target.

Linux Debug configuration, the complete build, the complete `cxx-policy` graph, and all 543 CTest
tests pass under Xvfb. A clean application-disabled build proves `noveltea_engine` creates neither
generated shaders nor staged runtime assets; building only `noveltea_render_backend_tests` then
generates the required shaders without creating the runtime/demo asset tree. Web Debug and its full
policy graph pass with both final applications linked. The optional benchmark and editor tool also
link without asset staging. Android Debug assembles successfully for the configured arm64-v8a ABI
through the existing Gradle-owned shader and runtime-asset tasks. Repository-wide `format-check`
remains blocked by pre-existing clang-format violations in C++ files outside this CMake/documentation
subpart; the 5I diff changes no C/C++ source and passes whitespace validation.

### Expected affected files

- engine/root/test/app/tool CMake files;
- source/header paths and namespaces;
- policy helpers and fixtures;
- build/architecture docs.

### Required verification

- configure/build/test after each target introduction;
- Linux full CTest;
- Web build/policies;
- Android build/link when available;
- module checker fixtures;
- C++/JSON policies on all targets;
- format check;
- player/sandbox/editor tool/benchmark links;
- header probes;
- no duplicate miniz symbols;
- no target cycles.

### Phase gate

Phase 5 is complete when the six production targets own intended sources, dependency direction is
represented by links, runtime/presentation compile without forbidden dependencies, tests/tools link
narrow targets, module policy is enforced, and old broad targets have no production consumer.

### Completion audit — 2026-07-18

Complete. The final Phase 5 audit rechecked every requirement in 5A through 5I against the configured
target graph, generated module inventory, policy fixtures, public-header probes, test ownership, and
platform link outputs. The six approved production targets own every classified production file,
have no forbidden cycle, expose only required lower NovelTea contracts, keep third-party
implementation dependencies private, and have no remaining `noveltea_core` or broad `engine` target
consumer. Tests, applications, the editor tool, and the opt-in benchmark link their intended modules.
Runtime/demo assets and generated shaders remain attached only to final applications or the dedicated
render-backend test path.

Two audit inconsistencies required changes. Thirteen C++ files modified during the Phase 5 cutover did
not satisfy the repository clang-format gate; they were formatted without semantic changes. The
lower full-plan checklist still showed completed Phase 5 module and policy requirements as open; it
was reconciled below while Phase 6-only sanitizer and final documentation-conformance items remain
open.

Final validation passed Linux Debug configuration and complete build, all 543 tests under Xvfb,
format-check, the complete C++/JSON/module policy graph, module-checker fixtures, and every public
header probe. Web Debug player and sandbox builds and the complete Web policy graph passed. Android
Debug APK assembly and dependency compiler policy passed for both arm64-v8a and x86_64. Player,
sandbox, editor tool, and opt-in benchmark links passed. A clean application-disabled build proved
that building `noveltea_engine` creates no generated shaders or staged runtime assets, while building
only `noveltea_render_backend_tests` generated 32 shader files without staging runtime/demo assets.
Desktop final artifacts contain one transitive miniz provider through the bgfx target closure and no
duplicate global `mz_*` definitions; Web and Android final links contain no standalone miniz archive,
and the content-only test suite retains its intentional standalone miniz provider. Phase 5 is
complete with no blocking issue; Phase 6 was not implemented by this audit.

### Explicitly deferred

- deletion of any one-window aliases/forwarders;
- final documentation/stale-comment reconciliation.

## Phase 6 — Public-surface cleanup, obsolete-path deletion, and final conformance

### Objective

Delete transitional host/module paths, finalize public surfaces/documentation, and prove physical
architecture matches the specifications.

### Implement

#### 6A — Engine public API finalization

Remove or relocate demo APIs, fixture audio config, raw preview RML/JSON/Lua from production Engine,
direct runtime audio handles, preview friendship, backend-heavy includes, and stale Typed/script-owned
runtime names.

Retain only intentional application-facing lifecycle/configuration operations.

##### Completion — 2026-07-18

The production `Engine` facade now exposes only construction, initialization, run/tick/resize,
presentation metrics, stop/shutdown, and running-state operations. Screenshot capture, preview
running state, FPS controls, raw preview RML/Lua/editor-document commands, debug mutation, and direct
preview audio access moved behind the explicitly included `EngineTooling`/`RuntimePreviewController`
surface used by sandbox/editor tooling. The redundant public `resize_host` alias was removed.

Sandbox demo code no longer has friendship or direct access to `Engine::Impl`; its deliberate
renderer/asset and preview requirements are obtained through the tooling adapter. `engine.hpp` no
longer names preview, sandbox, renderer, asset, audio, RmlUi, bgfx, or Lua types and retains the PImpl
closure enforced by the Engine-facade public-header probe. Production searches find no remaining
`script::CompiledRuntime`, `script::TypedRuntimeSession`, or `script::TypedExecutionKernel` owners.
`TypedSaveSlotStore` remains intentionally named because it is the current application-injected
opaque save-byte store contract, not a stale script-owned runtime owner.

Validation passed the complete Linux Debug build and all 543 tests, Linux formatting and public-
header/C++/JSON/module policy gates, the complete Web Debug player/sandbox build and corresponding
policy/header gates, browser RmlUi/compiled-world smoke, editor lint and typecheck, Android Debug APK
assembly, and the devtools-disabled ASan/UBSan build of player, sandbox, host tests, and Engine facade
probe. The sanitizer host suite passed all 70 cases with leak detection enabled. Phase 6A is complete;
6B–6F remain intentionally unimplemented.

#### 6B — RuntimeUI visibility

Decide and enforce whether RuntimeUI is private to noveltea_engine or a narrowly public host adapter.
Either way, remove generic `void*` RmlUi access, direct RuntimeSession binding, transaction control,
and presentation brokerage. Native access needed by tests uses private test adapters.

##### Completion — 2026-07-18

`RuntimeUI` is now explicitly private to `noveltea_engine`. Its declaration moved from the
application-facing `engine/include/noveltea/` tree to `engine/src/ui/rmlui/runtime_ui.hpp`; all
production owners and backend integration tests include it only through the engine-private source
include path. The public-header configuration now fails if the former public header is restored, and
the Engine facade remains the sole application-facing lifecycle surface.

The private facade retains only host lifecycle/frame/event handling, typed immutable UI publication
and input seams, concrete Layout realization commands, ActiveText state, backend reset/reload, and
diagnostics/status. Repository checks and compile-time integration regressions confirm there is no
generic borrowed RmlUi document/element/data-model access, RuntimeSession/RunningGame binding,
runtime transaction settlement, or presentation/audio brokerage. Native RmlUi document/element
inspection and selector playback remain available only through the private
`RuntimeUiPlaybackDriver` test/playback adapter.

Validation passed the complete Linux Debug build and all 543 tests under Xvfb, including RmlUi
readback, world/presentation transition, player, and sandbox package smoke coverage. Linux formatting,
public-header probes, and C++ runtime/dependency, JSON-boundary, and module-boundary policy gates
passed. The complete Web Debug player/sandbox build and corresponding public-header and policy gates
passed, as did the debug browser RmlUi/compiled-world smoke. Android Debug APK assembly passed for
arm64-v8a. The devtools-disabled ASan/UBSan build of the Engine facade probe, host tests, and UI
backend tests passed, followed by 21 focused RuntimeUI/GameHost lifecycle and ownership tests with
leak detection enabled. Phase 6B is complete; 6C–6F remain intentionally unimplemented.

#### 6C — Obsolete path deletion

Delete, as applicable:

- old `engine` and `noveltea_core` targets/aliases;
- old source locations and forwarding headers;
- RuntimeUI dispatch/broker methods;
- Engine realized Layout maps/reconciliation helpers;
- CompiledRuntime binding in RuntimeUiAssetResolver;
- demo branches in Engine update/render;
- preview friendship/raw JSON entrypoints;
- any stale callback-transition or generic-tween references left after the completed presentation
  cutover;
- stale migration comments and contradictory docs.

Require capability/consumer evidence before deleting retained functionality.

#### 6D — Dependency audit

Produce final report of target graph, public/private third-party edges, public header closure,
module-policy exceptions, app/tool/test links, platform differences, and any remaining large files
with a cohesive justification.

#### 6E — Documentation reconciliation

Update Engine architecture, architecture/runtime/rendering/UI/build overviews, build verification,
preview/editor communication docs, component docs, and root routing only where repository-wide rules
changed.

#### 6F — Final source-size review

Do not split by line count alone. Expected outcome: engine.cpp is facade/frame sequencing; no one
RuntimeUI file owns contexts/documents/data/ActiveText/playback/runtime dispatch; runtime/presentation
files align with modules; backend adapters stay grouped by backend.

### Required verification

Run:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --build --preset linux-debug --target format-check
cmake --build --preset linux-debug --target cxx-policy
cmake --build --preset linux-debug --target json-boundary-policy
cmake --build --preset linux-debug --target module-boundary-policy

cmake --preset web-debug
cmake --build --preset web-debug
cmake --build --preset web-debug --target cxx-policy
cmake --build --preset web-debug --target json-boundary-policy
cmake --build --preset web-debug --target module-boundary-policy
```

Also run Linux player/sandbox smoke, Web browser/RmlUi smoke, Android assemble/runtime smoke where
available, sanitizer coverage for RuntimeUI/GameHost lifecycle, editor lint/typecheck/relevant preview
tests, header/link probes, staged-package smoke, and devtools enabled/disabled builds.

### Final deletion searches

No production references should remain to equivalent obsolete owners, including:

- `script::CompiledRuntime`, `script::TypedRuntimeSession`, `script::TypedExecutionKernel`;
- RuntimeUI begin/settle transaction or presentation acceptance;
- Engine realized Layout maps;
- Engine demo-mode branches or preview JSON decoding;
- public RmlUi `void*` APIs outside private tests;
- production links to deleted broad targets;
- runtime/presentation forbidden backend/JSON/Lua includes;
- stale module-policy exceptions.

### Phase gate

Phase 6 is complete when Engine is a stable thin facade, GameHost owns loaded-game orchestration,
LayoutRealizer owns Layout backend reconciliation, RuntimeUI is only an RmlUi/view/input adapter,
preview/demo/devtools are isolated, bounded targets enforce dependencies, transitional aliases are
gone, and documentation/platform verification agree with implementation.

## Cross-plan dependency rules

### Completed runtime implementation

This plan consumes, rather than duplicates, final `RunningGame`/`RuntimeSession`,
`RuntimeDispatchResult`/`RuntimePublication`, semantic capability profiles, direct
`PresentationRuntimePort`, `ScriptInvocationPort`, private transaction settlement, and runtime
namespace ownership.

The former runtime implementation plan is complete and has been removed. Its early final-consumer
cutover is not a blocker for this plan: the required ports and publication contracts remain. Host
work must preserve those contracts and must not reintroduce deleted runtime-message brokerage while
extracting `GameHost`, `LayoutRealizer`, or `RuntimeUI` internals.

### World/Room implementation

GameHost and LayoutRealizer consume complete resolved world/presentation publications. They do not
compose Rooms, place Characters, filter Interactables, or clean current-Room state independently.
Preview uses the same resolver/publication path as gameplay.

### Presentation implementation

Host code owns concrete adapters/frame ordering but does not take operation lifecycle, checkpoint
class, desired identity, or transition semantics from presentation. LayoutRealizer realizes final
mounted records without replacing logical Layout ownership.

### Audio

Desired audio/finite operations remain runtime/presentation contracts. AudioSystem/miniaudio are
engine realization. Preview bypass is tooling-only.

### Physical split ordering

Correct source ownership first; enforce it through CMake afterward.

## Full completion checklist

### Engine and host

- [x] Engine is a thin facade with hidden implementation.
- [x] GameHost owns RunningGame and host/runtime lifecycle.
- [x] Loading uses final content/runtime/script owners.
- [x] Publication/events have one deterministic application path.
- [x] Old completions/bindings fail after reset/reload.
- [x] Engine stores no runtime queues or realized Layout maps.

### RuntimeUI and Layouts

- [x] One LayoutRealizer owns mounted-to-document reconciliation.
- [x] RuntimeUI does not bind RuntimeSession/RunningGame for authority.
- [x] RuntimeUI does not broker presentation/audio.
- [x] Contexts, documents, binding, ActiveText, and playback are internally segmented.
- [x] Completed Layout context/order/input/reload behavior remains intact.
- [x] Generic public `void*` RmlUi access is removed/private.

### Input and tooling

- [x] HostInputRouter owns deterministic routing.
- [x] Preview uses explicit dependencies and typed requests.
- [x] Raw editor JSON stays at protocol boundaries.
- [x] Sandbox demos do not add production Engine state/branches.
- [x] Preview audio is tooling-only.
- [x] DebugUI uses typed observations/capabilities.

### Modules

- [x] domain/content/runtime/presentation/script_lua/engine targets exist.
- [x] no forbidden target cycle exists.
- [x] backend/codec dependencies are private where intended.
- [x] tests/tools/apps link only required modules.
- [x] old broad targets are deleted.

### Policy and verification

- [x] module-boundary policy and fixtures exist.
- [x] no-exceptions/no-RTTI applies to all targets.
- [x] JSON policy remains valid.
- [x] header probes compile.
- [x] Linux/Web pass.
- [x] Android passes where available.
- [ ] RuntimeUI/GameHost sanitizer coverage passes.
- [x] player/sandbox/tools/preview consumers pass.
- [ ] documentation reflects final owners/targets.

## Definition of complete

This plan is complete only when physical code and build structure express the normative logical
architecture. Adding helpers is insufficient if Engine, RuntimeUI, noveltea_core, and engine remain
the real broad owners. There must be one thin Engine facade, one GameHost, one LayoutRealizer, one
deterministic host input path, one isolated preview/tooling path, and one bounded module graph with no
duplicate authority.
