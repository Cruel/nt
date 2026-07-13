#include "noveltea/script/script_runtime.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/script/script_invoker.hpp"
#include "script/lua/sol_access.hpp"
#include "script/lua/script_runtime_internal.hpp"

#include <lua.hpp>
#include <sol/sol.hpp>

#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>

namespace noveltea::script {
namespace {

ScriptError make_error(ScriptErrorCode code, std::string message, std::string chunk,
                       std::string traceback = {})
{
    if (traceback.empty())
        traceback = message;
    return ScriptError{code, std::move(message), std::move(chunk), std::move(traceback)};
}

int traceback_handler(lua_State* state)
{
    const char* message = lua_tostring(state, 1);
    if (!message) {
        if (luaL_callmeta(state, 1, "__tostring") && lua_type(state, -1) == LUA_TSTRING)
            message = lua_tostring(state, -1);
        else
            message = luaL_typename(state, 1);
    }
    luaL_traceback(state, state, message, 1);
    return 1;
}

int panic_handler(lua_State* state)
{
    const char* message = lua_tostring(state, -1);
    std::fprintf(stderr, "[lua] fatal panic: %s\n", message ? message : "unknown Lua panic");
    return 0;
}

std::string lua_value_message(lua_State* state, int index)
{
    const char* message = lua_tostring(state, index);
    if (message)
        return message;
    return std::string(luaL_typename(state, index));
}

std::string lua_type_name(lua_State* state, int index)
{
    return lua_typename(state, lua_type(state, index));
}

std::string prefixed_chunk(std::string_view chunk_name)
{
    std::string name(chunk_name.empty() ? "chunk" : chunk_name);
    if (!name.empty() && (name.front() == '@' || name.front() == '='))
        return name;
    return "=" + name;
}

core::Result<ScriptValue, ScriptError> to_script_value(lua_State* state, int returns,
                                                       const std::string& chunk)
{
    using Result = core::Result<ScriptValue, ScriptError>;
    if (returns == 0)
        return Result::success(std::monostate{});
    if (returns > 1) {
        return Result::failure(make_error(
            ScriptErrorCode::InvalidResult,
            "expression returned multiple values; ScriptRuntime::evaluate expects exactly one "
            "result",
            chunk));
    }

    const int index = lua_gettop(state);
    switch (lua_type(state, index)) {
    case LUA_TNIL:
        return Result::success(std::monostate{});
    case LUA_TBOOLEAN:
        return Result::success(lua_toboolean(state, index) != 0);
    case LUA_TNUMBER:
        if (lua_isinteger(state, index))
            return Result::success(static_cast<std::int64_t>(lua_tointeger(state, index)));
        return Result::success(static_cast<double>(lua_tonumber(state, index)));
    case LUA_TSTRING:
        return Result::success(std::string(lua_tostring(state, index)));
    default:
        return Result::failure(
            make_error(ScriptErrorCode::InvalidResult,
                       "unsupported Lua result type: " + lua_type_name(state, index), chunk));
    }
}

ScriptError lua_failure(lua_State* main, lua_State* thread, ScriptErrorCode code,
                        const std::string& chunk)
{
    const std::string raw = lua_value_message(thread, -1);
    luaL_traceback(main, thread, raw.c_str(), 1);
    const std::string traceback = lua_value_message(main, -1);
    lua_pop(main, 1);
    std::string message = raw;
    const std::size_t first_newline = message.find('\n');
    if (first_newline != std::string::npos)
        message.resize(first_newline);
    return make_error(code, std::move(message), chunk, traceback);
}

} // namespace

struct ScriptRuntime::Impl {
    struct InvocationRecord {
        std::uint64_t owner;
        int thread_reference;
        std::string chunk;
    };

    sol::state lua{panic_handler};
    const assets::AssetManager* assets = nullptr;
    bool initialized = false;
    sol::protected_function traceback;
    std::unordered_map<std::uint64_t, InvocationRecord> invocations;

    lua_State* thread(int reference)
    {
        lua_rawgeti(lua.lua_state(), LUA_REGISTRYINDEX, reference);
        lua_State* result = lua_tothread(lua.lua_state(), -1);
        lua_pop(lua.lua_state(), 1);
        return result;
    }

