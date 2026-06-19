#include "noveltea/script/script_runtime.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "script/lua/script_runtime_internal.hpp"

#include <lua.hpp>
#include <sol/sol.hpp>

#include <cstdint>
#include <exception>
#include <memory>
#include <string>
#include <utility>

namespace noveltea::script {
namespace {

ScriptError make_error(std::string message, std::string chunk, std::string traceback = {})
{
    if (traceback.empty()) traceback = message;
    return ScriptError{std::move(message), std::move(chunk), std::move(traceback)};
}

int traceback_handler(lua_State* state)
{
    const char* message = lua_tostring(state, 1);
    if (!message) {
        if (luaL_callmeta(state, 1, "__tostring") && lua_type(state, -1) == LUA_TSTRING) {
            message = lua_tostring(state, -1);
        } else {
            message = luaL_typename(state, 1);
        }
    }
    luaL_traceback(state, state, message, 1);
    return 1;
}

std::string lua_value_message(lua_State* state, int index)
{
    const char* message = lua_tostring(state, index);
    if (message) return message;
    return std::string(luaL_typename(state, index));
}

std::string lua_type_name(lua_State* state, int index)
{
    return lua_typename(state, lua_type(state, index));
}

ScriptResult<ScriptValue> to_script_value(lua_State* state, const sol::protected_function_result& result, const std::string& chunk)
{
    const int returns = result.return_count();
    if (returns == 0) {
        return ScriptResult<ScriptValue>::success(std::monostate {});
    }
    if (returns > 1) {
        return ScriptResult<ScriptValue>::failure(make_error(
            "expression returned multiple values; ScriptRuntime::evaluate expects exactly one result",
            chunk));
    }

    const int index = result.stack_index();
    switch (lua_type(state, index)) {
        case LUA_TNIL:
            return ScriptResult<ScriptValue>::success(std::monostate {});
        case LUA_TBOOLEAN:
            return ScriptResult<ScriptValue>::success(lua_toboolean(state, index) != 0);
        case LUA_TNUMBER:
            if (lua_isinteger(state, index)) {
                return ScriptResult<ScriptValue>::success(static_cast<std::int64_t>(lua_tointeger(state, index)));
            }
            return ScriptResult<ScriptValue>::success(static_cast<double>(lua_tonumber(state, index)));
        case LUA_TSTRING:
            return ScriptResult<ScriptValue>::success(std::string(lua_tostring(state, index)));
        default:
            return ScriptResult<ScriptValue>::failure(make_error(
                "unsupported Lua result type: " + lua_type_name(state, index),
                chunk));
    }
}

std::string prefixed_chunk(std::string_view chunk_name)
{
    std::string name(chunk_name.empty() ? "chunk" : chunk_name);
    if (!name.empty() && (name.front() == '@' || name.front() == '=')) return name;
    return "=" + name;
}

} // namespace

struct ScriptRuntime::Impl {
    sol::state lua;
    const assets::AssetManager* assets = nullptr;
    bool initialized = false;
    sol::protected_function traceback;

