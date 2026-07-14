cmake_minimum_required(VERSION 3.24)

if(NOT DEFINED SOURCE_ROOT OR NOT DEFINED ALLOWLIST)
    message(FATAL_ERROR "SOURCE_ROOT and ALLOWLIST are required")
endif()

if(NOT EXISTS "${ALLOWLIST}")
    message(FATAL_ERROR "JSON boundary allowlist does not exist: ${ALLOWLIST}")
endif()

set(approved_header_paths
    "engine/include/noveltea/core/compiled_package_codec.hpp"
    "engine/include/noveltea/core/compiled_project_codec.hpp"
    "engine/include/noveltea/core/editor_runtime_protocol.hpp"
    "engine/include/noveltea/core/json_access.hpp"
    "engine/include/noveltea/core/package_export.hpp"
    "engine/include/noveltea/core/rich_text_codec.hpp"
    "engine/include/noveltea/core/runtime_user_settings_codec.hpp"
    "engine/include/noveltea/core/save_state_codec.hpp"
    "engine/include/noveltea/render/material_codec.hpp"
    "engine/include/noveltea/script/compiled_runtime_loader.hpp")
list(APPEND approved_header_paths
    "engine/src/core/compiled_project_codec/internal.hpp"
    "engine/src/core/compiled_project_wire.hpp"
    "engine/src/core/save_state_codec/codec_internal.hpp")
set(json_markers
    "#include <nlohmann/"
    "#include \"nlohmann/"
    "nlohmann::json"
    "nlohmann::ordered_json"
    "nlohmann::basic_json"
    "nlohmann::adl_serializer"
    "ordered_json"
    "json_fwd.hpp")
set(forbidden_wrapper_patterns
    "(^|[^A-Za-z0-9_])(JsonValue|JsonObject|SerializedPayload|JsonPayload|JsonWrapper)([^A-Za-z0-9_]|$)")

file(STRINGS "${ALLOWLIST}" allowlist_lines)
set(allowlist_keys "")
set(allowlist_entries "")
foreach(line IN LISTS allowlist_lines)
    string(STRIP "${line}" line)
    if(line STREQUAL "" OR line MATCHES "^#")
        continue()
    endif()

    string(REPLACE "|" ";" fields "${line}")
    list(LENGTH fields field_count)
    if(NOT field_count EQUAL 6)
        message(FATAL_ERROR "Malformed JSON boundary allowlist entry (expected six fields): ${line}")
    endif()
    list(GET fields 0 path)
    list(GET fields 1 construct)
    list(GET fields 2 owner)
    list(GET fields 3 category)
    list(GET fields 4 rationale)
    list(GET fields 5 removal_condition)
    foreach(field_name path construct owner category rationale removal_condition)
        if("${${field_name}}" STREQUAL "")
            message(FATAL_ERROR "JSON boundary allowlist entry has an empty ${field_name}: ${line}")
        endif()
    endforeach()
    set(path_has_wildcard FALSE)
    foreach(wildcard "*" "?" "[")
        string(FIND "${path}" "${wildcard}" wildcard_position)
        if(NOT wildcard_position EQUAL -1)
            set(path_has_wildcard TRUE)
        endif()
    endforeach()
    string(FIND "${path}" ".." parent_path_position)
    if(path MATCHES "^/" OR NOT parent_path_position EQUAL -1 OR path_has_wildcard)
        message(FATAL_ERROR "JSON boundary allowlist path must be an exact repository-relative path: ${path}")
    endif()
    set(construct_has_wildcard FALSE)
    foreach(wildcard "*" "?" "[")
        string(FIND "${construct}" "${wildcard}" wildcard_position)
        if(NOT wildcard_position EQUAL -1)
            set(construct_has_wildcard TRUE)
        endif()
    endforeach()
    if(construct_has_wildcard)
        message(FATAL_ERROR "JSON boundary allowlist construct must be exact, not a wildcard: ${construct}")
    endif()
    if(NOT category MATCHES "^(external-boundary-codec|package-manifest-codec|editor-tool-protocol-adapter)$")
        message(FATAL_ERROR "JSON boundary allowlist category is not approved: ${category}")
    endif()
    if(NOT removal_condition STREQUAL "permanent external boundary" AND removal_condition STREQUAL "")
        message(FATAL_ERROR "JSON boundary allowlist entry needs a removal condition: ${line}")
    endif()
    if(NOT EXISTS "${SOURCE_ROOT}/${path}")
        message(FATAL_ERROR "Stale JSON boundary allowlist path: ${path}")
    endif()
    file(READ "${SOURCE_ROOT}/${path}" allowed_content)
    string(FIND "${allowed_content}" "${construct}" construct_position)
    if(construct_position EQUAL -1)
        message(FATAL_ERROR "Stale JSON boundary allowlist construct '${construct}' in ${path}")
    endif()
    set(key "${path}|${construct}")
    list(FIND allowlist_keys "${key}" duplicate_index)
    if(NOT duplicate_index EQUAL -1)
        message(FATAL_ERROR "Duplicate JSON boundary allowlist entry: ${key}")
    endif()
    list(APPEND allowlist_keys "${key}")
    list(APPEND allowlist_entries "${path}|${construct}")
