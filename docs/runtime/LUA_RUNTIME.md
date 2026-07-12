# Lua Runtime

## Purpose

Define the Lua-only scripting runtime contract for NovelTea.

## Current Direction

Lua is the only runtime scripting target. Imported script text is treated as Lua. Invalid script text should fail as Lua and surface diagnostics to runtime/editor users.

JavaScript, Duktape, dukglue, embedded JS engines, and JS compatibility shims are not runtime goals.

## Runtime Execution

Runtime controllers emit script work as `ScriptDeferred` commands, which `RuntimeSessionHost` exposes as `ScriptRequest` outputs. The optional engine-layer Lua executor consumes those requests, binds the active `RuntimeSessionHost`, executes each chunk through `ScriptRuntime`, and appends `ScriptResult` or structured `lua` diagnostics.

Lua errors do not crash the engine. A failed chunk records the message, chunk/context, source entity when known, and Lua traceback. Runtime progression continues after the diagnostic; hook-specific abort semantics are deferred until a later runtime policy requires them.

First-party Lua integration code contains no exception handlers. This is an intermediate migration
state: sol2 is still built in its ordinary exception-capable configuration until the dedicated Phase 4
audit enables `SOL_NO_EXCEPTIONS` and `SOL_NO_RTTI`. New Lua failure handling must use protected results
or explicit Lua status values rather than adding containment catches.

Lua scripts can mutate save-backed global properties, entity property overrides, object locations, text log entries, notifications, timers, and save slots through explicit `Game`, entity, `Log`, `toast`, and `Timer` APIs. `Game.save(slot)`, `Game.load(slot)`, and `Game.autosave()` route through the active host and require a bound `SaveSlotStore`.

Autosave currently writes the reserved autosave slot. Platform-specific persistence is intentionally outside the Lua layer and core runtime.

## Runtime Command API

RmlUi Layout event handlers and Layout script files should route player-visible actions through the
dispatcher-backed `Game` command helpers:

```lua
Game.start()
Game.pause()
Game.resume()
Game.open_load_menu()
Game.open_settings_menu()
Game.close_menu()
Game.continue()
Game.navigate(0)
Game.choose(1)
Game.select_object("lamp")
Game.clear_selection()
Game.run_action("look", { "lamp" })
Game.command("runtime.navigate", { direction = 0 })
```

These helpers dispatch the same runtime commands used by shell/UI/test paths and return `true` when
the dispatcher handled the command. `Game.start_room(id)`, `Game.start_dialogue(id)`,
`Game.start_scene(id)`, and `Game.run_script(id)` are present but currently report clear
not-implemented diagnostics until those runtime flows are wired.
