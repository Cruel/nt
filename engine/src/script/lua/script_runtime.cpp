#include "noveltea/script/script_runtime.hpp"
#include "noveltea/script/runtime_script_api.hpp"

#include "script/lua/sol_access.hpp"
#include "script/lua/script_runtime_internal.hpp"

#include <lua.hpp>
#include <sol/sol.hpp>

#include <cstdint>
#include <cstdio>
#include <algorithm>
#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
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

runtime::ProjectHookKind project_hook_kind(core::compiled::RoomScriptHookKind kind) noexcept
{
    using Compiled = core::compiled::RoomScriptHookKind;
    using Runtime = runtime::ProjectHookKind;
    switch (kind) {
    case Compiled::CanEnter:
        return Runtime::RoomCanEnter;
    case Compiled::CanLeave:
        return Runtime::RoomCanLeave;
    case Compiled::RejectEnter:
        return Runtime::RoomRejectEnter;
    case Compiled::RejectLeave:
        return Runtime::RoomRejectLeave;
    case Compiled::BeforeEnter:
        return Runtime::RoomBeforeEnter;
    case Compiled::AfterEnter:
        return Runtime::RoomAfterEnter;
    case Compiled::BeforeLeave:
        return Runtime::RoomBeforeLeave;
    case Compiled::AfterLeave:
        return Runtime::RoomAfterLeave;
    case Compiled::Compose:
        return Runtime::RoomCompose;
    }
    return Runtime::RoomCanEnter;
}

runtime::RuntimeCapabilityProfile hook_capability_profile(runtime::ProjectHookKind kind) noexcept
{
    using Hook = runtime::ProjectHookKind;
    switch (kind) {
    case Hook::RoomCanEnter:
    case Hook::RoomCanLeave:
        return runtime::RuntimeCapabilityProfile::SynchronousExpression;
    case Hook::RoomCompose:
        return runtime::RuntimeCapabilityProfile::RoomComposition;
    case Hook::RoomRejectEnter:
    case Hook::RoomRejectLeave:
    case Hook::RoomBeforeEnter:
    case Hook::RoomAfterEnter:
    case Hook::RoomBeforeLeave:
    case Hook::RoomAfterLeave:
        return runtime::RuntimeCapabilityProfile::GameplayLayoutEvent;
    }
    return runtime::RuntimeCapabilityProfile::SynchronousExpression;
}

std::optional<runtime::ProjectHookKind> parse_project_hook_kind(std::string_view value) noexcept
{
    using Hook = runtime::ProjectHookKind;
    if (value == "can-enter")
        return Hook::RoomCanEnter;
    if (value == "can-leave")
        return Hook::RoomCanLeave;
    if (value == "reject-enter")
        return Hook::RoomRejectEnter;
    if (value == "reject-leave")
        return Hook::RoomRejectLeave;
    if (value == "before-enter")
        return Hook::RoomBeforeEnter;
    if (value == "after-enter")
        return Hook::RoomAfterEnter;
    if (value == "before-leave")
        return Hook::RoomBeforeLeave;
    if (value == "after-leave")
        return Hook::RoomAfterLeave;
    if (value == "compose")
        return Hook::RoomCompose;
    return std::nullopt;
}

std::optional<runtime::ProjectHookSelector> parse_room_hook_selector(std::string_view value)
{
    using Kind = runtime::ProjectHookSelectorKind;
    if (value == "*")
        return runtime::ProjectHookSelector{
            runtime::ProjectHookSemanticKind::Room, Kind::Catchall, {}};
    if (value.empty() || value.find('*') != std::string_view::npos) {
        if (value.size() > 2 && value.ends_with(".*") &&
            value.substr(0, value.size() - 2).find('*') == std::string_view::npos) {
            return runtime::ProjectHookSelector{runtime::ProjectHookSemanticKind::Room,
                                                Kind::QualifiedPrefix,
                                                std::string(value.substr(0, value.size() - 1))};
        }
        return std::nullopt;
    }
    return runtime::ProjectHookSelector{runtime::ProjectHookSemanticKind::Room, Kind::Exact,
                                        std::string(value)};
}

bool selector_matches(const runtime::ProjectHookSelector& selector,
                      std::string_view target) noexcept
{
    switch (selector.kind) {
    case runtime::ProjectHookSelectorKind::Exact:
        return target == selector.value;
    case runtime::ProjectHookSelectorKind::QualifiedPrefix:
        return target.starts_with(selector.value);
    case runtime::ProjectHookSelectorKind::Catchall:
        return true;
    }
    return false;
}

int selector_specificity(const runtime::ProjectHookSelector& selector) noexcept
{
    switch (selector.kind) {
    case runtime::ProjectHookSelectorKind::Exact:
        return 3;
    case runtime::ProjectHookSelectorKind::QualifiedPrefix:
        return 2;
    case runtime::ProjectHookSelectorKind::Catchall:
        return 1;
    }
    return 0;
}

int focused_load(lua_State* state)
{
    std::size_t size = 0;
    const char* source = luaL_checklstring(state, 1, &size);
    const char* chunk = luaL_optstring(state, 2, "=(load)");
    const char* mode = luaL_optstring(state, 3, "t");
    if (!lua_isnoneornil(state, 4)) {
        lua_pushvalue(state, lua_upvalueindex(1));
        const bool same = lua_rawequal(state, 4, -1) != 0;
        lua_pop(state, 1);
        if (!same)
            return luaL_error(state, "focused load rejects an explicit foreign environment");
    }
    const int loaded = luaL_loadbufferx(state, source, size, chunk, mode);
    if (loaded != LUA_OK) {
        lua_pushnil(state);
        lua_insert(state, -2);
        return 2;
    }
    lua_pushvalue(state, lua_upvalueindex(1));
    if (lua_setupvalue(state, -2, 1) == nullptr)
        lua_pop(state, 1);
    return 1;
}

