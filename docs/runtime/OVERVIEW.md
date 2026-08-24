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

## Agent Rules

Keep runtime command, Lua API, and preview protocol changes documented together. A protocol change that affects editor preview must update the relevant runtime doc and `docs/editor/preview/ENGINE_PREVIEW_COMMUNICATION.md`.

When adding runtime behavior that should be test-recordable, update the test/recorder docs and make clear whether saved authoring tests can currently replay it.

Do not add JavaScript/Duktape compatibility. Lua is the only runtime scripting target.
