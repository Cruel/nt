#include "script/lua/script_runtime_internal.hpp"

#include <lua.hpp>
#include <sol/sol.hpp>

#include <cstdio>
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
        return "<" + std::string(sol::type_name(object.lua_state(), object.get_type())) + ">";
    }
}

void log_line(std::string_view value)
{
    std::fprintf(stderr, "[lua] %.*s\n", static_cast<int>(value.size()), value.data());
}

void host_log(const sol::object& value) { log_line(object_to_string(value)); }

int host_print(lua_State* state)
{
    sol::state_view lua(state);
    std::ostringstream out;
    const int count = lua_gettop(state);
    for (int i = 1; i <= count; ++i) {
        if (i > 1)
            out << '\t';
        out << object_to_string(sol::stack_object(state, i));
    }
    log_line(out.str());
    return 0;
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

void install_host_print(lua_State* state)
{
    sol::state_view lua(state);
    lua.set_function("print", host_print);
}

} // namespace noveltea::script
