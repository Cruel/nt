cmake_minimum_required(VERSION 3.24)

foreach(_required IN ITEMS
        SOURCE_DIR
        PATCH_FILE
        EXPECTED_PATCH_SHA256
        EXPECTED_PATCH_REVISION
        GIT_EXECUTABLE)
    if(NOT DEFINED ${_required} OR "${${_required}}" STREQUAL "")
        message(FATAL_ERROR "${_required} is required to apply a repository patch")
    endif()
endforeach()

if(NOT IS_DIRECTORY "${SOURCE_DIR}")
    message(FATAL_ERROR "Patch source directory does not exist: ${SOURCE_DIR}")
endif()
if(NOT EXISTS "${PATCH_FILE}")
    message(FATAL_ERROR "Repository patch does not exist: ${PATCH_FILE}")
endif()
if(NOT EXISTS "${GIT_EXECUTABLE}")
    message(FATAL_ERROR "Git executable does not exist: ${GIT_EXECUTABLE}")
endif()

file(SHA256 "${PATCH_FILE}" _actual_patch_sha256)
if(NOT _actual_patch_sha256 STREQUAL EXPECTED_PATCH_SHA256)
    message(FATAL_ERROR
        "Repository patch hash changed during dependency population. "
        "Expected ${EXPECTED_PATCH_SHA256}, got ${_actual_patch_sha256}: ${PATCH_FILE}")
endif()

# FetchContent source directories commonly live inside the NovelTea checkout's ignored build tree.
# Prevent Git from discovering the parent repository, otherwise `git apply` silently skips paths in
# the ignored dependency source directory instead of treating that directory as the patch root.
get_filename_component(_source_parent "${SOURCE_DIR}" DIRECTORY)
set(_git_apply_command
    "${CMAKE_COMMAND}" -E env "GIT_CEILING_DIRECTORIES=${_source_parent}"
    "${GIT_EXECUTABLE}" apply)

execute_process(
    COMMAND ${_git_apply_command} --check --whitespace=nowarn "${PATCH_FILE}"
    WORKING_DIRECTORY "${SOURCE_DIR}"
    RESULT_VARIABLE _check_result
    OUTPUT_VARIABLE _check_output
    ERROR_VARIABLE _check_error)

if(_check_result EQUAL 0)
    execute_process(
        COMMAND ${_git_apply_command} --whitespace=nowarn "${PATCH_FILE}"
        WORKING_DIRECTORY "${SOURCE_DIR}"
        RESULT_VARIABLE _apply_result
        OUTPUT_VARIABLE _apply_output
        ERROR_VARIABLE _apply_error)
    if(NOT _apply_result EQUAL 0)
        message(FATAL_ERROR
            "Repository patch passed its applicability check but failed to apply.\n"
            "Patch: ${PATCH_FILE}\nSource: ${SOURCE_DIR}\n${_apply_output}\n${_apply_error}")
    endif()
else()
    execute_process(
        COMMAND ${_git_apply_command} --reverse --check --whitespace=nowarn "${PATCH_FILE}"
        WORKING_DIRECTORY "${SOURCE_DIR}"
        RESULT_VARIABLE _reverse_result
        OUTPUT_VARIABLE _reverse_output
        ERROR_VARIABLE _reverse_error)
    if(NOT _reverse_result EQUAL 0)
        message(FATAL_ERROR
            "Repository patch does not apply cleanly and is not already applied.\n"
            "Patch: ${PATCH_FILE}\nSource: ${SOURCE_DIR}\n"
            "Forward check:\n${_check_output}\n${_check_error}\n"
            "Reverse check:\n${_reverse_output}\n${_reverse_error}")
    endif()
endif()

set(_marker "${SOURCE_DIR}/Include/RmlUi/Core/NovelTeaPatch.h")
if(NOT EXISTS "${_marker}")
    message(FATAL_ERROR "Repository patch did not produce its expected marker: ${_marker}")
endif()
file(READ "${_marker}" _marker_contents)
if(NOT _marker_contents MATCHES
   "RMLUI_NOVELTEA_PATCH_REVISION[ \t]+\"${EXPECTED_PATCH_REVISION}\"")
    message(FATAL_ERROR
        "Repository patch marker does not contain revision ${EXPECTED_PATCH_REVISION}: ${_marker}")
endif()

file(WRITE "${SOURCE_DIR}/.noveltea-patch-revision"
    "revision=${EXPECTED_PATCH_REVISION}\nsha256=${EXPECTED_PATCH_SHA256}\n")
message(STATUS
    "Applied repository patch ${EXPECTED_PATCH_REVISION} (${EXPECTED_PATCH_SHA256}) to ${SOURCE_DIR}")