endforeach()

file(GLOB_RECURSE headers
    "${SOURCE_ROOT}/engine/*.h" "${SOURCE_ROOT}/engine/*.hpp"
    "${SOURCE_ROOT}/apps/*.h" "${SOURCE_ROOT}/apps/*.hpp"
    "${SOURCE_ROOT}/tools/*.h" "${SOURCE_ROOT}/tools/*.hpp")
file(GLOB_RECURSE cpp_sources
    "${SOURCE_ROOT}/engine/*.cpp" "${SOURCE_ROOT}/engine/*.h" "${SOURCE_ROOT}/engine/*.hpp"
    "${SOURCE_ROOT}/apps/*.cpp" "${SOURCE_ROOT}/apps/*.h" "${SOURCE_ROOT}/apps/*.hpp"
    "${SOURCE_ROOT}/tools/*.cpp" "${SOURCE_ROOT}/tools/*.h" "${SOURCE_ROOT}/tools/*.hpp")

set(failures "")
foreach(header IN LISTS headers)
    file(RELATIVE_PATH relative "${SOURCE_ROOT}" "${header}")
    file(READ "${header}" content)
    list(FIND approved_header_paths "${relative}" approved_index)
    foreach(marker IN LISTS json_markers)
        string(FIND "${content}" "${marker}" marker_position)
        if(NOT marker_position EQUAL -1 AND approved_index EQUAL -1)
            set(allowed FALSE)
            foreach(entry IN LISTS allowlist_entries)
                string(REPLACE "|" ";" entry_fields "${entry}")
                list(GET entry_fields 0 allowed_path)
                list(GET entry_fields 1 allowed_construct)
                if(allowed_path STREQUAL relative AND marker STREQUAL allowed_construct)
                    set(allowed TRUE)
                endif()
            endforeach()
            if(NOT allowed)
                string(APPEND failures "\n  ${relative}: JSON marker '${marker}' is outside an approved boundary header")
            endif()
        endif()
    endforeach()
    foreach(pattern IN LISTS forbidden_wrapper_patterns)
        if(content MATCHES "${pattern}")
            string(APPEND failures "\n  ${relative}: forbidden opaque JSON wrapper")
        endif()
    endforeach()
endforeach()

foreach(source IN LISTS cpp_sources)
    file(RELATIVE_PATH relative "${SOURCE_ROOT}" "${source}")
    file(READ "${source}" content)
    if(content MATCHES "(^|[^A-Za-z0-9_])(to_json|from_json)[ \t\r\n]*\\(")
        string(APPEND failures "\n  ${relative}: ADL to_json/from_json codecs are forbidden")
    endif()
    if(content MATCHES "NLOHMANN_DEFINE_[A-Za-z0-9_]*")
        string(APPEND failures "\n  ${relative}: nlohmann serialization macros are forbidden")
    endif()
endforeach()

file(GLOB_RECURSE cmake_files
    "${SOURCE_ROOT}/CMakeLists.txt" "${SOURCE_ROOT}/cmake/*.cmake"
    "${SOURCE_ROOT}/engine/CMakeLists.txt" "${SOURCE_ROOT}/apps/CMakeLists.txt"
    "${SOURCE_ROOT}/tools/CMakeLists.txt" "${SOURCE_ROOT}/tests/CMakeLists.txt")
foreach(cmake_file IN LISTS cmake_files)
    file(RELATIVE_PATH relative "${SOURCE_ROOT}" "${cmake_file}")
    if(relative MATCHES "^build/" OR
       relative STREQUAL "cmake/VerifyJsonBoundaryPolicyChecker.cmake")
        continue()
    endif()
    file(READ "${cmake_file}" content)
    string(REGEX MATCHALL "target_link_libraries[ \t\r\n]*\\([^\\)]*\\)" link_commands
        "${content}")
    foreach(link_command IN LISTS link_commands)
        string(REGEX REPLACE "^target_link_libraries[ \t\r\n]*\\(" "" link_arguments
            "${link_command}")
        string(REGEX REPLACE "\\)$" "" link_arguments "${link_arguments}")
        string(REGEX REPLACE "[ \t\r\n]+" ";" link_arguments "${link_arguments}")
        set(link_visibility "")
        foreach(link_argument IN LISTS link_arguments)
            if(link_argument MATCHES "^(PRIVATE|PUBLIC|INTERFACE)$")
                set(link_visibility "${link_argument}")
            elseif(link_argument STREQUAL "nlohmann_json::nlohmann_json" AND
                   link_visibility MATCHES "^(PUBLIC|INTERFACE)$")
                string(APPEND failures "\n  ${relative}: nlohmann-json must not propagate through PUBLIC or INTERFACE linkage")
            endif()
        endforeach()
    endforeach()
endforeach()

if(failures)
    message(FATAL_ERROR "JSON boundary policy violations:${failures}")
endif()
