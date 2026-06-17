#include "noveltea/script/script_runtime.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "script/lua/script_runtime_internal.hpp"

#include <lua.hpp>
#include <sol/sol.hpp>

#include <cstdint>
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

ScriptValue to_script_value(const sol::object& object)
{
    if (!object.valid() || object == sol::nil) return std::monostate {};
    if (object.is<bool>()) return object.as<bool>();
    if (object.get_type() == sol::type::number) {
        if (object.is<lua_Integer>()) {
            return static_cast<std::int64_t>(object.as<lua_Integer>());
        }
        return static_cast<double>(object.as<lua_Number>());
    }
    if (object.is<std::string>()) return object.as<std::string>();
    return std::monostate {};
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

    ScriptError error_from_result(const sol::protected_function_result& result, std::string chunk) const
    {
        sol::error err = result;
        const std::string message = err.what();
        return make_error(message, std::move(chunk));
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
    bind_noveltea(m_impl->lua.lua_state());
    m_impl->initialized = true;
    return ScriptResult<void>::success();
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

    const std::string chunk = prefixed_chunk(chunk_name);
    sol::load_result loaded = m_impl->lua.load(std::string(source), chunk);
    if (!loaded.valid()) {
        sol::error err = loaded;
        return ScriptResult<void>::failure(make_error(err.what(), chunk));
    }

    sol::protected_function function = loaded;
    sol::protected_function_result result = function();
    if (!result.valid()) {
        return ScriptResult<void>::failure(m_impl->error_from_result(result, chunk));
    }
    return ScriptResult<void>::success();
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

    std::string source = "return ";
    source += expression;
    const std::string chunk = prefixed_chunk(chunk_name);
    sol::load_result loaded = m_impl->lua.load(source, chunk);
    if (!loaded.valid()) {
        sol::error err = loaded;
        return ScriptResult<ScriptValue>::failure(make_error(err.what(), chunk));
    }

    sol::protected_function function = loaded;
    sol::protected_function_result result = function();
    if (!result.valid()) {
        return ScriptResult<ScriptValue>::failure(m_impl->error_from_result(result, chunk));
    }
    sol::object object = result.get<sol::object>();
    return ScriptResult<ScriptValue>::success(to_script_value(object));
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

void ScriptRuntime::reinstall_host_print()
{
    if (is_initialized()) {
        bind_noveltea(m_impl->lua.lua_state());
    }
}

lua_State* native_lua_state(ScriptRuntime& runtime)
{
    return runtime.m_impl ? runtime.m_impl->lua.lua_state() : nullptr;
}

const lua_State* native_lua_state(const ScriptRuntime& runtime)
{
    return runtime.m_impl ? runtime.m_impl->lua.lua_state() : nullptr;
}

} // namespace noveltea::script
