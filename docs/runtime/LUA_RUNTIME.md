# Lua Runtime

## Fixed contract

Lua is the only runtime scripting language. JavaScript, Duktape, dukglue, embedded JS, and compatibility shims are prohibited.

Script Modules are resources and never autorun because they are packaged or collected. Lua executes only through the separate project startup hook, a typed condition/text/effect/instruction reference, or an explicit host request. Script is not a project entrypoint or continuation target. Startup, conditions, predicates, and text expressions are synchronous and cannot yield.

Immediate calls return `core::Result<T, ScriptError>`. Yield-capable effects/instructions return `core::Result<ScriptInvocationOutcome, ScriptError>`, where outcome is a closed Completed/Suspended variant. Every suspension has an engine-owned typed correlation handle bound to one flow frame. Native Lua coroutine state is never serialized; only an engine-defined serializable wait token can make suspension save-safe.

Lua accesses global variables and definition properties only through declared typed APIs. Property set validates owner kind, property type, and nullability; unset removes one override and resumes inheritance. Lua cannot inspect/replace generic JSON, reparent definitions, construct numeric entities, or mutate immutable definitions.

## Failure and policy

Authored failures are recoverable diagnostics and follow the owning instruction's typed failure semantics. They never cross C++ as exceptions or invoke panic. Panic is process-fatal and reserved for API misuse or unrecoverable Lua-state/allocation corruption.

First-party Lua code follows the completed no-exceptions/no-compiler-RTTI policy. sol2 uses `SOL_NO_EXCEPTIONS`, `SOL_NO_RTTI`, protected calls/results, and safety checks. The transitional optional-based `ScriptResult` is replaced during the scripting phase because it permits invalid states.

The TypeScript compiler treats Lua text as opaque after structural validation. Preview/export certification invokes the native Lua loader for syntax diagnostics, and shipped package loading repeats syntax validation.

## Current scaffold

`ScriptRuntime`, restricted Lua setup, protected execution, diagnostics, `RuntimeScriptExecutor`, and the Engine-owned service boundary are retained foundations. Current `ScriptDeferred` commands, generic entity bindings, legacy `Game` helpers, Script entrypoint helpers, arbitrary property/save mutation, and stubs are migration debt. They do not define future behavior and are removed as typed flow/state/command phases land.

Current consumers include Engine, `RuntimeSessionHost`, layout events, preview/playback, tests, and debugger adapters. Existing script runtime, executor, and game-binding tests remain the baseline until replaced with typed condition/result/yield/property tests.

### Current request/execution path

The existing runtime controller emits `ScriptDeferred` commands. `RuntimeSessionHost` converts those
commands into `ScriptRequest` outputs, and the optional engine-layer `RuntimeScriptExecutor` consumes
them by binding the active host and executing each chunk through `ScriptRuntime`. Results currently
return as transitional `ScriptResult` values or structured `lua` diagnostics containing message,
chunk/context, optional source entity, and traceback.

This separation is useful and should survive the migration in typed form:

```text
flow/controller requests script work
    -> host exposes a typed invocation request
    -> engine Lua service executes protected code
    -> typed completion/suspension/error returns to the owning frame
```

The final implementation changes ownership and payload types; it should not collapse Lua execution
back into UI code or individual controllers.

### Current command-facing Lua API

RmlUi Layout events and Layout script files currently route common player actions through
dispatcher-backed helpers:

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

These helpers are valuable because shell UI, tests, preview, and Lua use the same dispatcher path.
Their names and Object/Action payloads are transitional, but the shared command-routing principle is
retained in Phase 9.

Current `Game.start_room`, `Game.go_to_room`, `Game.start_dialogue`, and `Game.start_scene` route
through the transitional host/controller when their current runtime subset supports the target.
`Game.run_script` and Script entrypoint behavior exist only as migration scaffolding and are removed
in favor of explicit Script Module invocation plus the separate startup hook.

### Current state/save bindings

Current bindings can mutate save-backed global/entity properties, Object locations, text-log entries,
notifications, timers, and save slots. `Game.save(slot)`, `Game.load(slot)`, and `Game.autosave()` use
the bound `SaveSlotStore`; autosave writes the reserved autosave slot, while platform persistence
stays outside Lua/core.

This behavior is evidence for required capabilities, not for retaining the generic API. The target
replacement is:

- declared global Variable reads/writes;
- declared property reads and typed override set/unset;
- typed Interactable location/state operations;
- typed notification, timer, flow, and save requests;
- no arbitrary `SaveDocument` or entity JSON access.

### Retained failure behavior

Ordinary authored Lua failures currently stay inside protected calls, produce diagnostics, and do not
cross C++ as exceptions. The process-fatal panic handler is reserved for Lua API misuse or
unrecoverable state/allocation corruption. This distinction is retained. What changes in Phase 6 is
that each typed instruction defines whether failure aborts a frame, returns `Failed`, or is surfaced
to a caller; the current blanket “record and continue” behavior is not the final semantic contract.
