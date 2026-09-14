#include "script/lua/bind_wall_clock.hpp"
#include "noveltea/script/wall_clock.hpp"

#include <lua.hpp>

#include <cstring>
#include <limits>

namespace noveltea::script {
namespace {

const WallClock& provider(lua_State* state)
{
    return *static_cast<const WallClock*>(lua_touserdata(state, lua_upvalueindex(1)));
}

void set_integer(lua_State* state, const char* name, lua_Integer value)
{
    lua_pushinteger(state, value);
    lua_setfield(state, -2, name);
}

void push_calendar_fields(lua_State* state, const std::tm& value)
{
    set_integer(state, "year", lua_Integer(value.tm_year) + 1900);
    set_integer(state, "month", lua_Integer(value.tm_mon) + 1);
    set_integer(state, "day", value.tm_mday);
    set_integer(state, "hour", value.tm_hour);
    set_integer(state, "min", value.tm_min);
    set_integer(state, "sec", value.tm_sec);
    set_integer(state, "wday", value.tm_wday + 1);
    set_integer(state, "yday", value.tm_yday + 1);
    if (value.tm_isdst >= 0) {
        lua_pushboolean(state, value.tm_isdst);
        lua_setfield(state, -2, "isdst");
    }
}

int calendar_field(lua_State* state, const char* name, int fallback, int offset = 0)
{
    lua_getfield(state, 1, name);
    if (lua_isnil(state, -1)) {
        lua_pop(state, 1);
        if (fallback < 0)
            return luaL_error(state, "missing date field '%s'", name);
        return fallback;
    }
    int is_integer = 0;
    const auto value = lua_tointegerx(state, -1, &is_integer);
    if (!is_integer)
        return luaL_error(state, "date field '%s' must be an integer", name);
    if (value < lua_Integer(std::numeric_limits<int>::min()) + offset ||
        value > lua_Integer(std::numeric_limits<int>::max()) + offset)
        return luaL_error(state, "date field '%s' is out of range", name);
    lua_pop(state, 1);
    return static_cast<int>(value - offset);
}

bool supported_calendar(const std::tm& value)
{
    return value.tm_year >= -1899 && value.tm_year <= 8099;
}

int push_epoch(lua_State* state, std::int64_t epoch)
{
    // Lua's os.time reserves -1 for failure, even on hosts that can represent that instant.
    if (epoch == -1)
        return luaL_error(state, "time cannot be represented by the wall-clock provider");
    lua_pushinteger(state, epoch);
    return 1;
}

int wall_time(lua_State* state)
{
    if (lua_isnoneornil(state, 1))
        return push_epoch(state, provider(state).now());
    luaL_checktype(state, 1, LUA_TTABLE);
    lua_settop(state, 1);
    std::tm value{};
    value.tm_year = calendar_field(state, "year", -1, 1900);
    value.tm_mon = calendar_field(state, "month", -1, 1);
    value.tm_mday = calendar_field(state, "day", -1);
    value.tm_hour = calendar_field(state, "hour", 12);
    value.tm_min = calendar_field(state, "min", 0);
    value.tm_sec = calendar_field(state, "sec", 0);
    lua_getfield(state, 1, "isdst");
    value.tm_isdst = lua_isnil(state, -1) ? -1 : lua_toboolean(state, -1);
    lua_pop(state, 1);
    std::int64_t epoch = 0;
    if (!provider(state).local_time(value, epoch) || !supported_calendar(value))
        return luaL_error(state, "date cannot be represented by the wall-clock provider");
    push_calendar_fields(state, value);
    return push_epoch(state, epoch);
}

int wall_date(lua_State* state)
{
    std::size_t length = 0;
    const char* format = luaL_optlstring(state, 1, "%c", &length);
    const auto epoch =
        lua_isnoneornil(state, 2) ? provider(state).now() : luaL_checkinteger(state, 2);
    const bool utc = length > 0 && *format == '!';
    if (utc) {
        ++format;
        --length;
    }
    std::tm value{};
    if (!provider(state).calendar(epoch, utc, value) || !supported_calendar(value))
        return luaL_error(state, "date cannot be represented by the wall-clock provider");
    if (length == 2 && std::memcmp(format, "*t", 2) == 0) {
        lua_createtable(state, 0, 9);
        push_calendar_fields(state, value);
        return 1;
    }
    luaL_Buffer output;
    luaL_buffinit(state, &output);
    for (std::size_t index = 0; index < length; ++index) {
        if (format[index] != '%') {
            luaL_addchar(&output, format[index]);
            continue;
        }
        ++index;
        if (index == length || format[index] == '\0' ||
            std::strchr("aAbBcdHIjmMpSUwWxXyY%", format[index]) == nullptr)
            return luaL_argerror(state, 1, "unsupported date conversion specifier");
        // A prefix distinguishes a legitimate empty locale expansion (such as %p) from failure.
        const char conversion[]{' ', '%', format[index], '\0'};
        char buffer[256];
        const auto count = std::strftime(buffer, sizeof(buffer), conversion, &value);
        if (count == 0)
            return luaL_error(state, "date formatting failed");
        luaL_addlstring(&output, buffer + 1, count - 1);
    }
    luaL_pushresult(&output);
    return 1;
}

int difference(lua_State* state)
{
    const auto end = luaL_checkinteger(state, 1);
    const auto start = luaL_checkinteger(state, 2);
    // Subtract before converting to floating point, without signed overflow at epoch extremes.
    const auto magnitude = end >= start ? std::uint64_t(end) - std::uint64_t(start)
                                        : std::uint64_t(start) - std::uint64_t(end);
    const auto seconds = static_cast<lua_Number>(magnitude);
    lua_pushnumber(state, end >= start ? seconds : -seconds);
    return 1;
}

} // namespace

void bind_wall_clock(lua_State* state, const WallClock& clock)
{
    lua_newtable(state);
    lua_pushlightuserdata(state, const_cast<WallClock*>(&clock));
    lua_pushcclosure(state, wall_time, 1);
    lua_setfield(state, -2, "time");
    lua_pushlightuserdata(state, const_cast<WallClock*>(&clock));
    lua_pushcclosure(state, wall_date, 1);
    lua_setfield(state, -2, "date");
    lua_pushcfunction(state, difference);
    lua_setfield(state, -2, "difftime");
    lua_setglobal(state, "os");
}

} // namespace noveltea::script
