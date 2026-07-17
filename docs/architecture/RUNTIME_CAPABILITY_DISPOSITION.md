# Runtime Capability Disposition

Last audited: 2026-07-14.

## Purpose

This document is the durable capability inventory, binding disposition, and behavioral evidence for
the typed-runtime architecture. It classifies behavior, not legacy symbols. The old engine and
`docs/migration/audits/CORE_ENGINE_UNMIGRATED_AUDIT.md` are candidate sources only; neither defines a
compatibility contract.

Each row has one authoritative owner and exactly one disposition:

- `retained-complete`: required and proven by an executable typed path and focused tests;
- `retained-gap`: required but bounded work remains for Phase 12B;
- `retained-deferred`: required outside this plan, with a named plan and a non-blocking seam;
- `rejected-obsolete`: intentionally absent from the new architecture;
- `duplicate-covered`: fully subsumed by another row;
- `non-runtime-tooling`: editor, migration, diagnostic, or build behavior isolated from shipped
  gameplay ownership.

No row is classified from type or symbol presence alone.

## Scripting and host API

| ID | Capability contract | Disposition | Authoritative owner and evidence |
| --- | --- | --- | --- |
| SCR-01 | A Lua caller invokes an immediate expression/effect; success returns a typed value or completion, syntax/runtime failure returns diagnostics with traceback, and any yield from an immediate call is rejected without advancing gameplay. | retained-complete | `ScriptRuntime`, `ScriptInvoker`; `tests/script/script_runtime_tests.cpp` cases for typed values, explicit expression return policy, syntax/runtime tracebacks, and rejected immediate yields. |
| SCR-02 | A yielding Lua effect suspends only its exact flow frame and invocation, resumes or cancels only through the matching handle, and propagates a later failure without advancing the stable cursor. Native coroutine state is never persisted. | retained-complete | `ScriptRuntime`, `ScriptInvoker`, `FlowExecutor`; coroutine, exact-owner resume/cancel, and nested-failure cases in `tests/script/script_runtime_tests.cpp`, plus blocker ownership tests in `tests/script/typed_execution_kernel_tests.cpp`. |
| SCR-03 | Engine waits and logical timers advance from session time deterministically, complete/cancel only for the matching owner, and persist as logical timer records rather than backend clocks. | retained-complete | `SessionState`, `FlowExecutor`, `TypedExecutionKernel`; `tests/core/shared_evaluator_tests.cpp` engine-wait case and `tests/core/save_state_tests.cpp` deterministic time/timer and save/restore cases. |
| SCR-04 | Script-visible random operations use session-owned deterministic state whose sequence survives save/restore exactly and cannot depend on platform RNG state. | retained-complete | `SessionState` owns the specified SplitMix64 state; `RuntimeScriptApi` exposes `noveltea.random` and routes `math.random`/`math.randomseed` to the same generator; save format V2 persists `randomState`. Fixed-stream, invalid-range atomicity, Lua-wrapper, and exact save/load continuation coverage is in `tests/core/session_state_tests.cpp`, `tests/core/save_state_tests.cpp`, and `tests/script/typed_runtime_session_tests.cpp`. |
| SCR-05 | Lua reads definitions for Room, Scene, Dialogue, Interaction, Map, Character, Interactable, Verb, and resources through typed summaries; missing/wrong-kind IDs fail explicitly. | retained-complete | `RuntimeScriptApiTarget::script_definition`, `bind_typed_script_host.cpp`; typed host-service coverage in `tests/script/script_runtime_tests.cpp`. |
| SCR-06 | Lua reads and mutates declared variables with exact type checking; invalid IDs or values return diagnostics and leave state unchanged. | retained-complete | `RuntimeScriptApi`, `SessionState`; typed host tests in `tests/script/script_runtime_tests.cpp` and variable mutation tests in `tests/core/session_state_tests.cpp`. |
| SCR-07 | Lua reads, sets, and unsets declared same-type properties; lookup reports local/authored/ancestor/default/missing provenance and invalid mutations are atomic. | retained-complete | `RuntimeScriptApi`, `SessionState`; property host tests in `tests/script/script_runtime_tests.cpp` and inheritance/mutation tests in `tests/core/session_state_tests.cpp`. |
| SCR-08 | Lua can query and move a unique Interactable among Room placement, inventory, and nowhere; invalid destinations fail atomically. | retained-complete | `RuntimeScriptApi`, `TypedRuntimeSession`; typed host tests in `tests/script/script_runtime_tests.cpp` and live-state tests in `tests/core/session_state_tests.cpp`. |
| SCR-09 | Lua requests Room navigation, transient Scene/Dialogue execution, child Scene/Dialogue calls, tail replacement, return, and end through typed flow operations with validated targets and stable failure behavior. | retained-complete | `RuntimeScriptApi`, `ScriptHostServices`, `FlowExecutor`; flow host tests in `tests/script/script_runtime_tests.cpp` and atomic target/call tests in `tests/core/flow_executor_tests.cpp`. |
| SCR-10 | Lua drives current Dialogue choices, Room exits, transient selection, and Interaction invocation through the same closed runtime-input semantics used by the player/editor; stale indices and malformed operands fail deterministically. | retained-complete | `RuntimeScriptApi`, `TypedRuntimeSession`; indexed choice/navigation, selection, autosave, and malformed interaction tests in `tests/script/typed_runtime_session_tests.cpp`. |
| SCR-11 | Lua can present/hide a Map, select/focus a location, change the defined mode/visibility, and activate a connection; operations validate against authoritative Room exits and publish the same typed Map view as player input. | retained-complete | `bind_runtime_capabilities.cpp`, `RuntimeScriptApi`, and `TypedRuntimeSession` expose `noveltea.map.present/hide/select/activate/state`; activation emits the existing validated navigation request rather than mutating flow reentrantly. Kernel behavior remains covered by `tests/script/typed_map_execution_tests.cpp`; Lua success, invalid-ID/mode atomicity, view publication, and acknowledged navigation are covered by `tests/script/typed_runtime_session_tests.cpp`. |
| SCR-12 | Lua can set/clear reserved Layout slots and mount/query/unmount stable custom gameplay Layout instances through typed Layout IDs, owners, complete mounted policy, and admitted non-awaiting entrance/exit fades; invalid IDs, owners, plane/clock/input/pause/transition values, a second finite fade in the same command batch, or denied profiles fail before the rejected command mutates desired state. | retained-complete | `RuntimeCommandGateway`, `RuntimeScriptApi`, and `noveltea.layouts.get/set/clear/mount/mounted/unmount` own the capability. Runtime allocates canonical operation IDs and routes admitted fades through the presentation coordinator. `tests/script/typed_runtime_session_tests.cpp` proves Scene/session/current-Room/named-Room ownership, complete policy queries, stable replacement/removal, entrance/exit operation delivery, single-fade batch admission, pausing/non-pausing policy, save/load reconstruction, invalid-policy diagnostics, and gameplay-versus-shell Layout-event authority; `runtime_contracts_tests.cpp`, `rmlui_lifecycle_tests.cpp`, and `runtime_layout_manager_tests.cpp` cover the closed profiles and authority-isolated realization owner. |
| SCR-13 | Lua can pause/resume gameplay semantically and query that state without conflating editor visibility, audio pause, modal layout policy, or platform suspension. Pause is session-only and is not restored from a save. | retained-complete | `SessionState::gameplay_paused`, `TypedExecutionKernel`, `TypedRuntimeSession`, and `Game.pause/resume/paused` own semantic gameplay pause. The kernel stops before the next instruction, gameplay-advancing inputs are gated while control/load operations remain available, typed views/debug snapshots publish the flag, and restore resets it. `tests/script/typed_runtime_session_tests.cpp`, `tests/core/save_state_tests.cpp`, and editor protocol tests cover idempotence, in-flow timing, blocked advancement, view persistence, and load reset. |
| SCR-14 | Lua separates scoped reconstructible Music/Ambient intent from transient playback. Transient voice/gameplay sound uses typed operations with exact completion and checkpoint classification; explicitly typed UI sound may be disposable. Desired loops use stable owner/instance identity and never expose backend handles. | retained-complete | `RuntimeScriptApi` and `RuntimeCommandGateway` expose `audio.play/play_and_wait/stop/stop_and_wait/play_ui` plus `set_loop/set_music/clear_loop/clear_bus/state`. `SessionState` owns `DesiredAudioInstance`; `PresentationCoordinator` owns transient operation lifecycle; `RuntimeAudioAdapter` reconciles fresh looping voices and executes exact transient targets through `AudioSystem`. Save format V6 persists desired configuration only. Audio adapter/session/save tests prove layered ambience, reserved BGM replacement, overlapping one-shots, exact/bus stop behavior, causal/disposable classification, backend exhaustion/reuse, save/load/reset reconstruction, and no one-shot replay or backend progress in save bytes. |
| SCR-15 | Lua emits a notification through a typed request; request failure remains retryable and does not disappear behind a no-op. | retained-complete | `RuntimeScriptApi::request_notification`, `TypedRuntimeSession`; host-service tests in `tests/script/script_runtime_tests.cpp` and retained-failed-request test in `tests/script/typed_runtime_session_tests.cpp`. |
| SCR-16 | Lua appends a typed text-log entry with an explicit kind/origin/markup policy, or explicitly clears the log where product policy permits; invalid metadata fails atomically. | retained-complete | `noveltea.text_log.append/clear` routes through `RuntimeScriptApi` and `SessionState::append_text_log`; direct Lua entries require a typed system origin and validated kind, markup, and optional Character ID. `tests/script/typed_runtime_session_tests.cpp` proves accepted ActiveText markup, invalid kind/origin atomicity, clear, and save/restore; core validation and codec coverage remain in `tests/core/session_state_tests.cpp` and `tests/core/save_state_tests.cpp`. |
| SCR-17 | Manual save, load, and autosave use typed slot IDs and one strict byte contract; failed writes/decodes/restores leave the live session and API attachment unchanged. | retained-complete | `RuntimeScriptApi`, `TypedExecutionKernel`, `TypedSaveSlotStore`; save/load/autosave and failure-atomicity tests in `tests/script/typed_execution_kernel_tests.cpp` and `tests/script/typed_runtime_session_tests.cpp`. |
| SCR-18 | Startup Lua is a separate non-yielding hook executed before the Room/Scene/Dialogue entrypoint; failure prevents a partially started runtime. | retained-complete | `CompiledRuntime`; startup and entrypoint coverage in `tests/script/compiled_runtime_tests.cpp` and editor export separation in `editor/src/renderer/test/compiled-runtime-export.test.ts`. |

