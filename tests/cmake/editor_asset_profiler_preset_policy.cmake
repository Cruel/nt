if(NOT DEFINED SOURCE_DIR)
    message(FATAL_ERROR "SOURCE_DIR is required")
endif()

file(READ "${SOURCE_DIR}/CMakeLists.txt" root_cmake)
if(NOT root_cmake MATCHES
        "option\\([ \n\r\t]*NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER[\n\r\t ]+\"[^\"]+\"[\n\r\t ]+OFF[ \n\r\t]*\\)")
    message(FATAL_ERROR "The editor asset profiler CMake option must default to OFF")
endif()
if(NOT root_cmake MATCHES
        "set\\(NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER_VALUE 1\\)")
    message(FATAL_ERROR "The enabled profiler option must produce numeric value 1")
endif()
if(NOT root_cmake MATCHES
        "set\\(NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER_VALUE 0\\)")
    message(FATAL_ERROR "The disabled profiler option must produce numeric value 0")
endif()

file(READ "${SOURCE_DIR}/CMakePresets.json" presets_json)

function(find_configure_preset out_index preset_name)
    string(JSON preset_count LENGTH "${presets_json}" configurePresets)
    math(EXPR last_preset "${preset_count} - 1")
    foreach(index RANGE 0 ${last_preset})
        string(JSON name GET "${presets_json}" configurePresets ${index} name)
        if(name STREQUAL preset_name)
            set(${out_index} ${index} PARENT_SCOPE)
            return()
        endif()
    endforeach()
    set(${out_index} -1 PARENT_SCOPE)
endfunction()

function(resolve_preset_option out_value preset_name option_name)
    find_configure_preset(preset_index "${preset_name}")
    if(preset_index EQUAL -1)
        message(FATAL_ERROR "Required configure preset not found: ${preset_name}")
    endif()

    string(JSON direct_value ERROR_VARIABLE direct_error GET "${presets_json}"
        configurePresets ${preset_index} cacheVariables "${option_name}")
    if(direct_error STREQUAL "NOTFOUND")
        set(${out_value} "${direct_value}" PARENT_SCOPE)
        return()
    endif()

    string(JSON inherits_type ERROR_VARIABLE inherits_error TYPE "${presets_json}"
        configurePresets ${preset_index} inherits)
    if(NOT inherits_error STREQUAL "NOTFOUND")
        set(${out_value} "__MISSING__" PARENT_SCOPE)
        return()
    endif()

    if(inherits_type STREQUAL "STRING")
        string(JSON parent_name GET "${presets_json}" configurePresets ${preset_index} inherits)
        resolve_preset_option(parent_value "${parent_name}" "${option_name}")
        set(${out_value} "${parent_value}" PARENT_SCOPE)
        return()
    endif()

    if(inherits_type STREQUAL "ARRAY")
        string(JSON parent_count LENGTH "${presets_json}" configurePresets ${preset_index} inherits)
        if(parent_count GREATER 0)
            math(EXPR last_parent "${parent_count} - 1")
            foreach(parent_index RANGE 0 ${last_parent})
                string(JSON parent_name GET "${presets_json}"
                    configurePresets ${preset_index} inherits ${parent_index})
                resolve_preset_option(parent_value "${parent_name}" "${option_name}")
                if(NOT parent_value STREQUAL "__MISSING__")
                    set(${out_value} "${parent_value}" PARENT_SCOPE)
                    return()
                endif()
            endforeach()
        endif()
    endif()

    set(${out_value} "__MISSING__" PARENT_SCOPE)
endfunction()

function(require_resolved_option preset_name option_name expected_value)
    resolve_preset_option(actual_value "${preset_name}" "${option_name}")
    if(actual_value STREQUAL "__MISSING__")
        set(actual_value OFF)
    endif()
    if(NOT actual_value STREQUAL expected_value)
        message(FATAL_ERROR
            "Preset ${preset_name} must resolve ${option_name}=${expected_value}, got ${actual_value}")
    endif()
endfunction()

function(require_preset_property preset_name property_name expected_value)
    find_configure_preset(preset_index "${preset_name}")
    if(preset_index EQUAL -1)
        message(FATAL_ERROR "Required configure preset not found: ${preset_name}")
    endif()
    string(JSON actual_value GET "${presets_json}"
        configurePresets ${preset_index} "${property_name}")
    if(NOT actual_value STREQUAL expected_value)
        message(FATAL_ERROR
            "Preset ${preset_name} must set ${property_name}=${expected_value}, got ${actual_value}")
    endif()
endfunction()

function(require_build_preset preset_name)
    string(JSON preset_count LENGTH "${presets_json}" buildPresets)
    math(EXPR last_preset "${preset_count} - 1")
    foreach(index RANGE 0 ${last_preset})
        string(JSON name GET "${presets_json}" buildPresets ${index} name)
        if(name STREQUAL preset_name)
            string(JSON configure_name GET "${presets_json}" buildPresets ${index} configurePreset)
            if(NOT configure_name STREQUAL preset_name)
                message(FATAL_ERROR
                    "Build preset ${preset_name} must use configure preset ${preset_name}")
            endif()
            return()
        endif()
    endforeach()
    message(FATAL_ERROR "Required build preset not found: ${preset_name}")
