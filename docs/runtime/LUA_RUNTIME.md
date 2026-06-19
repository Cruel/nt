# Lua Runtime

## Purpose

Define the Lua-only scripting runtime contract for NovelTea.

## Current Direction

Lua is the only runtime scripting target. Imported script text is treated as Lua. Invalid script text should fail as Lua and surface diagnostics to runtime/editor users.

JavaScript, Duktape, dukglue, embedded JS engines, and JS compatibility shims are not runtime goals.

## Runtime Execution

Runtime controllers emit script work as `ScriptDeferred` commands, which `RuntimeSessionHost` exposes as `ScriptRequest` outputs. The optional engine-layer Lua executor consumes those requests, binds the active `GameSession`, executes each chunk through `ScriptRuntime`, and appends `ScriptResult` or structured `lua` diagnostics.

Lua errors do not crash the engine. A failed chunk records the message, chunk/context, source entity when known, and Lua traceback. Runtime progression continues after the diagnostic; hook-specific abort semantics are deferred until a later runtime policy requires them.

Lua scripts can currently mutate save-backed global properties, entity property overrides, object locations, text log entries, notifications, and timers through explicit `Game`, entity, `Log`, `toast`, and `Timer` APIs. Manual save/load/autosave slot behavior remains part of the save policy phase.
