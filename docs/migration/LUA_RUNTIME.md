# NovelTea Lua Runtime

## Versions and dependencies

NovelTea's selected scripting stack is standard Lua 5.5.0 and sol2 3.5.0.

Desktop builds use vcpkg manifest mode:

- `vcpkg-configuration.json` pins the builtin registry baseline to `40dd49b0c9c7dbd79dc64cad5e82308eae04f67f`.
- `vcpkg.json` declares Lua, sol2, and RmlUi dependencies and uses exact overrides for `lua` 5.5.0 port-version 1, `sol2` 3.5.0 port-version 1, and `rmlui` 6.2 port-version 0.
- RmlUi is requested with `freetype` and `lua` features.

Android and Emscripten keep the repository's FetchContent strategy:

- `cmake/NovelTeaLua.cmake` downloads the official Lua 5.5.0 source archive from lua.org with SHA-256 `57ccc32bbbd005cab75bcc52444052535af691789dba2b9016d5c50640d68b3d`.
- Lua is built as a C static library from the official source files, excluding `lua.c` and `luac.c`.
- `Lua::Lua` is the canonical Lua target before RmlUi is added.
- sol2 is fetched at tag `v3.5.0` and patched with the same narrow Lua 5.5 compatibility changes used by the vcpkg sol2 port.
- RmlUi FetchContent is still pinned to 6.2 with `RMLUI_LUA_BINDINGS=ON` and `RMLUI_LUA_BINDINGS_LIBRARY=lua`.

## Ownership and lifetime

NovelTea owns the persistent `lua_State` through `noveltea::script::ScriptRuntime`. Public scripting headers do not include Lua, sol2, or RmlUi headers and do not expose Lua or sol2 types.

The intended order is:

1. Platform initialization.
2. AssetManager mounting.
3. Renderer initialization.
4. `ScriptRuntime::initialize`.
5. `Rml::Initialise`.
6. `Rml::Lua::Initialise(native_lua_state(script_runtime))`.
7. RmlUi render interface, context, and document creation.
8. Game loop.
9. RmlUi documents and context destruction.
10. `Rml::Shutdown`.
11. `ScriptRuntime::shutdown`.
12. Renderer/platform shutdown.

`Engine` declares `ScriptRuntime` before `RuntimeUI`, so implicit destruction order also keeps the Lua state alive longer than RmlUi. Explicit shutdown follows the same policy.

RmlUi receives the NovelTea-owned state through `Rml::Lua::Initialise(lua_state)`. NovelTea never calls RmlUi's no-argument Lua initialization, so RmlUi does not own or close the state.

## Runtime API

The public runtime surface is in `engine/include/noveltea/script/`:

- `ScriptRuntime::initialize(ScriptRuntimeConfig)`.
- `shutdown`, `is_initialized`, `collect_garbage`, `reinstall_host_print`.
- `execute(source, chunk_name)`.
- `execute_asset(logical_asset_path)`.
- `evaluate(expression)`.
- `evaluate_bool(expression)`.
- `evaluate_string(expression)`.

`ScriptResult<T>` carries either a value or `ScriptError { message, chunk, traceback }`. `ScriptValue` is limited to `monostate`, `bool`, `int64_t`, `double`, and `string`.

All engine script execution uses protected sol2 calls. Lua errors are converted to `ScriptError` and must not escape uncontrolled into the engine loop.

## Standard libraries and host bindings

The runtime opens only:

- base
- coroutine
- table
- string
- math
- utf8

The `os`, `io`, and `debug` globals are removed by default. The Lua library source files may still compile into the static library, but those libraries are not opened for NovelTea scripts.

NovelTea creates a global `noveltea` table with:

- `noveltea.log(message)`
- `noveltea.echo(value)`
- `noveltea.lua_version()`
- `noveltea.sol_version()`

Logging routes through SDL logging for the current engine logging path. RmlUi's Lua plugin replaces global `print` during registration, so RuntimeUI calls `ScriptRuntime::reinstall_host_print()` immediately after `Rml::Lua::Initialise`.

## Assets and RmlUi

`ScriptRuntime::execute_asset` reads through `AssetManager` using logical paths such as `project:/scripts/example.lua`. Runtime scripts must not use native paths, `luaL_dofile`, or direct file streams.

RmlUi external scripts loaded with `<script src="..."></script>` continue through `AssetRmlFileInterface`, so Linux, Android, Web, packaged desktop builds, and editor preview share the same asset path behavior. RmlUi encodes logical path separators in some nested script paths, and the file interface normalizes those back to logical asset paths before opening.

RmlUi scripts share NovelTea's global Lua state. Inline RmlUi event attributes are compiled by RmlUi as functions with `event`, `element`, and `document` parameters. External scripts execute in the shared global environment and should namespace their globals, for example `noveltea_demo`, rather than introducing loose generic globals.

The sandbox demo loads `apps/sandbox/assets/rmlui/lua_demo.lua` from RML and logs `RMLUI_LUA_TEST_OK` through the sol2-bound `noveltea.log` function.

## Binding conventions

Future bindings should stay in implementation translation units. Suggested file organization:

- `bind_noveltea.cpp` for root host utilities.
- `bind_game.cpp` for game/runtime facade bindings.
- `bind_entities.cpp` for entity/object bindings.
- `bind_dialogue.cpp` for dialogue bindings.
- `bind_cutscene.cpp` for cutscene bindings.

Use sol2 directly in implementation files:

- Bound C++ classes use `sol::new_usertype`.
- Script calls use protected functions.
- Properties use `sol::property` where appropriate.
- Root engine services are normally non-owning engine-managed references.
- Game/domain entities may use `std::shared_ptr` when scripts are allowed to retain them.
- Avoid ownership cycles between shared_ptr objects and retained Lua closures.
- Never expose constructors for engine-owned types unless explicitly intended.

No old NovelTea Game, Context, Entity, Dialogue, Cutscene, or Duktape code was migrated in this slice.
