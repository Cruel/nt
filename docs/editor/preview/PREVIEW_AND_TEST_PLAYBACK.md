# Preview and Test Playback

## Shared Compiled Artifact

Full-game preview, authoring-test playback, and `.ntpkg` export use `prepareRuntimeArtifact` as their
single project-derived compilation and runtime-readiness interface. Play and test-playback intents
are effect-free; shader compiler effects are reserved for explicit export intents. The published
value is canonical `noveltea.compiled.project` Format V1 plus deterministic diagnostics. Preview sends that compiled object to the engine; it does not build
a second runtime-project shape.

The shared TypeScript CLI and Electron main process persist canonical runtime/test preparation under
`.noveltea/cache/runtime/`. Each disposable Project-local generation contains the canonical prepared
runtime artifact plus a lowered authored-test catalog. Runtime freshness and Test-catalog freshness
are independent: runtime freshness uses exact relevant Project Workspace files, declared Asset source
paths, conservative NovelTea-source discovery, and exact file modification-time-plus-size metadata,
while Test freshness uses the canonical `records/tests/` source revisions. Shared filesystem trust,
containment, deterministic discovery, and metadata capture live in the Project source-inventory
boundary; cache consumers supply only their authoritative paths and discovery scopes. A Test-only edit therefore
republishes the catalog while carrying forward the still-fresh runtime artifact bytes; a
runtime-affecting change causes normal runtime preparation and regenerates the catalog against the
new Project state. General persistent incremental runtime compilation remains deferred: only the
Test-catalog/runtime-artifact split is independently refreshable in this cache version.

Electron persistent-cache admission and publication are main-process responsibilities. The active
Project session supplies the authoritative saved Workspace snapshot; renderer tab dirtiness is not an
admission signal. Clean full-game Play compares only runtime-compilation content, so editor-local and
Test-only in-memory changes may still reuse the saved canonical runtime artifact. Clean authored-test
execution additionally requires the current Test content to match the saved Workspace before it can
consume/publish the saved lowered catalog. Pending raw inputs follow the same distinction: Test-only
pending input does not disqualify Play, while any pending runtime-compilation input keeps Play
session-local. A dirty/recovered Test or runtime input is prepared from the current in-memory Project
for that invocation and is never published over the canonical generation. Successful canonical
preparation may be published before the preview/native runner is launched; a later window, GPU, UI
runner, or other environment failure does not invalidate already-certified compiled cache state.

The catalog is the native-facing Test boundary. Every authored Test ID is emitted deterministically as
either `runnable`, with its runner kind and already-lowered `noveltea.editor.playback` specification,
or `blocked`, with deterministic readiness diagnostics. Cached consumers never need authored Test
schema/Zod parsing. A blocked Test does not invalidate the runtime artifact or prevent cache
publication, but explicitly running that Test returns its readiness diagnostics without invoking the
native runner. A malformed cache generation or failed publication remains disposable and falls back
to ordinary preparation. The standalone ScriptC host now probes this same cache contract before
importing its QuickJS island for the test command family. Authored single/suite execution requires a
proven runtime-artifact hit plus a proven lowered-catalog hit, while stdin `run-spec`/`run-ui-spec`
require only the runtime artifact and therefore remain static/native when authored Test sources alone
are stale. A runtime miss, stale/unusable generation, or conservative Project-root uncertainty imports
the shared TypeScript application and uses the normal preparation/publication path instead. Cached
prepared-artifact diagnostics and shader/material metadata are carried through the static path so a
cache hit preserves the same public warnings and UI runtime inputs as canonical fallback execution.
Bare CLI `test run` and the editor's `Run All` action both hand
the complete lowered catalog to the same native `run-test-suite` operation. That operation executes
runnable Tests sequentially in deterministic Test-ID order, continues after independent failures,
keeps complete playback reports for executed entries, and returns aggregate
`passed`/`failed`/`blocked`/`error` statuses with blocked readiness diagnostics.

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
payload must be `noveltea.compiled.project` format version 1.

Live commands lower to stable typed inputs for start/stop/reset/time, continue, dialogue choice,
navigation, semantic subject selection, interaction invocation, declared variable changes, inventory
location changes, room teleport, fast-forward, recorder controls, and debug snapshot requests.
Interaction subjects include Characters, exact live Interactable Instances, and owner-qualified
Features. Hotspot identity is not a runtime command surface. Gameplay publication carries exact Room
and live Interactable entries; any editor grouping is derived and non-authoritative.

Play keeps current-state debugger controls in its right-side tooling inspector. Runtime activity and
preview diagnostics are workbench bottom-panel concerns instead of a duplicate "Events & diagnostics"
inspector section. `Runtime Events` is intentionally semantic: it records explicit runtime debug events,
fast-forward outcomes, and runtime failures, while continuous debug snapshots, FPS/profiler telemetry,
command acknowledgements, pointer/focus traffic, and other preview-protocol plumbing remain hidden.
Runtime debug snapshots continue to drive the inspector's current-state views, and diagnostics carried
by those snapshots are projected into `Preview Diagnostics`, which may remain available after Play
closes while retained diagnostics exist.

