# Internal Host Contracts

Date: 2026-07-17

Status: Phase 1B contract baseline for
`docs/architecture/plans/HOST_AND_MODULE_BOUNDARY_IMPLEMENTATION_PLAN.md`.

## Purpose

These contracts define the narrow typed seams that later host extraction phases must use. They do
not move lifecycle or workflow ownership out of `Engine` or `RuntimeUI`, create a service locator, or
change runtime, presentation, Layout, preview, checkpoint, or transition semantics.

The contracts are private implementation headers under `engine/src/host/` so normal application
consumers do not acquire a second public host API while `Engine` remains the application-facing
facade.

## Runtime dispatch and publication

`runtime_host_contracts.hpp` defines:

- `HostRuntimeDispatchResult`, a move boundary over exactly one settled
  `runtime::RuntimeDispatchResult`. It preserves input disposition, the optional coherent
  `RuntimePublication`, ordered `RuntimeEvent` values, diagnostics, and budget outcome without
  reopening runtime transactions;
- `RuntimeInputSink`, the typed target used by RuntimeUI and preview input sources;
- `RuntimeInputSource`, the explicit binding contract for those sources; and
- `RuntimePublicationSink`, the one-way typed publication application seam that RuntimeUI will
  implement during its host detachment; and
- `RuntimeObservationSink`, the optional typed preview/devtools seam for the observations and ordered
  events retained by `GameHost` without exposing mutable runtime state.

An accepted host result means only that the runtime disposition is not `Failed`. It does not imply
that a new publication was produced. Events and diagnostics remain ordered output from the same
dispatch and must not cause recursive dispatch.

## Layout realization

`layout_realization_contracts.hpp` keeps logical mounted Layout state in the existing presentation
contracts and adds host-only realization requests:

- realize or update one stable mounted instance from a built-in, logical asset path, fragment, or
  memory source;
- remove one stable realization; or
- recreate current realizations after a backend generation change.

Every request carries a host generation. Realize requests also carry the source presentation
revision, mounted instance identity/policy, composition group, document identity, and typed source.
Results distinguish creation, replacement, update, removal, recreation, no-op, stale rejection, and
failure and retain typed diagnostics. This is the seam later owned by `LayoutRealizer`; it is not a
second logical Layout manager.

## Preview requests

`preview_host_contracts.hpp` defines a request envelope with a request ID and host generation. Its
closed payload variant covers the currently retained preview workflows: decoded Layout and shader
documents, project loading, typed runtime input, tooling Lua, fast-forward/debug snapshots, display
override, screenshots, and direct preview audio.

The request contains no JSON value or backend handle. JSON parsing and protocol validation remain at
the editor/content boundary. `PreviewResult` returns an explicit disposition, typed runtime/text/
capture payload where applicable, and diagnostics. Later `PreviewHost` must reject stale host
generations rather than retaining callbacks into replaced runtime or backend state.

## Lifecycle, backend notification, and frame stages

`host_lifecycle_contracts.hpp` defines:

- explicit host lifecycle states and shutdown reasons;
- monotonic host and backend generations;
- typed before/after backend-reset and backend-reload notifications; and
- stable `HostFrameStage` identifiers in execution order for diagnostics and characterization tests.

The frame-stage vocabulary records orchestration order only. It does not make lower runtime or
presentation modules aware of SDL, bgfx, RmlUi, miniaudio, or ImGui.

## Dependency constraints

The internal contracts reuse existing backend-neutral domain/runtime/presentation values and current
typed material, audio, and display-profile values needed by preview tooling. They do not include
SDL, bgfx, RmlUi, miniaudio, ImGui, Lua/sol2, JSON, or editor transport types. Concrete owners remain
responsible for translating backend failures into `core::Diagnostics` before crossing these seams.

## Deferred integration

Phase 1B deliberately does not replace current callback wiring or move runtime dispatch, Layout
realization, preview, frame, or shutdown implementation. `GameHost`, `LayoutRealizer`, RuntimeUI
decomposition, `HostInputRouter`, and `PreviewHost` adopt these contracts in Phases 2 through 4.