## Flow, Room, Map, Dialogue, Scene, and Interaction

| ID | Capability contract | Disposition | Authoritative owner and evidence |
| --- | --- | --- | --- |
| FLOW-01 | One executor owns the closed Room/Scene/Dialogue/Interaction frame stack; calls, returns, tail replacement, discard, blockers, and faults preserve explicit ordering and reject reentrancy. | retained-complete | `FlowExecutor`; focused ordering, atomicity, blocker, bounded-run, and uniqueness tests in `tests/core/flow_executor_tests.cpp`. |
| ROOM-01 | Entering a Room validates the target, runs before-leave/before-enter/after-leave/after-enter hooks in indexed order, updates current/previous navigation context and visit count at the defined commit point, and fails without a half-transition. | retained-complete | `FlowExecutor` Room transition path and `TypedExecutionKernel`; hook sequencing and failed transition tests in `tests/core/flow_executor_tests.cpp`, Room execution coverage in `tests/script/typed_room_execution_tests.cpp`. |
| ROOM-02 | Room exits and same-room/cross-room navigation use stable exit IDs, authoritative destination references, and one typed navigation pipeline for Lua, Map, player, and editor playback inputs. | retained-complete | `TypedRuntimeSession`, `TypedExecutionKernel`, `FlowExecutor`; indexed navigation test in `tests/script/typed_runtime_session_tests.cpp`, direct transition tests in `tests/core/flow_executor_tests.cpp`, Map execution tests in `tests/script/typed_map_execution_tests.cpp`. |
| ROOM-03 | Room placements, overlays, Interactable visibility/enabled/location, and transient selection produce a typed Room view; invalid live state is rejected rather than repaired silently. | retained-complete | `SessionState`, `TypedExecutionKernel`; Room/live-state tests in `tests/core/session_state_tests.cpp` and `tests/script/typed_room_execution_tests.cpp`. |
| MAP-01 | A Map is presentation over authoritative Room topology; present/hide, focus/selection, mode, visibility, connection availability, and activation are typed and deterministic. | retained-complete | `TypedExecutionKernel` Map methods and `SessionState::MapPresentationState`; `tests/script/typed_map_execution_tests.cpp` and typed RmlUi Map snapshot test in `tests/ui/rmlui_custom_components_tests.cpp`. Public Lua exposure is separately tracked by SCR-11. |
| DIA-01 | Dialogue executes specialized blocks, ordered segments/effects, conditions, waits, redirects, choices, and terminal behavior using stable IDs and cursor stages. | retained-complete | `typed_execution_dialogue.cpp`, `FlowExecutor`; complete block/segment/edge/wait test in `tests/script/typed_dialogue_execution_tests.cpp`. |
| DIA-02 | Choice identity, disabled/hidden policy, show-once history, and stale choice rejection are deterministic; a disabled choice is never selectable. | retained-complete | Dialogue execution and `SessionState`; show-once/disabled-choice tests in `tests/script/typed_dialogue_execution_tests.cpp` and history tests in `tests/core/session_state_tests.cpp`. |
| DIA-03 | Dialogue line/choice logging obeys closed project and per-item logging modes and persists typed origins without duplicating entries. | retained-complete | `typed_execution_dialogue.cpp`, `SessionState`; logging-mode tests in `tests/script/typed_dialogue_execution_tests.cpp`, typed log/save tests in `tests/core/session_state_tests.cpp` and `tests/core/save_state_tests.cpp`. |
| DIA-04 | Dialogue call/return resumes the exact caller position; failed effects or invalid child positions leave the current cursor unchanged and fail-stop execution. | retained-complete | `FlowExecutor`, Dialogue execution; nested-return and failure-atomicity cases in `tests/script/typed_dialogue_execution_tests.cpp` and invalid cursor tests in `tests/core/flow_executor_tests.cpp`. |
| SCN-01 | Scene executes every V1 instruction variant, including conditions/effects, text, waits, calls, flow replacement, presentation, layout, Map, audio, notification, and autosave requests, in stable order. | retained-complete | `TypedExecutionKernel`; complete vocabulary and representative composition tests in `tests/script/typed_execution_kernel_tests.cpp`, compiler/wire exhaustive cases in editor tests. |
| SCN-02 | Scene failures preserve the stable instruction cursor, stale resumes do not mutate state, and nested call/return restores the exact next position. | retained-complete | `TypedExecutionKernel`, `FlowExecutor`; Scene failure/cursor tests in `tests/script/typed_execution_kernel_tests.cpp` and generic call ordering tests in `tests/core/flow_executor_tests.cpp`. |
| INT-01 | Interaction resolution checks exact operand tuples before wildcard matches, preserves operand order and arity/role validation, evaluates conditions deterministically, and returns distinct handled/unhandled/failed outcomes. | retained-complete | `TypedExecutionKernel` Interaction execution and shared evaluator; exact/wildcard/fallback tests in `tests/script/typed_interaction_execution_tests.cpp`, condition coverage in `tests/core/shared_evaluator_tests.cpp`. |
| INT-02 | Interaction lookup falls back through same-type inheritance and then the Verb default program without flattening descendants; invalid or failed effects do not partially mutate state. | retained-complete | Interaction execution, `SessionState`, `FlowExecutor`; child-to-root/default fallback tests in `tests/script/typed_interaction_execution_tests.cpp`, property/effect atomicity tests in core suites. |
| INT-03 | Legacy Action and Object behavior is fully represented by typed Verb, Interaction, Interactable, and invocation rows and is not an independent runtime capability. | duplicate-covered | Covered by INT-01, INT-02, SCR-08, and ROOM-03. |

