# Presentation and Checkpoint Ownership

Date: 2026-07-16
Status: The checkpoint and presentation contracts remain active. The detailed inventory below is the
frozen pre-runtime-consolidation baseline used to implement those contracts; obsolete runtime class
names in baseline/evidence sections are historical and are not current owners. Current runtime
ownership is defined by `RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md` and the current architecture docs.

Runtime execution update (2026-07-16): the runtime execution and capability plan is complete.
`runtime::RunningGame` owns one `runtime::RuntimeSession`; the session owns dispatch settlement,
commands, capabilities, publication, events, and checkpoint integration. RuntimeUI is no longer a
runtime-output or presentation broker. Presentation/audio are accepted synchronously through the
presentation runtime port, while external protocol adapters consume final publications, events, and
diagnostics.

## Purpose and authority

This is the durable checkpoint/presentation contract record and the historical implementation
inventory from which those contracts were derived. Sections explicitly labeled as baseline or phase
implementation evidence must not be read as current runtime ownership. Current runtime ownership is
defined by `RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md`; later presentation phases keep the still-active
checkpoint and presentation contracts in this document current.

The fixed target architecture, semantic checkpoint classes, and phase boundaries remain defined by
[`PRESENTATION_COORDINATOR_AND_RUNTIME_LAYOUT_IMPLEMENTATION_PLAN.md`](../rendering/plans/PRESENTATION_COORDINATOR_AND_RUNTIME_LAYOUT_IMPLEMENTATION_PLAN.md).
The specification does not authorize implementing behavior assigned to later phases. Phase 1C adds
only the shared value types frozen here; behavior remains assigned to its named later phase.

Disposition means:

- `retain`: the current owner remains responsible for this capability, although a later phase may
  extend its typed data;
- `reduce`: the current owner keeps a narrower backend or adapter role after orchestration moves;
- `replace`: a named later-phase owner replaces the current source of truth or workflow;
- `delete`: obsolete scaffolding has no retained production role after the named phase.

## Historical audit scope and pre-consolidation runtime path

The inventory was derived from the implementation and focused tests on 2026-07-14. The inspected
paths included:

- state, Flow, waits, feature views, save projection/codec/validation/restore, slot stores, and
  runtime messages under `engine/include/noveltea/core/` and `engine/src/core/`;
- `TypedExecutionKernel`, `TypedRuntimeSession`, `ScriptInvoker`, `ScriptHostServices`,
  `RuntimeScriptApi`, Lua bindings, and compiled-runtime construction under `engine/src/script/`;
- `RuntimeUI`, the RmlUi system/input/render adapters and document binder,
  `RuntimeLayoutManager`, `RuntimeTransitionManager`, `TweenService`, ActiveText,
  `RuntimeAudioAdapter`, `AudioSystem`, and the miniaudio/backend contract;
- `Renderer`, `Engine`, `RuntimePreviewController`, the preview C/JSON adapters, sandbox and
  packaged-player entrypoints;
- the editor preview protocol, full-game preview, preview manager/thumbnail records, package
  publication consumers, and their focused tests;
- `tests/CMakeLists.txt` and the core, script, tween, UI, render-readback, sandbox-smoke, editor
  preview, and player-bootstrap coverage relevant to these paths.

The verified player path at the time of the baseline audit was:

```text
CompiledProject
  -> runtime::RunningGame
  -> runtime::RuntimeSession / runtime::RuntimeExecutor / SessionState
  -> RuntimePublication + ordered RuntimeEvent + Diagnostics
  -> Engine routing
       -> RuntimeUI gameplay-view adapter
       -> RuntimePresentationBridge / PresentationCoordinator
       -> RuntimeAudioAdapter -> AudioSystem -> AudioBackend
  -> Engine frame orchestration -> Renderer / RuntimeUI / DebugUI
```

`RuntimeLayoutManager` and `RuntimeTransitionManager` are compiled into `engine`, but repository-wide
symbol inspection found no production or test consumer. The live engine directly loads title and
runtime RmlUi documents. `Engine::render()` currently uses a constant zero transition opacity.
This conflicts with older documentation describing both managers as tested functional
orchestration; they are isolated scaffolding, not current runtime owners.

## Frozen implementation inventory

The tables in this section preserve the evidence and migration dispositions recorded while the
presentation/checkpoint work was implemented. Rows naming removed runtime types describe that
historical implementation only; they do not override the final runtime audit.

### Runtime, execution, and typed boundaries

| Concern / capability | Baseline authoritative owner | Implementation files and public types | Baseline consumers | Baseline tests or missing coverage | Final owner required by the plan | Disposition and exact phase |
| --- | --- | --- | --- | --- | --- | --- |
| Immutable presentation definitions and references | `CompiledProject` | `core/compiled_project.hpp`: `BackgroundPresentation`, `LayoutResource`, system Layout roles, Scene actor/background/Layout/transition/audio instructions | `SessionState`, typed executors/views, `RuntimeUiAssetResolver`, compiler/package paths | `compiled_project_model_tests`, `compiled_project_wire_tests`, editor compiled-wire/golden/export tests | Immutable `CompiledProject` definitions | `retain`; Phase 1B freezes ownership, Phase 7 extends only typed reconstructible definitions if required |
| Mutable gameplay and logical presentation state | `SessionState` | `core/session_state.hpp`, `core/feature_state.hpp`, `core/session_state.cpp`: variables, properties, Flow, actors, background, Layout slots, overlays, text/choices, transition, audio channels, Map | `FlowExecutor`, `TypedExecutionKernel`, `ScriptHostServices`, typed view projectors, save projection | `session_state_tests`, feature executor tests, `save_state_tests`; no test treats all presentation fields as a coherent renderer snapshot | Runtime/session state | `retain`; Phase 7 adds complete reconstructible presentation/audio records without backend state |
| Flow stack, cursor mutation, and typed blockers | `FlowExecutor` mutating `SessionState` | `core/flow.hpp`, `core/flow_executor.hpp`, `core/flow_executor.cpp`: five blocker alternatives and strong handles | typed feature executors, `ScriptInvoker`, `TypedRuntimeSession`, save/restore | `flow_executor_tests`, feature executor tests, `runtime_domain_types_tests`, `save_state_tests` | Runtime/session state and `FlowExecutor`; presentation only acknowledges exact operations | `retain`; Phase 1C canonicalizes shared operation identities, Phase 4 connects exact coordinator acknowledgements |
| Runtime input/output queues and pending operation correlation | `TypedRuntimeSession` | `core/runtime_messages.hpp`, `runtime/runtime_commands.hpp`, `script/typed_runtime_session.hpp/.cpp`: closed inputs/outputs, script-input queue, session-owned deferred command queue, ordered runtime events, one pending presentation operation, one pending blocking audio operation | `RuntimeUI`, preview/playback protocol, Lua `RuntimeScriptApi` | `runtime_messages_tests`, `runtime_contracts_tests`, `typed_runtime_session_tests`, `editor_runtime_protocol_tests` cover FIFO commands, bounded self-enqueue, stale owners, event ordering, and checkpoint settlement | Runtime owns inputs/execution queues; presentation coordinator owns presentation operation lifecycle | `reduce`; later transaction/publication phases consolidate the remaining transitional queues and consumers |
| Feature-oriented published UI view | `TypedExecutionKernel::runtime_ui_view()` and `TypedRuntimeSession::append_view()` | `core/feature_view.hpp`: `TypedRuntimeUIViewState`; specialized execution files | RmlUi binder/custom elements, ActiveText, preview debug snapshot, Lua stable-ID helpers | `session_state_tests`, `typed_runtime_session_tests`, `rmlui_document_binder_tests`, `rmlui_custom_components_tests`, preview protocol/editor tests | UI view remains feature-specific; complete presentation projection belongs to `PresentationProjector` | `reduce`; Phase 4 adds the separate complete `RuntimePresentationSnapshot`, Phase 8 migrates remaining consumers |
| Immediate and suspended Lua invocation | `ScriptRuntime` owns VM/coroutines; `ScriptInvoker` binds invocation to `ScriptFlowBlocker` | `script_runtime.hpp/.cpp`, `script_invoker.hpp/.cpp`, `typed_execution_kernel.cpp` | typed Scene/Dialogue/Interaction execution and `RuntimeScriptApi` | `script_runtime_tests`, typed execution tests, `save_state_tests` reject opaque suspension | Runtime/session execution | `retain`; Phase 2 includes invocation state in checkpoint readiness, never in serialized state |
| Deferred runtime commands, events, and autosave markers | `TypedRuntimeSession` owns the command queue and drain; `ScriptHostServices` is a transitional validating producer | `runtime/runtime_commands.hpp`, `runtime/runtime_contracts.hpp`, `core/script_host_services.hpp/.cpp`, `typed_runtime_session.cpp`: `DeferredRuntimeCommand`, monotonic sequence, source context, `RuntimeEvent` | Runtime execution drains commands internally; `RuntimeUI` and editor/playback adapters consume ordered events without acknowledgements | `runtime_contracts_tests`, `script_runtime_tests`, `typed_execution_kernel_tests`, `typed_runtime_session_tests`, `editor_runtime_protocol_tests` | Runtime command gateway/session; no internal host acknowledgement adapter | `replace`; runtime execution Phase 2 complete, semantic capability gateway replaces `ScriptHostServices` in the next phase |
| Public Lua runtime gateway | One `RuntimeScriptApi` targeted at `TypedRuntimeSession` | `runtime_script_api.hpp/.cpp`, `bind_runtime_capabilities.cpp`, `bind_noveltea.cpp` | authored Lua and RmlUi Layout events | `script_runtime_tests`, `typed_runtime_session_tests`; no final system-menu/custom-mount command coverage | `RuntimeScriptApi` with narrow typed ports | `retain`; Phase 7 adds persistent presentation/audio controls and Phase 8 adds menu/custom Layout commands |
| JSON at editor/debug protocol boundary | `editor_runtime_protocol` and `RuntimePreviewController` adapters | `core/editor_runtime_protocol.hpp/.cpp`, `runtime_preview_controller.cpp`, `editor/src/shared/preview-protocol.ts` | editor playback, debugger, full-game preview | `editor_runtime_protocol_tests`, `preview-protocol.test.ts`, `full-game-preview-editor.test.tsx` | External protocol adapters only | `retain`; Phase 8 updates protocol DTOs after shared runtime contracts exist |

### Save, restore, metadata, and storage

