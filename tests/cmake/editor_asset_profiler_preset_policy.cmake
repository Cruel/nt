if(NOT DEFINED SOURCE_DIR)
    message(FATAL_ERROR "SOURCE_DIR is required")
endif()

file(READ "${SOURCE_DIR}/CMakeLists.txt" root_cmake)
if(NOT root_cmake MATCHES
        "option\\([ \n\r\t]*NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER[\n\r\t ]+\"[^\"]+\"[\n\r\t ]+OFF[ \n\r\t]*\\)")
    message(FATAL_ERROR "The editor asset profiler CMake option must default to OFF")
endif()

file(READ "${SOURCE_DIR}/CMakePresets.json" presets_json)

function(require_preset_option preset_name expected_value)
    string(JSON preset_count LENGTH "${presets_json}" configurePresets)
    math(EXPR last_preset "${preset_count} - 1")
    foreach(index RANGE 0 ${last_preset})
        string(JSON name GET "${presets_json}" configurePresets ${index} name)
        if(name STREQUAL preset_name)
            string(JSON actual_value GET "${presets_json}" configurePresets ${index}
                cacheVariables NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER)
            if(NOT actual_value STREQUAL expected_value)
                message(FATAL_ERROR
                    "Preset ${preset_name} must set NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER=${expected_value}")
            endif()
            return()
        endif()
    endforeach()
    message(FATAL_ERROR "Required preset not found: ${preset_name}")
endfunction()

foreach(release_preset IN ITEMS linux-release windows-release macos-release web-release)
    require_preset_option("${release_preset}" "OFF")
endforeach()

require_preset_option("linux-debug-editor-profiler" "ON")
require_preset_option("web-editor-preview" "ON")

message(STATUS "Editor asset profiler preset policy verified")