void clone_environment_value(lua_State* state, int index,
                             std::unordered_map<const void*, int>& cloned_references,
                             std::vector<int>& owned_references)
{
    index = lua_absindex(state, index);
    if (!lua_istable(state, index)) {
        lua_pushvalue(state, index);
        return;
    }
    const void* identity = lua_topointer(state, index);
    if (const auto found = cloned_references.find(identity); found != cloned_references.end()) {
        lua_rawgeti(state, LUA_REGISTRYINDEX, found->second);
        return;
    }
    lua_newtable(state);
    const int clone = lua_absindex(state, -1);
    lua_pushvalue(state, clone);
    const int reference = luaL_ref(state, LUA_REGISTRYINDEX);
    cloned_references.emplace(identity, reference);
    owned_references.push_back(reference);
    lua_pushnil(state);
    while (lua_next(state, index) != 0) {
        clone_environment_value(state, -2, cloned_references, owned_references);
        clone_environment_value(state, -2, cloned_references, owned_references);
        lua_rawset(state, clone);
        lua_pop(state, 1);
    }
    if (lua_getmetatable(state, index) != 0) {
        clone_environment_value(state, -1, cloned_references, owned_references);
        lua_setmetatable(state, clone);
        lua_pop(state, 1);
    }
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
        core::FlowFrameId owner;
        int thread_reference;
        std::string chunk;
        runtime::RuntimeCapabilityProfile profile;
        runtime::CapabilityGeneration generation;
    };

    enum class ModuleStatus : std::uint8_t {
        Unloaded,
        Loading,
        Loaded,
        Failed,
    };

    struct ProjectModule {
        std::string source;
        std::optional<std::string> asset_path;
        ModuleStatus status = ModuleStatus::Unloaded;
        ScriptEnvironmentHandle environment{};
        int exports_reference = LUA_NOREF;
        std::string failure;
        std::vector<std::string> dependencies;
    };

    sol::state lua{panic_handler};
    const runtime::ScriptSourcePort* sources = nullptr;
    bool initialized = false;
    sol::protected_function traceback;
    std::unordered_map<std::uint64_t, InvocationRecord> invocations;
    std::unique_ptr<RuntimeScriptApi> runtime_api;
    std::unordered_map<std::uint64_t, int> environments;
    std::uint64_t next_environment = 1;
    std::unordered_map<std::string, ProjectModule> project_modules;
    std::optional<std::string> bootstrap_module;
    std::vector<runtime::ProjectHookRegistration> project_hooks;
    bool bootstrap_running = false;
    bool bootstrap_complete = false;
    bool hooks_frozen = false;
    bool game_ready_running = false;

    lua_State* thread(int reference)
    {
        lua_rawgeti(lua.lua_state(), LUA_REGISTRYINDEX, reference);
        lua_State* result = lua_tothread(lua.lua_state(), -1);
        lua_pop(lua.lua_state(), 1);
        return result;
    }

    void release(int reference) { luaL_unref(lua.lua_state(), LUA_REGISTRYINDEX, reference); }

    int environment_reference(ScriptEnvironmentHandle handle) const
    {
        const auto found = environments.find(handle.value);
        return found == environments.end() ? LUA_NOREF : found->second;
    }
};

ScriptRuntime::ScriptRuntime() = default;
ScriptRuntime::~ScriptRuntime() { shutdown(); }

ScriptRuntime::ScopedEnvironmentActivation::ScopedEnvironmentActivation(
    ScopedEnvironmentActivation&& other) noexcept
    : m_runtime(std::exchange(other.m_runtime, nullptr)),
      m_previous_reference(std::exchange(other.m_previous_reference, LUA_NOREF))
{
}

ScriptRuntime::ScopedEnvironmentActivation&
ScriptRuntime::ScopedEnvironmentActivation::operator=(ScopedEnvironmentActivation&& other) noexcept
{
    if (this == &other)
        return *this;
    reset();
    m_runtime = std::exchange(other.m_runtime, nullptr);
    m_previous_reference = std::exchange(other.m_previous_reference, LUA_NOREF);
    return *this;
}

void ScriptRuntime::ScopedEnvironmentActivation::reset() noexcept
{
    if (m_runtime == nullptr)
        return;
    m_runtime->restore_environment(m_previous_reference);
    m_runtime = nullptr;
    m_previous_reference = LUA_NOREF;
}

ScriptRuntime::ScopedSourceOverride::ScopedSourceOverride(ScopedSourceOverride&& other) noexcept
    : m_runtime(std::exchange(other.m_runtime, nullptr)),
      m_previous(std::exchange(other.m_previous, nullptr))
{
}

ScriptRuntime::ScopedSourceOverride&
ScriptRuntime::ScopedSourceOverride::operator=(ScopedSourceOverride&& other) noexcept
{
    if (this == &other)
        return *this;
    reset();
    m_runtime = std::exchange(other.m_runtime, nullptr);
    m_previous = std::exchange(other.m_previous, nullptr);
    return *this;
}

void ScriptRuntime::ScopedSourceOverride::reset() noexcept
{
    if (m_runtime == nullptr)
        return;
    m_runtime->restore_sources(m_previous);
    m_runtime = nullptr;
    m_previous = nullptr;
}

core::Result<void, ScriptError> ScriptRuntime::initialize(ScriptRuntimeConfig config)
{
    using Result = core::Result<void, ScriptError>;
    if (is_initialized())
        return Result::success();
    if (!config.sources) {
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime requires a script source port",
                                          "initialize"));
    }

    m_impl = std::make_unique<Impl>();
    m_impl->sources = config.sources;
    m_impl->lua.open_libraries(sol::lib::base, sol::lib::coroutine, sol::lib::table,
                               sol::lib::string, sol::lib::math, sol::lib::utf8);
    m_impl->lua["os"] = sol::lua_nil;
    m_impl->lua["io"] = sol::lua_nil;
    m_impl->lua["debug"] = sol::lua_nil;
    m_impl->lua["package"] = sol::lua_nil;
    m_impl->lua["require"] = sol::lua_nil;
    m_impl->lua["dofile"] = sol::lua_nil;
    m_impl->lua["loadfile"] = sol::lua_nil;
    sol::table math = m_impl->lua["math"];
    math["random"] = sol::lua_nil;
    math["randomseed"] = sol::lua_nil;
    m_impl->lua.set_function("__noveltea_traceback", traceback_handler);
    m_impl->traceback = m_impl->lua["__noveltea_traceback"];
    sol::protected_function::set_default_handler(m_impl->traceback);
    bind_noveltea(m_impl->lua.lua_state());
    install_host_print(m_impl->lua.lua_state());
    lua_State* state = m_impl->lua.lua_state();
    lua_newtable(state);
    lua_pushlightuserdata(state, this);
    lua_pushcclosure(state, &ScriptRuntime::project_hook_register_callback, 1);
    lua_setfield(state, -2, "register");
    lua_setglobal(state, "hooks");
    m_impl->runtime_api = std::make_unique<RuntimeScriptApi>();
    bind_typed_script_host(m_impl->lua.lua_state(), m_impl->runtime_api.get());
    m_impl->initialized = true;
    return Result::success();
}