    void release(int reference) { luaL_unref(lua.lua_state(), LUA_REGISTRYINDEX, reference); }
};

ScriptRuntime::ScriptRuntime() = default;
ScriptRuntime::~ScriptRuntime() { shutdown(); }

core::Result<void, ScriptError> ScriptRuntime::initialize(ScriptRuntimeConfig config)
{
    using Result = core::Result<void, ScriptError>;
    if (is_initialized())
        return Result::success();
    if (!config.assets) {
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime requires an AssetManager", "initialize"));
    }

    m_impl = std::make_unique<Impl>();
    m_impl->assets = config.assets;
    m_impl->lua.open_libraries(sol::lib::base, sol::lib::coroutine, sol::lib::table,
                               sol::lib::string, sol::lib::math, sol::lib::utf8);
    m_impl->lua["os"] = sol::lua_nil;
    m_impl->lua["io"] = sol::lua_nil;
    m_impl->lua["debug"] = sol::lua_nil;
    m_impl->lua["package"] = sol::lua_nil;
    m_impl->lua["require"] = sol::lua_nil;
    m_impl->lua["dofile"] = sol::lua_nil;
    m_impl->lua["loadfile"] = sol::lua_nil;
    m_impl->lua.set_function("__noveltea_traceback", traceback_handler);
    m_impl->traceback = m_impl->lua["__noveltea_traceback"];
    sol::protected_function::set_default_handler(m_impl->traceback);
    bind_noveltea(m_impl->lua.lua_state());
    if (config.audio)
        ::noveltea::script::bind_audio(m_impl->lua.lua_state(), config.audio);
    install_host_print(m_impl->lua.lua_state());
    m_impl->initialized = true;
    return Result::success();
}

void ScriptRuntime::shutdown()
{
    if (m_impl) {
        m_impl->initialized = false;
        m_impl->invocations.clear();
        release_game_binding_state(m_impl->lua.lua_state());
        m_impl.reset();
    }
}

bool ScriptRuntime::is_initialized() const { return m_impl && m_impl->initialized; }

core::Result<ScriptValue, ScriptError> ScriptRuntime::evaluate(std::string_view expression,
                                                               std::string_view chunk_name)
{
    using Result = core::Result<ScriptValue, ScriptError>;
    if (!is_initialized()) {
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized",
                                          std::string(chunk_name)));
    }

    std::string source = "return ";
    source += expression;
    const std::string chunk = prefixed_chunk(chunk_name);
    lua_State* main = m_impl->lua.lua_state();
    lua_State* thread = lua_newthread(main);
    const int reference = luaL_ref(main, LUA_REGISTRYINDEX);
    const int loaded = luaL_loadbufferx(thread, source.data(), source.size(), chunk.c_str(), "t");
    if (loaded != LUA_OK) {
        auto error = lua_failure(main, thread, ScriptErrorCode::LoadFailed, chunk);
        m_impl->release(reference);
        return Result::failure(std::move(error));
    }

    int returns = 0;
    const int status = lua_resume(thread, main, 0, &returns);
    if (status == LUA_YIELD) {
        m_impl->release(reference);
        return Result::failure(make_error(ScriptErrorCode::YieldForbidden,
                                          "synchronous Lua expression attempted to yield", chunk));
    }
    if (status != LUA_OK) {
        auto error = lua_failure(main, thread, ScriptErrorCode::RuntimeFailed, chunk);
        m_impl->release(reference);
        return Result::failure(std::move(error));
    }
    auto value = to_script_value(thread, returns, chunk);
    m_impl->release(reference);
    return value;
}

core::Result<void, ScriptError> ScriptRuntime::execute(std::string_view source,
                                                       std::string_view chunk_name)
{
    using Result = core::Result<void, ScriptError>;
    if (!is_initialized()) {
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized",
                                          std::string(chunk_name)));
    }

    const std::string chunk = prefixed_chunk(chunk_name);
    lua_State* main = m_impl->lua.lua_state();
    lua_State* thread = lua_newthread(main);
    const int reference = luaL_ref(main, LUA_REGISTRYINDEX);
    const int loaded = luaL_loadbufferx(thread, source.data(), source.size(), chunk.c_str(), "t");
    if (loaded != LUA_OK) {
        auto error = lua_failure(main, thread, ScriptErrorCode::LoadFailed, chunk);
        m_impl->release(reference);
        return Result::failure(std::move(error));
    }

    int returns = 0;
    const int status = lua_resume(thread, main, 0, &returns);
    if (status == LUA_YIELD) {
        m_impl->release(reference);
        return Result::failure(make_error(ScriptErrorCode::YieldForbidden,
                                          "synchronous Lua execution attempted to yield", chunk));
    }
    if (status != LUA_OK) {
        auto error = lua_failure(main, thread, ScriptErrorCode::RuntimeFailed, chunk);
        m_impl->release(reference);
        return Result::failure(std::move(error));
    }
    m_impl->release(reference);
    return Result::success();
}

