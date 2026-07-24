# Runtime Capability Characterization

Date: 2026-07-15

Status: Historical Phase 1 baseline updated through runtime implementation Phase 2. This records the
behavior and transitional owners used during the cutover; final owners are normative in
`RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md` and `RUNTIME_CAPABILITY_DISPOSITION.md`.

| Capability/input family | Phase 1 baseline owner/path | Characterization evidence |
| --- | --- | --- |
| Definition queries | `RuntimeScriptApiTarget::script_definition` through the typed session | `script_runtime_tests.cpp`: typed Lua host-services coverage |
| Variable read/write | `SessionState` through `ScriptHostServices`/typed session | `typed_runtime_session_tests.cpp`: checkpoint lifecycle, no-op mutation, reset/load API attachment |
| Property read/set/unset | `SessionState` through `ScriptHostServices`/typed session | `script_runtime_tests.cpp`: validated typed host state and closed requests |
| Interactable location/move | query through typed session; validated move drains through the session-owned deferred command queue | `script_runtime_tests.cpp`: typed host services; `typed_runtime_session_tests.cpp`: internal settlement, reset/load cancellation, stale-owner behavior |
| Room navigation | typed exit validation then internal `NavigateRoomCommand` | `typed_runtime_session_tests.cpp`: indexed/Map navigation, FIFO drain, bounded command enqueue; `script_runtime_tests.cpp`: Room/transient distinction |
| Transient Scene/Dialogue | validated internal deferred commands drained by the session | `script_runtime_tests.cpp`: Room/transient distinction; `typed_runtime_session_tests.cpp`: same-operation command drain |
| Child Scene/Dialogue call | validated internal deferred commands retaining source-frame context | `script_runtime_tests.cpp`: closed command coverage; `typed_execution_kernel_tests.cpp`: exact Flow/blocker behavior |
| Tail-replace Flow | internal deferred command; later old-owner commands are rejected without mutation | `typed_runtime_session_tests.cpp`: frame-destructive stale-owner coverage; Flow executor focused tests |
| Notifications | ordered `RuntimeEvent` values with no acknowledgement | `typed_runtime_session_tests.cpp`: notification/audio relative ordering; editor runtime protocol tests |
| Deterministic random | typed session mutates saved random state | `typed_runtime_session_tests.cpp`: deterministic random across save/load and invalid ranges |
| Map | typed session Map state and validated activation/navigation | `typed_runtime_session_tests.cpp`: Map and Layout controls |
| Layout slots | typed session Layout slot query/mutation and presentation output | `typed_runtime_session_tests.cpp`: Map and Layout controls; runtime-presentation tests |
| Gameplay pause | typed session explicit pause plus effective Layout pause | `typed_runtime_session_tests.cpp`: Lua pause timing, load reset, Layout pause gating, authoritative effective pause |
| Audio | typed session emits audio operations with exact owner/completion correlation | `typed_runtime_session_tests.cpp`: audio operation tests; `runtime_audio_adapter_tests.cpp` |
| Text log | typed session validates and persists text-log state | `typed_runtime_session_tests.cpp`: text-log metadata and save/restore |
| Continue/choice/navigation/selection/interaction input | typed runtime input vocabulary and session dispatch | `typed_runtime_session_tests.cpp`; Scene/Dialogue/Interaction execution-kernel tests |
| Save/load/autosave | `RuntimeCheckpointService` plus typed save-slot store | `runtime_checkpoint_service_tests.cpp`; `typed_runtime_session_tests.cpp`: lifecycle, autosave, failed-load atomicity |

## Phase 1 contract evidence

`tests/runtime/runtime_contracts_tests.cpp` fixes the new backend-neutral contract invariants:

- publication revision zero is invalid and revisions cannot wrap;
- runtime publication, command, external-request, and capability-generation identities share one
  nonzero, nonwrapping typed monotonic-ID primitive;
- mutation impacts coalesce in one transaction journal;
- command and external-request identities reject zero;
- external requests have one validated terminal transition and retain typed cancellation reasons;
- capability profiles are closed engine-selected values;
- invalid capability-profile enum values are rejected rather than issued as empty authority sets;
- query and command authority are represented separately;
- Room composition admits only a typed draft extension point and no command groups;
- capability views are lightweight and non-owning, cannot be constructed from arbitrary group masks,
  and are issued only from validated closed profile descriptors;
- script invocation failures preserve typed code, message, chunk, and traceback fields across the
  backend-neutral port;
- concrete test fakes implement the script, presentation, and external-request ports using only the
  backend-neutral contract headers.

Later phases moved the evidence to final owners before deleting the transitional paths listed in the
matrix.

## Phase 2 cutover evidence

- One session-owned FIFO queue allocates monotonic internal command sequence identities and retains
  source context.
- Interactable movement, navigation, transient/call/replace Flow operations, and autosave intent do
  not appear in runtime output vocabulary and require no host acknowledgement.
- Commands drain only after the current execution callback returns, may enqueue additional commands
  under one bounded command budget, and reject stale Flow owners without mutation.
- Stop, reset, successful load, failed transaction completion, and session destruction discard
  pending internal commands deterministically.
- Notifications are ordered runtime events and retain their position relative to audio and other
  transitional outputs.
- `TypedHostRequest`, `HostRequestId`, acknowledgement/failure inputs, pending request vectors, host
  checkpoint barriers, and the old save-projection external-request count are absent from production
  runtime/save vocabulary. Only the payload-free future external-request lifecycle contracts remain.
