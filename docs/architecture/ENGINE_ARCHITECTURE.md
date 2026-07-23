# Engine Architecture

## Current Runtime Path

NovelTea has one gameplay artifact and one native gameplay model:

```text
AuthoringProject V2
  -> compileAuthoringProject
  -> noveltea.compiled.project v1 (canonical gameplay.json)
  -> decode_compiled_project
  -> CompiledProject
  -> runtime::RunningGame
  -> runtime::RuntimeSession
```

Editor preview, authoring-test playback, package export, platform export, the sandbox, and packaged
players all use this path. The deleted `noveltea.runtime.project`, `ProjectDocument`,
`ProjectModel`, legacy importer/package reader, controller hierarchy, and JSON-backed save path are
not runtime compatibility surfaces.

Unsupported gameplay schemas fail with structured diagnostics. The loader never converts an old
shape or falls back to an old engine model.

## Top-Level Ownership

The public `Engine` facade owns one private `Engine::Impl`. The implementation composes platform,
rendering, assets, audio, Lua, runtime UI, preview integration, and host adapters. `GameHost` owns the
optional `runtime::RunningGame`; a loaded `RunningGame` owns the immutable `LoadedCompiledPackage`
and exactly one `RuntimeSession`.

The important boundaries are:

- `AssetManager`: logical `system:/`, `project:/`, and `cache:/` sources plus asynchronous typed
  request/prefetch orchestration, residency accounting, and lease publication. It does not expose a
  synchronous prepared-asset loading facade.
- `RunningGame`: narrow lifetime owner constructed only after package validation, Lua
  certification, and runtime-port wiring succeed.
- `RuntimeSession`: typed inputs, flow/state ownership, output publication, playback, and save
  orchestration.
- `RuntimeUI`: private RmlUi and ActiveText presentation adapter consuming revisioned
  `RuntimeUiGameplayValues` that contain the typed runtime UI view.
- `RuntimeScriptApi`: the sole authored-script/Layout-event gameplay gateway.
- `TypedSaveSlotStore`: native typed save persistence; players provide a filesystem store and
  previews may use the in-memory store.

Backend-neutral runtime code contains no SDL, bgfx, RmlUi, ImGui, Electron, or platform types.

## Physical Module Graph

Production code is split into six libraries with one-way dependencies:

```text
noveltea_domain
  <- noveltea_content
  <- noveltea_runtime <- noveltea_presentation
                     <- noveltea_script_lua
  <- noveltea_engine
```

`noveltea_engine` is the application-composition and concrete-backend library. SDL, bgfx, RmlUi,
miniaudio, Twink, text backends, optional ImGui, JSON boundary implementation, and Lua/sol2 are
private or link-only requirements. The exact graph and platform-specific providers are recorded in
`HOST_MODULE_DEPENDENCY_AUDIT.md` and enforced by `MODULE_BOUNDARY_POLICY.md`.

## Loading

The public application path supplies `EngineConfig::compiled_project` during initialization. Preview
and tooling paths use private `PreviewHost`/`EngineTooling` adapters. Both reach the same private
`Engine::Impl::load_compiled_project(logical_path)` orchestration, which accepts either:

1. canonical `noveltea.compiled.project` V2 JSON for preview/smoke use; or
2. a final `.ntpkg` ZIP containing `gameplay.json`, `manifest.json`, and optional
   `shader-materials.json`.

Both forms decode before atomic `RunningGame` construction. JSON input must have the exact compiled schema and
version. Package input must pass safe-path, manifest inventory, checksum, gameplay identity,
shader/material, shader-binary, resource, and Lua-certification checks before a session exists.

The sandbox flag is:

```sh
--compiled-project project:/projects/example.ntpkg
```

The player validates `player.json`, package checksum/API/capabilities, mounts the package location,
and passes its logical path through the same engine loader.

Production `.ntpkg` loading mounts one indexed `ZipAssetSource`. Startup reads only the manifest,
canonical gameplay entry, and optional shader/material manifest; later consumers open individual
entries on demand. Native/Android use a path-backed source when the platform provides a materialized
package. Web hands one immutable downloaded archive allocation directly to a memory-backed ZIP source
without writing the package to Emscripten's virtual filesystem. No production path expands every
entry into `MemoryAssetSource`.