void ScriptRuntime::shutdown()
{
    if (m_impl) {
        if (m_impl->runtime_api)
            m_impl->runtime_api->clear_capabilities();
        clear_project_modules();
        m_impl->initialized = false;
        m_impl->invocations.clear();
        for (const auto& [_, reference] : m_impl->environments)
            m_impl->release(reference);
        m_impl->environments.clear();
        m_impl.reset();
    }
}

bool ScriptRuntime::is_initialized() const { return m_impl && m_impl->initialized; }

ScriptRuntime::ScopedSourceOverride
ScriptRuntime::override_sources(const runtime::ScriptSourcePort& sources) noexcept
{
    if (!m_impl)
        return {};
    const auto* previous = m_impl->sources;
    m_impl->sources = &sources;
    return ScopedSourceOverride(*this, previous);
}

void ScriptRuntime::restore_sources(const runtime::ScriptSourcePort* sources) noexcept
{
    if (m_impl)
        m_impl->sources = sources;
}

core::Result<void, ScriptError> ScriptRuntime::certify(std::string_view source,
                                                       std::string_view chunk_name)
{
    using Result = core::Result<void, ScriptError>;
    if (!is_initialized()) {
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized",
                                          std::string(chunk_name)));
    }

    const std::string chunk = prefixed_chunk(chunk_name);
    lua_State* state = m_impl->lua.lua_state();
    const int loaded = luaL_loadbufferx(state, source.data(), source.size(), chunk.c_str(), "t");
    if (loaded != LUA_OK) {
        const std::string message = lua_value_message(state, -1);
        lua_pop(state, 1);
        return Result::failure(make_error(ScriptErrorCode::LoadFailed, message, chunk, message));
    }
    lua_pop(state, 1);
    return Result::success();
}

core::Result<void, ScriptError> ScriptRuntime::certify_asset(std::string_view logical_asset_path)
{
    using Result = core::Result<void, ScriptError>;
    if (!is_initialized()) {
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized",
                                          std::string(logical_asset_path)));
    }
    auto text = m_impl->sources->read_script_source(logical_asset_path);
    if (!text) {
        return Result::failure(make_error(ScriptErrorCode::LoadFailed, text.error().message,
                                          std::string(logical_asset_path)));
    }
    return certify(*text.value_if(), "@" + std::string(logical_asset_path));
}

core::Result<void, runtime::ScriptInvocationError>
ScriptRuntime::certify_source(std::string_view source, std::string_view chunk_name)
{
    return certify(source, chunk_name);
}

core::Result<void, runtime::ScriptInvocationError>
ScriptRuntime::certify_asset_source(std::string_view logical_path)
{
    return certify_asset(logical_path);
}

void ScriptRuntime::clear_project_modules() noexcept
{
    if (!m_impl)
        return;
    for (auto& [_, module] : m_impl->project_modules) {
        if (module.exports_reference != LUA_NOREF)
            m_impl->release(module.exports_reference);
        if (module.environment)
            destroy_environment(module.environment);
    }
    m_impl->project_modules.clear();
    m_impl->bootstrap_module.reset();
    m_impl->project_hooks.clear();
    m_impl->bootstrap_running = false;
    m_impl->bootstrap_complete = false;
    m_impl->hooks_frozen = false;
    m_impl->game_ready_running = false;
}

core::Result<void, runtime::ScriptInvocationError>
ScriptRuntime::prepare_project_modules(const core::CompiledProject& project)
{
    using Result = core::Result<void, runtime::ScriptInvocationError>;
    if (!is_initialized() || !m_impl->runtime_api)
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized", "project-modules"));

    clear_project_modules();
    m_impl->runtime_api->clear_capabilities();
    for (const auto& resource : project.scripts()) {
        Impl::ProjectModule module;
        if (const auto* inline_source =
                std::get_if<core::compiled::InlineLuaSource>(&resource.source)) {
            module.source = inline_source->source;
        } else if (const auto* asset_source =
                       std::get_if<core::compiled::AssetScriptSource>(&resource.source)) {
            const auto* asset = project.find_asset(asset_source->asset);
            if (!asset) {
                return Result::failure(make_error(ScriptErrorCode::LoadFailed,
                                                  "Script Module '" + resource.id.text() +
                                                      "' references a missing source Asset",
                                                  "module:" + resource.id.text()));
            }
            module.asset_path = asset->path.find(":/") == std::string::npos
                                    ? "project:/" + asset->path
                                    : asset->path;
        }
        m_impl->project_modules.emplace(resource.id.text(), std::move(module));
    }
    m_impl->bootstrap_module = project.bootstrap_module().text();
    for (std::size_t room_index = 0; room_index < project.rooms().size(); ++room_index) {
        const auto& room = project.rooms()[room_index];
        for (std::size_t hook_index = 0; hook_index < room.script_hooks.size(); ++hook_index) {
            const auto& mapping = room.script_hooks[hook_index];
            m_impl->project_hooks.push_back(runtime::ProjectHookRegistration{
                .hook = project_hook_kind(mapping.hook),
                .selector = {runtime::ProjectHookSemanticKind::Room,
                             runtime::ProjectHookSelectorKind::Exact, room.identity.id.text()},
                .handler = {mapping.handler.module.text(), mapping.handler.export_name},
                .source = runtime::ProjectHookRegistrationSource::DirectDefinition,
                .source_path = "/definitions/rooms/" + std::to_string(room_index) +
                               "/scriptHooks/" + std::to_string(hook_index),
                .capability_profile = hook_capability_profile(project_hook_kind(mapping.hook)),
            });
        }
    }
    return Result::success();
}

int ScriptRuntime::project_import_callback(lua_State* state)
{
    auto* runtime = static_cast<ScriptRuntime*>(lua_touserdata(state, lua_upvalueindex(1)));
    if (runtime == nullptr)
        return luaL_error(state, "Project module loader is unavailable");

    std::size_t module_size = 0;
    const char* module = luaL_checklstring(state, 1, &module_size);
    std::optional<std::string_view> export_name;
    std::size_t export_size = 0;
    if (!lua_isnoneornil(state, 2)) {
        const char* export_text = luaL_checklstring(state, 2, &export_size);
        export_name = std::string_view(export_text, export_size);
    }
    std::optional<std::string_view> requester;
    std::size_t requester_size = 0;
    if (const char* requester_text = lua_tolstring(state, lua_upvalueindex(2), &requester_size))
        requester = std::string_view(requester_text, requester_size);
    if (auto error = runtime->push_project_import(state, std::string_view(module, module_size),
                                                  export_name, requester)) {
        lua_pushlstring(state, error->message.data(), error->message.size());
        // lua_error performs a non-local exit, so release C++ ownership before crossing it.
        error.reset();
        return lua_error(state);
    }
    return 1;
}

