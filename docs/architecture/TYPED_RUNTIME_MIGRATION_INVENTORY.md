# Typed Runtime Migration Inventory

## Purpose and scope

This inventory began as the Phase 0 baseline and is maintained through the migration. It records the
existing scaffold, JSON-bearing public seams, and the Phase 9 classification of every surviving
generic runtime message path. It is not approval to add legacy compatibility or generic JSON state.

`TYPED_RUNTIME_MODEL_AND_JSON_BOUNDARIES_IMPLEMENTATION_PLAN.md` is the canonical replacement
schedule. All new runtime behavior must target its typed model; the listed legacy types only remain
available to keep the current application and test scaffold buildable until their named removal
phase.

## Retained scaffold

| Scaffold | Current owner/use | Retain through | Replacement phase |
| --- | --- | --- | --- |
| `core::RuntimeValue`, `Result`, `Diagnostic`, and `json_access` | Closed scalar values, nonthrowing result/diagnostic transport, and audited JSON decoding helpers | Entire migration | 2 extends the values; 11 keeps codecs only at boundaries |
| `core::RuntimeProject` and `decode_runtime_project` | Named-field `noveltea.runtime.project` V1 decoder used by codec tests and the provisional export contract | Until its consumers move | 4 defines compiled wire V1; 5 replaces it with `CompiledProject` decoding |
| Editor `runtime-project.ts` and `authoring-runtime-export.ts` | Pure TypeScript export pipeline, Zod validation, diagnostics, preview/export/package callers | Pipeline and diagnostics remain | 3 replaces authoring schema; 4 replaces lowering and wire schema |
| `ProjectDocument` -> `ProjectModel` -> `GameSession`/`RuntimeController` | Shipped legacy-shaped runtime loading and playback path | Runtime cutover | 5--10, deleted at 10 |
| `RuntimeSessionHost` and `RuntimeUIViewAdapter` | Current backend-neutral host/input/view seam | Host/UI seam remains | 6--9 replace internals and payloads |
| Editor playback/preview and package-export callers | Current consumers of the temporary model and wire contract | Until compiled-project path is wired | 4, 7, and 10 as applicable |

## Legacy paths and temporary adapters

| Path | Current role | Guardrail | Removal phase |
| --- | --- | --- | --- |
| `ProjectDocument`, `ProjectModel`, `EntityRef`, `EntityType`, and `core/legacy/*` | Positional legacy project import, document storage, numeric entity addressing, and validation | Do not add records, fields, compatibility cases, or new callers for runtime features | 10 |
| `CutsceneController`, `CutsceneModel`, and raw cutscene segments | Legacy scene execution and JSON snapshots | New work uses the canonical `Scene` terminology and awaits the typed Scene program | 7/10 |
| `GameSession` generic properties, `EntityMetadata::properties`, and `ProjectModel::merged_properties` | Generic JSON property mutation/inheritance | Do not add properties or implement features through these bags | 2, 8, 10 |
| Controller, event, input/output, and UI adapter JSON payloads | Shipped pre-cutover legacy message and snapshot transport | Do not add payload variants or typed-runtime callers; Phase 9 replacement is complete and Phase 10 deletes this path atomically | 10 |
| `SaveDocument` and controller checkpoint JSON | Legacy saved mutable state | Do not add save fields or save compatibility; Phase 8 introduces typed `SaveState` | 8/10 |
| Legacy package reader/writer and `ProjectTooling::import_legacy_game_json` | Transitional import/package workflow | No new legacy formats or compatibility behavior | 10 |

## Public `nlohmann::json` classification

The following is the complete Phase 0 classification of public C++ declarations that expose
`nlohmann::json` in `engine/include/`. Entries tagged **temporary** are also mirrored in
`cmake/json-boundary-allowlist.txt`. “Permanent boundary” means JSON is limited to a decoder,
encoder, or external protocol adapter and must remain outside domain models after Phase 11.

