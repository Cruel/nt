if(NOT DEFINED SOL2_SOURCE_DIR)
    message(FATAL_ERROR "SOL2_SOURCE_DIR is required")
endif()

set(_compat53 "${SOL2_SOURCE_DIR}/include/sol/compatibility/compat-5.3.h")
set(_compat54 "${SOL2_SOURCE_DIR}/include/sol/compatibility/compat-5.4.h")
set(_state "${SOL2_SOURCE_DIR}/include/sol/state.hpp")

file(READ "${_compat53}" _compat53_text)
string(REPLACE
    "LUA_VERSION_NUM < 501 || LUA_VERSION_NUM > 504"
    "LUA_VERSION_NUM < 501 || LUA_VERSION_NUM > 505"
    _compat53_text
    "${_compat53_text}")
file(WRITE "${_compat53}" "${_compat53_text}")

file(READ "${_compat54}" _compat54_text)
string(REPLACE
    "defined(LUA_VERSION_NUM) && LUA_VERSION_NUM == 504"
    "defined(LUA_VERSION_NUM) && (LUA_VERSION_NUM == 504 || LUA_VERSION_NUM == 505)"
    _compat54_text
    "${_compat54_text}")
file(WRITE "${_compat54}" "${_compat54_text}")

file(READ "${_state}" _state_text)
if(NOT _state_text MATCHES "lua_newstate\\(alfunc, alpointer, 0\\)")
    string(REPLACE
        ": unique_base(lua_newstate(alfunc, alpointer)), state_view(unique_base::get()) {"
        "#if LUA_VERSION_NUM < 505\n\t\t: unique_base(lua_newstate(alfunc, alpointer)), state_view(unique_base::get()) {\n#else\n\t\t: unique_base(lua_newstate(alfunc, alpointer, 0)), state_view(unique_base::get()) {\n#endif"
        _state_text
        "${_state_text}")
    file(WRITE "${_state}" "${_state_text}")
endif()