int ScriptRuntime::project_hook_register_callback(lua_State* state)
{
    auto* runtime = static_cast<ScriptRuntime*>(lua_touserdata(state, lua_upvalueindex(1)));
    if (runtime == nullptr || !runtime->m_impl)
        return luaL_error(state, "Project Hook Registry is unavailable");
    if (!runtime->m_impl->bootstrap_running || runtime->m_impl->hooks_frozen)
        return luaL_error(state, "Hook Registry registration is only available during Bootstrap");

    std::size_t semantic_size = 0;
    std::size_t hook_size = 0;
    std::size_t selector_size = 0;
    std::size_t module_size = 0;
    std::size_t export_size = 0;
    const char* semantic_text = luaL_checklstring(state, 1, &semantic_size);
    const char* hook_text = luaL_checklstring(state, 2, &hook_size);
    const char* selector_text = luaL_checklstring(state, 3, &selector_size);
    const char* module_text = luaL_checklstring(state, 4, &module_size);
    const char* export_text = luaL_checklstring(state, 5, &export_size);
    const std::string_view semantic(semantic_text, semantic_size);
    const std::string_view hook_name(hook_text, hook_size);
    const std::string_view selector_name(selector_text, selector_size);
    const std::string_view module_id(module_text, module_size);
    const std::string_view export_name(export_text, export_size);

    if (semantic != "room")
        return luaL_error(state, "Hook semantic kind '%s' is unsupported", semantic_text);
    if (module_id.empty() || export_name.empty())
        return luaL_error(state, "Hook handler module and export names must be non-empty");
    const auto hook = parse_project_hook_kind(hook_name);
    if (!hook)
        return luaL_error(state, "Room hook kind '%s' is unsupported", hook_text);
    const auto selector = parse_room_hook_selector(selector_name);
    if (!selector)
        return luaL_error(
            state,
            "Room Hook Selector '%s' must be exact, a trailing qualified-prefix wildcard like "
            "chapter.*, or '*'",
            selector_text);

    runtime->m_impl->project_hooks.push_back(runtime::ProjectHookRegistration{
        .hook = *hook,
        .selector = *selector,
        .handler = {std::string(module_id), std::string(export_name)},
        .source = runtime::ProjectHookRegistrationSource::Bootstrap,
        .source_path = "module:" + runtime->m_impl->bootstrap_module.value_or("bootstrap"),
        .capability_profile = hook_capability_profile(*hook),
    });
    return 0;
}

std::optional<ScriptError>
ScriptRuntime::push_project_import(lua_State* state, std::string_view module_id,
                                   std::optional<std::string_view> export_name,
                                   std::optional<std::string_view> requester)
{
    if (!is_initialized() || !m_impl->runtime_api)
        return make_error(ScriptErrorCode::NotInitialized, "ScriptRuntime is not initialized",
                          "module:" + std::string(module_id));

    auto found = m_impl->project_modules.find(std::string(module_id));
    if (found == m_impl->project_modules.end())
        return make_error(ScriptErrorCode::LoadFailed,
                          "Script Module '" + std::string(module_id) + "' does not exist",
                          "module:" + std::string(module_id));
    auto& module = found->second;
    if (requester) {
        auto owner = m_impl->project_modules.find(std::string(*requester));
        if (owner != m_impl->project_modules.end() &&
            std::find(owner->second.dependencies.begin(), owner->second.dependencies.end(),
                      module_id) == owner->second.dependencies.end())
            owner->second.dependencies.emplace_back(module_id);
    }
    if (m_impl->game_ready_running && module.status == Impl::ModuleStatus::Unloaded)
        return make_error(ScriptErrorCode::RuntimeFailed,
                          "On Game Ready cannot initialize Script Module '" +
                              std::string(module_id) + "'; import it during Bootstrap",
                          "module:" + std::string(module_id));
    if (module.status == Impl::ModuleStatus::Loading)
        return make_error(ScriptErrorCode::RuntimeFailed,
                          "Script Module import cycle detected at '" + std::string(module_id) + "'",
                          "module:" + std::string(module_id));
    if (module.status == Impl::ModuleStatus::Failed)
        return make_error(ScriptErrorCode::RuntimeFailed,
                          "Script Module '" + std::string(module_id) +
                              "' previously failed initialization: " + module.failure,
                          "module:" + std::string(module_id));

    if (module.status == Impl::ModuleStatus::Unloaded) {
        module.status = Impl::ModuleStatus::Loading;
        auto environment = create_environment();
        if (!environment) {
            module.status = Impl::ModuleStatus::Failed;
            module.failure = environment.error().message;
            return std::move(environment).error();
        }
        module.environment = *environment.value_if();
        const int environment_reference = m_impl->environment_reference(module.environment);
        lua_rawgeti(state, LUA_REGISTRYINDEX, environment_reference);
        lua_pushliteral(state, "import");
        lua_pushlightuserdata(state, this);
        lua_pushlstring(state, module_id.data(), module_id.size());
        lua_pushcclosure(state, &ScriptRuntime::project_import_callback, 2);
        lua_rawset(state, -3);
        lua_pop(state, 1);

        std::string asset_source;
        std::string_view source = module.source;
        std::string chunk = "@module:" + std::string(module_id);
        if (module.asset_path) {
            auto text = m_impl->sources->read_script_source(*module.asset_path);
            if (!text) {
                module.status = Impl::ModuleStatus::Failed;
                module.failure = text.error().message;
                destroy_environment(module.environment);
                module.environment = {};
                return make_error(ScriptErrorCode::LoadFailed, module.failure, *module.asset_path);
            }
            asset_source = std::move(*text.value_if());
            source = asset_source;
            chunk = "@" + *module.asset_path;
        }

        const int stack_base = lua_gettop(state);
        const int loaded =
            luaL_loadbufferx(state, source.data(), source.size(), chunk.c_str(), "t");
        if (loaded != LUA_OK) {
            module.status = Impl::ModuleStatus::Failed;
            module.failure = lua_value_message(state, -1);
            lua_settop(state, stack_base);
            destroy_environment(module.environment);
            module.environment = {};
            return make_error(ScriptErrorCode::LoadFailed, module.failure, chunk, module.failure);
        }
        lua_rawgeti(state, LUA_REGISTRYINDEX, environment_reference);
        if (lua_setupvalue(state, -2, 1) == nullptr)
            lua_pop(state, 1);

        m_impl->runtime_api->clear_capabilities();
        const int status = lua_pcall(state, 0, LUA_MULTRET, 0);
        if (status != LUA_OK) {
            const std::string raw = lua_value_message(state, -1);
            const auto error_code = status == LUA_YIELD ? ScriptErrorCode::YieldForbidden
                                                        : ScriptErrorCode::RuntimeFailed;
            luaL_traceback(state, state, raw.c_str(), 1);
            const std::string traceback = lua_value_message(state, -1);
            module.status = Impl::ModuleStatus::Failed;
            module.failure = raw;
            lua_settop(state, stack_base);
            destroy_environment(module.environment);
            module.environment = {};
            return make_error(error_code, raw, chunk, traceback);
        }
        const int returns = lua_gettop(state) - stack_base;
        if (returns != 1 || !lua_istable(state, -1)) {
            module.status = Impl::ModuleStatus::Failed;
            module.failure = "Script Modules must return exactly one exports table";
            lua_settop(state, stack_base);
            destroy_environment(module.environment);
            module.environment = {};
            return make_error(ScriptErrorCode::InvalidResult, module.failure, chunk);
        }
        module.exports_reference = luaL_ref(state, LUA_REGISTRYINDEX);
        module.status = Impl::ModuleStatus::Loaded;
    }

    lua_rawgeti(state, LUA_REGISTRYINDEX, module.exports_reference);
    if (export_name) {
        lua_pushlstring(state, export_name->data(), export_name->size());
        lua_rawget(state, -2);
        if (lua_isnil(state, -1)) {
            lua_pop(state, 2);
            return make_error(ScriptErrorCode::InvalidResult,
                              "Script Module '" + std::string(module_id) + "' has no export '" +
                                  std::string(*export_name) + "'",
                              "module:" + std::string(module_id));
        }
        lua_remove(state, -2);
    }
    return std::nullopt;
}