| Header and symbols | Classification | Owner/rationale | Replacement or removal phase |
| --- | --- | --- | --- |
| `core/json_access.hpp` helpers | Permanent codec | Audited nonthrowing decoder helper used only by JSON codecs | 11 retains |
| `core/runtime_project_codec.hpp::decode_runtime_project` | Temporary migration codec | Provisional runtime wire decoder | 5 |
| `core/project_document.hpp::ProjectDocument` | Temporary migration debt | Legacy JSON root is the current project source of truth | 10 |
| `core/project_model.hpp::{EntityMetadata, CutsceneSegmentModel, ProjectModel}` | Temporary migration debt | Generic properties, raw segments, and retained document root | 10 |
| `core/legacy/entity_schema.hpp` and `core/legacy/project_importer.hpp` | Temporary migration adapter | Legacy positional schema/import only | 10 |
| `core/entity_ref.hpp::{to_json, from_json}` | Temporary migration codec | Numeric legacy entity references | 10 |
| `core/save_document.hpp::SaveDocument` | Temporary migration debt | JSON-backed legacy save root | 10 |
| `core/runtime_user_settings_codec.hpp` | Permanent codec | Strict `noveltea.runtime.user-settings` V1 boundary around a JSON-free native value | 11 retains |
| `core/game_session.hpp` generic property/log/notification APIs | Temporary migration debt | Shipped legacy session state only; typed state and communications use `SessionState` and Phase 9 messages | 10 |
| `core/{cutscene,dialogue,runtime}_controller.hpp` state/snapshot APIs and `ControllerCommand::data` | Temporary migration debt | Shipped legacy controller execution/snapshots only; no replacement-runtime consumer | 10 |
| `core/runtime_events.hpp::RuntimeEvent::data` | Temporary migration debt | Shipped `GameSession`/`RuntimeController` event transport only | 10 |
| `core/runtime_io.hpp::{RuntimeInput, RuntimeOutput, RuntimeDiagnostic}` | Temporary migration debt | Shipped legacy host/shell/tooling only; typed runtime uses `RuntimeInputMessage`, `RuntimeOutputMessage`, and `core::Diagnostic` | 10 |
| `core/runtime_session_host.hpp::enqueue_audio_command` | Temporary migration debt | Shipped legacy audio output only; typed runtime uses `AudioOperation` | 10 |
| `core/runtime_ui_view.hpp` JSON adapter helpers | Temporary migration debt | Shipped legacy UI command/log adaptation only | 10 |
| `core/rich_text.hpp` JSON conversion helpers | External protocol adapter | Preview/debug/UI serialization boundary; keep domain rich-text values JSON-free | 11 retains adapter |
| `core/package_export.hpp` JSON metadata and manifest fields | Permanent package boundary | Versioned shader/material and package manifest documents | 11 retains adapter |
| `core/editor_api.hpp` JSON project editing, playback specs, snapshots, and reports | Temporary tooling/migration adapter | Shipped editor tooling still drives the legacy runtime until atomic cutover | 10 |
| `core/editor_runtime_protocol.hpp` | Permanent named external protocol | Strict Phase 9 decoder/encoder boundary around typed editor inputs, playback, reports, and debug snapshots | 11 retains adapter |
| `runtime_command.hpp::RuntimeCommand::payload` | Temporary external protocol debt | Shipped shell/preview command transport only; typed platform/editor adapters lower directly to `RuntimeInputMessage` | 10 |
| `runtime_ui_playback.hpp` JSON playback specs/results | Temporary external protocol debt | Shipped legacy UI playback only; typed playback uses the named editor runtime protocol | 10 |
| `runtime_debug_snapshot.hpp` debug JSON helpers | Permanent debugger adapter | Serialized only for debugger/preview clients | 11 retains adapter |
| `render/material.hpp::parse_shader_material_project_json_value` | Permanent package-metadata codec | Dedicated versioned shader/material metadata boundary | 11 retains adapter |

`assets/resource_aliases.hpp` accepts JSON text but does not expose a JSON value; it is likewise a
permanent resource-metadata decoder boundary. JSON use only inside implementation files follows the
classification of its public entrypoint; implementation-only parser construction is not a domain API.

## Affected consumers and baseline tests

Current consumers that constrain Phase 0 are the engine load path (`Engine::load_runtime_project`),
`RuntimeSessionHost`, the editor runtime-export builder, package export, preview/playback bridges,
and debugger/UI playback adapters. The current runtime project scaffold is covered by
`tests/core/runtime_project_codec_tests.cpp`; editor emission/validation is covered by
`editor/src/renderer/test/authoring-runtime-export.test.ts` and
`editor/src/renderer/test/authoring-export.test.ts`.

Legacy paths are covered by `tests/core/{project_document,project_model,project_validator,
legacy_entity_schema,game_session,runtime_controller,cutscene_controller,dialogue_controller,
save_document,editor_api,compatibility_completion}_tests.cpp`, with scripting and UI consumers in
`tests/script/game_bindings_tests.cpp` and `tests/core/runtime_ui_view_tests.cpp`. JSON helper and
fuzz boundaries are covered by `tests/core/json_access_tests.cpp` and `tests/fuzz/parser_fuzz.cpp`.
Package and material boundary coverage is in `tests/core/project_document_tests.cpp` and
`tests/render/{material_asset,shader_compiler,shader_manifest,shader_package_export}_tests.cpp`.

No Phase 0 test changes are required: it adds inventory and guardrails only. Later phases must update
the listed consumer tests when they replace the corresponding seam.

## Phase 9 typed-message audit

The Phase 9 audit classifies all production uses requested by the implementation plan. Searches cover
`engine/`, `apps/`, and public headers; tests are consumers only where noted below.