## Data, inheritance, persistence, and messages

| ID | Capability contract | Disposition | Authoritative owner and evidence |
| --- | --- | --- | --- |
| DATA-01 | Variables are declared, initialized from typed defaults, mutated only with the declared type/constraints, and separated into save-persistent versus session-only families. | retained-complete | `SessionState`, `SaveState`; variable tests in `tests/core/session_state_tests.cpp` and persisted-family projection in `tests/core/save_state_tests.cpp`. |
| DATA-02 | Property inheritance is immutable in topology and same-type only; local runtime override, authored value, live ancestor override/value, declaration default, and missing resolve in that order. Child shadowing and unset fallback react immediately. | retained-complete | `SessionState`; focused inheritance/provenance/mutation tests in `tests/core/session_state_tests.cpp` and restore tests in `tests/core/save_state_tests.cpp`. |
| DATA-03 | Save snapshots contain only typed logical gameplay state, stable frame positions, waits/timers, history, logs, layouts/audio intent where specified, and deterministic metadata; renderer, platform, pointers, and Lua coroutine internals are excluded. | retained-complete | `SaveState`, codec, `FlowExecutor::restore_session`; projection, preflight, strict decode/link, and atomic restoration tests in `tests/core/save_state_tests.cpp`. |
| DATA-04 | Runtime/editor/player communication uses one closed JSON-free C++ input/output vocabulary internally and strict adapters only at external boundaries; malformed/open payloads are rejected. | retained-complete | `runtime_messages.hpp`, editor protocol adapters; `tests/core/runtime_messages_tests.cpp` and `tests/core/editor_runtime_protocol_tests.cpp`. |
| DATA-05 | The compiled project is the sole gameplay definition source; authoring compilation is deterministic, inheritance remains sparse, and preview/playback/package/CLI publication uses byte-equivalent canonical gameplay bytes. | retained-complete | Authoring compiler and `CompiledProject`; editor compiler, golden corpus, wire, and `compiled-artifact-publication.test.ts` suites plus native decoder tests. |