core::Result<void, runtime::ScriptInvocationError> ScriptRuntime::run_project_bootstrap()
{
    using Result = core::Result<void, runtime::ScriptInvocationError>;
    if (!is_initialized() || !m_impl->bootstrap_module)
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "Project Script Modules have not been prepared",
                                          "bootstrap"));
    if (m_impl->hooks_frozen)
        return Result::failure(make_error(ScriptErrorCode::RuntimeFailed,
                                          "Hook Registry is already frozen", "bootstrap"));
    m_impl->runtime_api->clear_capabilities();
    m_impl->bootstrap_running = true;
    struct BootstrapScope final {
        bool& active;
        ~BootstrapScope() { active = false; }
    } bootstrap_scope{m_impl->bootstrap_running};
    lua_State* state = m_impl->lua.lua_state();
    const int stack_base = lua_gettop(state);
    auto error = push_project_import(state, *m_impl->bootstrap_module, std::nullopt);
    lua_settop(state, stack_base);
    if (error)
        return Result::failure(std::move(*error));
    m_impl->bootstrap_complete = true;
    return Result::success();
}

core::Result<void, runtime::ScriptInvocationError> ScriptRuntime::freeze_project_hooks()
{
    using Result = core::Result<void, runtime::ScriptInvocationError>;
    if (!is_initialized() || !m_impl->bootstrap_complete)
        return Result::failure(make_error(
            ScriptErrorCode::NotInitialized,
            "Project Bootstrap must complete before Hook Registry freeze", "hook-registry"));
    if (m_impl->hooks_frozen)
        return Result::success();

    for (std::size_t index = 0; index < m_impl->project_hooks.size(); ++index) {
        const auto& candidate = m_impl->project_hooks[index];
        for (std::size_t previous = 0; previous < index; ++previous) {
            const auto& existing = m_impl->project_hooks[previous];
            if (candidate.hook == existing.hook &&
                candidate.selector.semantic_kind == existing.selector.semantic_kind &&
                candidate.selector.kind == existing.selector.kind &&
                candidate.selector.value == existing.selector.value) {
                return Result::failure(make_error(
                    ScriptErrorCode::RuntimeFailed,
                    "Duplicate Hook Registry mapping conflicts with '" + existing.source_path + "'",
                    candidate.source_path));
            }
        }
    }

    lua_State* state = m_impl->lua.lua_state();
    for (const auto& registration : m_impl->project_hooks) {
        const int stack_base = lua_gettop(state);
        auto error = push_project_import(state, registration.handler.module_id,
                                         registration.handler.export_name);
        if (error) {
            lua_settop(state, stack_base);
            error->chunk = registration.source_path;
            return Result::failure(std::move(*error));
        }
        if (!lua_isfunction(state, -1)) {
            const std::string type = lua_type_name(state, -1);
            lua_settop(state, stack_base);
            return Result::failure(make_error(ScriptErrorCode::InvalidResult,
                                              "Hook handler '" + registration.handler.module_id +
                                                  "#" + registration.handler.export_name +
                                                  "' must be a function, not " + type,
                                              registration.source_path));
        }
        lua_settop(state, stack_base);
    }

    m_impl->hooks_frozen = true;
    return Result::success();
}

core::Result<runtime::ProjectHookExplanation, runtime::ScriptInvocationError>
ScriptRuntime::explain_project_hook(runtime::ProjectHookSemanticKind semantic_kind,
                                    runtime::ProjectHookKind hook, std::string_view target) const
{
    using Result = core::Result<runtime::ProjectHookExplanation, runtime::ScriptInvocationError>;
    if (!is_initialized() || !m_impl->hooks_frozen)
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "Hook Registry is not frozen", "hook-registry"));

    runtime::ProjectHookExplanation explanation{
        .semantic_kind = semantic_kind,
        .hook = hook,
        .target = std::string(target),
        .winner = std::nullopt,
        .fallbacks = {},
        .frozen = true,
    };
    std::vector<const runtime::ProjectHookRegistration*> matches;
    for (const auto& registration : m_impl->project_hooks) {
        if (registration.hook == hook && registration.selector.semantic_kind == semantic_kind &&
            selector_matches(registration.selector, target))
            matches.push_back(&registration);
    }
    std::sort(matches.begin(), matches.end(), [](const auto* left, const auto* right) {
        const int left_specificity = selector_specificity(left->selector);
        const int right_specificity = selector_specificity(right->selector);
        if (left_specificity != right_specificity)
            return left_specificity > right_specificity;
        if (left->selector.kind == runtime::ProjectHookSelectorKind::QualifiedPrefix &&
            left->selector.value.size() != right->selector.value.size())
            return left->selector.value.size() > right->selector.value.size();
        return left->source_path < right->source_path;
    });
    if (!matches.empty()) {
        explanation.winner = *matches.front();
        for (std::size_t index = 1; index < matches.size(); ++index)
            explanation.fallbacks.push_back(*matches[index]);
    }
    return Result::success(std::move(explanation));
}