core::Result<void, ScriptError> ScriptRuntime::execute_asset(std::string_view logical_asset_path)
{
    using Result = core::Result<void, ScriptError>;
    if (!is_initialized()) {
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized",
                                          std::string(logical_asset_path)));
    }
    auto text = m_impl->assets->read_text(logical_asset_path);
    if (!text) {
        return Result::failure(
            make_error(ScriptErrorCode::LoadFailed, text.error, std::string(logical_asset_path)));
    }
    return execute(*text.value, "@" + std::string(logical_asset_path));
}

core::Result<bool, ScriptError> ScriptRuntime::evaluate_bool(std::string_view expression,
                                                             std::string_view chunk_name)
{
    using Result = core::Result<bool, ScriptError>;
    auto result = evaluate(expression, chunk_name);
    const auto* evaluated = result.value_if();
    if (evaluated == nullptr)
        return Result::failure(result.error());
    if (const auto* value = std::get_if<bool>(evaluated))
        return Result::success(*value);
    return Result::failure(make_error(ScriptErrorCode::InvalidResult,
                                      "expression did not evaluate to bool",
                                      std::string(chunk_name)));
}

core::Result<std::string, ScriptError> ScriptRuntime::evaluate_string(std::string_view expression,
                                                                      std::string_view chunk_name)
{
    using Result = core::Result<std::string, ScriptError>;
    auto result = evaluate(expression, chunk_name);
    const auto* evaluated = result.value_if();
    if (evaluated == nullptr)
        return Result::failure(result.error());
    if (const auto* value = std::get_if<std::string>(evaluated))
        return Result::success(*value);
    return Result::failure(make_error(ScriptErrorCode::InvalidResult,
                                      "expression did not evaluate to string",
                                      std::string(chunk_name)));
}

core::Result<ScriptInvocationOutcome, ScriptError>
ScriptRuntime::begin_invocation(std::string_view source, std::string_view chunk_name,
                                const core::FlowFrameId& owner,
                                const core::ScriptInvocationHandle& invocation)
{
    using Result = core::Result<ScriptInvocationOutcome, ScriptError>;
    if (!is_initialized()) {
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized",
                                          std::string(chunk_name)));
    }
    if (m_impl->invocations.contains(invocation.number())) {
        return Result::failure(make_error(ScriptErrorCode::StaleInvocation,
                                          "Lua invocation handle is already active",
                                          std::string(chunk_name)));
    }

    const std::string chunk = prefixed_chunk(chunk_name);
    lua_State* main = m_impl->lua.lua_state();
    lua_State* thread = lua_newthread(main);
    const int reference = luaL_ref(main, LUA_REGISTRYINDEX);
    const int loaded = luaL_loadbufferx(thread, source.data(), source.size(), chunk.c_str(), "t");
    if (loaded != LUA_OK) {
        auto error = lua_failure(main, thread, ScriptErrorCode::LoadFailed, chunk);
        m_impl->release(reference);
        return Result::failure(std::move(error));
    }

    int returns = 0;
    const int status = lua_resume(thread, main, 0, &returns);
    if (status == LUA_YIELD) {
        m_impl->invocations.emplace(invocation.number(),
                                    Impl::InvocationRecord{owner.number(), reference, chunk});
        return Result::success(ScriptInvocationSuspended{owner, invocation});
    }
    if (status != LUA_OK) {
        auto error = lua_failure(main, thread, ScriptErrorCode::RuntimeFailed, chunk);
        m_impl->release(reference);
        return Result::failure(std::move(error));
    }
    m_impl->release(reference);
    return Result::success(ScriptInvocationCompleted{});
}

