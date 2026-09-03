# Runtime Documentation Overview

Feature subject identity, Hotspot hit testing, semantic target dispatch, Room-exit routing, and
pointer consumption are specified in
`docs/architecture/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME.md`.

## Purpose

Use this entrypoint before changing runtime state, playback, Lua scripting, runtime shell/layout flow, save/autosave behavior, package export, full-game preview, debugger, recorder, or test playback behavior.

## Current Documents

- `docs/architecture/RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md` defines the target runtime-session,
  transaction, command/request, semantic capability, Lua-adapter, checkpoint-integration, and
  coherent-publication architecture that runtime implementation work must follow.
- `docs/runtime/STATE_AND_PLAYBACK.md` describes runtime input/output contracts, save policy, diagnostics, recorded playback, and remaining work.
- `docs/runtime/LUA_RUNTIME.md` describes Lua runtime direction and command API.
- `docs/runtime/PACKAGE_EXPORT.md` describes runtime package layout, manifest, and editor hook.
- `docs/editor/preview/PREVIEW_AND_TEST_PLAYBACK.md` describes editor-side preview/test playback integration.
- `docs/editor/preview/ENGINE_PREVIEW_COMMUNICATION.md` describes preview iframe protocol and transport behavior.

## Code Areas

- Backend-neutral runtime execution lives under `engine/src/runtime/` and public contracts under
  `engine/include/noveltea/runtime/`; both are owned by `noveltea_runtime`.
- The Lua adapter lives under `engine/src/script/lua/` and is owned by `noveltea_script_lua`.
- Host publication, preview, audio, and RmlUi realization are consumers under `noveltea_engine`, not
  runtime owners.
- Semantic script access is owned by `runtime::RuntimeCommandGateway`; runtime execution reaches Lua
  through `runtime::ScriptInvocationPort` and engine-issued capability profiles.
- Preview transport/protocol types live in editor shared/preview modules and the engine preview web wrapper.
- Full-game preview/debugger/recorder UI lives under editor renderer preview/test editor surfaces.
- Package/export builders live in editor main/shared services and runtime package code.

## Asset Progress and Presentation Publication

Runtime asset preparation is asynchronous and is serviced through
`assets::AssetProgressOrchestrator`, owned by the engine owner-frame loop. Request execution priority
and host-blocking urgency are separate contracts: `AssetRequestReason` controls preparation priority,
while `AssetRequestUrgency` determines whether pending work selects the engine's loading-frame job
budget. Mandatory publication and causal audio are Blocking; disposable cosmetic audio and editor
audio-preview requests remain Background while still using Demand priority. Deferred request
servicing belongs to the progress orchestrator rather than to presentation consumers.

Mandatory presentation assets publish transactionally through `MandatoryPublicationScope`. A ready
lease set becomes a candidate, remains pinned while backend state is realized, and becomes current
only after explicit transaction commit. Commit rechecks the source generation; failure or RAII
rollback leaves the existing publication intact. Runtime may retain exactly one predecessor
publication while a finite visual operation still needs the old revision, then explicitly releases
that predecessor after the operation settles.

Runtime and focused editor preview own independent publication scopes. Runtime realization resolves
only runtime candidate/current/predecessor leases; focused-preview realization resolves only focused
candidate/current leases. A source refresh may therefore leave an older focused publication pinned
without allowing it to satisfy a newer runtime realization, and neither scope can replace or clear
the other's publication. See `docs/assets/OVERVIEW.md` for request, residency, prefetch, telemetry,
and lease-lifecycle details.

## Scene Runtime Boundary

Scene execution is an ordered Event cursor owned by each Flow invocation. A Scene invocation selects
its Stage once before its first runtime Event. `inherited` keeps the caller presentation,
`staged-room` resolves Room visual composition without changing Current Room, Location, Active Room
Context, Hotspots, eligible Interaction subjects, or Room lifecycle, and `blank` supplies an
invocation-local background/Layout presentation without requiring a Room.

Scene Stage presentation is projected from active Flow frames and is owner-qualified by the Scene
invocation. Child Scene presentation therefore overlays caller presentation and disappears when the
child frame returns. Dedicated `scene-text` and `scene-choice` System Layout Roles realize Scene
narration and Scene choices independently from the Game HUD and Dialogue UI. See
`docs/engine/SCENE.md` for the current authoring/compiled/Event contract.

## Flow Prediction Boundary