core::Result<void, runtime::ScriptInvocationError>
ScriptRuntime::run_project_on_game_ready(const runtime::RuntimeCapabilitySet& capabilities)
{
    using Result = core::Result<void, runtime::ScriptInvocationError>;
    if (!is_initialized() || !m_impl->runtime_api)
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized", "on-game-ready"));
    if (!m_impl->hooks_frozen)
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "Hook Registry must be frozen before On Game Ready",
                                          "on-game-ready"));
    if (capabilities.profile() != runtime::RuntimeCapabilityProfile::OnGameReady)
        return Result::failure(make_error(ScriptErrorCode::InvalidResult,
                                          "On Game Ready requires its read-only capability profile",
                                          "on-game-ready"));

    std::vector<std::string> loaded;
    for (const auto& [id, module] : m_impl->project_modules)
        if (module.status == Impl::ModuleStatus::Loaded)
            loaded.push_back(id);
    std::sort(loaded.begin(), loaded.end());

    std::unordered_set<std::string> visited;
    std::vector<std::string> ordered;
    const auto visit = [&](const auto& self, const std::string& id) -> void {
        if (!visited.emplace(id).second)
            return;
        const auto found = m_impl->project_modules.find(id);
        if (found == m_impl->project_modules.end())
            return;
        auto dependencies = found->second.dependencies;
        std::sort(dependencies.begin(), dependencies.end());
        for (const auto& dependency : dependencies) {
            const auto dependency_module = m_impl->project_modules.find(dependency);
            if (dependency_module != m_impl->project_modules.end() &&
                dependency_module->second.status == Impl::ModuleStatus::Loaded)
                self(self, dependency);
        }
        ordered.push_back(id);
    };
    for (const auto& id : loaded)
        visit(visit, id);

    m_impl->runtime_api->replace_capabilities(capabilities);
    struct CapabilityScope final {
        RuntimeScriptApi& api;
        ~CapabilityScope() { api.clear_capabilities(); }
    } capability_scope{*m_impl->runtime_api};
    m_impl->game_ready_running = true;
    struct ReadyScope final {
        bool& active;
        ~ReadyScope() { active = false; }
    } ready_scope{m_impl->game_ready_running};

    lua_State* state = m_impl->lua.lua_state();
    for (const auto& id : ordered) {
        const auto found = m_impl->project_modules.find(id);
        if (found == m_impl->project_modules.end())
            continue;
        auto& module = found->second;
        const int stack_base = lua_gettop(state);
        lua_rawgeti(state, LUA_REGISTRYINDEX, module.exports_reference);
        lua_getfield(state, -1, "on_ready");
        if (lua_isnil(state, -1)) {
            lua_settop(state, stack_base);
            continue;
        }
        if (!lua_isfunction(state, -1)) {
            lua_settop(state, stack_base);
            return Result::failure(
                make_error(ScriptErrorCode::InvalidResult,
                           "Script Module '" + id + "' export 'on_ready' must be a function",
                           "module:" + id + "#on_ready"));
        }
        lua_remove(state, -2);
        const int status = lua_pcall(state, 0, 0, 0);
        if (status != LUA_OK) {
            const std::string raw = lua_value_message(state, -1);
            luaL_traceback(state, state, raw.c_str(), 1);
            const std::string traceback = lua_value_message(state, -1);
            lua_settop(state, stack_base);
            const auto code = raw.find("yield") != std::string::npos
                                  ? ScriptErrorCode::YieldForbidden
                                  : ScriptErrorCode::RuntimeFailed;
            return Result::failure(make_error(code, raw, "module:" + id + "#on_ready", traceback));
        }
        lua_settop(state, stack_base);
    }
    return Result::success();
}

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
    auto text = m_impl->sources->read_script_source(logical_asset_path);
    if (!text) {
        return Result::failure(make_error(ScriptErrorCode::LoadFailed, text.error().message,
                                          std::string(logical_asset_path)));
    }
    return execute(*text.value_if(), "@" + std::string(logical_asset_path));
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

core::Result<ScriptEnvironmentHandle, ScriptError> ScriptRuntime::create_environment()
{
    using Result = core::Result<ScriptEnvironmentHandle, ScriptError>;
    if (!is_initialized())
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized", "environment"));
    lua_State* state = m_impl->lua.lua_state();
    lua_newtable(state);
    const int environment = lua_gettop(state);
    std::unordered_map<const void*, int> cloned_references;
    std::vector<int> owned_references;
    lua_pushglobaltable(state);
    lua_pushnil(state);
    while (lua_next(state, -2) != 0) {
        if (lua_type(state, -2) == LUA_TSTRING &&
            std::string_view(lua_tostring(state, -2)) == "_G") {
            lua_pop(state, 1);
            continue;
        }
        lua_pushvalue(state, -2);
        clone_environment_value(state, -2, cloned_references, owned_references);
        lua_rawset(state, environment);
        lua_pop(state, 1);
    }
    lua_pop(state, 1);
    for (const int reference : owned_references)
        luaL_unref(state, LUA_REGISTRYINDEX, reference);
    lua_pushliteral(state, "_G");
    lua_pushvalue(state, environment);
    lua_rawset(state, environment);
    lua_pushliteral(state, "load");
    lua_pushvalue(state, environment);
    lua_pushcclosure(state, focused_load, 1);
    lua_rawset(state, environment);
    const int reference = luaL_ref(state, LUA_REGISTRYINDEX);
    const ScriptEnvironmentHandle handle{m_impl->next_environment++};
    m_impl->environments.emplace(handle.value, reference);
    return Result::success(handle);
}

void ScriptRuntime::destroy_environment(ScriptEnvironmentHandle environment) noexcept
{
    if (!m_impl)
        return;
    const auto found = m_impl->environments.find(environment.value);
    if (found == m_impl->environments.end())
        return;
    m_impl->release(found->second);
    m_impl->environments.erase(found);
}

ScriptRuntime::ScopedEnvironmentActivation
ScriptRuntime::activate_environment(ScriptEnvironmentHandle environment) noexcept
{
    if (!m_impl)
        return {};
    const int environment_reference = m_impl->environment_reference(environment);
    if (environment_reference == LUA_NOREF)
        return {};
    lua_State* state = m_impl->lua.lua_state();
    lua_pushglobaltable(state);
    const int previous = luaL_ref(state, LUA_REGISTRYINDEX);
    lua_rawgeti(state, LUA_REGISTRYINDEX, environment_reference);
    lua_rawseti(state, LUA_REGISTRYINDEX, LUA_RIDX_GLOBALS);
    return ScopedEnvironmentActivation(*this, previous);
}