## ActiveText, presentation, editor, and export

| ID | Capability contract | Disposition | Authoritative owner and evidence |
| --- | --- | --- | --- |
| TXT-01 | ActiveText parses typed rich-text markup, reveals complete codepoints/graphemes, computes deterministic effects, and carries object/material/shader metadata without corrupting layout. | retained-complete | Rich-text/ActiveText model; `tests/ui/active_text_tests.cpp`. |
| TXT-02 | ActiveText shapes/wraps before reveal, supports word/CJK wrapping, page breaks, continue state, object hit testing, styles, effects, and deterministic page selection. | retained-complete | `active_text_layout.cpp`, playback model; `tests/ui/active_text_layout_tests.cpp` and `tests/ui/active_text_playback_tests.cpp`. |
| TXT-03 | ActiveText and typed text-log state reach RmlUi/bgfx through data-only snapshots and explicit material/shader roles. | retained-complete | RmlUi custom components and bgfx text renderer; `tests/ui/rmlui_custom_components_tests.cpp`, `tests/render/material_binder_tests.cpp`, and `tests/render/shader_manifest_tests.cpp`. |
| TXT-04 | Production font-family resolution, fallback, synthetic styles, and multilingual font asset policy are completed without changing the typed text/runtime boundary. | retained-deferred | `docs/rendering/plans/ACTIVE_TEXT_FONT_RESOLVER_IMPLEMENTATION_PLAN.md`; the seam is `ActiveTextStyledShaper`/font handles and does not require runtime-model or save changes. |
| PRE-01 | Runtime presentation coordination owns layout layers, modal/input/pause policy, title/game transitions, resize/aspect behavior, and host presentation lifetimes without becoming gameplay state. | retained-deferred | `docs/rendering/plans/PRESENTATION_COORDINATOR_AND_RUNTIME_LAYOUT_IMPLEMENTATION_PLAN.md`; typed `TypedRuntimeUIViewState` and runtime outputs are the validated non-blocking seam. |
| EDT-01 | Full-game preview loads the canonical compiled artifact, exposes typed debug snapshots and mutations, records semantic inputs, replays/undoes deterministically, and never falls back to legacy controllers. | retained-complete | Editor Play/preview transport; `full-game-preview-editor.test.tsx`, `preview-protocol.test.ts`, `test-playback-project.test.ts`, `recorded-test-draft.test.ts`, and native editor protocol tests. |
| EDT-02 | Record-specific previews are editor tooling with pooled host lifetimes and editor-owned selections; they do not define gameplay inheritance or runtime state. | non-runtime-tooling | Editor preview manager/pools; Room/Layout/Character/Dialogue/Scene preview tests. |
| EXP-01 | Package export, platform export, CLI export, and packaged launch consume the canonical compiled artifact and publish atomically with explicit diagnostics. | retained-complete | Editor package/platform services; compiled artifact publication, package workflow, platform staging/certification, CLI, Android integration, and canonical integration tests. |
| EXP-02 | Remaining platform identity, signing, template certification, and host-specific player packaging responsibilities stay outside the typed-runtime migration. | retained-deferred | `docs/editor/plans/PLATFORM_EXPORT_AND_APP_IDENTITY_IMPLEMENTATION_PLAN.md`; the compiled package/player-template contracts are the validated seam. |

