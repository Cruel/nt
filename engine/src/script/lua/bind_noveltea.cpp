#include "script/lua/script_runtime_internal.hpp"

#include <lua.hpp>
#include <sol/sol.hpp>

#include <cstdio>
#include <functional>
#include <sstream>
#include <string>
#include <string_view>

namespace noveltea::script {
namespace {

std::string object_to_string(const sol::object& object)
{
    if (!object.valid() || object == sol::lua_nil)
        return "nil";
    switch (object.get_type()) {
    case sol::type::boolean:
        return object.as<bool>() ? "true" : "false";
    case sol::type::number:
        if (object.is<std::int64_t>()) {
            return std::to_string(object.as<std::int64_t>());
        }
        return std::to_string(object.as<double>());
    case sol::type::string:
        return object.as<std::string>();
    default:
        std::string result{"<"};
        result += sol::type_name(object.lua_state(), object.get_type());
        result += '>';
        return result;
    }
}

void log_line(std::string_view value)
{
    std::fprintf(stderr, "[lua] %.*s\n", static_cast<int>(value.size()), value.data());
}

void host_log(const sol::object& value) { log_line(object_to_string(value)); }

int host_print(lua_State* state)
{
    std::ostringstream out;
    const int count = lua_gettop(state);
    for (int i = 1; i <= count; ++i) {
        if (i > 1)
            out << '\t';
        out << object_to_string(sol::stack_object(state, i));
    }
    const auto line = out.str();
    log_line(line);
    const auto* sink = static_cast<const std::function<void(const ScriptDebugMessage&)>*>(
        lua_touserdata(state, lua_upvalueindex(1)));
    if (sink != nullptr && *sink) {
        ScriptDebugMessage message{.severity = ScriptDebugSeverity::Info,
                                   .message = line,
                                   .source = {},
                                   .line = std::nullopt};
        lua_Debug frame{};
        if (lua_getstack(state, 1, &frame) != 0 && lua_getinfo(state, "Sl", &frame) != 0) {
            if (frame.source != nullptr) {
                message.source = frame.source;
                if (!message.source.empty() &&
                    (message.source.front() == '@' || message.source.front() == '='))
                    message.source.erase(message.source.begin());
            }
            if (frame.currentline > 0)
                message.line = static_cast<std::uint32_t>(frame.currentline);
        }
        (*sink)(message);
    }
    return 0;
}

int debug_log(lua_State* state)
{
    const auto severity =
        static_cast<ScriptDebugSeverity>(lua_tointeger(state, lua_upvalueindex(1)));
    const auto* sink = static_cast<const std::function<void(const ScriptDebugMessage&)>*>(
        lua_touserdata(state, lua_upvalueindex(2)));
    if (sink == nullptr || !*sink)
        return 0;

    std::ostringstream out;
    const int count = lua_gettop(state);
    for (int i = 1; i <= count; ++i) {
        if (i > 1)
            out << '\t';
        out << object_to_string(sol::stack_object(state, i));
    }

    ScriptDebugMessage message{
        .severity = severity, .message = out.str(), .source = {}, .line = std::nullopt};
    lua_Debug frame{};
    if (lua_getstack(state, 1, &frame) != 0 && lua_getinfo(state, "Sl", &frame) != 0) {
        if (frame.source != nullptr) {
            message.source = frame.source;
            if (!message.source.empty() &&
                (message.source.front() == '@' || message.source.front() == '='))
                message.source.erase(message.source.begin());
        }
        if (frame.currentline > 0)
            message.line = static_cast<std::uint32_t>(frame.currentline);
    }
    (*sink)(message);
    return 0;
}

void set_debug_function(lua_State* state, const char* name, ScriptDebugSeverity severity,
                        const std::function<void(const ScriptDebugMessage&)>* debug_sink)
{
    lua_pushinteger(state, static_cast<lua_Integer>(severity));
    lua_pushlightuserdata(state,
                          const_cast<std::function<void(const ScriptDebugMessage&)>*>(debug_sink));
    lua_pushcclosure(state, debug_log, 2);
    lua_setfield(state, -2, name);
}

} // namespace

void bind_noveltea(lua_State* state)
{
    sol::state_view lua(state);
    sol::table noveltea = lua["noveltea"].get_or_create<sol::table>();
    noveltea.set_function("log", host_log);
    noveltea.set_function("echo", [](const sol::object& value) { return object_to_string(value); });
    noveltea.set_function("lua_version", [] { return std::string(LUA_VERSION); });
    noveltea.set_function("sol_version", [] {
        return std::to_string(SOL_VERSION_MAJOR) + "." + std::to_string(SOL_VERSION_MINOR) + "." +
               std::to_string(SOL_VERSION_PATCH);
    });
}

void install_host_print(lua_State* state,
                        const std::function<void(const ScriptDebugMessage&)>* debug_sink)
{
    lua_pushlightuserdata(state,
                          const_cast<std::function<void(const ScriptDebugMessage&)>*>(debug_sink));
    lua_pushcclosure(state, host_print, 1);
    lua_setglobal(state, "print");
}

void install_debug_api(lua_State* state,
                       const std::function<void(const ScriptDebugMessage&)>* debug_sink)
{
    lua_newtable(state);
    set_debug_function(state, "info", ScriptDebugSeverity::Info, debug_sink);
    set_debug_function(state, "warn", ScriptDebugSeverity::Warning, debug_sink);
    set_debug_function(state, "error", ScriptDebugSeverity::Error, debug_sink);
    lua_setglobal(state, "Debug");
}

} // namespace noveltea::script
