if(NOT DEFINED SOL2_SOURCE_DIR)
    message(FATAL_ERROR "SOL2_SOURCE_DIR is required")
endif()

set(_compat53 "${SOL2_SOURCE_DIR}/include/sol/compatibility/compat-5.3.h")
set(_compat54 "${SOL2_SOURCE_DIR}/include/sol/compatibility/compat-5.4.h")
set(_state "${SOL2_SOURCE_DIR}/include/sol/state.hpp")

foreach(_required IN ITEMS "${_compat53}" "${_compat54}" "${_state}")
    if(NOT EXISTS "${_required}")
        message(FATAL_ERROR "sol2 Lua 5.5 patch expected source file is missing: ${_required}")
    endif()
endforeach()

function(_noveltea_patch_once FILE UNPATCHED PATCHED LABEL)
    file(READ "${FILE}" _text)
    string(FIND "${_text}" "${PATCHED}" _patched_pos)
    string(FIND "${_text}" "${UNPATCHED}" _unpatched_pos)
    if(_patched_pos GREATER_EQUAL 0)
        return()
    endif()
    if(_unpatched_pos LESS 0)
        message(FATAL_ERROR "sol2 Lua 5.5 patch ${LABEL} found neither expected unpatched nor patched text in ${FILE}")
    endif()
    string(REPLACE "${UNPATCHED}" "${PATCHED}" _text "${_text}")
    string(FIND "${_text}" "${PATCHED}" _verified_pos)
    if(_verified_pos LESS 0)
        message(FATAL_ERROR "sol2 Lua 5.5 patch ${LABEL} replacement was not applied in ${FILE}")
    endif()
    string(FIND "${_text}" "${UNPATCHED}" _remaining_pos)
    if(_remaining_pos GREATER_EQUAL 0)
        message(FATAL_ERROR "sol2 Lua 5.5 patch ${LABEL} left expected unpatched text in ${FILE}")
    endif()
    file(WRITE "${FILE}" "${_text}")
endfunction()

_noveltea_patch_once(
    "${_compat53}"
    "LUA_VERSION_NUM < 501 || LUA_VERSION_NUM > 504"
    "LUA_VERSION_NUM < 501 || LUA_VERSION_NUM > 505"
    "compat-5.3 version guard")

_noveltea_patch_once(
    "${_compat54}"
    "defined(LUA_VERSION_NUM) && LUA_VERSION_NUM == 504"
    "defined(LUA_VERSION_NUM) && (LUA_VERSION_NUM == 504 || LUA_VERSION_NUM == 505)"
    "compat-5.4 version guard")

_noveltea_patch_once(
    "${_state}"
    ": unique_base(lua_newstate(alfunc, alpointer)), state_view(unique_base::get()) {"
    "#if LUA_VERSION_NUM < 505\n\t\t: unique_base(lua_newstate(alfunc, alpointer)), state_view(unique_base::get()) {\n#else\n\t\t: unique_base(lua_newstate(alfunc, alpointer, 0)), state_view(unique_base::get()) {\n#endif"
    "lua_newstate allocator signature")
