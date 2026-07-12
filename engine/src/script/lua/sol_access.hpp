#pragma once

#include <sol/sol.hpp>

#include <cstdio>
#include <string_view>

namespace noveltea::script::detail {

template<class T>
[[nodiscard]] T* registry_pointer(sol::state_view lua, std::string_view key) noexcept
{
    sol::object value = lua.registry()[key];
    if (!value.valid() || value == sol::lua_nil || !value.is<T*>()) {
        return nullptr;
    }
    return value.as<T*>();
}

[[nodiscard]] inline bool registry_bool(sol::state_view lua, std::string_view key,
                                        bool fallback = false) noexcept
{
    sol::object value = lua.registry()[key];
    if (!value.valid() || value == sol::lua_nil || !value.is<bool>()) {
        return fallback;
    }
    return value.as<bool>();
}

inline void log_protected_failure(std::string_view context,
                                  const sol::protected_function_result& result) noexcept
{
    if (result.valid()) {
        return;
    }
    const int index = result.stack_index();
    lua_State* state = result.lua_state();
    const char* message = state ? lua_tostring(state, index) : nullptr;
    std::fprintf(stderr, "[lua] %.*s failed: %s\n", static_cast<int>(context.size()),
                 context.data(), message ? message : "unknown Lua error");
}

} // namespace noveltea::script::detail