Prepared font, texture, shader-program, material, and audio resources cross the production boundary
only as `AssetLease<T>`. Mandatory publication retains the leases required by world draws, mounted
Layouts, material/shader binding, and runtime audio; a missing mandatory lease leaves publication
pending or produces a structured failure/rollback instead of invoking a synchronous loader. ActiveText
owns an asynchronous startup font request, and editor preview audio owns asynchronous Demand requests.
The lower-level renderer/text loader entry points used by isolated sandbox demonstrations are tooling
backends outside `AssetManager` residency and are not production compatibility paths.

## Runtime Loop

Each update advances `RuntimeSession` with `AdvanceTimeInput` while preview playback is running.
Inputs from SDL, RmlUi, preview C ABI, and recorded playback lower to closed `RuntimeInputMessage`
variants. One session dispatch owns nested execution, command draining, presentation/audio
acceptance, checkpoint settlement, and publication. Its settled result contains at most one coherent
runtime publication plus ordered events and diagnostics.

The session is confined to its construction thread. Backend work and platform callbacks return as
later typed inputs; no background callback mutates runtime state directly.

`GameHost` owns settled runtime dispatch, applies the coherent publication, routes the desired
presentation snapshot, delivers events, flushes backend work, and queues exact completion inputs for
later non-recursive dispatch. `PresentationLayoutReconciler` owns snapshot-to-mounted-Layout identity
and transition retention; `LayoutRealizer` is the sole mounted-Layout-to-RmlUi document reconciler.
Engine retains only composition and frame sequencing. RuntimeUI renders the supplied typed view and
lowers stable IDs for continue, choice, map, navigation, selection, and interaction requests through
the host input sink. It stores no runtime-session or presentation-handler pointer and owns no gameplay
flow, mutable state, save state, or completion queue.

## Lua

`ScriptRuntime` provides the sandboxed Lua VM. `RuntimeScriptApi` is bound to the active typed
session and exposes approved typed operations. Lua source is certified during preview/export
readiness and again while loading a runtime package. The old dispatcher-backed `Game.*` bindings
and runtime script executor no longer exist.

## Presentation Inventory

Phase 10 deliberately retains functional presentation code:

| Responsibility | Status | Authority |
|---|---|---|
| `RuntimeUI` and RmlUi document/component binding | Retained low-level backend | Consumes typed views/inputs; no gameplay authority |
| ActiveText parsing, playback, layout, and direct bgfx text rendering | Retained low-level backend | Presentation only |
| Audio system and typed audio-operation handling | Retained low-level backend | Executes typed output; no flow/state ownership |
| `PresentationCoordinator` and `WorldTransitionBackend` | Retained typed finite-operation lifecycle and realization | Coordinator owns identities/barriers; backend owns transient progress/resources only |
| `RuntimeLayoutManager` | Retained logical mounted-Layout policy/lifetime | Owns typed mount identity and policy; no backend document or semantic animation authority |
| `PresentationLayoutReconciler` and `LayoutRealizer` | Retained engine-private realization adapters | Reconciler owns snapshot mount/retention bookkeeping; realizer alone owns backend document reconciliation |
| Direct bgfx/RmlUi rendering adapters | Retained low-level backend | Renderer resource/submission ownership only |

Finite background, actor, Layout, Room-navigation, and Scene-group presentation now use coordinator
operations with typed target keys and exact snapshot revisions. The callback transition manager and
old raw-target/string-channel tween owner have been deleted. The animation layer now provides a
handle-based `TweenService`, privately backed by mandatory Twink and owned locally by realization
backends. Backend progress remains transient and cannot become gameplay mode, Flow, mutable state, or
save truth.

## Verification

Engine changes use Linux and Web builds plus C++ policy/format checks and the complete Linux test
suite. Rendering/input/UI changes also use the sandbox smoke targets. Android is checked when the
SDK is available and platform/package behavior changes.