Speculative Flow prediction consumes compiler-generated `Flow Prediction Index` metadata carried by
the Compiled Project rather than rediscovering supported prediction topology from raw Scene,
Dialogue, Room Lifecycle, or Gameplay Command definitions at runtime. The metadata is optimization
only: it never drives canonical Flow execution, and a missing/unused prediction index leaves gameplay
correctness unchanged because mandatory asset publication remains independent.

`runtime::FlowPredictor` exposes a read-only semantic projection over the generated index. In addition
to Scene and Dialogue entry roots, active Scene and Dialogue Flow can be rooted at their current
`SceneFramePosition` / `DialogueFramePosition`, and prospective Room entry is a first-class prediction
root. A separate resident-Room root is admitted only after a Room is Current; it names the currently
plausible Interaction/default/fallback programs and action Layouts without changing the memory pool or
making those paths part of adjacent-Room entry prediction. Prospective Scene prediction begins at
Scene entry and sees the invocation Stage once; active Scene prediction begins at the current step (or
terminal) and does not replay already-consumed Stage/Event dependencies. Scene control follows generated
sequential, ordered-Condition, and Choice edges rather than walking the raw Scene program. Awaited child
Scene/Dialogue Flow is traversed before the caller continuation, while a detached Scene contributes an
immediate parallel root whose deeper continuation is demoted relative to foreground work. Short
deterministic waits increase execution distance while retaining expected continuation; stronger waits
and player decisions retain later reachability but demote it to alternatives. This is semantic horizon
ranking, not a probability model.

Dialogue prediction uses the same horizon and projection semantics. Entry prediction introduces the
Dialogue's initially visible Stage/media state once. Execution-local slices cover the current line/cue
cursor, speaker and Stage/media Character presentation, voice/SFX/media dependencies, Gameplay Command
effect cursors, Call-Scene ordering, redirects, Choices, and completion Flow. A live effect cursor does
not replay effects that runtime has already consumed; a command that is currently awaiting completion is
treated as consumed before prediction resumes. Choice presentation is the expected frontier and viable
outcomes are alternatives. Lua remains opaque and may invalidate projected facts without executing.

The Runtime Session publishes the authoritative foreground Scene or Dialogue identity and execution
position alongside each immutable runtime publication. The host forwards that execution snapshot to
the mandatory-asset gate after publication succeeds, allowing speculative prefetch to rotate from the
live Flow position even when the rendered presentation snapshot is unchanged. These execution snapshots
are prediction input only; presentation reconciliation and mandatory correctness remain driven by their
existing authoritative contracts.

Completed Room-mode publications similarly carry an optional resident-Room prediction root derived
from already-resolved runtime UI state. Runtime reuses the Verb availability already resolved for the
publication and admits only Interaction/Verb programs whose slots have eligible Current-Room subjects;
it does not evaluate Interaction Guards merely to improve speculation. The predictor does not
re-evaluate Verb availability, execute Lua, or clone the Runtime Session: runtime supplies the
semantic program/Layout identities after the normal publication has resolved them. The host activates
exactly one foreground-Flow or resident root for each publication, and activates the resident root
only after publication succeeds.
Resident dependencies are alternatives (`PossibleNext`) and provenance identifies the resident root
and Current Room. Re-publishing an identical resident root is a no-op for speculative generation
replacement, while a semantic change refreshes the one shared prefetch plan.

Prospective Room entry composes the canonical successful transition order (source `before_leave`,
target `before_enter`, target Room presentation, source `after_leave`, target `after_enter` where
applicable) and deliberately excludes rejection programs. Compiler-lowered Gameplay Command summaries
can hand off to Scene or Dialogue and carry a narrow disposable projection of typed Global Property
mutations into later Conditions. Known Conditions select an expected branch; unknown or Lua-dependent
Conditions widen alternatives. Lua is never executed or analyzed, and an opaque Lua command discards
projected state while prediction continues through statically known Flow. Traversal detects cyclic
generated topology and terminates it without changing gameplay. This remains speculative metadata only;
it does not clone a Runtime Session or participate in authoritative execution.

## Agent Rules

Keep runtime command, Lua API, and preview protocol changes documented together. A protocol change that affects editor preview must update the relevant runtime doc and `docs/editor/preview/ENGINE_PREVIEW_COMMUNICATION.md`.

When adding runtime behavior that should be test-recordable, update the test/recorder docs and make clear whether saved authoring tests can currently replay it.

Do not add JavaScript/Duktape compatibility. Lua is the only runtime scripting target.