| Concern / capability | Baseline authoritative owner | Implementation files and public types | Baseline consumers | Baseline tests or missing coverage | Final owner required by the plan | Disposition and exact phase |
| --- | --- | --- | --- | --- | --- | --- |
| Live save projection | `TypedExecutionKernel::snapshot_save()` calls `make_save_state()` on the live `SessionState` | `core/save_state.hpp/.cpp`: `SaveState`; `typed_execution_kernel.cpp` | retained-checkpoint candidate projection | `save_state_tests`, `typed_execution_kernel_tests`, `typed_runtime_session_tests` explicitly cover current behavior | Runtime checkpoint/save service | `reduce`; candidate projection contains only serializable runtime state and receives no fabricated host/request context |
| Save eligibility preflight | Ad hoc checks inside `make_save_state()` | Rejects execution fault, `m_flow_running`, queued external requests, and `ScriptFlowBlocker`; permits input/duration/presentation/audio blockers | direct manual save and autosave | `save_state_tests` proves the current incomplete predicate; no presentation-status, generation, transaction-settling, or time-coalescing coverage | Runtime checkpoint/save service consuming typed presentation status | `replace`; Phase 2 |
| Save codec and project-aware validation | Dedicated save JSON boundary | `save_state_codec.hpp/.cpp` and `save_state_codec/*`: strict `noveltea.save.state` V2 encode/decode/validation | kernel slot save/load, tests, tools | extensive `save_state_tests`; JSON boundary/policy tests cover placement | Runtime checkpoint/save service invokes the retained codec; codec remains serialization boundary | `retain`; Phase 2 changes capture caller, Phase 7 extends reconstructible fields |
| Save restore | `FlowExecutor::restore_session()` creates a fresh `SessionState` and handles | `core/session_restore.cpp` | `TypedExecutionKernel::restore/load_slot`, manual load, Lua `Game.load` | `save_state_tests`, kernel/session tests; tests currently assert Room baseline derivation and omitted blocker behavior | Runtime checkpoint/save service restores runtime, then coordinator reconstructs presentation | `replace`; Phase 2 removes fabricated post-operation restoration, Phase 7 completes presentation reconstruction |
| Manual slot write | `TypedExecutionKernel::save_slot()` encodes current live state and immediately calls the store | `typed_execution_kernel.cpp`; `SaveRuntimeInput`, `RuntimeScriptApi::save` | runtime session, Lua, editor playback protocol | kernel/session tests; no older-retained-checkpoint write test | Runtime checkpoint/save service | `replace`; Phase 2 |
| Autosave | `ScriptHostServices` queues compiler-marked safe-point requests; `consume_autosave()` writes current live state immediately and consumes markers on success | `script_host_services.*`, `typed_execution_kernel.cpp`, `typed_runtime_session.cpp` | Scene/Dialogue executors | kernel/dialogue/session tests; no deferred-next-checkpoint semantic test | Runtime checkpoint/save service | `replace`; Phase 2 |
| Slot identity and byte persistence | `TypedSaveSlotStore` | `core/typed_save_slot_store.hpp/.cpp`: manual/autosave identity, memory string bytes, atomic filesystem replacement | previews/tests use memory store; packaged player injects filesystem store | `typed_save_slot_store_tests`; player wiring indirectly covered by bootstrap/export tests, no end-to-end packaged-player save/load test | Runtime checkpoint/save service owns retained bytes and commands; slot store remains byte I/O | `reduce`; Phase 2 keeps store as I/O-only port |
| Save metadata | `SaveStateMetadata` contains format, project ID, project version; `SaveOutcome` contains slot/status/autosave | `save_state.hpp`, `runtime_messages.hpp`, codec | slot encode/load and external output encoder | save/runtime-message/protocol tests; no checkpoint revision, Room/time/display metadata coverage | Runtime checkpoint/save service | `replace`; Phase 1B specifies fields, Phase 2 implements checkpoint metadata, Phase 7 completes presentation-aware values |
| Save thumbnails | No save/checkpoint thumbnail implementation | Renderer screenshot path is `Renderer::request_screenshot`; editor `ThumbnailRequest` is an entity-preview cache and is unrelated to save slots | command-line/readback screenshots; editor entity previews | RmlUi/presentation readback tests and `preview-manager.test.ts` cover those separate paths; no save-thumbnail test | Runtime checkpoint/save service owns checkpoint association; renderer supplies capture bytes through a typed boundary | `replace`; Phase 7 implements checkpoint-owned thumbnails, Phase 8 exposes them in menu/preview/player workflows |
| Preview `saveSnapshot` | `RuntimePreviewController` emits an empty JSON object | `runtime_preview_controller.cpp`; `RuntimeDebugSnapshot.saveSnapshot` is an external `Record<string, unknown>` | full-game preview inspector | protocol/editor tests accept arbitrary boundary records; no runtime checkpoint content exists | Preview adapter encodes typed checkpoint diagnostics/metadata owned by runtime | `replace`; Phase 8 |

### Presentation, Layout, UI, rendering, and frame orchestration

| Concern / capability | Baseline authoritative owner | Implementation files and public types | Baseline consumers | Baseline tests or missing coverage | Final owner required by the plan | Disposition and exact phase |
| --- | --- | --- | --- | --- | --- | --- |
| Presentation operation IDs and current payloads | Runtime allocates the canonical IDs; current payloads remain in `core/runtime_messages.hpp` | `core/session_operation_id.hpp`: `SessionOperationId`, `PresentationOperationId`; `core/runtime_messages.hpp`: transitional `TransitionPresentationOperation`, `LayoutPresentationOperation` | `TypedRuntimeSession`, `RuntimeUI` sink dispatch | `presentation_checkpoint_contracts_tests`, `runtime_messages_tests`, typed session tests; Layout operation has no production sink behavior | Canonical shared presentation contracts | `reduce`; Phase 1C/1D canonicalized and verified identities without changing payload behavior; Phase 4 owns lifecycle and replaces transitional payload dispatch |
| Presentation dispatch and acknowledgement broker | Engine-owned `RuntimePresentationBridge` composes `PresentationCoordinator`, snapshot publication, the minimal presentation port, and `RuntimeAudioAdapter`; `RuntimeUI` only forwards complete typed output batches and returns coordinator terminal inputs through the runtime seam | `core/presentation_coordinator.*`, `runtime_presentation_bridge.*`, `ui_runtime.*` | live engine runtime UI and audio path | coordinator lifecycle/fake-backend tests, bridge/audio termination and exact-correlation tests, typed-session checkpoint-provider tests, full Linux/Web builds and policy checks | `PresentationCoordinator` through the engine-owned bridge | `retain`; Phase 4 complete, Phases 5–7 replace only low-level realization and extend reconstructible payloads |
| Layout resource content | `CompiledProject::LayoutResource`; it has source, target intent, dependencies, and script metadata but no mount policy | `core/compiled_project.hpp`, package/compiler/editor Layout schema | RmlUi template resolver, preview/export/resource validation | compiled-model/wire tests, editor authoring Layout tests | Immutable `CompiledProject` definitions | `retain`; Phase 3 introduces separate mounted-instance policy |
| Gameplay-owned Layout slots | `SessionState::m_layouts` keyed by coarse compiled `LayoutSlot` | `feature_state.hpp`, `session_state.*`, Scene executor and `RuntimeScriptApi` Layout helpers | Scene views; no live `Engine` path mounts these slots into `RuntimeUI` | session and typed-session Lua tests cover state mutation only; no restore/mount integration test | Runtime/session state with reconstructible mounted intent | `reduce`; Phase 3 adopts typed mount policy, Phase 7 persists reconstructible state, Phase 8 completes consumer cutover |
| Shell/menu documents | Direct `RuntimeUI` document map; built-in title is live, pause document asset/API exists but no engine menu stack invokes it | `ui_runtime_rmlui.cpp`, system title/pause RML; `Engine::load_compiled_project()` | title screen and authored preview documents | `title_layout_asset_tests` only checks title Lua calls; no pause/settings/load/save stack test | Shell/menu state using mounted Layout instances | `replace`; Phase 8 |
| Mounted Layout policy | Engine-owned `RuntimeLayoutManager` owns canonical typed mounted instances, deterministic ordering, input evaluation, and owner-routed Escape dismissal; RmlUi remains the realization host | `runtime_layout_manager.hpp/.cpp`; `engine.hpp/.cpp`; `core::MountedLayoutInstance`, strong ID, owner, and complete policy; document IDs remain adapter metadata | live engine pause/input derivation and built-in title/game-HUD visibility | `runtime_layout_manager_tests.cpp` covers typed policy/lifetime/input/dismissal; `gameplay_pause_tests.cpp` covers pause participation | RmlUi/Layout presentation with typed mount policy; shell state for menus | `reduce`; Phase 3 complete, Phase 5 integrates lifecycle contexts, Phase 7 reconstructs gameplay mounts |
| RmlUi lifecycle and documents | `RuntimeUI::State` owns contexts keyed by typed plane/composition-group/clock/input policy; compatible contiguous documents share contexts and plane render adapters | `ui_runtime.hpp`, `ui_runtime_rmlui.cpp`, `ui/rmlui/*` | engine runtime UI and editor authored previews | lifecycle clock/order/input tests, mounted-policy tests, headless migration/reload integration, GPU readbacks, Linux/Web smoke | RmlUi/Layout presentation context registry | `retain`; Phase 5 complete |
| RmlUi time | `SdlSystemInterface` reports engine-selected gameplay or unscaled absolute time before each context update/render | `rmlui_system_interface_sdl3.*`, `rmlui_lifecycle.hpp` | every RmlUi document/context | clock-domain tests cover frozen gameplay and live unscaled time | Engine clock service plus RmlUi clock router | `retain`; Phase 5 complete |
| RmlUi input and ordering | RuntimeUI routes SDL input through visible lifecycle contexts from top to bottom; consumption or `Modal` stops lower presentation delivery, while `BlockGameplay` permits lower UI delivery but prevents gameplay fallthrough through `RuntimeLayoutManager` admission. Composition groups preserve interleaved mounted order and Escape dismissal remains owner-routed. | `runtime_layout_manager.*`, `engine.cpp`, `ui_runtime_rmlui.cpp`, `rmlui_input_sdl3.*`, `rmlui_lifecycle.hpp` | host events and typed Layout gameplay commands | mounted-policy input/dismissal tests, lifecycle ordering/input tests, headless context migration/reload test | Typed mounted-Layout input router and RmlUi contexts | `retain`; Phase 5 complete |
| ActiveText logical content and stable input wait | `SessionState::PresentedTextState` plus Flow input blocker; view projected through `TypedRuntimeUIViewState` | `feature_state.hpp`, feature executors/views | RuntimeUI custom component and direct glyph path | save tests prove presented text is omitted; executor/UI tests cover content and input separately | Runtime/session state for reconstructible logical page/input state | `reduce`; Phase 5 integrates stable logical state with coordinator operations |
| ActiveText reveal/fade/page realization | Coordinator owns typed reveal/fade lifecycle and causal barriers; `RuntimeUI::State` owns clock-driven playback and direct-render realization only | `presentation_coordinator.*`, `runtime_presentation_bridge.*`, `active_text_playback.*`, `ui_runtime_rmlui.cpp` | `RuntimeUI::begin_frame()`, direct renderer snapshot | playback/layout and bridge barrier tests | Presentation coordinator; RmlUi/direct renderer are realization backends | `retain`; Phase 5 complete |
| General tween primitive | `TweenService` owns target pointers, Twink objects when enabled, string owner/channel, and completion callbacks | `tween_service.hpp/.cpp` | ActiveText only in the live engine | `tween_service_tests`; no typed operation identity/cancellation ownership test | Coordinator owns semantic operation state; backend may retain specialized tween primitive | `reduce`; Phase 6 |
| Transition state emitted by Flow | `SessionState::LogicalTransitionState` and one pending typed operation in `TypedRuntimeSession` | `feature_state.hpp`, `typed_execution_kernel.cpp`, `typed_runtime_session.cpp` | `RuntimeUI` would require a presentation sink, but `Engine` binds none | typed kernel/session tests cover blocker correlation; no live renderer transition test | Runtime target state plus `PresentationCoordinator` operation lifecycle | `replace`; Phase 4 coordinates operations, Phase 6 implements final transition behavior |
| Callback transition scaffolding | Isolated `RuntimeTransitionManager` owns fade phase/opacity and `std::function` midpoint callback | `runtime_transition_manager.hpp/.cpp` | none; engine transition opacity is constant zero | explicit missing coverage: no manager test or engine integration | `PresentationCoordinator` plus renderer-owned capture/interpolation | `delete`; Phase 6 |
| Runtime UI binding | `RuntimeUiDocumentBinder` and custom components derive RmlUi content from `TypedRuntimeUIViewState` | `rmlui_document_binder.*`, `rmlui_custom_components.*` | runtime game document and preview documents | binder/custom-component tests and readback fixtures | RmlUi/Layout presentation consuming snapshot and typed operations | `reduce`; Phase 5 |
| Engine 2D and ActiveText rendering | `Renderer` owns bgfx frame lifecycle/resources, demo quads/text, direct ActiveText, fullscreen color, screenshots | `renderer.hpp`, `render/bgfx/*`, text renderer | `Engine::render()`, sandbox/readback | render/material/text tests and GPU readbacks; no complete world-snapshot renderer test | Renderer backend consuming `RuntimePresentationSnapshot` | `reduce`; Phase 6 |
| Composition order | `Engine::render()` manually orders renderer begin, demo draws, RmlUi render, direct ActiveText, inactive transition block, ImGui, screenshot, frame end | `engine.cpp` | sandbox, Web, packaged player | presentation/RmlUi readback covers current pixels; no typed-plane/view-range invariant test | Typed planes coordinated across presentation/RmlUi/renderer/debug | `replace`; Phase 6 |
| Frame clocks and pause | `core::RuntimeClock` sanitizes the sole platform delta ingestion; `derive_effective_gameplay_pause()` combines the authoritative explicit session source, visible mounted Layouts, platform suspension, and engine/runtime suspension before advancement. The same typed status gates gameplay runtime inputs. | `runtime_clock.*`, `gameplay_pause.*`, `engine.cpp`, `typed_runtime_session.cpp` | live runtime, UI/tweens, preview diagnostics, audio and shader/demo presentation | runtime-clock, gameplay-pause, typed-session, and save-state tests cover divergence, source independence, admission, and save exclusion | Engine clock service | `retain`; Phase 3A/3C complete, Phase 5 adds RmlUi context routing |
| Backend reset/project reload | `Engine::load_compiled_project()` terminates coordinated transient work, resets low-level realization, and replaces compiled runtime; `RuntimeUI::reload_documents_and_styles()` recreates all recorded documents in their lifecycle contexts with visibility/order/focus/listeners restored before authoritative rebinding | `engine.cpp`, `ui_runtime_rmlui.cpp`, `runtime_audio_adapter.cpp` | preview reload, project load | headless document migration/reload integration, editor freshness tests, sandbox/readback smoke; desired-audio device reconciliation remains Phase 7 | Presentation coordinator reconciles fresh backends from snapshot | `replace`; Phase 4/5 foundation, completed for remaining audio persistence in Phase 7 |

