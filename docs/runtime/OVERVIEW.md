# Runtime Documentation Overview

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

- Runtime C++ systems live under `engine/src/runtime/`, `engine/src/script*`, `engine/src/ui*`, and related engine modules.
- Preview transport/protocol types live in editor shared/preview modules and the engine preview web wrapper.
- Full-game preview/debugger/recorder UI lives under editor renderer preview/test editor surfaces.
- Package/export builders live in editor main/shared services and runtime package code.

## Agent Rules

Keep runtime command, Lua API, and preview protocol changes documented together. A protocol change that affects editor preview must update the relevant runtime doc and `docs/editor/preview/ENGINE_PREVIEW_COMMUNICATION.md`.

When adding runtime behavior that should be test-recordable, update the test/recorder docs and make clear whether saved authoring tests can currently replay it.

Do not add JavaScript/Duktape compatibility. Lua is the only runtime scripting target.