void ScriptRuntime::restore_environment(int previous_reference) noexcept
{
    if (!m_impl || previous_reference == LUA_NOREF)
        return;
    lua_State* state = m_impl->lua.lua_state();
    lua_rawgeti(state, LUA_REGISTRYINDEX, previous_reference);
    lua_rawseti(state, LUA_REGISTRYINDEX, LUA_RIDX_GLOBALS);
    luaL_unref(state, LUA_REGISTRYINDEX, previous_reference);
}

namespace {
template<class RuntimeImpl>
core::Result<ScriptValue, ScriptError>
run_in_environment(RuntimeImpl& impl, ScriptEnvironmentHandle environment, std::string_view source,
                   std::string_view chunk_name, bool expression)
{
    using Result = core::Result<ScriptValue, ScriptError>;
    const int environment_reference = impl.environment_reference(environment);
    if (environment_reference == LUA_NOREF)
        return Result::failure(make_error(ScriptErrorCode::StaleInvocation,
                                          "Lua environment handle is not active",
                                          std::string(chunk_name)));
    std::string buffer;
    if (expression) {
        buffer = "return ";
        buffer += source;
        source = buffer;
    }
    const std::string chunk = prefixed_chunk(chunk_name);
    lua_State* main = impl.lua.lua_state();
    lua_State* thread = lua_newthread(main);
    const int thread_reference = luaL_ref(main, LUA_REGISTRYINDEX);
    const int loaded = luaL_loadbufferx(thread, source.data(), source.size(), chunk.c_str(), "t");
    if (loaded != LUA_OK) {
        auto error = lua_failure(main, thread, ScriptErrorCode::LoadFailed, chunk);
        impl.release(thread_reference);
        return Result::failure(std::move(error));
    }
    lua_rawgeti(thread, LUA_REGISTRYINDEX, environment_reference);
    if (lua_setupvalue(thread, -2, 1) == nullptr)
        lua_pop(thread, 1);
    int returns = 0;
    const int status = lua_resume(thread, main, 0, &returns);
    if (status == LUA_YIELD) {
        impl.release(thread_reference);
        return Result::failure(make_error(ScriptErrorCode::YieldForbidden,
                                          "synchronous focused Lua attempted to yield", chunk));
    }
    if (status != LUA_OK) {
        auto error = lua_failure(main, thread, ScriptErrorCode::RuntimeFailed, chunk);
        impl.release(thread_reference);
        return Result::failure(std::move(error));
    }
    auto value =
        expression ? to_script_value(thread, returns, chunk) : Result::success(std::monostate{});
    impl.release(thread_reference);
    return value;
}
} // namespace

core::Result<void, ScriptError>
ScriptRuntime::execute_in_environment(ScriptEnvironmentHandle environment, std::string_view source,
                                      std::string_view chunk_name)
{
    using Result = core::Result<void, ScriptError>;
    if (!is_initialized())
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized",
                                          std::string(chunk_name)));
    auto result = run_in_environment(*m_impl, environment, source, chunk_name, false);
    return result ? Result::success() : Result::failure(std::move(result).error());
}

core::Result<bool, ScriptError> ScriptRuntime::evaluate_bool_in_environment(
    ScriptEnvironmentHandle environment, std::string_view expression, std::string_view chunk_name)
{
    using Result = core::Result<bool, ScriptError>;
    if (!is_initialized())
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized",
                                          std::string(chunk_name)));
    auto result = run_in_environment(*m_impl, environment, expression, chunk_name, true);
    if (!result)
        return Result::failure(std::move(result).error());
    if (const auto* value = std::get_if<bool>(result.value_if()))
        return Result::success(*value);
    return Result::failure(make_error(ScriptErrorCode::InvalidResult,
                                      "expression did not evaluate to bool",
                                      std::string(chunk_name)));
}

core::Result<std::string, ScriptError> ScriptRuntime::evaluate_string_in_environment(
    ScriptEnvironmentHandle environment, std::string_view expression, std::string_view chunk_name)
{
    using Result = core::Result<std::string, ScriptError>;
    if (!is_initialized())
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized",
                                          std::string(chunk_name)));
    auto result = run_in_environment(*m_impl, environment, expression, chunk_name, true);
    if (!result)
        return Result::failure(std::move(result).error());
    if (const auto* value = std::get_if<std::string>(result.value_if()))
        return Result::success(*value);
    return Result::failure(make_error(ScriptErrorCode::InvalidResult,
                                      "expression did not evaluate to string",
                                      std::string(chunk_name)));
}

core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>
ScriptRuntime::invoke_in_environment(ScriptEnvironmentHandle environment,
                                     const runtime::ScriptInvocationRequest& request,
                                     const runtime::RuntimeCapabilitySet& capabilities)
{
    using Result = core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>;
    if (!is_initialized() || !m_impl->runtime_api)
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized", request.chunk_name));
    if (request.owner || request.invocation)
        return Result::failure(make_error(ScriptErrorCode::YieldForbidden,
                                          "focused Lua invocation cannot yield",
                                          request.chunk_name));
    m_impl->runtime_api->replace_capabilities(capabilities);
    struct Scope final {
        RuntimeScriptApi& api;
        ~Scope() { api.clear_capabilities(); }
    } scope{*m_impl->runtime_api};
    if (request.result_kind == runtime::ScriptInvocationResultKind::Boolean) {
        auto value = evaluate_bool_in_environment(environment, request.source, request.chunk_name);
        return value ? Result::success(runtime::ScriptInvocationCompleted{*value.value_if()})
                     : Result::failure(std::move(value).error());
    }
    if (request.result_kind == runtime::ScriptInvocationResultKind::String) {
        auto value =
            evaluate_string_in_environment(environment, request.source, request.chunk_name);
        return value ? Result::success(runtime::ScriptInvocationCompleted{*value.value_if()})
                     : Result::failure(std::move(value).error());
    }
    std::string asset_source;
    std::string_view source = request.source;
    std::string chunk_name = request.chunk_name;
    if (request.asset_path) {
        auto text = m_impl->sources->read_script_source(*request.asset_path);
        if (!text)
            return Result::failure(
                make_error(ScriptErrorCode::LoadFailed, text.error().message, *request.asset_path));
        asset_source = std::move(*text.value_if());
        source = asset_source;
        chunk_name = "@" + *request.asset_path;
    }
    auto executed = execute_in_environment(environment, source, chunk_name);
    return executed ? Result::success(runtime::ScriptInvocationCompleted{})
                    : Result::failure(std::move(executed).error());
}