### Audio

| Concern / capability | Baseline authoritative owner | Implementation files and public types | Baseline consumers | Baseline tests or missing coverage | Final owner required by the plan | Disposition and exact phase |
| --- | --- | --- | --- | --- | --- | --- |
| Semantic channel state | `SessionState::m_audio_channels` has at most one `AudioChannelState` per semantic channel | `feature_state.hpp`, `session_state.cpp`, Scene executor and Lua audio API | Scene view and `audio.state()` | session/typed-session tests; save tests prove omission | Runtime/session desired looping audio only | `replace`; Phase 7 splits desired intent from transient operations |
| Generic `audio.play()` state mutation | `TypedRuntimeSession::script_request_audio()` overwrites the single channel record for every play/fade/stop, including voice and one-shots | `typed_runtime_session.cpp` | Lua audio queries and emitted operations | typed-session audio tests verify overwrite/query behavior but not safe persistence | Runtime desired loops and coordinator-owned transient playback are separate | `replace`; Phase 7 |
| Typed audio operation correlation | `TypedRuntimeSession` allocates `AudioOperationId`, keeps only one pending blocking operation, and emits nonblocking operations from a queue | `runtime_messages.hpp`, `typed_runtime_session.*` | `RuntimeUI` broker and `RuntimeAudioAdapter` | runtime-message/session/audio-adapter tests; no checkpoint classification/status test | Presentation coordinator operation lifecycle | `replace`; Phase 4 establishes lifecycle/status, Phase 7 finalizes audio classifications |
| Semantic channel to backend tracks | `RuntimeAudioAdapter` maps each play operation to a unique track ID and keeps a vector of active tracks per channel; stop/fade applies to all tracked instances | `runtime_audio_adapter.hpp/.cpp` | live engine through `RuntimeUI` audio sink | `runtime_audio_adapter_tests` explicitly prove overlapping play and channel-wide stop | Audio adapter/backend realization below coordinator | `reduce`; Phase 7 |
| Track and voice realization | `AudioSystem` owns decoded backend handles, multiple `ManagedVoice` values per track ID, fades, buses, pause, and cleanup | `audio_system.hpp/.cpp`, `audio_types.hpp`, `audio_backend.hpp`, miniaudio backend | runtime adapter, sandbox direct demo audio | audio-adapter tests use a fake backend; no device-reset reconciliation test | Audio backend | `retain`; Phase 7 adds desired-state reconciliation above it |
| Awaited audio completion | `RuntimeAudioAdapter` polls active tracks, emits exact `CompleteAudioInput`; `TypedRuntimeSession` resumes/cancels Flow or Lua | adapter/session/kernel files | engine update loop | adapter/session tests cover exact correlation and fade completion | Presentation coordinator reports barrier lifecycle; audio backend reports realization completion | `replace`; Phase 4 shared lifecycle, Phase 7 final audio barrier policy |

### Preview, editor, sandbox, and packaged player consumers

| Consumer | Baseline use of runtime/presentation/save contracts | Concrete files | Baseline tests or missing coverage | Required migration phase |
| --- | --- | --- | --- | --- |
| Engine/sandbox | Owns live orchestration, memory slots by default, RmlUi/audio sinks, demo/world rendering | `engine.hpp/.cpp`, `apps/sandbox/main.cpp` | Linux CTest sandbox package smoke, RmlUi/presentation GPU readbacks; no menu/save-thumbnail/end-to-end transition test | Phases 3–7 by subsystem; final cutover Phase 8 |
| Web sandbox and editor iframe | Calls exported preview functions and hosts typed external protocol; same engine internals | `engine/src/app.cpp`, `web/shell.html`, `web/widget.html`, sandbox CMake | Web build/smoke, editor protocol and preview hook/component tests | Phase 8 |
| `RuntimePreviewController` | Converts JSON boundary values to typed runtime inputs and encodes debug snapshots from `TypedRuntimeUIViewState`; save snapshot is empty | `runtime_preview_controller.*`, preview bridge | `editor_runtime_protocol_tests`, editor full-game preview/protocol tests; no checkpoint diagnostics/metadata test | Phase 8 |
| Editor full-game preview/playback | Consumes external debug snapshot, runtime controls, and generic boundary `saveSnapshot`; manages hidden/inert presentation separately | `editor/src/shared/preview-protocol.ts`, preview hooks/manager, `FullGamePreviewEditor.tsx` | protocol, full-game preview, persistent host, playback tests | Phase 8 |
| Editor entity thumbnail worker | Owns derived authoring-preview thumbnail cache only; it is not save-slot metadata | `editor/src/renderer/preview/preview-types.ts`, `preview-manager*.ts` | `preview-manager.test.ts` | Retain as separate editor feature; no checkpoint migration. Save thumbnails are new in Phase 7/8 |
| Packaged native/Web player | Creates filesystem slot store and passes it into the same `Engine`/compiled-runtime path | `apps/player/main.cpp`, player CMake/bootstrap/export code | `player_bootstrap_tests`, editor export/certification tests; no packaged-player save/menu integration test | Phase 8 |
| Editor tool / recorded playback | Decodes named external protocol messages to `RuntimeInputMessage`, encodes observations/reports | `editor_runtime_protocol.*`, `tools/editor_tool/`, editor playback services | protocol/core/editor playback suites | Phase 8 for new save/presentation diagnostics |

## Unsafe and ambiguous baseline behavior

These are verified implementation facts, not target-policy exceptions:

| Baseline behavior | Concrete evidence | Risk / ambiguity | Required resolution |
| --- | --- | --- | --- |
| Current save format omits presentation and audio blockers | `SaveState` intentionally represents only input/duration blockers, while `make_save_state()` now rejects active presentation/audio/script blockers with typed diagnostics. | The V2 format cannot represent causal progress. | Phase 2A prevents a new candidate from fabricating completion; Phase 2B adds settled transitional barrier status and Phase 7 adds final presentation/audio persistence. |
| Restore has no representation for presentation/audio blockers | `session_restore.cpp` restores only serializable blockers; no new V2 save can be projected while a causal presentation/audio blocker is active. | Older historical slot bytes may still encode a post-operation cursor. | Phase 2D load/reset cleanup replaces historical assumptions; new retained candidates are protected by Phase 2A projection rejection. |
| Presentation fields are cleared or definition-derived | Restore clears actors, background, Layouts, overlays, presented text, choices, transitions, audio channels, and Map; only Room background and overlay defaults are reconstructed for Room/Room-transition state. | Script-selected or Scene-owned target presentation is lost; deriving Room defaults cannot reproduce history-selected intent. | Phase 7 persists every reconstructible record identified below. |
| Callback-owned transitions exist as isolated scaffolding | `RuntimeTransitionRequest::on_midpoint` is `std::function<void()>`; no consumer exists; engine renders no transition. | Callback continuation is untyped and there is no current production realization. | Delete/replace in Phase 6 after Phase 4 coordinator contracts exist. |
| `AudioChannelState` conflates desired intent and transient playback | Every generic Scene/Lua play/stop mutates the one state record per semantic channel. | Voice/one-shots can overwrite would-be persistent looping intent. | Phase 7. |
| One semantic audio channel owns multiple backend tracks | `RuntimeAudioAdapter::m_active` is a vector; each operation gets a unique track ID; channel stop iterates all instances. `AudioSystem` also stores vectors of voices per track. | The logical state shape cannot describe actual playback instances, and a channel is not a voice identity. | Preserve overlap behavior while Phase 7 separates desired channel intent from transient instances. |
| Shell and gameplay Layout state are disconnected | Shell title/pause documents live in `RuntimeUI`; gameplay Layout slots live in `SessionState`; the unused manager holds another mount list. | No single mount stack or reconstruction policy exists. | Phase 3 establishes mounted policy; Phase 8 completes shell/gameplay workflows and removes obsolete paths. |
| Save metadata and thumbnails have no checkpoint owner | Save metadata is only project identity/version; screenshot requests and editor entity thumbnails are independent. | A future slot UI could display live/newer presentation unrelated to the saved state. | Phase 2 owns checkpoint metadata; Phase 7 binds thumbnails to checkpoint revision; Phase 8 displays them. |

