cmake_minimum_required(VERSION 3.24)

if(NOT DEFINED BUILD_DIR OR NOT DEFINED PLATFORM_NAME)
    message(FATAL_ERROR "BUILD_DIR and PLATFORM_NAME are required")
endif()

string(TOLOWER "${PLATFORM_NAME}" platform_name)

set(compile_database "${BUILD_DIR}/compile_commands.json")
if(NOT EXISTS "${compile_database}")
    message(FATAL_ERROR "Missing compile database: ${compile_database}")
endif()

file(READ "${compile_database}" commands)
string(JSON command_count LENGTH "${commands}")
math(EXPR last_command "${command_count} - 1")

set(required_source_fragments
    "/_deps/bgfx.cmake-src/bx/"
    "/_deps/bgfx.cmake-src/bimg/"
    "/_deps/bgfx.cmake-src/bgfx/"
    "/_deps/harfbuzz-src/"
    "/_deps/imgui-src/"
    "/_deps/rmlui-src/"
    "/_deps/rmlui_bgfx-src/"
    "/_deps/twink-src/")

set(found_dependency_commands 0)
set(found_first_party_commands 0)
if(platform_name STREQUAL "windows")
    set(required_compiler_flags "/GR-" "/EHs-c-")
    set(required_policy_include "/FI")
else()
    set(required_compiler_flags "-fno-exceptions" "-fno-rtti")
    set(required_policy_include "-include")
endif()

foreach(index RANGE 0 ${last_command})
    string(JSON source GET "${commands}" ${index} file)
    if(NOT source MATCHES "\\.(cc|cpp|cxx|C)$")
        continue()
    endif()

    set(is_first_party FALSE)
    foreach(fragment IN ITEMS "/engine/" "/apps/" "/tools/" "/tests/")
        string(FIND "${source}" "${fragment}" fragment_position)
        if(NOT fragment_position EQUAL -1 AND NOT source MATCHES "/_deps/")
            set(is_first_party TRUE)
            break()
        endif()
    endforeach()

    string(JSON command GET "${commands}" ${index} command)
    if(is_first_party)
        math(EXPR found_first_party_commands "${found_first_party_commands} + 1")
        foreach(required IN LISTS required_compiler_flags)
            string(FIND " ${command} " " ${required} " flag_position)
            if(flag_position EQUAL -1)
                message(FATAL_ERROR "First-party compile command lacks ${required}: ${source}")
            endif()
        endforeach()
        if(NOT command MATCHES "${required_policy_include}[^ ]*compiler_policy\\.hpp")
            message(FATAL_ERROR "First-party compile command lacks forced compiler_policy.hpp: ${source}")
        endif()
    endif()

    set(is_required FALSE)
    foreach(fragment IN LISTS required_source_fragments)
        string(FIND "${source}" "${fragment}" fragment_position)
        if(NOT fragment_position EQUAL -1)
            set(is_required TRUE)
            break()
        endif()
    endforeach()
    if(NOT is_required)
        continue()
    endif()

    math(EXPR found_dependency_commands "${found_dependency_commands} + 1")
    foreach(required IN LISTS required_compiler_flags)
        string(FIND " ${command} " " ${required} " flag_position)
        if(flag_position EQUAL -1)
            message(FATAL_ERROR "Dependency compile command lacks ${required}: ${source}")
        endif()
    endforeach()
    if(source MATCHES "/_deps/rmlui(_bgfx)?-src/")
        if(NOT command MATCHES "[/-]DRMLUI_CUSTOM_RTTI")
            message(FATAL_ERROR "RmlUi compile command lacks RMLUI_CUSTOM_RTTI: ${source}")
        endif()
        if(NOT command MATCHES "[/-]DITLIB_FLAT_MAP_NO_THROW")
            message(FATAL_ERROR "RmlUi compile command lacks ITLIB_FLAT_MAP_NO_THROW: ${source}")
        endif()
    endif()
endforeach()

if(found_dependency_commands EQUAL 0)
    message(FATAL_ERROR "No source-built C++ dependency commands were found")
endif()
if(found_first_party_commands EQUAL 0)
    message(FATAL_ERROR "No first-party C++ compile commands were found")
endif()

if(platform_name STREQUAL "linux")
    set(link_file "${BUILD_DIR}/apps/player/CMakeFiles/noveltea-player.dir/link.txt")
    if(NOT EXISTS "${link_file}")
        message(FATAL_ERROR "Missing Linux player link command: ${link_file}")
    endif()
    file(READ "${link_file}" link_command)
    if(link_command MATCHES "vcpkg_installed/x64-linux/")
        message(FATAL_ERROR "Runtime link graph contains an ordinary x64-linux vcpkg archive")
    endif()
    if(NOT link_command MATCHES "vcpkg_installed/x64-linux-noveltea/")
        message(FATAL_ERROR "Runtime link graph does not contain the NovelTea policy triplet")
    endif()
endif()

message(STATUS
    "Verified ${found_first_party_commands} first-party and ${found_dependency_commands} dependency C++ compile commands for ${platform_name}")
