# Preview and Test Playback

## Shared Compiled Artifact

Full-game preview and `.ntpkg` export use `buildCompiledRuntimeExport` as their single
project-derived compilation and runtime-readiness path. Authoring-test playback uses the same
compiled publication contract. The published value is canonical `noveltea.compiled.project` V2
plus deterministic diagnostics. Preview sends that compiled object to the engine; it does not build
a second runtime-project shape.

Only diagnostics classified for the `runtime-package` boundary block Play or `.ntpkg`. Platform-only
application identity, locale, signing, and deployment diagnostics remain visible at their owning
boundary without suppressing the playable artifact. Compiler or native Lua-certification errors
that prevent a playable artifact still block load and remain actionable editor diagnostics.
The permanent classification inventory is
`docs/editor/project/PROJECT_VALIDATION_DIAGNOSTIC_MATRIX.md`.

Blank authored project names and versions remain invalid authoring/platform values. Runtime
generation substitutes `[Unnamed Project]` and `0.0.0` only in the detached compiled artifact and
package metadata; it never writes those fallbacks into authoring content or recovery state.

## Preview Runtime

The dedicated Play preview owns its engine iframe for the open-tab lifetime. A
`runtime-load-compiled-project` transport message stages the canonical compiled value and referenced
preview assets, then invokes the narrow preview C ABI. `PreviewHost` uses the same `GameHost` load
path as packaged playback;
`runtime::RunningGame::create` receives only the validated typed package and constructs one
`runtime::RuntimeSession`.

The transport message name is an external protocol operation, not a schema name. Its `project`
payload must be `noveltea.compiled.project` version 2.

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

The Play editor records the content-plus-recovery fingerprint that produced the last successfully
loaded runtime. Editor-chrome-only changes do not affect that fingerprint. A changed fingerprint or
current runtime-package blocker marks the session stale; the last successful runtime remains loaded
until the current project can be compiled and the user explicitly restarts with it.

While stale, generic engine Reload is disabled because it cannot truthfully claim to use the current
project. Runtime Reset is also disabled when the current project has runtime blockers. The Play tab
shows those blockers through the standard Problems navigation contract, and correcting them enables
a fresh compile without reopening the project.

Play and package preparation are read-only with respect to authoring content. Shader binaries
produced for publication are overlaid on detached shader/material metadata and are not recorded by a
hidden `shader.applyCompiledOutputs` command. An explicit user command may still persist compiled
outputs as ordinary save-unit-owned authoring work.

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
messages, stale-runtime retention and correction without reopen, and the full editor suite.