## Baseline persistence and derivation inventory

`Encoded` means present in `SaveState` and its V2 codec. `Derived` means restore recreates it from
`CompiledProject`. `Cleared` means restore explicitly removes the live value. `Omitted` means it is
neither encoded nor reconstructed. This table describes the frozen baseline behavior only; the final
matrix is normative below.

| State family | Baseline runtime representation | Baseline save/restore behavior | Baseline coverage | Required final treatment and owning phase |
| --- | --- | --- | --- | --- |
| Variables | `SessionState::m_variables` | Encoded for every declared variable; validated and restored | save/session tests | Retain authoritative save state; Phase 2 generation tracking |
| Property overrides | `m_property_overrides` | Only `PropertyPersistence::Save` overrides encoded; Session-policy values omitted; restored on actual owner | save/property tests | Retain; Phase 2 structural generation tracking |
| Interactables | `m_interactables` with typed location/enabled/visible | Entire vector encoded and restored | save/session/interaction tests | Retain; Phase 2 structural generation tracking |
| Visits, dialogue history, show-once effects | room/line/choice history containers and Flow positions | Encoded and restored; show-once behavior derives from history/cursors | save and feature execution tests | Retain; Phase 2 |
| Text log | `m_text_log` | Encoded and restored | save/session/Lua/UI component tests | Retain; Phase 2 |
| Random state | `m_random_state` | Encoded and restored exactly | save/Lua tests | Retain; Phase 2 |
| Flow mode and stack | `m_mode`, `m_flow_stack` | Encoded as snapshot-local frame IDs and typed positions; fresh live IDs allocated on restore | flow/save tests | Retain; Phase 2 readiness/generation ownership |
| Input blocker | `InputFlowBlocker` | Encoded with snapshot owner; fresh handle on restore | save/flow tests | Retain as stable checkpointable boundary; Phase 2 |
| Duration blocker | `DurationFlowBlocker` | Remaining milliseconds encoded; fresh handle on restore | save/flow tests | Retain typed remaining duration; Phase 2 |
| Presentation blocker | `PresentationFlowBlocker` | Omitted; restore has no blocker while cursor remains post-instruction | save test explicitly asserts omission | Never serialize progress; prevent replacement and use retained checkpoint in Phase 2; final status Phase 4 |
| Audio blocker | `AudioFlowBlocker` | Omitted with the same fabricated post-operation result | save test explicitly asserts omission | Same as presentation blocker; Phase 2 transitional status, Phase 7 final audio policy |
| Lua/script blocker and coroutine | `ScriptFlowBlocker`, `ScriptRuntime` coroutine | Save rejected; coroutine never encoded | save/script tests | Retain as runtime readiness barrier; Phase 2 |
| Deferred commands and genuine external requests | Deferred commands are session-owned and drained before settlement; no current production external request variant exists | Commands are never serialized and must be empty at checkpoint settlement; future genuine external requests require a separate typed lifecycle | Runtime/session tests cover settled queues, cancellation, bounded self-enqueue, and stale ownership | Block replacement until runtime queues settle; add external-request barriers only when concrete external authority exists |
| Actors, pose/expression/placement/visibility | `m_actors` | Omitted and explicitly cleared | session/Scene tests; no persistence test beyond clear behavior | Persist reconstructible target actor state, discard interpolation phase; Phase 7 |
| Background | `m_background` | Omitted and cleared; derived only from active Room definition or committed side of Room transition | save restore Room test | Persist non-derivable Scene/script-selected target; derive only proven Room defaults; final rule Phase 1B, implementation Phase 7 |
| Gameplay Layout slots | `m_layouts` | Omitted and cleared | state/Lua tests; no save restoration coverage | Persist reconstructible gameplay mounts with typed instance policy; Phase 7 after Phase 3 policy |
| Room overlays | `m_overlays` | Omitted and cleared; active Room definition defaults are re-added | save restore Room test | Persist runtime visibility/selection where mutable; derive immutable Layout definition; Phase 7 |
| Presented text | `m_presented_text` | Omitted and cleared | save tests indirectly; ActiveText/executor tests separate | Persist stable logical page/input state needed for reconstruction; discard reveal/fade realization; Phase 5 contract integration and Phase 7 save extension |
| Active choices | `m_active_choice` | Omitted and cleared even though Flow/input cursor may restore | choice/Flow tests; no save test proving coherent choice reconstruction | Persist or deterministically derive exact stable choice view under Phase 1B rule; implement Phase 7 |
| Map presentation | `m_map_presentation` | Omitted and cleared | save test asserts no Map after Room restore; Lua/Map tests cover live state | Persist map ID/mode/visibility/focus as reconstructible intent; Phase 7 |
| Logical transition target | `m_transition` | Omitted and cleared | typed session/kernel tests; no live rendering test | Desired target plus causal operation relationship; no progress; Phase 4/6, persistence policy Phase 7 |
| Desired audio | `m_audio_channels` currently ambiguous | Omitted and cleared | live audio tests only | Persist only desired looping music/ambience after split; Phase 7 |
| Shell/menu stack | direct RmlUi documents; no authoritative stack | Omitted; project reload recreates title only when requested | title asset/editor preview tests; pause stack missing | Intentionally transient shell state; Phase 8 |
| Gameplay pause | `m_gameplay_paused` | Omitted; explicitly reset false | save/Lua pause tests | Intentionally session-only; pause derivation replaced in Phase 3 |
| Play time | `m_play_time` | Encoded/restored | save/timer tests | Retain; time-only generation/coalescing Phase 2 |
| Logical timers and pending completions | timer vectors with live IDs | Encoded using snapshot IDs/remaining durations; fresh IDs allocated on restore | save/timer tests | Retain; time-only vs structural rules Phase 2 |
| Engine/RmlUi/audio absolute clocks | integer `core::RuntimeClock` domain times plus transitional SDL/RmlUi and backend realization time | Omitted; restarted with engine/subsystem lifetime | Phase 3A core clock tests; cross-context restore remains deferred | Backend-only; engine domains implemented in Phase 3A, RmlUi integration Phase 5 |
| ActiveText reveal/fade/prompt phase | `RuntimeUI::State` playback/tween fields | Omitted; recreated from new bound view/document | ActiveText/tween unit tests only | Causal until stable input; never serialize progress; Phase 5 |
| Tween objects and callbacks | `TweenService::Entry`, Twink objects | Omitted/reset on project load/shutdown | tween unit tests | Backend/coordinator transient only; Phase 5/6 |
| RmlUi documents, focus, CSS animation, render state | `RuntimeUI::State` / `Rml::Context` | Omitted; path-backed and memory-backed documents recreate in recorded lifecycle contexts with visibility/order/focus/listeners restored, while CSS animation progress restarts from the selected domain time | lifecycle/reload integration and GPU/readback tests | Backend-only; reconstruct from snapshot/mounts, Phase 5 |
| Renderer/GPU resources and captures | `Renderer` and bgfx adapters | Omitted; resources recreated by renderer lifecycle | render/readback tests | Backend-only; Phase 4/6 reconciliation |
| Audio voices/decoders/sample/fade progress | `AudioSystem`, `AudioBackend`, adapter active/pending lists | Omitted and adapter reset on project load | fake-backend adapter tests; no device reset test | Backend-only; desired loops reconstructed without phase, Phase 7 |
| Slot metadata | save format/project ID/version plus runtime `SaveOutcome` | Encoded inside save document; no separate listing/index metadata | save/message/protocol tests | Checkpoint-owned typed metadata, Phase 2/7 |
| Save thumbnail | none | Omitted | explicit missing coverage | Checkpoint-owned capture, Phase 7; displayed Phase 8 |

## Final ownership matrix

This matrix is normative. Each concern has exactly one authoritative owner from the ownership set
fixed by the implementation plan. A consumer may cache or realize an owner's output, but that cache
is never another source of truth.

| Concern | Exactly one authoritative owner | Normative boundary and owning implementation phase |
| --- | --- | --- |
| Authored resources, presentation definitions, system Layout roles, and definition references | Immutable `CompiledProject` definitions | Existing compiled model remains authoritative; later phases may add only validated typed definitions. |
| Variables, saved properties, Interactables, histories, Flow state, logical timers, and gameplay pause inputs | Runtime/session state | Existing runtime ownership retained; Phase 2 adds checkpoint generations without moving gameplay state. |
| Durable logical backgrounds, actors, gameplay Layout mounts, Room overlays/loops, stable text/choice/Map state, and desired looping audio | Runtime/session state | Phase 7 completes reconstructible records; no backend progress or handle enters runtime state. |
| Runtime input/output queues, deferred commands, ordered events, Lua/Flow execution, and exact completion consumption | Runtime/session state | Internal commands drain inside runtime; only presentation/audio operations retain exact completion acknowledgement. |
| Checkpoint eligibility, readiness diagnostics, generations, capture, retained bytes/metadata, save-command semantics, and slot writes | Runtime checkpoint/save service | Shared contracts in Phase 1C; service behavior in Phase 2; metadata/thumbnail extensions in Phase 7. |
| Projection of immutable definitions plus mutable runtime intent into an idempotent presentation snapshot | `PresentationProjector` and `RuntimePresentationSnapshotPublisher` in `core/runtime_presentation.*` | Phase 4A complete. The projector is read-only, resolves typed identities without I/O, and never owns gameplay or save state; Phase 4B adds coordinator lifecycle. |
| Presentation/audio operation acceptance, global ordering, lifecycle, causal-barrier publication, reconciliation, and typed completion/failure reporting | Presentation projector/coordinator | Phase 4, with transition realization in Phase 6 and audio classification/realization integration in Phase 7. |
| Mounted-instance composition policy and presentation-domain clock routing | Presentation projector/coordinator | Policy contract in Phase 1C and orchestration in Phase 3. RmlUi consumes the selected policy and clock. |
| RML documents, contexts, focus, CSS animation, ActiveText realization, and RmlUi draw submission | RmlUi/Layout presentation | Phase 5. These are disposable/recreated realization state. |
| World/actor/background draw realization, view allocation, GPU resources, render targets, and screenshots | Renderer backend | Phases 4 and 6. A screenshot supplied for a checkpoint does not transfer checkpoint metadata ownership. |
| Decoders, voices, sample/fade progress, buses, device state, and backend track instances | Audio backend | Phase 7. Backend instances may overlap and are never semantic-channel state. |
| Title/pause/settings/load/save/confirmation stack and its transient mounted instances | Shell/menu state | Phase 8. Project load resets this stack; it is never checkpoint data. |
| Save-thumbnail association and selection | Runtime checkpoint/save service | Phase 7 binds an artifact to one checkpoint revision; renderer only produces requested pixels and shell only displays them. |
| External preview/player representation of readiness, metadata, and operation diagnostics | Runtime/session state | Phase 8 adapters serialize typed runtime observations at the external protocol boundary; editor/player code is not authoritative. |

