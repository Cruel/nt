# Preview and Test Playback

## Shared Compiled Artifact

Full-game preview and authoring-test playback call `publishCompiledArtifact` through the shared
compiled export/publication path. The published value is canonical
`noveltea.compiled.project` V1 plus deterministic diagnostics. Preview sends that compiled object
to the engine; it does not build a second runtime-project shape.

Compiler or native Lua-certification errors block load and remain actionable editor diagnostics.

## Preview Runtime

The dedicated Play preview owns its engine iframe for the open-tab lifetime. A
`runtime-load-compiled-project` transport message stages the canonical compiled value and referenced
preview assets, then invokes the narrow preview C ABI. `PreviewHost` uses the same `GameHost` load
path as packaged playback;
`runtime::RunningGame::create` receives only the validated typed package and constructs one
`runtime::RuntimeSession`.

The transport message name is an external protocol operation, not a schema name. Its `project`
payload must be `noveltea.compiled.project` version 1.

Live commands lower to stable typed inputs for start/stop/reset/time, continue, dialogue choice,
navigation, selection, interaction, declared variable changes, inventory location changes, room
teleport, fast-forward, recorder controls, and debug snapshot requests.

Finite presentation in Play preview uses the same `PresentationCoordinator` and typed renderer
backend as packaged playback. Runtime load/reset/project replacement terminates in-flight
background, actor, Layout, and world-composition realization, then reconciles the newly published
target snapshot; transition progress and callback state are never part of the preview protocol or a
save record.

## Authoring Tests

Tests are authoring records validated and compiled with their project. Native playback uses the
named `editor_runtime_protocol` decoder and drives `runtime::RuntimeSession`. It does not use a native
`ProjectDocument` editor API or a legacy playback session.

Recorded targets use stable IDs. Unsupported selector-based UI clicks, ambiguous index-only
choice/navigation steps, arbitrary playback Lua, and old assertion payloads are rejected with
structured diagnostics.

Reports contain ordered runtime events, diagnostics, pass/fail state, and `finalPublication`, which
encodes the coherent publication revision, gameplay UI view, presentation revision/desired-family
summary, and published observations. Interactive debug snapshots retain the same publication and
surface its revisions and scoped desired-state counts. Playback, recorder replay, debugger, and
interactive preview therefore share execution semantics. The removed mixed runtime-output array,
`finalView`, RuntimeUI read-back, and generic `controllerState` payload are not part of the protocol.

## Freshness and Reload

The Play editor hashes/revisions the compiled publication. Authoring changes mark the running preview
stale; reload recompiles and replaces the runtime only after successful publication. A failed compile
leaves the prior runtime visible and reports why the new artifact was not loaded.

## Diagnostics and Security

The iframe handshake, MessageChannel ownership, origin/session checks, and request IDs are documented
in `ENGINE_PREVIEW_COMMUNICATION.md`. Runtime protocol decoders reject missing fields, unknown
variants, invalid strong IDs, and unsupported schema versions at the boundary.
Renderer-side finite-operation failures are emitted as structured runtime diagnostics and surface
through the existing `runtime-error`/`preview-diagnostic` paths rather than being converted to
successful completion.

## Verification

Coverage includes publication byte equivalence, preview load/freshness, playback protocol
validation, Room/Scene/Dialogue launch, typed debug mutations/snapshots, recorder replay, malformed
messages, and the full editor suite.
