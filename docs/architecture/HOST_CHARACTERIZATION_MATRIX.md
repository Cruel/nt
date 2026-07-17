# Host Characterization Matrix

Date: 2026-07-17

Status: Phase 1C behavior baseline for
`docs/architecture/plans/HOST_AND_MODULE_BOUNDARY_IMPLEMENTATION_PLAN.md`.

## Purpose

This matrix fixes the observable Engine/RuntimeUI behavior that later GameHost, LayoutRealizer,
HostInputRouter, PreviewHost, Engine facade, and module-boundary extractions must preserve. It maps
each required behavior to focused executable evidence rather than treating the current broad Engine
or RuntimeUI implementations as the contract.

The evidence intentionally combines existing lower-level tests with the small host-focused additions
made in Phase 1C. Later phases may move or rename the tests with their owners, but they must retain the
listed observations.

## Matrix

| Characterized behavior | Required observable | Current executable evidence | Later owner |
| --- | --- | --- | --- |
| Initialization failure is cleanup-safe | A failed initialized component remains shut down; rollback and repeated shutdown do not retain a running host or mutate unrelated preview state. | `script_runtime_tests.cpp`: `ScriptRuntime initialization failure leaves runtime clean`; `host_characterization_tests.cpp`: `Engine partial shutdown and unloaded preview reset are cleanup safe` | `Engine::Impl` composition root and host lifecycle owner |
| Running-game creation failure leaves no partial RuntimeUI/presentation binding | Package validation or Lua certification failure returns no `RunningGame` and does not reconcile, accept, or terminate presentation work. RuntimeUI binding remains a post-success host action. | `compiled_runtime_tests.cpp`: `compiled runtime rejects malformed package data before session construction`; `running-game creation failure leaves presentation integration untouched`; `runtime_ui_lifecycle_integration_tests.cpp`: RuntimeUI has no session or presentation brokerage | `GameHost` creation/load transaction |
| Start/reset/load/project-reload ordering is deterministic | Start publishes only after construction; reset/load replace generations and transient state in one ordered transaction; project reload terminates old presentation state before publishing the replacement. | `typed_runtime_session_tests.cpp`: `runtime reset clears checkpoint and transient lifecycle without fabricated completion`, `runtime script API survives reset and load without kernel-owned Lua closures`, failed-load atomicity coverage; `presentation_coordinator_tests.cpp`: backend reset/project-reload tests; `runtime_system_layouts_tests.cpp`: reset/fresh initialization | `GameHost` lifecycle orchestration |
| One runtime publication is applied consistently to UI and presentation | The presentation snapshot reconciled during a dispatch equals the presentation member of that dispatch's coherent publication; RuntimeUI consumes the same publication through a one-way typed application path. | `typed_runtime_session_tests.cpp`: `typed runtime session returns playback observations beside one coherent publication` now compares the reconciled snapshot to the publication; `runtime_ui_lifecycle_integration_tests.cpp`: RuntimeUI adapter boundary; `host_contracts_tests.cpp`: typed publication sink | `GameHost` publication application |
| Completion inputs are scheduled later rather than recursively dispatched | Presentation/audio backends return typed completion inputs; public recursive dispatch is rejected; the caller submits returned completions at a later host dispatch boundary. | `typed_runtime_session_tests.cpp`: `reentrant public runtime dispatch is rejected without disturbing the outer operation`; `runtime_audio_adapter_tests.cpp`: exact completion correlation and `take_completions`; `presentation_coordinator_tests.cpp`: acknowledgement and reset behavior | `GameHost` deferred host-input queue |
| Input routing is deterministic | Ordering is platform lifecycle, optional devtools, RuntimeUI, mounted-Layout admission, then gameplay. RuntimeUI consumption or a blocking Layout prevents gameplay while devtools observation remains independent. | `host_characterization_tests.cpp`: `host input routing preserves devtools RuntimeUI Layout and gameplay order`; `runtime_layout_manager_tests.cpp`: `visible mounted Layout input policy is deterministic`; `rmlui_event_disposition_tests.cpp` | `HostInputRouter` |
| Layout reconciliation preserves stable identity/order/visibility/policy | Policy replacement retains the mounted instance; ordering is deterministic; failed realization is atomic; visibility and input policy derive from current mounted state. | `runtime_layout_manager_tests.cpp`: canonical defaults, atomic mount failure, stable policy replacement/order, identity retirement, deterministic input policy, Escape ordering | `LayoutRealizer` plus presentation-owned `RuntimeLayoutManager` |
| RmlUi reload recreates realized Layouts without changing desired state | Document reload recreates backend documents while preserving visibility, focus, listeners, policy migration, and logical mounted state. | `runtime_ui_lifecycle_integration_tests.cpp`: `RuntimeUI preserves lifecycle document state across migration and reload`; `runtime_layout_manager_tests.cpp`: stable logical state independent of document recreation | `LayoutRealizer` and RuntimeUI document registry |
| Resize/suspend/resume do not create clock jumps | Resize alone does not advance a runtime clock; suspended host time advances neither domain; the resume boundary contributes zero delta before normal frame deltas resume. | `runtime_clock_tests.cpp`: `runtime clock freezes both domains during host suspension`, `runtime clock resume boundary does not accumulate suspended or resize time`; `noveltea_rmlui_resize_readback_capture` | Engine frame owner and `HostInputRouter` lifecycle handling |
| Shutdown works after partial and complete initialization | Repeated shutdown is safe before full initialization and after initialized RuntimeUI/ScriptRuntime lifecycles; initialized components can be reinitialized after shutdown. | `host_characterization_tests.cpp`: partial Engine shutdown; `runtime_ui_lifecycle_integration_tests.cpp`: complete RuntimeUI shutdown/reinitialization; `script_runtime_tests.cpp`: idempotent shutdown/reinitialization | `Engine::Impl` and `GameHost` teardown |
| Preview load/reset does not contaminate player state | An unloaded preview reset is rejected without changing demo/preview state; runtime reset/load uses typed runtime transactions and replaces generation/state atomically. | `host_characterization_tests.cpp`: unloaded preview reset isolation; `typed_runtime_session_tests.cpp`: reset/load generation and state tests; editor runtime protocol tests | `PreviewHost` |
| Sandbox demo behavior is distinguishable from loaded-game behavior | Demo rendering is selected explicitly and production loaded-game/readback runs use `--demo none`; loaded-game world rendering is independently verifiable. | CTest `noveltea_rmlui_readback_capture` and feature/resize captures use explicit demo selection; `noveltea_world_presentation_readback_capture` and transition captures use `--demo none --compiled-project ...`; sandbox CLI parsing tests/smokes | apps/sandbox demo harness and production Engine facade |

## Phase 1C additions

- `engine/src/host/input_routing_contracts.hpp` records the current deterministic admission order and
  decision without moving event ownership out of `Engine`. `Engine::handle_events()` uses the same
  decision, so the characterization is not a test-only model.
- `tests/host/host_characterization_tests.cpp` covers routing and cleanup-safe partial Engine state.
- Running-game loader tests now prove rejected construction has no presentation-side effects.
- Runtime-session tests now compare the presentation snapshot delivered to the presentation port
  with the presentation state in the coherent publication.
- Runtime clock and RuntimeUI lifecycle tests explicitly cover resume-boundary and repeated-shutdown
  behavior.

## Deferred integration

This phase does not extract `GameHost`, `LayoutRealizer`, `HostInputRouter`, or `PreviewHost`; split
RuntimeUI sources; move sandbox demo rendering; or reorganize CMake production targets. The matrix is
the acceptance baseline for those later changes.
