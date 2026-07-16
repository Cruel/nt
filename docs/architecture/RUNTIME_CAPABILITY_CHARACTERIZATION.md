# Runtime Capability Characterization

Date: 2026-07-15

Status: Phase 1 baseline for
`plans/RUNTIME_EXECUTION_AND_CAPABILITY_IMPLEMENTATION_PLAN.md`. This records behavior that later
runtime/capability cutovers must preserve; it does not make the transitional owners normative.

| Capability/input family | Current production owner/path | Characterization evidence |
| --- | --- | --- |
| Definition queries | `RuntimeScriptApiTarget::script_definition` through the typed session | `script_runtime_tests.cpp`: typed Lua host-services coverage |
| Variable read/write | `SessionState` through `ScriptHostServices`/typed session | `typed_runtime_session_tests.cpp`: checkpoint lifecycle, no-op mutation, reset/load API attachment |
| Property read/set/unset | `SessionState` through `ScriptHostServices`/typed session | `script_runtime_tests.cpp`: validated typed host state and closed requests |
| Interactable location/move | query through typed session; move promoted to `TypedHostRequest` | `script_runtime_tests.cpp`: typed host services; `typed_runtime_session_tests.cpp`: recursive acknowledgement and settlement |
| Room navigation | typed exit validation then `NavigationHostRequest` | `typed_runtime_session_tests.cpp`: indexed navigation and Map navigation; `script_runtime_tests.cpp`: Room/transient request distinction |
| Transient Scene/Dialogue | `ScriptHostServices` request promoted through the session | `script_runtime_tests.cpp`: Room/transient request distinction |
| Child Scene/Dialogue call | `ScriptHostServices` request promoted through the session | `script_runtime_tests.cpp`: typed host-services closed-request coverage; `typed_execution_kernel_tests.cpp`: exact Flow/blocker behavior |
| Tail-replace Flow | `ScriptHostServices` request promoted through the session | `script_runtime_tests.cpp`: typed host-services closed-request coverage; Flow executor focused tests |
| Notifications | current notification host request/output path | `script_runtime_tests.cpp`: typed host-services closed-request coverage; runtime-message tests |
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

Later phases must move the evidence to final owners before deleting any transitional path listed in
the matrix.