## Final state-versus-operation matrix

`State` is idempotent desired intent. `Operation` is ordered transient work with a session-local
identity and lifecycle. `Realization only` is backend state that is neither runtime state nor a
semantic operation. The classifications below are exact for the first implementation.

| Concern | Durable/reconstructible state | Ordered operation or realization | Checkpoint rule and final owner |
| --- | --- | --- | --- |
| Background | Current target definition/reference and target visibility | Cut, dissolve, or finite interpolation is an operation; draw resources are realization only | Target is `Reconstructible`; causal transition blocks while active, disposable interpolation does not. Runtime owns target; coordinator owns operation. |
| Actor pose/expression/placement/visibility | One target record per stable actor instance | Entrance, exit, move, pose blend, and finite animation are operations; interpolation phase is realization only | Target is `Reconstructible`; optional interpolation progress is discarded. Awaited/cue-bearing work is `CausalBarrier`; proven cosmetic interpolation is `Disposable`. |
| Actor/Room/environment loop | Selected loop definition, stable owner/instance, and typed parameters | Fresh loop playback and exact loop phase are realization only | State is `Reconstructible` and restarts from phase zero. A loop with gameplay/script/external cues is not eligible for this state contract. |
| Gameplay Layout slot or custom gameplay mount | Layout ID, stable mounted-instance ID, owner, visibility, and immutable mount policy | Entrance/exit operation IDs are transient; RML document/context state is realization only | Mount state is `Reconstructible`; operation classification follows its typed invocation. Runtime owns desired mount; coordinator owns lifecycle. |
| Shell Layout mount | No gameplay/save state | Mount stack is transient shell state; RML state is realization only | Never encoded. Shell owns it and resets it on project load. |
| Room overlay | Selected overlay/definition reference, stable owner, visibility, and mount policy | Entrance/exit or cosmetic animation is an operation/realization | Mutable selection/visibility is `Reconstructible`; immutable defaults may be derived only from the exact active Room definition. |
| ActiveText content and page/input state | Resolved logical content identity, current page, stable fully-presented/input-wait state, and prompt eligibility inputs | Reveal/fade before the stable wait is one causal operation; glyph alpha, prompt pulse, and tween phase are realization only | Reveal/fade is `CausalBarrier`; the stable input state is reconstructible. Prompt visibility is derived from stable text/input state, never independently saved. |
| Choice presentation | Exact choice kind, owner, stable option IDs/order, enabled/visible state, and current selection if logically meaningful | Hover/focus/local selection animation is realization only | Stable choice view is `Reconstructible`; cosmetic UI state is `Disposable`. Runtime owns the choice. |
| Map presentation | Map ID, mode, visibility, focus/selection when logically meaningful, and referenced Layout/background intent | Pan/zoom interpolation and hover effects are realization only unless an authored completion depends on them | Logical Map view is `Reconstructible`; disposable interpolation phase is discarded. |
| Notification | No retained state in V1 | Each gameplay notification is a typed presentation operation; shell/tool notifications remain external communication | Gameplay notification is `CausalBarrier` by default; a separate UI-only API may create `Disposable` notifications. No notification is reconstructed in V1. |
| Transition | Committed target background/Room/scene state only | Transition timeline is an operation with exact lifecycle and optional commit point | Commit-bearing or awaited transition is `CausalBarrier`; progress is never encoded. A separately typed noncausal transition may be `Disposable`. |
| One-shot visual effect | Target state only when the effect changes a durable target | One typed effect operation plus backend realization | `CausalBarrier` by default; only a typed effect contract forbidding semantic cues/completion work may be `Disposable`. Never reconstructed in V1. |
| Desired music/ambience | At most one desired looping record for each semantic `Music` or `Ambient` channel | Starting/reconciling fresh backend instances is realization; an explicit fade/replace is an operation | Desired intent is `Reconstructible`; exact sample/fade phase is discarded. Runtime owns intent; coordinator/audio backend realize it. |
| Voice | No desired retained record | Every play is a distinct overlapping operation/backend instance | Always `CausalBarrier` in V1, awaited or not; no progress or voice is encoded. |
| Gameplay sound effect | No desired retained record | Every play is a distinct overlapping operation/backend instance | `CausalBarrier` by default. Only a separate typed UI-only/disposable API may omit it safely. |
| Audio stop/fade | Resulting desired loop state changes immediately when the command targets desired music/ambience | Stop/fade is an operation over an exact typed scope of active instances | Awaited stop/fade is `CausalBarrier`; non-awaited gameplay stop/fade remains a barrier by default. Backend instances and fade progress are omitted. |
| Backend playback tracks | None | Multiple backend tracks may exist for one semantic channel | Realization only. A semantic channel is never a track identity. |

## Final persistence and derivation matrix

The retained checkpoint encodes authoritative runtime records, never presentation/backend progress.
`Discard progress` means the exact phase is intentionally omitted and recreated at phase zero or
snapped to the retained target. These rules supersede the current-behavior matrix above.

| Item | Authoritative runtime representation | Encoded in retained checkpoint | Exact load reconstruction source | Discard exact progress/phase | Class or runtime rule | Owning implementation phase |
| --- | --- | --- | --- | --- | --- | --- |
| Variables | Declared variable values in `SessionState` | Yes | Encoded value validated against `CompiledProject` declaration | No | Authoritative save state | Phase 2 retains; existing codec |
| Property overrides | Save-policy overrides in `SessionState` | Yes | Encoded owner/property/value validated against definitions | No | Authoritative save state | Phase 2 retains; existing codec |
| Interactables | Typed location/enabled/visible records | Yes | Encoded records validated against definitions | No | Authoritative save state | Phase 2 retains; existing codec |
| Histories and text log | Typed visit/dialogue/log records | Yes | Encoded records | No | Authoritative save state | Phase 2 retains; existing codec |
| Random state | Runtime random-state value | Yes | Encoded value | No | Authoritative save state | Phase 2 retains; existing codec |
| Flow mode/stack | Typed Flow frames and positions | Yes | Encoded frames remapped to fresh live frame IDs | No | Serializable runtime execution | Phase 2 retains; existing codec |
| Stable input blocker | Typed owner and input wait | Yes | Encoded saved owner remapped to live frame/blocker handle | No | Stable checkpoint boundary | Phase 2 retains; existing codec |
| Duration blocker | Typed owner and remaining duration | Yes | Encoded remaining duration and remapped owner | No | Serializable runtime wait | Phase 2 retains; existing codec |
| Presentation/audio causal blocker | Runtime blocker plus coordinator barrier identity while live | No | Never reconstructed; load starts from the older retained checkpoint captured before acceptance | Yes | `CausalBarrier` | Phase 2 policy; Phase 4/7 status |
| Immediate/suspended Lua | Typed invocation/coroutine owned by runtime | No | Never reconstructed; load uses older retained checkpoint | Yes | Runtime barrier | Phase 2 |
| Deferred commands, future external requests, and unsettled typed queues | Internal command entries have no host IDs; no production external request variant currently exists | No | Never reconstructed; capture waits until transaction and queues settle | Yes | Runtime barrier | Runtime execution Phase 2 |
| Play time | `SessionState` duration | Yes | Encoded duration | No | Time-only generation | Phase 2 |
| Logical timers/completions | Typed timer state with remaining durations | Yes | Encoded records with fresh live IDs | No | Time-only or structural mutation according to timer operation | Phase 2 |
| Actors | Stable actor instance plus target pose/expression/placement/visibility | Yes | Encoded target records validated against character/assets/definitions | Yes, interpolation/clip phase | `Reconstructible` | Phase 7 |
| Background | Current logical target reference/value | Yes unless it is exactly an immutable active-Room default selected without override | Encoded target when mutable/non-derivable; otherwise exact active Room definition | Yes, transition/interpolation phase | `Reconstructible` | Phase 7 |
| Gameplay Layout mounts | Stable mounted-instance ID, Layout ID, owner, visibility, immutable policy | Yes | Encoded mount records plus immutable `LayoutResource` definitions | Yes, RML/entrance/exit phase | `Reconstructible` | Phase 3 policy; Phase 7 persistence |
| Shell/menu Layouts | Shell stack | No | Reset to shell/project-load entry state | Yes | Transient shell rule | Phase 8 |
| Room overlays and selected Room/actor/environment loops | Stable selected definition/instance/owner/parameters/visibility | Yes when mutable or history-selected; exact immutable defaults may be derived | Encoded selection or exact active Room definition | Yes, loop/animation phase | `Reconstructible` | Phase 7 |
| ActiveText | Logical content identity, page, and stable input/prompt inputs | Yes only at the fully presented stable input boundary | Encoded stable text/page state plus compiled text definition/resolution inputs | Yes, reveal/fade/prompt animation phase | Stable state reconstructible; reveal/fade `CausalBarrier` | Phase 5 boundary; Phase 7 persistence |
| Choices | Exact typed choice view and logical selection | Yes at a stable input boundary | Encoded stable choice state plus immutable option definitions | Yes, hover/focus phase | `Reconstructible` | Phase 7 |
| Map | Typed map ID/mode/visibility/focus/selection intent | Yes | Encoded intent plus immutable Map/Layout definitions | Yes, pan/zoom/UI phase | `Reconstructible` | Phase 7 |
| Notification | No retained V1 record | No | Not reconstructed | Yes | Gameplay notification `CausalBarrier`; UI-only notification `Disposable` | Phase 4 classification |
| Transition | Committed target resides in its owning logical state | No separate timeline/progress record | Target state from checkpoint; no active transition | Yes | `CausalBarrier` or separately typed `Disposable` | Phase 6; target persistence Phase 7 |
| One-shot effect | No retained V1 operation record | No | Not reconstructed; retained target state still applies | Yes | `CausalBarrier` by default or separately typed `Disposable` | Phase 6 |
| Desired looping music/ambience | One optional desired-loop record per semantic loop channel | Yes | Encoded asset/loop/volume/typed parameters; coordinator creates fresh voices | Yes, sample/fade phase | `Reconstructible` | Phase 7 |
| Voice/gameplay SFX | No desired retained record; live typed operations only | No | Not reconstructed; load uses older retained checkpoint when active | Yes | `CausalBarrier` in V1/default | Phase 7 |
| UI-only audio | Presentation-only typed operation | No | Not reconstructed | Yes | `Disposable` | Phase 7 |
| Gameplay pause | Derived from engine/platform state and visible mounted policies | No | Recomputed after shell/gameplay mounts are reconstructed | Yes | Derived runtime rule | Phase 3 |
| Structural/time generation state | Runtime checkpoint service counters | No; it describes the live capture process, not gameplay | Reset so all restored state matches the loaded retained revision and subsequent mutations advance from that baseline | No meaningful backend phase | Runtime checkpoint rule | Phase 2 |
| Retained checkpoint revision/bytes/metadata | Runtime checkpoint service immutable record | Stored as the slot payload/sidecar representation owned by the service, not recursively inside `SaveState` | Loaded slot bytes are decoded into runtime state; service then establishes a fresh retained record for that loaded state | No | Runtime checkpoint rule | Phase 2; metadata extended Phase 7 |
| Slot metadata | Typed checkpoint metadata owned with retained bytes | Core save metadata/play time are in the encoded save; session-local revision/generations are not persisted | Decode the same committed save bytes and establish a fresh loaded checkpoint revision/generation baseline | No | Runtime checkpoint rule | Phase 2; persistent thumbnail association Phase 7 |
| Save thumbnail | Artifact associated with one checkpoint revision | Yes when Phase 7 capture is available; absence remains typed | Loaded only with matching slot/checkpoint revision | Rendering frame phase is irrelevant | Checkpoint-owned derived artifact | Phase 7; displayed Phase 8 |
| RmlUi documents, contexts, focus, CSS state, ActiveText tweens | RmlUi/Layout presentation realization | No | Rebuilt from snapshot and mount policies | Yes | Backend-only / `Disposable` | Phase 5 |
| Renderer resources, render targets, screenshots, GPU state | Renderer realization | No | Rebuilt from immutable assets and snapshot | Yes | Backend-only | Phases 4/6 |
| Audio decoders, voices, tracks, buses, sample/fade state | Audio backend realization | No | Fresh realization from desired loops and future operations | Yes | Backend-only | Phase 7 |

