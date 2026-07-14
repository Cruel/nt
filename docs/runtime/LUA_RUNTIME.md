# Lua Runtime

## Direction

Lua is the only runtime scripting language. `ScriptRuntime` owns the sandboxed Lua VM; OS, IO,
debug, package loading, `require`, `dofile`, and `loadfile` are unavailable by default.

Lua source remains opaque to the TypeScript authoring compiler after structural validation. Native
Lua certification runs for preview/export readiness and again during compiled package load. Invalid
inline or asset-backed Lua prevents publication/session construction and reports structured
diagnostics without executing the script.

## Gameplay Gateway

`RuntimeScriptApi` is the sole public authored-script and Layout-event gameplay gateway. The active
`TypedRuntimeSession` implements its typed target operations. Bindings accept stable strong IDs and
typed values, then return explicit success, failure, or yield outcomes.

The gateway covers approved runtime behavior such as:

- typed variable/property reads and writes;
- room, scene, dialogue, and interaction requests;
- interactable location/inventory changes;
- presentation, layout, transition, and audio requests;
- typed view/query helpers and user communication;
- script invocation/yield continuation through owned flow handles.

There is no dispatcher-backed second `Game.*` implementation. `GameBinding`,
`bind_game_session`, `bind_runtime_host`, `bind_runtime_command_dispatcher`, generic entity
tables, arbitrary save JSON access, and `RuntimeScriptExecutor` were deleted in Phase 10C.

## Invocation and Yielding

`ScriptInvoker` owns invocation handles and resumes Lua coroutines only for the matching flow owner.
Opaque Lua suspension is distinct from engine-defined input, duration, presentation, audio, and
child-flow waits. Cancellation and stale handles return explicit errors.

Script errors use `core::Result<..., ScriptError>` with stable error categories, chunk/source
identity, message, and traceback. No C++ exception crosses the runtime boundary.

## Audio

Direct low-level Lua audio helpers bind to `AudioSystem` for approved playback controls. Gameplay
audio operations that participate in typed flow use `RuntimeScriptApi` and typed
`AudioOperation` correlation handles. The removed JSON queue-to-`RuntimeSessionHost` path is not a
supported API.

## Assets

Asset-backed chunks resolve through `AssetManager` logical paths. Package validation proves required
script resources exist, then certification loads each referenced chunk without side effects before
the runtime session starts.

## Rules

- Do not add JavaScript or compatibility shims.
- Do not expose arbitrary JSON project/save state.
- Do not capture legacy session/controller/dispatcher pointers in Lua closures.
- Add gameplay helpers through `RuntimeScriptApi` with strong IDs, typed results, and representative
  failure-path tests.
