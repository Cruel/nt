# Typed Runtime Migration Inventory

## Status

Phase 10 is complete. Every shipped gameplay consumer uses canonical
`noveltea.compiled.project` V1, native `CompiledProject`, `CompiledRuntime`, typed session state,
typed runtime messages, typed saves, and `RuntimeScriptApi`.

## Final Ownership

| Concern | Authoritative owner |
|---|---|
| Editable content | `AuthoringProjectV2` |
| Semantic compilation and diagnostics | `compileAuthoringProject` / `publishCompiledArtifact` |
| Gameplay wire bytes | canonical `gameplay.json` with `noveltea.compiled.project` version 1 |
| Immutable native definitions/programs | `CompiledProject` |
| Mutable gameplay state | `SessionState` and typed feature/flow state |
| Execution | `FlowExecutor`, typed execution kernel/mode handlers, `TypedRuntimeSession` |
| Runtime input/output | `RuntimeInputMessage` / `RuntimeOutputMessage` |
| Saves | `SaveState`, its codec boundary, and `TypedSaveSlotStore` |
| Authored Lua/Layout events | `RuntimeScriptApi` |
| Editor preview/playback JSON | named `editor_runtime_protocol` encoders/decoders |
| Runtime package | final manifest + canonical `gameplay.json` + optional shader/material manifest |

## Deleted Phase 10C Graph

The following no longer exist in shipped targets:

- provisional `RuntimeProject`, its TypeScript schema/exporter, native codec, and fixtures;
- `ProjectDocument`, `ProjectModel`, numeric `EntityType`, generic `EntityRef`, project key
  constants, positional schema parsing, old importers, and old package reader;
- `GameSession`, cutscene/dialogue/runtime controllers, runtime events, generic runtime I/O,
  `RuntimeSessionHost`, legacy runtime view adapter, shell/dispatcher/playback adapters, and JSON
  debug mutation/snapshot implementations;
- `SaveDocument` and JSON controller checkpoints;
- `GameBinding`, `bind_game_session`, `bind_runtime_host`,
  `bind_runtime_command_dispatcher`, and `RuntimeScriptExecutor`;
- native editor commands for legacy import, project loading/validation/editing, and legacy playback.

The JSON boundary allowlist now contains only current codecs/protocol adapters. The parser fuzz matrix
no longer builds deleted project/save/package/runtime-project parsers.

## Consumer Convergence

| Consumer | Final path |
|---|---|
| Entity/full-game preview | publish compiled artifact, send canonical compiled object, load through preview C ABI into `CompiledRuntime` |
| Authoring test playback | compile once, decode named typed playback protocol, execute `TypedRuntimeSession` |
| Package and platform export | one compiled export assembly around `publishCompiledArtifact`; manifests remain separate boundaries |
| Export CLI/orchestration | same assembly and canonical gameplay bytes as UI export |
| Sandbox | `--compiled-project` to raw compiled JSON or final package |
| Player | verified player config/package, then `Engine::load_compiled_project` |
| Web/Android | same engine/package loader compiled for their platform targets |

## Retained Presentation Inventory

| Component | Classification | Follow-up |
|---|---|---|
| `RuntimeUI` | retained low-level RmlUi/input backend | Presentation coordinator will own higher-level orchestration |
| `RuntimeLayoutManager` | transitional scaffolding | Replace orchestration under the presentation plan; preserve behavior meanwhile |
| `RuntimeTransitionManager` | transitional scaffolding | Replace orchestration under the presentation plan; preserve behavior meanwhile |
| `TweenService` | retained low-level animation primitive | Coordinator may schedule it but does not replace its interpolation role |
| Audio output/backend | retained low-level backend | Continue consuming typed `AudioOperation` only |
| ActiveText/layout/direct renderer | retained low-level backend | Continue consuming typed published text state |
| bgfx/RmlUi direct-render adapters | retained low-level backend | Remain explicit renderer/UI implementation details |

None of these components may own Flow state, mutable gameplay state, save state, or internal gameplay
JSON. The presentation-coordinator plan is the sole owner of their deferred orchestration cleanup.

## Guardrails

- Do not reintroduce an authoring-to-provisional runtime adapter.
- Do not add old-format import fallback to project open or package load.
- Do not add JSON property bags or generic message payloads to runtime domain types.
- Do not add a second Lua gameplay gateway.
- Reject unsupported schema/version values with structured diagnostics.