## Frozen Phase 1 shared contract specification

Phase 1C must implement exactly the declarations and invariants in this section. It must not add
feature payloads for the projector, transitions, animation/effects, or audio migration. Those remain
Phases 4, 6, and 7 respectively.

### Canonical headers and dependency direction

| Canonical header | Namespace | Sole contents/ownership |
| --- | --- | --- |
| `engine/include/noveltea/core/session_operation_id.hpp` | `noveltea::core` | Existing session-local operation-ID template, shared `SessionSequence<Tag>` template, operation tags/aliases, and `AudioCompletionHandle`. Existing declarations move unchanged in meaning from `runtime_messages.hpp`. Runtime/session allocates operation IDs. |
| `engine/include/noveltea/core/presentation_contracts.hpp` | `noveltea::core` | Presentation revision/sequence/instance identities, checkpoint class, Layout policy vocabulary, operation owner/completion/lifecycle infrastructure. Presentation coordinator owns lifecycle and mounted policy realization; runtime owns completion targets. |
| `engine/include/noveltea/core/checkpoint_contracts.hpp` | `noveltea::core` | Barrier/status/readiness vocabulary, generation state, immutable retained checkpoint representation, and save request/outcome variants. Runtime checkpoint/save service owns these values; presentation only publishes `PresentationCheckpointStatus`. |

`runtime_messages.hpp` includes these headers and does not redeclare their types. The headers may
include typed core domain headers but never SDL, bgfx, RmlUi, miniaudio/audio-backend, callback, Lua,
JSON, editor, or platform types.

Phase 1C implementation evidence (2026-07-14): the three headers above now exist at their canonical
paths, and `runtime_messages.hpp` includes them instead of redeclaring session operation identities.
`tests/core/presentation_checkpoint_contracts_tests.cpp`, included in `noveltea_core_tests`, verifies
the strong domain types, exact closed variant sizes and exhaustive handling, independent Layout
policy dimensions, distinct checkpoint/save domains, and backend-neutral retained value shape. The
focused contract/runtime-message tests, Linux build and full CTest suite, C++/dependency/JSON policy
targets, and Web build all passed. This slice added no service or backend behavior assigned to later
phases.

### Strong numeric identity rules

`SessionOperationId<Tag>` retains its current deleted default constructor,
`from_number(std::uint64_t)`, `number()`, and comparison. Its canonical aliases remain exactly:

```cpp
struct PresentationOperationTag;
struct AudioOperationTag;
using PresentationOperationId = SessionOperationId<PresentationOperationTag>;
using AudioOperationId = SessionOperationId<AudioOperationTag>;
using AudioCompletionHandle =
    std::variant<AudioFlowBlockerHandle, ScriptInvocationHandle>;
```

New numeric identities use `SessionSequence<Tag>` from `session_operation_id.hpp`. It has a deleted
default constructor, `from_number(std::uint64_t)`, `number()`, and comparison, with one private
`std::uint64_t m_value`. The aliases have these sole canonical locations:

```cpp
// presentation_contracts.hpp
struct PresentationSnapshotRevisionTag;
struct PresentationOperationSequenceTag;
struct MountedLayoutInstanceTag;
using PresentationSnapshotRevision = SessionSequence<PresentationSnapshotRevisionTag>;
using PresentationOperationSequence = SessionSequence<PresentationOperationSequenceTag>;
using MountedLayoutInstanceId = SessionSequence<MountedLayoutInstanceTag>;

// checkpoint_contracts.hpp
struct CheckpointBarrierTag;
struct CheckpointStatusRevisionTag;
struct CheckpointReadinessRevisionTag;
struct SaveCheckpointRevisionTag;
using CheckpointBarrierId = SessionSequence<CheckpointBarrierTag>;
using CheckpointStatusRevision = SessionSequence<CheckpointStatusRevisionTag>;
using CheckpointReadinessRevision = SessionSequence<CheckpointReadinessRevisionTag>;
using SaveCheckpointRevision = SessionSequence<SaveCheckpointRevisionTag>;
```

For every operation ID and sequence alias, zero is invalid/reserved, allocation starts at one, values
increase monotonically within one runtime session/owning service, exhaustion returns typed
diagnostics, and allocation never wraps. Values are comparable only within the same alias. Operation,
barrier, snapshot, and status identities are not serialized into `SaveState`. A mounted gameplay
Layout instance ID is serialized only as part of its reconstructible mount record; a restored service
advances its allocator beyond every restored mounted ID.

`PresentationSnapshotRevision` starts at one for the initial complete snapshot and increments once
for each atomic desired-snapshot change; backend realization and lifecycle-only changes do not
increment it. `PresentationOperationSequence` starts at one and increments once for every accepted
presentation or audio operation, providing their single total acceptance order.
`MountedLayoutInstanceId` starts at one for each runtime session and is never reused within that
session. `SaveCheckpointRevision` starts at one for the first successfully published retained
checkpoint and increments only on successful atomic replacement, never on a slot write of an
existing checkpoint. Barrier and status revision rules are fixed in the status section below.

### Presentation, Layout, and lifecycle declarations

The closed policy vocabulary is:

```cpp
enum class CheckpointClass : std::uint8_t {
    Reconstructible,
    CausalBarrier,
    Disposable,
};

enum class PresentationPlane : std::uint8_t {
    WorldBackground,
    WorldContent,
    WorldOverlay,
    GameUi,
    MenuOverlay,
    Modal,
    Transition,
    Debug,
};
enum class LayoutClockDomain : std::uint8_t { Gameplay, UnscaledPresentation };
enum class LayoutInputMode : std::uint8_t { None, Normal, BlockGameplay, Modal };
enum class GameplayPausePolicy : std::uint8_t { Continue, PauseWhileVisible };
enum class LayoutVisibility : std::uint8_t { Hidden, Visible };
enum class EscapeDismissalPolicy : std::uint8_t { Ignore, Dismiss };
enum class MountedLayoutOwner : std::uint8_t { Gameplay, Shell };

struct MountedLayoutPolicy {
    PresentationPlane plane;
    std::int32_t local_order = 0;
    LayoutClockDomain clock;
    LayoutInputMode input;
    GameplayPausePolicy gameplay_pause;
    LayoutVisibility visibility;
    EscapeDismissalPolicy escape_dismissal;
    std::optional<PresentationOperationId> entrance_operation;
    std::optional<PresentationOperationId> exit_operation;
    auto operator<=>(const MountedLayoutPolicy&) const = default;
};

struct MountedLayoutInstance {
    MountedLayoutInstanceId instance;
    LayoutId layout;
    MountedLayoutOwner owner;
    MountedLayoutPolicy policy;
    bool operator==(const MountedLayoutInstance&) const = default;
};
```

`MountedLayoutPolicy` is immutable after coordinator acceptance. Showing/hiding or changing any
policy dimension publishes a replacement mounted instance with the same `instance` and a new
snapshot revision; it does not mutate an adapter-local flag. Entrance/exit IDs are reserved typed
operation identities whose payloads remain in later-phase operation variants. They may be absent.
`local_order` is meaningful only within `plane`; cross-plane numeric ordering is invalid. A gameplay
mount is reconstructible; a shell mount is transient even though both use the same policy shape.

The operation-lifecycle infrastructure is exactly:

```cpp
using PresentationOperationRef =
    std::variant<PresentationOperationId, AudioOperationId>;

enum class PresentationOperationOwner : std::uint8_t {
    GameplayRuntime,
    Shell,
};

struct NoPresentationCompletion {
    auto operator<=>(const NoPresentationCompletion&) const = default;
};
struct PresentationFlowCompletion {
    FlowFrameId owner;
    PresentationFlowBlockerHandle blocker;
    auto operator<=>(const PresentationFlowCompletion&) const = default;
};
struct AudioFlowCompletion {
    FlowFrameId owner;
    AudioFlowBlockerHandle blocker;
    auto operator<=>(const AudioFlowCompletion&) const = default;
};
struct ScriptAudioCompletion {
    FlowFrameId owner;
    ScriptInvocationHandle invocation;
    auto operator<=>(const ScriptAudioCompletion&) const = default;
};
using PresentationCompletionTarget =
    std::variant<NoPresentationCompletion, PresentationFlowCompletion,
                 AudioFlowCompletion, ScriptAudioCompletion>;

struct PresentationOperationMetadata {
    PresentationOperationRef operation;
    PresentationOperationSequence sequence;
    PresentationOperationOwner owner;
    CheckpointClass checkpoint_class;
    PresentationCompletionTarget completion;
    bool operator==(const PresentationOperationMetadata&) const = default;
};

struct PresentationOperationAccepted {};
struct PresentationOperationRunning {};
struct PresentationOperationCompleted {};

enum class PresentationCancellationReason : std::uint8_t {
    ExplicitRequest,
    OwnerEnded,
    FastForward,
    RuntimeReset,
    ProjectReload,
    CheckpointLoad,
};
struct PresentationOperationCancelled {
    PresentationCancellationReason reason;
};
struct PresentationOperationReplaced {
    PresentationOperationRef replacement;
};
enum class PresentationFailureDomain : std::uint8_t {
    WorldPresentation,
    LayoutPresentation,
    AudioPresentation,
};
struct PresentationOperationFailed {
    PresentationFailureDomain domain;
    Diagnostic diagnostic;
};
using PresentationOperationState =
    std::variant<PresentationOperationAccepted, PresentationOperationRunning,
                 PresentationOperationCompleted, PresentationOperationCancelled,
                 PresentationOperationReplaced, PresentationOperationFailed>;

struct PresentationOperationLifecycle {
    PresentationOperationMetadata metadata;
    PresentationOperationState state;
    bool operator==(const PresentationOperationLifecycle&) const = default;
};
```

