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

## GameHost lifecycle ordering

Phase 2F makes loaded-game lifecycle replacement synchronous, generation-scoped, and idempotent.
The authoritative ordering is:

1. **New game or project reload:** fully resolve, validate, construct, start, optionally stop, and
   prepare candidate host resources without mutating the current game. After preparation succeeds,
   detach current RuntimeUI and system-Layout bindings, detach the old presentation port, detach
   host-owned project resources, terminate old presentation work with `ProjectReload`, activate the
   candidate presentation state, install the candidate, commit its host resources, and attach its
   RuntimeUI/system-Layout bindings. Only after the complete candidate is attached do session and
   backend generations advance and the old `RunningGame` is destroyed. Any failure before that
   point preserves the previous game and generations; an attach failure restores its resources and
   bindings before returning failure.
2. **Start and stop:** the first accepted Start moves a stopped game to `Running`; the first accepted
   Stop clears deferred host inputs, cancels runtime transient work through the runtime transaction,
   and moves the game to `Stopped`. Start while already running and Stop while already stopped are
   successful no-ops. Frame advancement occurs only while the loaded game is `Running`.
3. **Reset and save load:** Reset and Load remain one runtime dispatch transaction. A successful
   Reset or Load invalidates the old runtime capability generation inside `RuntimeSession`, clears
   deferred host inputs, advances GameHost session and backend generations, and rebinds generation-
   scoped RuntimeUI and shell handlers before later input is admitted. Save does not replace a
   generation. Failed Reset or Load leaves the current generations unchanged.
4. **Host suspend and resume:** only the first suspend edge freezes host/runtime advancement and only
   the first resume edge re-enables it; repeated notifications are no-ops. Deferred backend facts
   remain queued until a resumed running frame can dispatch them.
5. **Backend reset:** the first begin-reset edge advances the backend generation, discards queued
   facts from the replaced backend, terminates active presentation operations, and blocks runtime
   dispatch and project replacement. Finish-reset reconciles the current publication into the new
   backend generation and flushes resulting facts. It remains active after a failed reconciliation
   so the caller can retry; repeated begin or successful finish calls are no-ops.
6. **Engine shutdown:** stop the Engine loop and devtools first, then advance GameHost session and
   backend generations, detach RuntimeUI/system-Layout bindings, terminate presentation work,
   destroy the `RunningGame` so runtime capabilities are invalidated, and clear loaded-game state.
   Engine then detaches RuntimeUI realization, resets world/UI/clock state, and shuts down audio,
   scripts, renderer, and platform in dependency order. Native teardown may synchronously complete
   the final executor drain. Web teardown never spins or sleeps the browser owner thread: it begins
   cancellation, services one shutdown step, and reschedules deferred cleanup through the browser
   event loop until worker joins and owner completions are complete. Repeated shutdown is a no-op.

Every deferred runtime completion carries both the GameHost session generation and backend
generation. A late completion from either a replaced game/runtime generation or a reset backend is
discarded with a typed diagnostic. Direct requests captured by old RuntimeUI bindings fail against
their captured session generation. Runtime capability generations continue to fail closed in
`RuntimeSession` and `ScriptRuntime` after Reset, Load, project replacement, or shutdown.

## Dependency constraints

The internal contracts reuse existing backend-neutral domain/runtime/presentation values and current
typed material, audio, and display-profile values needed by preview tooling. They do not include
SDL, bgfx, RmlUi, miniaudio, ImGui, Lua/sol2, JSON, or editor transport types. Concrete owners remain
responsible for translating backend failures into `core::Diagnostics` before crossing these seams.

## Deferred integration

Phase 1B deliberately does not replace current callback wiring or move runtime dispatch, Layout
realization, preview, frame, or shutdown implementation. `GameHost`, `LayoutRealizer`, RuntimeUI
decomposition, `HostInputRouter`, and `PreviewHost` adopt these contracts in Phases 2 through 4.
