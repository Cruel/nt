# NovelTea Lua Runtime

## Versions and dependencies

NovelTea's selected scripting stack is standard Lua 5.5.0, sol2/sol3 3.5.0, and RmlUi 6.2.

Desktop builds use vcpkg manifest mode:

- `vcpkg-configuration.json` pins the builtin registry baseline to `40dd49b0c9c7dbd79dc64cad5e82308eae04f67f`.
- `vcpkg.json` declares Lua, sol2, and RmlUi dependencies and uses exact overrides for `lua` 5.5.0 port-version 1, `sol2` 3.5.0 port-version 1, and `rmlui` 6.2 port-version 0.
- RmlUi is requested with `freetype` and `lua` features.

Android and Emscripten use FetchContent:

- `cmake/NovelTeaLua.cmake` downloads the official Lua 5.5.0 source archive from lua.org with SHA-256 `57ccc32bbbd005cab75bcc52444052535af691789dba2b9016d5c50640d68b3d`.
- Lua is built as a C static library from the official source files, excluding `lua.c` and `luac.c`.
- `Lua::Lua` is the canonical Lua target before RmlUi is added.
- sol2 is pinned to immutable commit `9190880c593dfb018ccf5cc9729ab87739709862`, verified as the commit behind tag `v3.5.0` (`refs/tags/v3.5.0^{}`).
- `cmake/patch-sol2-lua55.cmake` applies the narrow Lua 5.5 compatibility patch and fails if expected files or strings are missing. The patch is idempotent and accepts only the known unpatched or patched states.
- RmlUi FetchContent remains pinned to 6.2 with `RMLUI_LUA_BINDINGS=ON` and `RMLUI_LUA_BINDINGS_LIBRARY=lua`.

## Ownership and lifetime

NovelTea owns one persistent Lua state through `noveltea::script::ScriptRuntime`. Public scripting headers do not include Lua, sol2, or RmlUi headers and do not expose Lua or sol2 types. Native Lua state access is implementation-only through `engine/src/script/lua/script_runtime_internal.hpp` and is used only by internal integration code and narrowly scoped tests.

The intended order is:

1. Platform initialization.
2. AssetManager mounting.
3. Renderer initialization.
4. `ScriptRuntime::initialize`.
5. `RuntimeUI::initialize`.
6. `Rml::Initialise`.
7. `Rml::Lua::Initialise` with the NovelTea-owned state.
8. RmlUi render interface, context, and document creation.
9. Game loop.
10. RuntimeUI shutdown: unload documents, remove context, call `Rml::Shutdown`, then destroy render/system/file interfaces.
11. `ScriptRuntime::shutdown`.
12. Renderer/platform shutdown.

`Engine` declares `ScriptRuntime` before `RuntimeUI`, so implicit destruction order keeps Lua alive longer than RmlUi. Explicit shutdown follows the same policy. `Engine::initialize()` also rolls back partially initialized subsystems in exact reverse order on failure.

RmlUi receives the NovelTea-owned state through `Rml::Lua::Initialise(lua_state)`. NovelTea never calls RmlUi's no-argument Lua initialization, so RmlUi does not own or close the state.

## Runtime API

The public runtime surface is in `engine/include/noveltea/script/`:

- `ScriptRuntime::initialize(ScriptRuntimeConfig)`.
- `shutdown`, `is_initialized`, and `collect_garbage`.
- `execute(source, chunk_name)`.
- `execute_asset(logical_asset_path)`.
- `evaluate(expression)`.
- `evaluate_bool(expression)`.
- `evaluate_string(expression)`.

`ScriptResult<T>` carries either a value or `ScriptError { message, chunk, traceback }`. `ScriptValue` is limited to `monostate`, `bool`, `int64_t`, `double`, and `string`.

All engine script execution uses protected calls with a Lua traceback handler based on `luaL_traceback`. Runtime errors keep a concise primary `message`, the logical `chunk`, and a full `traceback` containing Lua stack frames. Syntax errors still report useful source/chunk diagnostics even when no runtime stack exists.

## Standard libraries and host bindings

The runtime opens only:

- base
- coroutine
- table
- string
- math
- utf8

After opening base, NovelTea removes the native-filesystem and module-loader globals:

- `os`
- `io`
- `debug`
- `package`
- `require`
- `dofile`
- `loadfile`

`load` remains available so runtime code can compile source strings. No native filesystem package loader is installed.

NovelTea creates a global `noveltea` table with:

- `noveltea.log(message)`
- `noveltea.echo(value)`
- `noveltea.lua_version()`
- `noveltea.sol_version()`

Logging routes through SDL logging. RmlUi's Lua plugin replaces global `print` during registration, so RuntimeUI calls the internal `install_host_print(...)` helper immediately after `Rml::Lua::Initialise`. It does not rebuild all NovelTea host bindings just to restore `print`.

## Evaluation policy

`ScriptRuntime::evaluate` compiles `return <expression>` and enforces a strict typed expression policy:

- No return values map to `std::monostate`.
- One returned Lua nil maps to `std::monostate`.
- One bool, string, integer, or float maps to the matching `ScriptValue` alternative.
- Multiple return values are rejected.
- Unsupported return types are rejected with the Lua type name. This includes table, function, userdata, and thread.

Lua integer and floating-point values are distinguished with Lua's own integer inspection (`lua_isinteger`). `42` returns `int64_t`, while `42.0` and `42.5` return `double`.

## Assets and RmlUi

`ScriptRuntime::execute_asset` reads through `AssetManager` using logical paths such as `project:/scripts/example.lua`. Runtime scripts must not use native paths, `luaL_dofile`, or direct file streams.

RmlUi external scripts loaded with `<script src="..."></script>` continue through `AssetRmlFileInterface`, so Linux, Android, Web, packaged desktop builds, and editor preview share the same asset path behavior. RmlUi emits encoded logical paths such as `project|/rmlui/lua_demo.lua`; the file interface decodes only a leading valid, mounted asset namespace. It leaves relative paths and ordinary strings containing `|/` later in the path untouched.

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