Empty lifecycle alternatives receive default comparisons in implementation. `Accepted` is committed
synchronously when the coordinator accepts the operation. For `CausalBarrier`, barrier registration
is part of that same commit. `Running` is optional realization progress and cannot register a late
barrier. `Completed`, `Cancelled`, `Replaced`, and `Failed` are terminal and remove the exact matching
barrier in the same status revision. `Replaced` names one already accepted replacement operation.
Only a non-`NoPresentationCompletion` target may resume/cancel runtime execution, and runtime must
match every ID and handle before consuming it. A realization failure carries a backend-neutral
presentation domain and core `Diagnostic`, never a renderer, RmlUi, audio-backend object, or callback.

### Checkpoint status and readiness declarations

```cpp
enum class RuntimeQueueKind : std::uint8_t {
    Input,
    Output,
    ScriptInput,
    DeferredCommand,
    PresentationAcknowledgement,
};

struct RuntimeTransactionBarrierSource {};
struct RuntimeQueueBarrierSource { RuntimeQueueKind queue; };
struct FlowCheckpointBarrierSource {
    FlowFrameId owner;
    FlowBlockerKind blocker;
};
struct ScriptCheckpointBarrierSource { ScriptInvocationHandle invocation; };
struct PresentationCheckpointBarrierSource { PresentationOperationRef operation; };
using CheckpointBarrierSource =
    std::variant<RuntimeTransactionBarrierSource, RuntimeQueueBarrierSource,
                 FlowCheckpointBarrierSource, ScriptCheckpointBarrierSource,
                 PresentationCheckpointBarrierSource>;

enum class CheckpointBarrierKind : std::uint8_t {
    RuntimeTransaction,
    UnsettledQueue,
    UnserializableFlow,
    ImmediateScriptInvocation,
    SuspendedScriptInvocation,
    PresentationCausalOperation,
    InvalidReconstructibleState,
};

struct CheckpointBarrier {
    CheckpointBarrierId id;
    CheckpointBarrierSource source;
    CheckpointBarrierKind kind;
    bool operator==(const CheckpointBarrier&) const = default;
};
struct PresentationCheckpointStatus {
    CheckpointStatusRevision revision;
    std::vector<CheckpointBarrier> active_barriers;
    bool operator==(const PresentationCheckpointStatus&) const = default;
};
```

`PresentationCheckpointStatus` contains only presentation-sourced causal barriers and is published
synchronously as an immutable value sorted by source alternative and `CheckpointBarrierId`.
Membership in `active_barriers` is the sole barrier-status representation: present means active;
absent means resolved. There is deliberately no second boolean or free-form status field. `revision` starts at one
and increments exactly once for each atomic accepted/terminal barrier-set change; disposable and
reconstructible realization does not change it.

Phase 4B implements this headless ownership in
`engine/include/noveltea/core/presentation_coordinator.hpp` and
`engine/src/core/presentation_coordinator.cpp`. `PresentationCoordinator` owns accepted operation
metadata, total sequencing, lifecycle, barrier membership, snapshot reconciliation, and retry-safe
delivery through separate snapshot and operation backend ports. The live runtime continues to use
the transitional broker until Phase 4C; this slice does not perform the engine/runtime cutover.

Phase 4C completes the live cutover through
`engine/include/noveltea/runtime_presentation_bridge.hpp` and
`engine/src/runtime_presentation_bridge.cpp`. `Engine` owns this bridge and its coordinator;
`RuntimeUI` forwards typed operation batches to it but does not own lifecycle or barriers.
`TypedRuntimeSession` now provides only operation identity and exact completion-handle validation and
reads the coordinator's immutable checkpoint status during settlement. Reset/load/reload terminate
the old coordinator session before backend reset and fresh snapshot reconciliation.

The runtime combines that view with its own barriers into:

```cpp
enum class CheckpointReadinessReason : std::uint8_t {
    RuntimeTransactionActive,
    RuntimeQueueUnsettled,
    FlowStateNotSerializable,
    ImmediateScriptInvocationActive,
    SuspendedScriptInvocationActive,
    PresentationBarrierActive,
    ReconstructibleStateInvalid,
    SaveProjectionFailed,
    SaveValidationFailed,
    SaveEncodingFailed,
};

struct CheckpointReadinessIssue {
    CheckpointReadinessReason reason;
    std::optional<CheckpointBarrier> barrier;
    Diagnostic diagnostic;
    bool operator==(const CheckpointReadinessIssue&) const = default;
};
struct CheckpointReadinessStatus {
    CheckpointReadinessRevision revision;
    std::vector<CheckpointReadinessIssue> issues;
    [[nodiscard]] bool can_capture() const noexcept { return issues.empty(); }
    bool operator==(const CheckpointReadinessStatus&) const = default;
};
```

Barrier IDs increase within their source owner; the globally exact barrier identity is the pair of
closed `source` value and `id`, so independently allocated runtime and presentation IDs cannot be
confused. Presentation status is ordered by source alternative and then barrier ID. Readiness issues
are ordered first by `reason` declaration order and then by the same composite barrier identity;
non-barrier capture failures have no barrier. `Diagnostic.code` and `Diagnostic.message` supply
human-readable context at the typed diagnostic boundary; callers never infer policy from those
strings. `revision` advances once after an event-driven runtime transaction settles and the ordered
issue set changes. A status with no issues is the only capture-eligible state.

### Generations, retained bytes, and save commands

```cpp
struct CheckpointGenerationState {
    std::uint64_t structural_generation = 0;
    std::uint64_t captured_structural_generation = 0;
    std::uint64_t time_generation = 0;
    std::uint64_t captured_time_generation = 0;
    auto operator<=>(const CheckpointGenerationState&) const = default;
};

struct SaveCheckpointMetadata {
    std::uint32_t save_format_version = SaveStateMetadata::current_format_version;
    ProjectId project;
    std::string project_version;
    std::chrono::milliseconds play_time{0};
    CheckpointGenerationState generations;
    bool operator==(const SaveCheckpointMetadata&) const = default;
};
struct LatestSaveCheckpoint {
    SaveCheckpointRevision revision;
    std::string encoded_save;
    SaveCheckpointMetadata metadata;
    bool operator==(const LatestSaveCheckpoint&) const = default;
};
```

`encoded_save` is the exact opaque byte string accepted by `TypedSaveSlotStore::write_slot`; Phase 1
does not add a second byte container or parse it outside the save codec. The record is immutable after
publication. Replacement constructs, validates, and encodes a complete candidate before atomically
publishing it. Any failure preserves the prior record and generations. `metadata` is computed from
the candidate checkpoint, never the newer live frame. A Phase 2 slot write writes `encoded_save`
unchanged through `TypedSaveSlotStore`; core metadata is recoverable from those same save bytes.
Session-local checkpoint revision and generation counters are deliberately not serialized. Phase 7
adds a typed, atomic thumbnail association without changing retained save-byte ownership.

The four generation fields are the complete V1 generation state. Structural capture sets
`captured_structural_generation` to `structural_generation`; time capture sets
`captured_time_generation` to `time_generation`. Structural changes request capture at the next
eligible settled transaction. Time-only replacement is coalesced to no more than once per elapsed
unscaled second. Manual save may request an immediate eligible time refresh. Counters never wrap;
exhaustion is a typed fatal runtime diagnostic rather than silent reuse.

The closed save-command vocabulary is:

```cpp
struct ManualSaveRequest {
    TypedSaveSlotId slot;
    auto operator<=>(const ManualSaveRequest&) const = default;
};
struct DeferredAutosaveRequest {
    auto operator<=>(const DeferredAutosaveRequest&) const = default;
};
struct ImmediateRetainedCheckpointWriteRequest {
    TypedSaveSlotId slot;
    auto operator<=>(const ImmediateRetainedCheckpointWriteRequest&) const = default;
};
using CheckpointSaveRequest =
    std::variant<ManualSaveRequest, DeferredAutosaveRequest,
                 ImmediateRetainedCheckpointWriteRequest>;

enum class CheckpointWriteSource : std::uint8_t {
    CapturedCurrentState,
    RetainedCheckpoint,
};
struct CheckpointWriteSucceeded {
    TypedSaveSlotId slot;
    SaveCheckpointRevision checkpoint;
    CheckpointWriteSource source;
    auto operator<=>(const CheckpointWriteSucceeded&) const = default;
};
struct DeferredAutosaveQueued {
    auto operator<=>(const DeferredAutosaveQueued&) const = default;
};
enum class CheckpointSaveFailureStage : std::uint8_t {
    InvalidRequest,
    NoRetainedCheckpoint,
    Capture,
    SlotWrite,
};
struct CheckpointSaveFailed {
    std::optional<TypedSaveSlotId> slot;
    CheckpointSaveFailureStage stage;
    Diagnostics diagnostics;
    bool operator==(const CheckpointSaveFailed&) const = default;
};
using CheckpointSaveOutcome =
    std::variant<CheckpointWriteSucceeded, DeferredAutosaveQueued,
                 CheckpointSaveFailed>;
```

`ManualSaveRequest` rejects an autosave slot. If eligible and generations are newer, it first
captures and writes that revision with `CapturedCurrentState`; if eligible but not newer, or
ineligible, it writes the existing retained revision with `RetainedCheckpoint`. With no retained
checkpoint it fails. An attempted eligible refresh that fails returns `Capture` and writes nothing.

`DeferredAutosaveRequest` has no slot field because it always targets
`TypedSaveSlotId::autosave()`. At most one request is pending; repeated requests coalesce and still
produce `DeferredAutosaveQueued`. It writes the next successfully published replacement checkpoint
and remains pending across capture failures until success, reset, project load, or explicit runtime
shutdown cancellation.

`ImmediateRetainedCheckpointWriteRequest` never evaluates readiness or captures. It writes the
current retained revision to its requested slot and fails with `NoRetainedCheckpoint` when none
exists. Supplying an autosave slot is valid only for this explicit immediate-autosave semantic.
Every successful write reports the exact checkpoint revision written.

### Frozen audio migration contract

- Runtime/session state owns only desired looping intent for the semantic `Music` and `Ambient`
  channels. Each channel has zero or one desired record; setting/replacing/stopping that intent is an
  authoritative structural mutation.
- `Voice` and `SoundEffect` never write a desired-loop record. Every play is a distinct transient
  operation and backend instance. Generic one-shot play cannot mutate desired music/ambience.
- `audio.play()` overlaps active instances by default. A semantic channel is a routing/grouping key,
  not a backend voice identity and not proof that only one instance exists.
- A typed instance-targeted stop/fade affects exactly one operation/instance identity. A typed
  channel-targeted stop/fade affects every currently active instance on that semantic channel. A
  desired-loop replace/stop also updates the runtime desired record and reconciliation then applies
  the corresponding backend operation.
- Awaited audio, all voice, and gameplay one-shots are `CausalBarrier` in V1 unless the call uses the
  separate UI-only disposable API. Non-awaited does not imply disposable.
- Load discards every backend instance and operation, then creates fresh looping realization from
  desired music/ambience without preserving sample or fade phase.

