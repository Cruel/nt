if(NOT DEFINED BINARY_DIR OR NOT DEFINED EXPECTED_ENABLED)
    message(FATAL_ERROR "BINARY_DIR and EXPECTED_ENABLED are required")
endif()

if(EXPECTED_ENABLED)
    set(expected_numeric 1)
    set(expected_cache_value ON)
else()
    set(expected_numeric 0)
    set(expected_cache_value OFF)
endif()

file(READ "${BINARY_DIR}/CMakeCache.txt" cache_text)
if(NOT cache_text MATCHES
        "NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER:BOOL=${expected_cache_value}([\n\r]|$)")
    message(FATAL_ERROR
        "Configured profiler option does not match expected value ${expected_cache_value}")
endif()

file(READ "${BINARY_DIR}/compile_commands.json" compile_commands_json)
string(JSON command_count LENGTH "${compile_commands_json}")
math(EXPR last_command "${command_count} - 1")

set(engine_definition_verified FALSE)
set(sandbox_definition_verified FALSE)
set(profiler_source_count 0)

foreach(index RANGE 0 ${last_command})
    string(JSON source_file GET "${compile_commands_json}" ${index} file)
    string(JSON command GET "${compile_commands_json}" ${index} command)

    if(source_file MATCHES "/engine/src/core/editor_asset_profiler_service\\.cpp$")
        math(EXPR profiler_source_count "${profiler_source_count} + 1")
    endif()

    if(source_file MATCHES "/engine/src/engine\\.cpp$")
        if(NOT command MATCHES
                "NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER=${expected_numeric}([ \"]|$)")
            message(FATAL_ERROR
                "noveltea_engine does not compile with numeric profiler definition ${expected_numeric}")
        endif()
        set(engine_definition_verified TRUE)
    endif()

    if(source_file MATCHES "/apps/sandbox/sandbox_app\\.cpp$")
        if(NOT command MATCHES
                "NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER=${expected_numeric}([ \"]|$)")
            message(FATAL_ERROR
                "noveltea-sandbox does not compile with numeric profiler definition ${expected_numeric}")
        endif()
        set(sandbox_definition_verified TRUE)
    endif()
endforeach()

if(NOT engine_definition_verified)
    message(FATAL_ERROR "Could not find engine/src/engine.cpp in compile_commands.json")
endif()
if(NOT sandbox_definition_verified)
    message(FATAL_ERROR "Could not find apps/sandbox/sandbox_app.cpp in compile_commands.json")
endif()

if(EXPECTED_ENABLED)
    if(NOT profiler_source_count EQUAL 1)
        message(FATAL_ERROR
            "Profiler-enabled build must compile editor_asset_profiler_service.cpp exactly once")
    endif()
elseif(NOT profiler_source_count EQUAL 0)
    message(FATAL_ERROR
        "Profiler-disabled build must not compile editor_asset_profiler_service.cpp")
endif()

message(STATUS
    "Editor asset profiler build isolation verified (${expected_cache_value}, definition=${expected_numeric})")
