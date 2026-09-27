cmake_minimum_required(VERSION 3.25)

set(NOVELTEA_CLANG_FORMAT_VERSION "18.1.8")
set(NOVELTEA_CLANG_FORMAT_BATCH_SIZE 64)

if(NOT DEFINED SOURCE_ROOT OR SOURCE_ROOT STREQUAL "")
    get_filename_component(SOURCE_ROOT "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
endif()

if(NOT DEFINED MODE OR MODE STREQUAL "")
    set(MODE "check")
endif()

if(NOT MODE STREQUAL "check" AND NOT MODE STREQUAL "format")
    message(FATAL_ERROR "MODE must be 'check' or 'format' (got '${MODE}')")
endif()

find_program(NOVELTEA_UV_EXECUTABLE NAMES uv)
if(NOT NOVELTEA_UV_EXECUTABLE)
    message(FATAL_ERROR
        "uv is required to run clang-format ${NOVELTEA_CLANG_FORMAT_VERSION}. "
        "Install uv and retry.")
endif()

file(GLOB_RECURSE NOVELTEA_FORMAT_SOURCES
    "${SOURCE_ROOT}/apps/*.cpp"
    "${SOURCE_ROOT}/apps/*.h"
    "${SOURCE_ROOT}/apps/*.hpp"
    "${SOURCE_ROOT}/engine/*.cpp"
    "${SOURCE_ROOT}/engine/*.h"
    "${SOURCE_ROOT}/engine/*.hpp"
    "${SOURCE_ROOT}/tests/*.cpp"
    "${SOURCE_ROOT}/tests/*.h"
    "${SOURCE_ROOT}/tests/*.hpp"
    "${SOURCE_ROOT}/tools/benchmark/*.cpp"
    "${SOURCE_ROOT}/tools/benchmark/*.h"
    "${SOURCE_ROOT}/tools/benchmark/*.hpp"
)
list(SORT NOVELTEA_FORMAT_SOURCES)

if(MODE STREQUAL "check")
    set(NOVELTEA_CLANG_FORMAT_ARGS --dry-run --Werror)
else()
    set(NOVELTEA_CLANG_FORMAT_ARGS -i)
endif()

list(LENGTH NOVELTEA_FORMAT_SOURCES NOVELTEA_FORMAT_SOURCE_COUNT)
set(NOVELTEA_FORMAT_OFFSET 0)

while(NOVELTEA_FORMAT_OFFSET LESS NOVELTEA_FORMAT_SOURCE_COUNT)
    math(EXPR NOVELTEA_FORMAT_REMAINING
        "${NOVELTEA_FORMAT_SOURCE_COUNT} - ${NOVELTEA_FORMAT_OFFSET}")
    if(NOVELTEA_FORMAT_REMAINING GREATER NOVELTEA_CLANG_FORMAT_BATCH_SIZE)
        set(NOVELTEA_FORMAT_COUNT ${NOVELTEA_CLANG_FORMAT_BATCH_SIZE})
    else()
        set(NOVELTEA_FORMAT_COUNT ${NOVELTEA_FORMAT_REMAINING})
    endif()

    list(SUBLIST NOVELTEA_FORMAT_SOURCES
        ${NOVELTEA_FORMAT_OFFSET}
        ${NOVELTEA_FORMAT_COUNT}
        NOVELTEA_FORMAT_BATCH)

    execute_process(
        COMMAND
            "${NOVELTEA_UV_EXECUTABLE}"
            tool run
            --from "clang-format==${NOVELTEA_CLANG_FORMAT_VERSION}"
            clang-format
            ${NOVELTEA_CLANG_FORMAT_ARGS}
            ${NOVELTEA_FORMAT_BATCH}
        WORKING_DIRECTORY "${SOURCE_ROOT}"
        RESULT_VARIABLE NOVELTEA_CLANG_FORMAT_RESULT
    )

    if(NOT NOVELTEA_CLANG_FORMAT_RESULT EQUAL 0)
        message(FATAL_ERROR
            "clang-format ${NOVELTEA_CLANG_FORMAT_VERSION} failed in ${MODE} mode")
    endif()

    math(EXPR NOVELTEA_FORMAT_OFFSET
        "${NOVELTEA_FORMAT_OFFSET} + ${NOVELTEA_FORMAT_COUNT}")
endwhile()

message(STATUS
    "clang-format ${NOVELTEA_CLANG_FORMAT_VERSION} ${MODE} passed for "
    "${NOVELTEA_FORMAT_SOURCE_COUNT} file(s)")