The concrete desired-audio and audio-operation payloads remain Phase 7 work. Phase 1C implements only
the shared identity, lifecycle, checkpoint-class, and barrier infrastructure they will use.

## Phase 1B gate evidence

- The final ownership, state/operation, and persistence matrices assign one owner, one reconstruction
  rule, one checkpoint rule, and one implementation phase to every required concern.
- The three canonical headers, namespaces, public types, fields, closed alternatives, and numeric-ID
  invariants are fixed above. There are no backend types, callbacks, JSON values, free-form policy
  flags, or unresolved field alternatives.
- Manual save, deferred autosave, and immediate retained-checkpoint writes have distinct requests and
  exact outcomes. Retained bytes use the existing slot store's opaque `std::string` representation.
- The audio split preserves overlapping backend instances while preventing generic one-shots from
  overwriting desired looping intent.
- No production header or behavior was changed in Phase 1B. Shared declarations remain Phase 1C;
  projector, transition/effect, and audio feature payloads remain Phases 4, 6, and 7.

## Phase 1D integration and closure evidence

- The implemented canonical locations are
  `engine/include/noveltea/core/session_operation_id.hpp`,
  `engine/include/noveltea/core/presentation_contracts.hpp`, and
  `engine/include/noveltea/core/checkpoint_contracts.hpp`. `runtime_messages.hpp` includes the
  canonical operation-ID header and contains no duplicate ID or completion-handle declaration.
- `tests/core/presentation_checkpoint_contracts_tests.cpp` now audits all public NovelTea headers
  for sole canonical operation and mounted-instance declarations, rejects backend/JSON/callback/
  exception/RTTI tokens in the three shared headers, enumerates every frozen enum value, exhaustively
  visits every closed variant, and verifies strong-ID and ownership-record domain separation.
- The isolated `RuntimeLayoutManager` still uses its differently named numeric scaffolding ID and
  boolean policies. It has no consumer or test suite. Converting only its ID would require changing
  its zero-as-failure return contract and would partially implement the Phase 3 mount migration, so
  Phase 1D retains it as explicit transitional debt and tests the typed replacement contract instead.
- At the Phase 1D boundary, presentation/audio blocker omission remained unsafe implementation debt
  assigned to Phase 2. Phase 2A has since replaced that projection behavior as recorded above.
- Verification on 2026-07-15 passed: 15 focused contract/runtime/save/audio/script tests, the full
  Linux build, all 325 Linux CTest tests, `format-check`, `cxx-policy`,
  `json-boundary-policy`, and the full Web build. No Phase 2-through-8 service, coordinator,
  projector, clock, backend dispatch, save-codec behavior, or menu behavior was added.
- Every ownership, persistence, and activity-classification row above has one exact Phase 1 contract
  representation or one explicit later-phase implementation assignment. No unresolved Phase 1
  decision or contradictory implemented location remains.

## Phase 2A implementation evidence

- `engine/include/noveltea/script/runtime_checkpoint_service.hpp` and
  `engine/src/script/runtime_checkpoint_service.cpp` implement the runtime-owned checkpoint service.
  `TypedRuntimeSession` owns it for the session lifetime while it retains only project/store
  references; candidate calls borrow a const `SessionState` projection.
- The service owns `CheckpointGenerationState`, revisioned readiness, the optional immutable
  `LatestSaveCheckpoint`, deferred-autosave placeholder, and time-only deadline. Its candidate
  pipeline performs conservative reconstructibility validation, `make_save_state()`, save validation,
  encoding, exact-candidate metadata creation, then atomic retained-value publication.
- `tests/script/runtime_checkpoint_service_tests.cpp` verifies candidate metadata, retained-value
  atomicity on projection and encoding failure, omitted-state rejection, and causal-blocker
  rejection. Core save tests now verify that presentation/audio blockers are rejected rather than
  omitted.
- This is only the Phase 2A foundation. It does not yet wire settled transactions, presentation
  status, live initial capture, save commands, autosaves, load/reset, or Phase 7 presentation fields.

## Phase 2B implementation evidence

- `RuntimeUI` is the single live outer dispatch broker. Nested completions and acknowledgements share
  its transaction, causal status is registered before sink/backend work, and checkpoint settlement
  occurs once after recursive output handling and ActiveText status publication.
- `TypedRuntimeSession` owns the transitional presentation-status provider and transaction mutation
  recorder. It supplies complete settled facts to `RuntimeCheckpointService`; the service alone
  orders typed readiness issues and decides whether to replace the retained candidate.
- Structural mutations advance one generation per committed transaction. Deterministic elapsed
  runtime input advances time generation once per transaction, with a one-second time-only capture
  deadline; structural dirtiness bypasses that deadline and idle transactions do not re-encode.
- Awaited presentation/audio, transient voice/SFX, ActiveText reveal/fade, Lua suspension, unsettled
  runtime queues, and non-reconstructible current presentation/audio state prevent replacement
  without mutating the older retained checkpoint. Deferred internal commands drain before
  settlement rather than becoming checkpoint barriers. Startup uses the same broker after sinks bind.
- Phase 2C retained-checkpoint save/autosave cutover, Phase 2D load/reset lifecycle, and final
  coordinator/reconstructible presentation work remain intentionally unchanged.

## Phase 2C implementation evidence

- `RuntimeCheckpointService` owns manual, deferred-autosave, and immediate-retained requests and
  typed outcomes. Every successful slot write receives an already-retained immutable byte string.
- `TypedRuntimeSession` adapts existing runtime and Lua save commands to those canonical requests;
  `TypedExecutionKernel` no longer owns live-state slot writes or autosave consumption.
- Focused checkpoint-service and typed-session tests cover refreshed and retained manual writes,
  capture and slot-write failures, coalesced deferred requests with immutable retry targets,
  same-settlement autosave fulfillment, and immediate retained writes.

## Phase 2D implementation evidence

- `TypedRuntimeSession` constructs a load candidate by reading exact slot bytes, decoding and
  project-validating `SaveState`, and restoring a complete replacement `TypedExecutionKernel`
  before any live mutation or backend reset. A failed read, decode, validation, or restore leaves
  the live kernel, transitional sinks, and retained checkpoint unchanged.
- `RuntimeUI` binds the session's narrow transient-reset callback to the current presentation and
  audio sinks. Successful load resets them with `CheckpointLoad` before committing the replacement;
  reset uses `RuntimeReset`. `RuntimeAudioAdapter::reset` stops backend tracks and clears pending
  completions and termination acknowledgements without dispatching fabricated runtime completion.
- `RuntimeCheckpointService::prepare_loaded_checkpoint` allocates a fresh monotonic session-local
  revision from decoded metadata, while `commit_loaded_checkpoint` adopts the exact loaded bytes,
  resets generation baselines, and clears pending manual/deferred outcomes and targets. The load
  settlement observes equal captured generations and therefore does not re-encode the state.
- Runtime reset clears checkpoint state, pending save requests/outcomes, deferred commands,
  transitional operation/barrier state, selections, and pending audio/presentation work. Its settlement is explicitly
  suppressed so a new checkpoint is obtained only from the subsequent startup settlement.
- Project replacement and shutdown unbind `RuntimeUI` from the live session before destroying the
  owning `CompiledRuntime`. `RuntimeUI::shutdown()` also clears the session reset callback before
  deleting its state, preventing stale callback/session pointers across reload, shutdown, and later
  reinitialization. Engine shutdown destroys the compiled runtime before `ScriptRuntime` shutdown so
  the old checkpoint service and pending save work end with their owning session.
- Focused script and UI verification covers failed-load atomicity, exact-byte retained adoption,
  fresh revisions, reset cancellation reasons, empty generation baselines, no fabricated
  completion, and checkpoint-service lifecycle clearing. Phase 7 persistence debt remains unchanged.
- Verification on 2026-07-15 passed the full Linux build, all 345 Linux CTest tests, focused script
  (83 cases) and UI (58 cases) suites, `format-check`, `cxx-policy`, `json-boundary-policy`, the full
  Web build, and Web `cxx-policy`.

## Affected test targets and later-phase obligations

| Test target / suite | Current relevant coverage | Missing coverage later slices must add |
| --- | --- | --- |
| `noveltea_core_tests` | state families, Flow/blocker ownership, save projection/codec/restore, slot bytes, runtime messages, external protocol, and Phase 1 canonical-definition/dependency/vocabulary/domain invariants | Phase 2 checkpoint readiness/generations/atomic retained bytes; Phase 7 reconstructible save records |
| `noveltea_script_tests` | Lua suspension/API, feature execution, direct save/autosave/load, typed session queues, audio adapter overlap/completion, checkpoint candidate atomicity, settled generations/coalescing, readiness barriers, and transitional operation lifetime | retained manual/deferred autosave semantics, final coordinator acknowledgements, audio split and reconstruction |
| `noveltea_tween_tests` | float advance/pause/kill/callback behavior | typed coordinator ownership and cancellation boundaries after Phase 5/6; current target-pointer/callback primitive is not contract evidence |
| `noveltea_ui_tests` | ActiveText parsing/playback/layout, RmlUi binders/components/assets, outer dispatch settlement, and transitional ActiveText barrier publication | mounted-policy tests, pause/unscaled clocks, multi-context input/render order, final coordinator-owned ActiveText recreation |
| `noveltea_render_tests` and readback executables | shader/material adapters and current RmlUi/ActiveText/composition pixels | snapshot-driven world rendering, typed plane/view allocation, transitions, reset/device-loss reconciliation |
| Sandbox CTest smoke | compiled package boots repeatedly and title document loads | menu stack, save/load checkpoint behavior, runtime snapshot reconciliation, Linux/Web composition scenarios |
| Editor Vitest suite | protocol validation, preview freshness/lifetime, playback, generic debug snapshot, entity thumbnail cache | typed checkpoint readiness/metadata/replay distance, save thumbnails, menu/save workflow, common preview/player semantics |
| Player/bootstrap/export tests | package/bootstrap and store injection wiring | packaged-player end-to-end save/menu/load and checkpoint-owned metadata/thumbnail behavior |
| Missing standalone manager tests | none for `RuntimeLayoutManager` or `RuntimeTransitionManager` | Do not add tests that entrench obsolete contracts; test their typed replacements in Phases 3 and 6 |

## Phase 1A gate evidence

- The current owner, public types/files, consumers, tests or explicit missing tests, final owner,
  disposition, and exact owning phase are recorded for every audited concern.
- Every transitional owner is assigned to a numbered replacement/reduction phase; this inventory has
  no `TBD`, `unknown`, or decide-later entry.
- The unsafe blocker omission and restore behavior, all cleared/derived presentation fields, the
  single raw-clock RmlUi context, callback transitions, ActiveText tween ownership, audio-state
  conflation, multi-track channels, shell/gameplay Layout split, and missing checkpoint
  metadata/thumbnail ownership are tied to concrete implementation types and files.
- No production code or public contract changed in Phase 1A. Phase 1B froze final ownership,
  Phase 1C implemented the three canonical headers, and Phase 1D verified their public integration
  and boundaries. Behavioral work remains assigned to Phases 2 through 8.