The interactive Player Input panel does not enumerate authored Hotspot definitions. Runtime debug
snapshots publish semantic clickable targets that are currently presented and eligible: either an
Interaction subject plus label or a Room Exit plus label. A pointer Hotspot and a non-pointer control
therefore converge on the same subject/navigation input. Hidden, disabled, absent, condition-false,
and otherwise ineligible geometry does not produce enabled preview controls.

Focused Room preview uses the current `noveltea.room-preview` document and remains passive for
activation. Its projected snapshot includes eligible Room and Interactable Hotspot geometry so mouse
hover can exercise the same Project/Hotspot cursor arbitration as runtime, but focused preview does not
route presses or releases into semantic Hotspot activation. Play preview uses the normal runtime
projection and full world controller in the same preview executable.

Localization owns one editor-local **Preview Locale** selection under local editor state. Focused
previews and Play resolve against that selection instead of mutating the Project Source or Default
locale. Any declared locale, including work-in-progress/non-Supported locales, may be selected for
preview; Play enables that locale only in its detached compilation input so the tracked Project locale
policy remains unchanged. Full-game Play treats those detached inputs as explicit build-context
variants: the Project Default uses the persistent canonical runtime/test generation, real preview
locales use persistent `preview-locale:<locale>` variants, and the virtual QA locale uses a distinct
persistent pseudo-preview context. Preview-only generations share the disposable runtime-cache
namespace but are indexed separately from the canonical `current` pointer. Their persistent LRU is
capped at four active variants and the standalone native CLI probe accepts only `canonical-runtime`,
so a preview artifact can never masquerade as the canonical test/runtime artifact. A virtual
**Pseudo-localized** QA choice is generated from the current Message
source/structure: visible text is marked and expanded while placeholders, selector structure, semantic
Dialogue Cue identities, and RML/rich-text markup remain intact. Play materializes the virtual target
only in its detached compilation input, and focused previews derive the corresponding presentation
directly; no pseudo locale, translations, inheritance, or support policy are persisted to Project
localization storage or emitted by ordinary package/export preparation. Removing a selected real locale
falls back to the Project Default. Preview Locale itself is not part of runtime package/export
preparation. Focused Room/Layout/Shader preview builders keep their existing specialized preparation
and freshness paths; they do not consult this full-runtime persistent/variant cache.

Finite presentation in Play preview uses the same `PresentationCoordinator` and typed renderer
backend as packaged playback. Runtime load/reset/project replacement terminates in-flight
background, actor, Layout, and world-composition realization, then reconciles the newly published
target snapshot; transition progress and callback state are never part of the preview protocol or a
save record.

Play and authoring previews both fill their current host rectangle and report host-logical and
host-framebuffer dimensions separately. Electron's current device-pixel ratio determines the
backing-buffer size. A DPR-only change at unchanged CSS dimensions is therefore a resize transaction,
not a reload: the engine preserves document identity and runtime state while RmlUi and ActiveText
rerasterize against the new committed context metrics.

## Authored Layout Preview Environment

An authored Layout preview is loaded through the typed `load-preview-document` or
`update-preview-document` operation. The operation carries the Layout document and one atomic
environment containing:

- the effective project/custom profile name and native resolution;
- the Layout's resolved UI/text scale inheritance policy;
- the project reference resolution, world-raster policy, and bar color;
- the project accessibility scale policy.

There is no independent preview display-profile mutation. Changing the editor's project/custom
profile control rebuilds the environment used by the next Layout load/update. The native decoder
requires the complete environment for Layout previews and rejects it for unrelated preview kinds.
After validation, the engine commits presentation and RuntimeUI environment changes before
`LayoutRealizer` loads the document into the matching scale-domain context. A subsequent non-Layout
preview restores the preceding presentation and runtime user scales transactionally.

The iframe remains a neutral surface. Neither the custom profile nor the Layout record changes the
React/CSS host rectangle; the engine owns viewport fitting and presentation bars inside the actual
widget surface.

## Authoring Tests

Tests are authoring records validated and compiled with their project. Native playback uses the
named `editor_runtime_protocol` decoder and drives `runtime::RuntimeSession`. It does not use a native
`ProjectDocument` editor API or a legacy playback session.

Recorded targets use stable IDs. Unsupported selector-based UI clicks, ambiguous index-only
choice/navigation steps, arbitrary playback Lua, and old assertion payloads are rejected with
structured diagnostics.

Recording is acceptance-driven. A semantic input is appended to the recorder draft only after its
request receives a successful command result. Rejected subject selections, navigation requests, and
other failed runtime commands remain diagnostics/trace events and do not become replayable test
steps. Recorded pointer-driven work stores the resolved semantic selection/navigation input, not a
Hotspot ID or pointer coordinates.

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

## Asset-memory simulation

Play exposes compact `Desktop`, `Android`, and `Web` memory-target selection plus a policy selector.
The selector offers the built-in Low/Balanced/High policies and named reusable Project policies from
`/export/assetMemoryPolicies`. The selection is editor-local per Play tab/project state; it does not
modify an Export profile or compiled gameplay content. Focused Room/Layout/etc. previews do not
participate in this simulation.

Changing target, policy, or the active named policy definition reconfigures the already-running Play
engine through `set-engine-settings`; it does not normally reload the iframe or restart gameplay.
The renderer resolves named authoring policies to concrete target-specific byte limits before they
cross the preview protocol. The Asset Performance panel identifies the simulated target/policy and
reports peaks since the last policy change.

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