core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>
ScriptRuntime::invoke(const runtime::ScriptInvocationRequest& request,
                      const runtime::RuntimeCapabilitySet& capabilities)
{
    using Result = core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>;
    if (!is_initialized() || !m_impl->runtime_api) {
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized", request.chunk_name));
    }
    const bool yielding = request.owner.has_value() || request.invocation.has_value();
    if (request.owner.has_value() != request.invocation.has_value()) {
        return Result::failure(make_error(
            ScriptErrorCode::InvalidResult,
            "Script invocation must provide both Flow owner and invocation handle or neither",
            request.chunk_name));
    }
    if (yielding && !runtime::describe(capabilities.profile()).may_yield) {
        return Result::failure(
            make_error(ScriptErrorCode::YieldForbidden,
                       "Script capability profile does not admit yield-capable invocation",
                       request.chunk_name));
    }

    m_impl->runtime_api->replace_capabilities(capabilities);
    struct CapabilityScope final {
        RuntimeScriptApi& api;
        ~CapabilityScope() { api.clear_capabilities(); }
    } capability_scope{*m_impl->runtime_api};
    if (yielding) {
        if (request.result_kind != runtime::ScriptInvocationResultKind::None) {
            return Result::failure(
                make_error(ScriptErrorCode::InvalidResult,
                           "Yield-capable script invocation cannot request a synchronous result",
                           request.chunk_name));
        }
        return begin_invocation(request.source, request.chunk_name, *request.owner,
                                *request.invocation, capabilities.profile(),
                                capabilities.generation());
    }

    switch (request.result_kind) {
    case runtime::ScriptInvocationResultKind::None: {
        auto result = request.asset_path ? execute_asset(*request.asset_path)
                                         : execute(request.source, request.chunk_name);
        return result ? Result::success(runtime::ScriptInvocationCompleted{})
                      : Result::failure(std::move(result).error());
    }
    case runtime::ScriptInvocationResultKind::Boolean: {
        auto result = evaluate_bool(request.source, request.chunk_name);
        const auto* value = result.value_if();
        return value ? Result::success(runtime::ScriptInvocationCompleted{*value})
                     : Result::failure(std::move(result).error());
    }
    case runtime::ScriptInvocationResultKind::String: {
        auto result = evaluate_string(request.source, request.chunk_name);
        const auto* value = result.value_if();
        return value ? Result::success(runtime::ScriptInvocationCompleted{*value})
                     : Result::failure(std::move(result).error());
    }
    }
    return Result::failure(make_error(ScriptErrorCode::InvalidResult,
                                      "Script invocation result kind is invalid",
                                      request.chunk_name));
}

core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>
ScriptRuntime::resume(const core::ScriptInvocationHandle& invocation,
                      const runtime::RuntimeCapabilitySet& capabilities)
{
    using Result = core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>;
    if (!is_initialized() || !m_impl->runtime_api) {
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized", "resume"));
    }
    const auto found = m_impl->invocations.find(invocation.number());
    if (found == m_impl->invocations.end()) {
        return Result::failure(make_error(ScriptErrorCode::StaleInvocation,
                                          "Lua resume does not match an active invocation",
                                          "resume"));
    }
    if (found->second.profile != capabilities.profile() ||
        found->second.generation != capabilities.generation()) {
        return Result::failure(make_error(
            ScriptErrorCode::StaleInvocation,
            "Lua resume capability profile or generation does not match the active invocation",
            found->second.chunk));
    }
    m_impl->runtime_api->replace_capabilities(capabilities);
    struct CapabilityScope final {
        RuntimeScriptApi& api;
        ~CapabilityScope() { api.clear_capabilities(); }
    } capability_scope{*m_impl->runtime_api};
    return resume_invocation(invocation);
}

void ScriptRuntime::cancel(const core::ScriptInvocationHandle& invocation,
                           runtime::ScriptCancellationReason)
{
    cancel_invocation(invocation);
}

void ScriptRuntime::invalidate_capabilities(runtime::CapabilityGeneration) noexcept
{
    clear_runtime_capabilities();
}

void ScriptRuntime::replace_runtime_capabilities(
    runtime::RuntimeCapabilitySet capabilities) noexcept
{
    if (is_initialized() && m_impl->runtime_api)
        m_impl->runtime_api->replace_capabilities(std::move(capabilities));
}

void ScriptRuntime::clear_runtime_capabilities() noexcept
{
    if (is_initialized() && m_impl->runtime_api)
        m_impl->runtime_api->clear_capabilities();
}

core::Result<ScriptInvocationOutcome, ScriptError> ScriptRuntime::begin_invocation(
    std::string_view source, std::string_view chunk_name, const core::FlowFrameId& owner,
    const core::ScriptInvocationHandle& invocation, runtime::RuntimeCapabilityProfile profile,
    runtime::CapabilityGeneration generation)
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
        m_impl->invocations.emplace(
            invocation.number(),
            Impl::InvocationRecord{owner, reference, chunk, profile, generation});
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
ScriptRuntime::resume_invocation(const core::ScriptInvocationHandle& invocation)
{
    using Result = core::Result<ScriptInvocationOutcome, ScriptError>;
    if (!is_initialized()) {
        return Result::failure(make_error(ScriptErrorCode::NotInitialized,
                                          "ScriptRuntime is not initialized", "resume"));
    }
    const auto found = m_impl->invocations.find(invocation.number());
    if (found == m_impl->invocations.end()) {
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
        return Result::success(ScriptInvocationSuspended{found->second.owner, invocation});

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

void ScriptRuntime::cancel_invocation(const core::ScriptInvocationHandle& invocation) noexcept
{
    if (!is_initialized())
        return;
    const auto found = m_impl->invocations.find(invocation.number());
    if (found == m_impl->invocations.end())
        return;
    const int reference = found->second.thread_reference;
    m_impl->invocations.erase(found);
    m_impl->release(reference);
}

void ScriptRuntime::collect_garbage()
{
    if (is_initialized())
        m_impl->lua.collect_garbage();
}

lua_State* detail::ScriptRuntimeAccess::state(ScriptRuntime& runtime)
{
    return runtime.m_impl ? runtime.m_impl->lua.lua_state() : nullptr;
}

const lua_State* detail::ScriptRuntimeAccess::state(const ScriptRuntime& runtime)
{
    return runtime.m_impl ? runtime.m_impl->lua.lua_state() : nullptr;
}

std::size_t detail::ScriptRuntimeAccess::environment_count(const ScriptRuntime& runtime) noexcept
{
    return runtime.m_impl ? runtime.m_impl->environments.size() : 0;
}

} // namespace noveltea::script