    ScriptError error_from_result(const sol::protected_function_result& result, std::string chunk) const
    {
        const int index = result.stack_index();
        const std::string traceback_text = lua_value_message(lua.lua_state(), index);
        std::string message = traceback_text;
        const std::size_t first_newline = message.find('\n');
        if (first_newline != std::string::npos) {
            message.resize(first_newline);
        }
        return make_error(std::move(message), std::move(chunk), traceback_text);
    }
};

ScriptRuntime::ScriptRuntime() = default;
ScriptRuntime::~ScriptRuntime() { shutdown(); }

ScriptResult<void> ScriptRuntime::initialize(ScriptRuntimeConfig config)
{
    if (is_initialized()) return ScriptResult<void>::success();
    if (!config.assets) {
        return ScriptResult<void>::failure(make_error("ScriptRuntime requires an AssetManager", "initialize"));
    }

    try {
        m_impl = std::make_unique<Impl>();
        m_impl->assets = config.assets;
        m_impl->lua.open_libraries(
            sol::lib::base,
            sol::lib::coroutine,
            sol::lib::table,
            sol::lib::string,
            sol::lib::math,
            sol::lib::utf8
        );
        m_impl->lua["os"] = sol::nil;
        m_impl->lua["io"] = sol::nil;
        m_impl->lua["debug"] = sol::nil;
        m_impl->lua["package"] = sol::nil;
        m_impl->lua["require"] = sol::nil;
        m_impl->lua["dofile"] = sol::nil;
        m_impl->lua["loadfile"] = sol::nil;
        m_impl->lua.set_function("__noveltea_traceback", traceback_handler);
        m_impl->traceback = m_impl->lua["__noveltea_traceback"];
        sol::protected_function::set_default_handler(m_impl->traceback);
        bind_noveltea(m_impl->lua.lua_state());
        install_host_print(m_impl->lua.lua_state());
        m_impl->initialized = true;
        return ScriptResult<void>::success();
    } catch (const std::exception& ex) {
        m_impl.reset();
        return ScriptResult<void>::failure(make_error(ex.what(), "initialize"));
    } catch (...) {
        m_impl.reset();
        return ScriptResult<void>::failure(make_error("unknown ScriptRuntime initialization failure", "initialize"));
    }
}

void ScriptRuntime::shutdown()
{
    if (m_impl) {
        m_impl->initialized = false;
        m_impl.reset();
    }
}

bool ScriptRuntime::is_initialized() const
{
    return m_impl && m_impl->initialized;
}

ScriptResult<void> ScriptRuntime::execute(std::string_view source, std::string_view chunk_name)
{
    if (!is_initialized()) {
        return ScriptResult<void>::failure(make_error("ScriptRuntime is not initialized", std::string(chunk_name)));
    }

    try {
        const std::string chunk = prefixed_chunk(chunk_name);
        sol::load_result loaded = m_impl->lua.load(std::string(source), chunk);
        if (!loaded.valid()) {
            sol::error err = loaded;
            return ScriptResult<void>::failure(make_error(err.what(), chunk));
        }

        sol::protected_function function(loaded, m_impl->traceback);
        sol::protected_function_result result = function();
        if (!result.valid()) {
            return ScriptResult<void>::failure(m_impl->error_from_result(result, chunk));
        }
        return ScriptResult<void>::success();
    } catch (const std::exception& ex) {
        return ScriptResult<void>::failure(make_error(ex.what(), std::string(chunk_name)));
    } catch (...) {
        return ScriptResult<void>::failure(make_error("unknown ScriptRuntime execution failure", std::string(chunk_name)));
    }
}

ScriptResult<void> ScriptRuntime::execute_asset(std::string_view logical_asset_path)
{
    if (!is_initialized()) {
        return ScriptResult<void>::failure(make_error("ScriptRuntime is not initialized", std::string(logical_asset_path)));
    }
    auto text = m_impl->assets->read_text(logical_asset_path);
    if (!text) {
        return ScriptResult<void>::failure(make_error(text.error, std::string(logical_asset_path)));
    }
    return execute(*text.value, "@" + std::string(logical_asset_path));
}

ScriptResult<ScriptValue> ScriptRuntime::evaluate(std::string_view expression, std::string_view chunk_name)
{
    if (!is_initialized()) {
        return ScriptResult<ScriptValue>::failure(make_error("ScriptRuntime is not initialized", std::string(chunk_name)));
    }

    try {
        std::string source = "return ";
        source += expression;
        const std::string chunk = prefixed_chunk(chunk_name);
        sol::load_result loaded = m_impl->lua.load(source, chunk);
        if (!loaded.valid()) {
            sol::error err = loaded;
            return ScriptResult<ScriptValue>::failure(make_error(err.what(), chunk));
        }

        sol::protected_function function(loaded, m_impl->traceback);
        sol::protected_function_result result = function();
        if (!result.valid()) {
            return ScriptResult<ScriptValue>::failure(m_impl->error_from_result(result, chunk));
        }
        return to_script_value(m_impl->lua.lua_state(), result, chunk);
    } catch (const std::exception& ex) {
        return ScriptResult<ScriptValue>::failure(make_error(ex.what(), std::string(chunk_name)));
    } catch (...) {
        return ScriptResult<ScriptValue>::failure(make_error("unknown ScriptRuntime evaluation failure", std::string(chunk_name)));
    }
}

ScriptResult<bool> ScriptRuntime::evaluate_bool(std::string_view expression, std::string_view chunk_name)
{
    auto result = evaluate(expression, chunk_name);
    if (!result) return ScriptResult<bool>::failure(*result.error);
    if (auto* value = std::get_if<bool>(&*result.value)) {
        return ScriptResult<bool>::success(*value);
    }
    return ScriptResult<bool>::failure(make_error("expression did not evaluate to bool", std::string(chunk_name)));
}

ScriptResult<std::string> ScriptRuntime::evaluate_string(std::string_view expression, std::string_view chunk_name)
{
    auto result = evaluate(expression, chunk_name);
    if (!result) return ScriptResult<std::string>::failure(*result.error);
    if (auto* value = std::get_if<std::string>(&*result.value)) {
        return ScriptResult<std::string>::success(*value);
    }
    return ScriptResult<std::string>::failure(make_error("expression did not evaluate to string", std::string(chunk_name)));
}

void ScriptRuntime::collect_garbage()
{
    if (is_initialized()) {
        m_impl->lua.collect_garbage();
    }
}

void ScriptRuntime::bind_game_session(core::GameSession* session)
{
    if (!is_initialized()) return;
    noveltea::script::bind_game_session(m_impl->lua.lua_state(), session);
}

void ScriptRuntime::clear_game_bindings()
{
    if (!is_initialized()) return;
    noveltea::script::clear_game_bindings(m_impl->lua.lua_state());
}

lua_State* detail::ScriptRuntimeAccess::state(ScriptRuntime& runtime)
{
    return runtime.m_impl ? runtime.m_impl->lua.lua_state() : nullptr;
}

const lua_State* detail::ScriptRuntimeAccess::state(const ScriptRuntime& runtime)
{
    return runtime.m_impl ? runtime.m_impl->lua.lua_state() : nullptr;
}

} // namespace noveltea::script
