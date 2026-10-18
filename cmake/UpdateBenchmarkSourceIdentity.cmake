# The benchmark's source identity must follow the files actually compiled,
# not the Git state at CMake configure time or when the binary is launched.
if(NOT DEFINED SOURCE_ROOT OR NOT DEFINED OUTPUT_HEADER)
    message(FATAL_ERROR "SOURCE_ROOT and OUTPUT_HEADER are required")
endif()

find_program(BENCHMARK_GIT_EXECUTABLE NAMES git)
set(revision "unavailable")
set(dirty "nullptr")
set(fingerprint "unavailable")

if(BENCHMARK_GIT_EXECUTABLE)
    execute_process(
        COMMAND "${BENCHMARK_GIT_EXECUTABLE}" -C "${SOURCE_ROOT}" rev-parse --verify HEAD
        OUTPUT_VARIABLE current_revision
        OUTPUT_STRIP_TRAILING_WHITESPACE
        RESULT_VARIABLE revision_status
        ERROR_QUIET)
    string(LENGTH "${current_revision}" revision_length)
    if(revision_status EQUAL 0 AND current_revision MATCHES "^[0-9a-fA-F]+$"
       AND (revision_length EQUAL 40 OR revision_length EQUAL 64))
        set(revision "${current_revision}")
        execute_process(
            COMMAND "${BENCHMARK_GIT_EXECUTABLE}" -C "${SOURCE_ROOT}"
                diff --no-ext-diff --binary HEAD --
            OUTPUT_VARIABLE tracked_diff
            RESULT_VARIABLE diff_status
            ERROR_QUIET)
        if(diff_status EQUAL 0)
            if(tracked_diff STREQUAL "")
                set(dirty "false")
            else()
                set(dirty "true")
            endif()
            # Also disambiguate two builds from the same dirty checkout.
            string(SHA256 fingerprint "${revision}\n${tracked_diff}")
        endif()
    endif()
endif()

set(contents
    "#pragma once\n"
)
string(APPEND contents
    "#define NOVELTEA_BENCHMARK_REVISION \"${revision}\"\n"
    "#define NOVELTEA_BENCHMARK_SOURCE_DIRTY ${dirty}\n"
    "#define NOVELTEA_BENCHMARK_SOURCE_FINGERPRINT \"${fingerprint}\"\n")

get_filename_component(output_directory "${OUTPUT_HEADER}" DIRECTORY)
file(MAKE_DIRECTORY "${output_directory}")
set(temp_header "${OUTPUT_HEADER}.tmp")
file(WRITE "${temp_header}" "${contents}")
execute_process(
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${temp_header}" "${OUTPUT_HEADER}"
    RESULT_VARIABLE write_status)
file(REMOVE "${temp_header}")
if(NOT write_status EQUAL 0)
    message(FATAL_ERROR "Cannot update benchmark source identity header")
endif()
