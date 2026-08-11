if(NOT DEFINED NOVELTEA_GIT_EXECUTABLE OR NOT DEFINED NOVELTEA_PATCH_SOURCE_DIR OR
   NOT DEFINED NOVELTEA_PATCH_FILE)
    message(FATAL_ERROR "ApplyGitPatchOnce.cmake requires Git, source directory, and patch paths")
endif()

execute_process(
    COMMAND "${NOVELTEA_GIT_EXECUTABLE}" rev-parse --show-toplevel
    WORKING_DIRECTORY "${NOVELTEA_PATCH_SOURCE_DIR}"
    OUTPUT_VARIABLE _noveltea_repository_root
    OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE _noveltea_repository_result
)
if(NOT _noveltea_repository_result EQUAL 0)
    message(FATAL_ERROR "Cannot locate the checkout containing ${NOVELTEA_PATCH_SOURCE_DIR}")
endif()
file(RELATIVE_PATH _noveltea_patch_source_relative
    "${_noveltea_repository_root}" "${NOVELTEA_PATCH_SOURCE_DIR}")

execute_process(
    COMMAND "${NOVELTEA_GIT_EXECUTABLE}" apply
        "--directory=${_noveltea_patch_source_relative}"
        --reverse --check "${NOVELTEA_PATCH_FILE}"
    RESULT_VARIABLE _noveltea_patch_already_applied
    OUTPUT_QUIET
    ERROR_QUIET
)
if(_noveltea_patch_already_applied EQUAL 0)
    return()
endif()

execute_process(
    COMMAND "${NOVELTEA_GIT_EXECUTABLE}" apply
        "--directory=${_noveltea_patch_source_relative}"
        "${NOVELTEA_PATCH_FILE}"
    RESULT_VARIABLE _noveltea_patch_result
    ERROR_VARIABLE _noveltea_patch_error
)
if(NOT _noveltea_patch_result EQUAL 0)
    message(FATAL_ERROR "Failed to apply ${NOVELTEA_PATCH_FILE}: ${_noveltea_patch_error}")
endif()