## Explicitly rejected or isolated legacy families

| ID | Capability contract | Disposition | Architectural reason / owner |
| --- | --- | --- | --- |
| REJ-01 | Generic entity JSON mutation, arbitrary JSON property bags, and generic `save_entity`/load-arbitrary-record APIs. | rejected-obsolete | They bypass declarations, typed diagnostics, save ownership, and the JSON boundary. Variables, properties, and typed save rows are the supported capabilities. |
| REJ-02 | Universal numeric entity tags, one enum spanning unrelated domains, generic `{collection,id}` references, and runtime raw indexes/pointers as public identity. | rejected-obsolete | Owned strong IDs and explicit heterogeneous variants prevent cross-domain aliasing and are required for deterministic linking. |
| REJ-03 | Legacy constructors, positional selected-entity arrays, `ObjectList`, fake player-object inventory, and count-as-custom-property conventions. | rejected-obsolete | Unique Interactables and typed selection/location state replace these shapes. Stackable items are not inferred from legacy structure. |
| REJ-04 | Runtime reparenting, cross-collection inheritance, editor-tree parent semantics, and flattened inherited descendant values. | rejected-obsolete | The fixed model is immutable, acyclic, same-type inheritance with live sparse resolution. |
| REJ-05 | Script entrypoint entities, JavaScript/Duktape, autorun collection scanning, compatibility Lua tables, and duplicate `Game.*` implementations. | rejected-obsolete | Lua-only modules plus a separate startup hook and one `RuntimeScriptApi` are the final scripting model. |
| REJ-06 | Legacy package fallback, dual authoring schemas, runtime importers, alternate project/save codecs, and alternate runtime controllers. | rejected-obsolete | The canonical compiled artifact, typed session, and strict save codec are sole sources of truth. |
| REJ-07 | Porting SFML/Qt drawable, controller, manager, widget, or editor class structures by name. | rejected-obsolete | Rendering, presentation, and editor behavior use bgfx/RmlUi/Electron adapters over typed state; class parity has no product requirement. |
| REJ-08 | Stackable/count inventory as an inferred migration requirement. | rejected-obsolete | The current product model requires unique Interactables only. A future stackable `ItemDefinition` would be a new independently planned feature, not restoration of `ObjectList`, count properties, or legacy save behavior. |
| TOOL-01 | Historical project import, should it ever be requested, runs as a one-time editor tool and never links into shipped players. | non-runtime-tooling | No importer is currently required. Any future work needs its own plan, explicit input/output contract, and editor-only target. |
| TOOL-02 | Categories, tags, chapters, preview selections, test drafts, export profiles, diagnostics, and migration audit metadata remain editor/build tooling rather than gameplay state. | non-runtime-tooling | Editor authoring and tooling services; compiler tests prove editor metadata is omitted from canonical gameplay bytes. |

