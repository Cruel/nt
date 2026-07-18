cmake_minimum_required(VERSION 3.25)

if(NOT DEFINED NOVELTEA_SOURCE_ROOT)
    get_filename_component(NOVELTEA_SOURCE_ROOT "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
endif()
file(REAL_PATH "${NOVELTEA_SOURCE_ROOT}" NOVELTEA_SOURCE_ROOT)

include("${CMAKE_CURRENT_LIST_DIR}/NovelTeaModuleFileClassification.cmake")

set(_expected_targets
    noveltea_domain
    noveltea_content
    noveltea_runtime
    noveltea_presentation
    noveltea_script_lua
    noveltea_engine
)

if(NOT NOVELTEA_MODULE_CLASSIFICATION_VERSION EQUAL 1)
    message(FATAL_ERROR
        "Unsupported NovelTea module file classification version: "
        "${NOVELTEA_MODULE_CLASSIFICATION_VERSION}")
endif()

if(NOT "${NOVELTEA_MODULE_CLASSIFICATION_TARGETS}" STREQUAL "${_expected_targets}")
    message(FATAL_ERROR
        "The Phase 5A classification must contain exactly the six approved production targets.\n"
        "Expected: ${_expected_targets}\n"
        "Actual:   ${NOVELTEA_MODULE_CLASSIFICATION_TARGETS}")
endif()

get_cmake_property(_defined_variables VARIABLES)
foreach(_variable IN LISTS _defined_variables)
    if(_variable MATCHES "^NOVELTEA_MODULE_FILES_(.+)$")
        set(_classified_target "${CMAKE_MATCH_1}")
        list(FIND _expected_targets "${_classified_target}" _classified_target_index)
        if(_classified_target_index EQUAL -1)
            message(FATAL_ERROR
                "Unexpected seventh classification target: ${_classified_target}")
        endif()
    endif()
endforeach()

file(GLOB_RECURSE _production_files
    LIST_DIRECTORIES FALSE
    RELATIVE "${NOVELTEA_SOURCE_ROOT}"
    "${NOVELTEA_SOURCE_ROOT}/engine/include/*.h"
    "${NOVELTEA_SOURCE_ROOT}/engine/include/*.hpp"
    "${NOVELTEA_SOURCE_ROOT}/engine/include/*.c"
    "${NOVELTEA_SOURCE_ROOT}/engine/include/*.cc"
    "${NOVELTEA_SOURCE_ROOT}/engine/include/*.cpp"
    "${NOVELTEA_SOURCE_ROOT}/engine/include/*.cxx"
    "${NOVELTEA_SOURCE_ROOT}/engine/src/*.h"
    "${NOVELTEA_SOURCE_ROOT}/engine/src/*.hpp"
    "${NOVELTEA_SOURCE_ROOT}/engine/src/*.c"
    "${NOVELTEA_SOURCE_ROOT}/engine/src/*.cc"
    "${NOVELTEA_SOURCE_ROOT}/engine/src/*.cpp"
    "${NOVELTEA_SOURCE_ROOT}/engine/src/*.cxx"
)
list(SORT _production_files)

set(_classified_files)
foreach(_target IN LISTS NOVELTEA_MODULE_CLASSIFICATION_TARGETS)
    set(_variable_name "NOVELTEA_MODULE_FILES_${_target}")
    if(NOT DEFINED ${_variable_name})
        message(FATAL_ERROR "Missing classification list for ${_target}")
    endif()

    set(_target_files "${${_variable_name}}")
    list(LENGTH _target_files _target_file_count)
    if(_target_file_count EQUAL 0)
        message(FATAL_ERROR "Classification list for ${_target} is empty")
    endif()

    foreach(_file IN LISTS _target_files)
        if(IS_ABSOLUTE "${_file}")
            message(FATAL_ERROR
                "Classification entries must be repository-relative: ${_file}")
        endif()
        if(NOT EXISTS "${NOVELTEA_SOURCE_ROOT}/${_file}")
            message(FATAL_ERROR
                "Classified production file does not exist: ${_file}")
        endif()

        list(FIND _production_files "${_file}" _production_index)
        if(_production_index EQUAL -1)
            message(FATAL_ERROR
                "Classification entry is outside the production source/header universe: ${_file}")
        endif()

        list(FIND _classified_files "${_file}" _duplicate_index)
        if(NOT _duplicate_index EQUAL -1)
            message(FATAL_ERROR
                "Production file has more than one primary target: ${_file}")
        endif()
        list(APPEND _classified_files "${_file}")
    endforeach()

    message(STATUS "${_target}: ${_target_file_count} files")
endforeach()

set(_missing_files "${_production_files}")
foreach(_file IN LISTS _classified_files)
    list(REMOVE_ITEM _missing_files "${_file}")
endforeach()

if(_missing_files)
    list(JOIN _missing_files "\n  - " _missing_text)
    message(FATAL_ERROR
        "Production files without a primary target:\n  - ${_missing_text}")
endif()

list(LENGTH _production_files _production_file_count)
list(LENGTH _classified_files _classified_file_count)
if(NOT _production_file_count EQUAL _classified_file_count)
    message(FATAL_ERROR
        "Classification count mismatch: ${_classified_file_count} classified, "
        "${_production_file_count} production files")
endif()

message(STATUS
    "NovelTea Phase 5A classification is complete: "
    "${_classified_file_count}/${_production_file_count} files, exactly one primary target each")