| Audited family | Classification after Phase 9 | Exact owner and removal condition |
| --- | --- | --- |
| `ControllerCommand::data`, controller `save_state`/`restore_state`, and debug controller snapshots | Transitional legacy-path debt | `RuntimeController`, legacy debugger/editor snapshots, and legacy playback. Delete in Phase 10 after the shipped runtime and debug snapshot producer consume `CompiledProject`, typed views, and typed save state. |
| `RuntimeInput::payload`, `RuntimeOutput::payload`, and `RuntimeDiagnostic` | Transitional legacy-path debt | `RuntimeSessionHost`, `RuntimeShell`, legacy editor API/playback, engine audio draining, and legacy script execution. Delete in Phase 10 after those consumers route through `TypedRuntimeSession` and `core::Diagnostic`. |
| `RuntimeEvent::data`, generic notification/log metadata, and audio-command JSON | Transitional legacy-path debt | `GameSession`, `RuntimeController`, `RuntimeUIViewAdapter`, and legacy engine audio handling. Delete in Phase 10 after the shipped path uses typed user-communication and audio operations. |
| Legacy editor playback payloads and reports | Transitional legacy-path debt | `core::editor_api` and `runtime_ui_playback`. Delete in Phase 10 when production preview/playback routing adopts `editor_runtime_protocol`. |
| `GameBinding`, `build_game_table`, `bind_game_session`, `bind_runtime_host`, `bind_runtime_command_dispatcher`, matching `ScriptRuntime` methods, and `RuntimeScriptExecutor` | Transitional legacy-path debt | Legacy `ScriptRuntime`, engine/runtime-shell initialization, and legacy playback/tests. Delete together in Phase 10 after all shipped authored Lua uses session-owned `RuntimeScriptApi`. |
| `editor_runtime_protocol` JSON documents | Permanent named protocol adapter | Strict versioned editor input/playback decoders and typed report/debug encoders. JSON is not retained by runtime state. |
| Existing `noveltea_runtime_*` preview/Web C ABI | Transitional external boundary debt | The existing exports still target the shipped legacy preview host. Their arguments are external scalars/strings, but production lowering into `RuntimeInputMessage` is part of the Phase 10 atomic consumer cutover; there is no separate committed `platform_runtime_protocol` module. |
| `runtime_messages`, `TypedRuntimeSession`, typed `RuntimeUI`, and `RuntimeScriptApi` | Removed/replaced typed path | These are the replacement owners. They do not construct or inspect legacy generic messages or JSON payload objects. |

No audited generic family is shared with the replacement runtime. The remaining legacy graph is
intentionally kept intact until Phase 10 because independently deleting one message type would break
the currently shipped project-loading/runtime path and would violate the atomic-cutover requirement.

Closed Phase 9 variants use compile-time exhaustive visitors. `TypedRuntimeSession` and typed
`RuntimeUI` already end visitors in dependent `static_assert` branches. Phase 9E adds the same rule to
runtime output category/kind classification and to the nested editor protocol communication,
observation, and debug-snapshot encoders; adding an alternative without handling it now fails the
build.

### Phase 9E verification record

The completed audit was verified against the current checkout with the following coverage:

- Linux Debug built successfully and the complete CTest suite passed: 538/538 tests.
- The focused typed runtime, editor protocol, preview/debugger/playback, typed UI, and diagnostic
  selection passed: 31/31 tests.
- Linux ASan/UBSan built successfully; the focused Phase 9 runtime/script/protocol selection passed
  23/23 tests, and all six configured parser fuzz-smoke tests passed.
- The Web build completed successfully. Web C++ policy and formatting targets passed.
- Linux first-party runtime policy, checker self-tests, and dependency compiler/link policy passed
  against the complete Linux Debug build (`190` first-party and `5` dependency compile commands).
- Editor ESLint and TypeScript checks passed. The complete Vitest suite passed: 723 tests, with five
  intentionally skipped platform integration tests. Two unrelated asynchronous UI tests were made
  deterministic by waiting for their MessageChannel/menu/API boundaries rather than relying on
  scheduling order; no product behavior changed.
- `git diff --check` was run for both staged and unstaged changes.

Linux executes the native adapter and sanitizer tests. Web receives compile and policy coverage in
this environment. The Android player has no NovelTea JNI gameplay/runtime command surface to execute;
no placeholder JNI adapter was introduced. Android, Windows, and macOS builds were not executed as
part of this local Phase 9E verification and retain their CI/platform-build ownership.

## Phase 0 guardrails

- Do not implement a new runtime feature first in `ProjectDocument`, `ProjectModel`, `GameSession`,
  `SaveDocument`, `RuntimeController`, a generic JSON payload, numeric `EntityType`, or raw cutscene
  record.
- Do not add legacy import/export compatibility. Existing readers remain only as transitional code.
- New C++ JSON decoding must use `core::json_access` and the completed no-exceptions/no-RTTI policy;
  untrusted JSON must not use throwing parse/access APIs.
- Add any temporary public-domain JSON declaration to the allowlist in the same change, with its
  owner and scheduled removal phase. Permanent JSON is allowed only at the explicit boundary roles
  recorded above.