endfunction()

string(JSON configure_preset_count LENGTH "${presets_json}" configurePresets)
math(EXPR last_configure_preset "${configure_preset_count} - 1")
foreach(index RANGE 0 ${last_configure_preset})
    string(JSON preset_name GET "${presets_json}" configurePresets ${index} name)
    if(preset_name STREQUAL "linux-debug-editor-profiler" OR
       preset_name STREQUAL "linux-release-editor-profiler" OR
       preset_name STREQUAL "web-editor-preview")
        set(expected_value ON)
    else()
        set(expected_value OFF)
    endif()
    require_resolved_option("${preset_name}" NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
        "${expected_value}")
endforeach()

require_preset_property("linux-debug-editor-profiler" inherits "linux-debug")
require_preset_property("linux-debug-editor-profiler" binaryDir
    "\${sourceDir}/build/linux-debug-editor-profiler")
require_preset_property("linux-release-editor-profiler" inherits "linux-release")
require_preset_property("linux-release-editor-profiler" binaryDir
    "\${sourceDir}/build/linux-release-editor-profiler")
require_preset_property("web-editor-preview" inherits "web-release")
require_preset_property("web-editor-preview" binaryDir
    "\${sourceDir}/build/web-editor-preview")

require_resolved_option("web-editor-preview" NOVELTEA_BUILD_SANDBOX ON)
require_resolved_option("web-editor-preview" NOVELTEA_BUILD_PLAYER OFF)
require_resolved_option("web-editor-preview" NOVELTEA_ENABLE_DEVTOOLS OFF)
require_resolved_option("web-editor-preview" NOVELTEA_WEB_SHELL_FILE
    "\${sourceDir}/web/widget.html")

require_build_preset("linux-debug-editor-profiler")
require_build_preset("linux-release-editor-profiler")
require_build_preset("web-editor-preview")

file(READ "${SOURCE_DIR}/editor/scripts/build-engine-preview.mjs" preview_build_script)
string(FIND "${preview_build_script}"
    "const configureArgs = ['--preset', 'web-editor-preview'];" configure_preset_position)
if(configure_preset_position EQUAL -1)
    message(FATAL_ERROR "The editor preview configure step must use web-editor-preview")
endif()
if(NOT preview_build_script MATCHES
        "'--preset',[\n\r\t ]+'web-editor-preview'")
    message(FATAL_ERROR "The editor preview build step must use web-editor-preview")
endif()
string(FIND "${preview_build_script}" "'web-release'" release_preset_position)
if(NOT release_preset_position EQUAL -1)
    message(FATAL_ERROR "The editor preview build script must not reuse web-release")
endif()

file(READ "${SOURCE_DIR}/engine/CMakeLists.txt" engine_cmake)
if(NOT engine_cmake MATCHES
        "if\\(NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER\\)[\n\r\t ]+target_sources\\(noveltea_engine PRIVATE")
    message(FATAL_ERROR "Profiler implementation sources must be conditionally added to the engine")
endif()
if(NOT engine_cmake MATCHES
        "NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER=\\$\\{NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER_VALUE\\}")
    message(FATAL_ERROR "noveltea_engine must receive the numeric profiler compile definition")
endif()

file(READ "${SOURCE_DIR}/apps/sandbox/CMakeLists.txt" sandbox_cmake)
if(NOT sandbox_cmake MATCHES
        "NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER=\\$\\{NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER_VALUE\\}")
    message(FATAL_ERROR "noveltea-sandbox must receive the numeric profiler compile definition")
endif()
if(NOT sandbox_cmake MATCHES
        "if\\(NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER\\)[\n\r\t ]+string\\(REGEX REPLACE")
    message(FATAL_ERROR "Profiler Web exports must be appended only under the profiler gate")
endif()
foreach(required_export
        _noveltea_asset_profiler_snapshot
        _noveltea_asset_profiler_delta)
    string(FIND "${sandbox_cmake}" "${required_export}" export_position)
    if(export_position EQUAL -1)
        message(FATAL_ERROR "Missing conditional Web export ${required_export}")
    endif()
endforeach()

file(READ "${SOURCE_DIR}/web/widget.html" widget_html)
if(NOT widget_html MATCHES
        "nativeExportAvailable\\('noveltea_asset_profiler_snapshot'\\).+nativeExportAvailable\\('noveltea_asset_profiler_delta'\\).+\\['asset-profiler-v1'\\]")
    message(FATAL_ERROR
        "Widget capability must require both profiler exports before advertising asset-profiler-v1")
endif()

message(STATUS "Editor asset profiler preset and source policy verified")