core::Result<ScriptInvocationOutcome, ScriptError>
ScriptRuntime::resume_invocation(const core::FlowFrameId& owner,
                                 const core::ScriptInvocationHandle& invocation)
{
    using Result = core::Result<ScriptInvocationOutcome, ScriptError>;
    if (!is_initialized()) {
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized", "resume"));
    }
    const auto found = m_impl->invocations.find(invocation.number());
    if (found == m_impl->invocations.end() || found->second.owner != owner.number()) {
        return Result::failure(make_error(ScriptErrorCode::StaleInvocation,
                                          "Lua resume does not match an active invocation",
                                          "resume"));
    }

    lua_State* thread = m_impl->thread(found->second.thread_reference);
    if (thread == nullptr) {
        return Result::failure(make_error(ScriptErrorCode::StaleInvocation,
                                          "Lua invocation no longer owns a coroutine", "resume"));
    }
    int returns = 0;
    const int status = lua_resume(thread, m_impl->lua.lua_state(), 0, &returns);
    if (status == LUA_YIELD)
        return Result::success(ScriptInvocationSuspended{owner, invocation});

    const int reference = found->second.thread_reference;
    const std::string chunk = found->second.chunk;
    m_impl->invocations.erase(found);
    if (status != LUA_OK) {
        auto error =
            lua_failure(m_impl->lua.lua_state(), thread, ScriptErrorCode::RuntimeFailed, chunk);
        m_impl->release(reference);
        return Result::failure(std::move(error));
    }
    m_impl->release(reference);
    return Result::success(ScriptInvocationCompleted{});
}

core::Result<void, ScriptError>
ScriptRuntime::cancel_invocation(const core::FlowFrameId& owner,
                                 const core::ScriptInvocationHandle& invocation)
{
    using Result = core::Result<void, ScriptError>;
    if (!is_initialized()) {
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized", "cancel"));
    }
    const auto found = m_impl->invocations.find(invocation.number());
    if (found == m_impl->invocations.end() || found->second.owner != owner.number()) {
        return Result::failure(make_error(ScriptErrorCode::StaleInvocation,
                                          "Lua cancellation does not match an active invocation",
                                          "cancel"));
    }
    const int reference = found->second.thread_reference;
    m_impl->invocations.erase(found);
    m_impl->release(reference);
    return Result::success();
}

void ScriptRuntime::collect_garbage()
{
    if (is_initialized())
        m_impl->lua.collect_garbage();
}

void ScriptRuntime::bind_game_session(core::GameSession* session)
{
    if (is_initialized())
        noveltea::script::bind_game_session(m_impl->lua.lua_state(), session);
}

void ScriptRuntime::bind_runtime_host(core::RuntimeSessionHost* host)
{
    if (!is_initialized())
        return;
    noveltea::script::bind_runtime_host(m_impl->lua.lua_state(), host);
    ::noveltea::script::bind_audio_runtime_host(m_impl->lua.lua_state(), host);
}

void ScriptRuntime::bind_runtime_command_dispatcher(RuntimeCommandDispatcher* dispatcher)
{
    if (is_initialized())
        noveltea::script::bind_runtime_command_dispatcher(m_impl->lua.lua_state(), dispatcher);
}

void ScriptRuntime::bind_audio(AudioSystem* audio)
{
    if (is_initialized())
        ::noveltea::script::bind_audio(m_impl->lua.lua_state(), audio);
}

void ScriptRuntime::clear_audio_binding()
{
    if (is_initialized())
        noveltea::script::clear_audio_binding(m_impl->lua.lua_state());
}

void ScriptRuntime::clear_game_bindings()
{
    if (is_initialized())
        noveltea::script::clear_game_bindings(m_impl->lua.lua_state());
}

void ScriptRuntime::bind_typed_host(core::ScriptHostServices* host)
{
    if (!is_initialized())
        return;
    noveltea::script::clear_game_bindings(m_impl->lua.lua_state());
    noveltea::script::bind_typed_script_host(m_impl->lua.lua_state(), host);
}

void ScriptRuntime::clear_typed_host()
{
    if (is_initialized())
        noveltea::script::clear_typed_script_host(m_impl->lua.lua_state());
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