## Completed capability closure

Phase 12B closed exactly the six former `retained-gap` rows: SCR-04, SCR-11, SCR-12, SCR-13,
SCR-14, and SCR-16. No rejected compatibility API, alternate controller, second save model, raw
backend pointer binding, or fallback loader was introduced. There are no remaining
`retained-gap` dispositions.

## Audit result

- Every candidate family from the old-engine audit and Phase 12 plan has one disposition and owner.
- Every `retained-complete` row cites executable implementation and focused behavioral tests.
- Every `retained-gap` row has a bounded acceptance test and a named typed owner.
- Every `retained-deferred` row points to an existing plan and an already-present typed seam.
- Every rejected family records why it conflicts with the final architecture.
- No unresolved product decision or unclassified row remains for Phase 12A.

## Implementation result

- Every former retained gap now has a typed authoritative implementation and focused positive,
  negative, persistence, ordering, or failure-atomicity coverage as applicable.
- Script-visible random state is deterministic and saved; Map, layout, pause, audio, and text-log
  operations use the single `RuntimeScriptApi`/`TypedRuntimeSession` path.
- Typed Lua audio reaches the shipped `AudioSystem` through `RuntimeAudioAdapter`; exact awaited
  completion is correlated without exposing backend pointers to Lua.
- Unsupported or malformed operations fail explicitly and do not mutate accepted state.
- Linux, sanitizer, Web, editor, policy, formatting, and Android verification evidence is recorded
  in the Phase 12 implementation plan.

## Final architecture closure

The final repository audit removed the superseded migration inventory and the stale migration-plan,
compatibility, and post-RmlUi-bgfx snapshot documents. Active architecture, engine, runtime,
migration, build, UI, and export documentation now names only the canonical compiled artifact and
typed runtime path. Historical terminology remains only in `docs/archive`, `refs`, explicit rejected
capability rows, strict-rejection tests, or narrowly named external JSON-boundary adapters.

The final classified search dispositions are:

| Search family | Disposition |
| --- | --- |
| `noveltea.runtime.project`, old model/controller/save names in decoder and fuzz tests | Required strict-rejection coverage; no production path accepts them. |
| `to_json`/`from_json` and nlohmann uses in named codec/adapter modules | Required external JSON boundary; enforced by `json-boundary-policy`. |
| `ProjectDocument` wording in editor store/preview documentation | Editor document lifecycle terminology only; it does not name a legacy runtime model or wire schema. |
| Historical old-engine terminology | Historical reference under `docs/archive` or `refs`, or an explicit rejected-obsolete disposition. |
| `RuntimeLayoutManager` | Retained low-level mounted-document realization beneath the presentation coordinator. The obsolete callback transition manager and raw-target/string-channel tween owner were deleted when targeted finite realization became live. A redesigned backend-local `animation::TweenService` retains reusable interpolation without semantic lifecycle authority. |

No retained-gap or ambiguous capability row remains. The typed-runtime migration is complete; the
deferred presentation, font, and platform-export plans do not reintroduce compatibility surfaces.
