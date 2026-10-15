cmake_minimum_required(VERSION 3.25)

if(NOT DEFINED TEST_ROOT)
    message(FATAL_ERROR "TEST_ROOT is required")
endif()
find_program(TEST_GIT_EXECUTABLE NAMES git REQUIRED)

# Use an isolated synthetic repository to reproduce changes without modifying
# the developer's real checkout or asking CMake to reconfigure.
set(repo "${TEST_ROOT}/fixture")
set(header "${TEST_ROOT}/generated/benchmark_source_identity.hpp")
file(REMOVE_RECURSE "${TEST_ROOT}")
file(MAKE_DIRECTORY "${repo}")

function(run_checked)
    execute_process(COMMAND ${ARGN} RESULT_VARIABLE result OUTPUT_VARIABLE stdout
        ERROR_VARIABLE stderr)
    if(NOT result EQUAL 0)
        message(FATAL_ERROR "Command failed: ${ARGN}\n${stdout}\n${stderr}")
    endif()
endfunction()

function(regenerate)
    run_checked("${CMAKE_COMMAND}" "-DSOURCE_ROOT=${repo}" "-DOUTPUT_HEADER=${header}"
        -P "${CMAKE_CURRENT_LIST_DIR}/UpdateBenchmarkSourceIdentity.cmake")
endfunction()

function(require_contains expected)
    file(READ "${header}" actual)
    string(FIND "${actual}" "${expected}" position)
    if(position EQUAL -1)
        message(FATAL_ERROR "Expected generated header to contain '${expected}':\n${actual}")
    endif()
endfunction()

run_checked("${TEST_GIT_EXECUTABLE}" init -q "${repo}")
file(WRITE "${repo}/src.cpp" "initial\n")
run_checked("${TEST_GIT_EXECUTABLE}" -C "${repo}" add src.cpp)
run_checked("${TEST_GIT_EXECUTABLE}" -C "${repo}" -c user.name=Benchmark
    -c user.email=benchmark@example.test commit -qm initial)
execute_process(COMMAND "${TEST_GIT_EXECUTABLE}" -C "${repo}" rev-parse HEAD
    OUTPUT_VARIABLE first_revision OUTPUT_STRIP_TRAILING_WHITESPACE)
regenerate()
require_contains("NOVELTEA_BENCHMARK_REVISION \"${first_revision}\"")
require_contains("NOVELTEA_BENCHMARK_SOURCE_DIRTY false")
file(READ "${header}" clean_header)

# A no-op regeneration must preserve the dependency timestamp.
file(TIMESTAMP "${header}" original_time "%s")
run_checked("${CMAKE_COMMAND}" -E sleep 1.2)
regenerate()
file(TIMESTAMP "${header}" repeated_time "%s")
if(NOT original_time STREQUAL repeated_time)
    message(FATAL_ERROR "Unchanged source identity rewrote the generated header")
endif()

file(WRITE "${repo}/src.cpp" "modified first\n")
regenerate()
require_contains("NOVELTEA_BENCHMARK_SOURCE_DIRTY true")
file(READ "${header}" dirty_header)
if(dirty_header STREQUAL clean_header)
    message(FATAL_ERROR "Tracked worktree modification was not reflected at build time")
endif()

file(WRITE "${repo}/src.cpp" "modified second\n")
regenerate()
file(READ "${header}" second_dirty_header)
if(second_dirty_header STREQUAL dirty_header)
    message(FATAL_ERROR "Two different dirty source trees were not distinguished")
endif()

run_checked("${TEST_GIT_EXECUTABLE}" -C "${repo}" add src.cpp)
run_checked("${TEST_GIT_EXECUTABLE}" -C "${repo}" -c user.name=Benchmark
    -c user.email=benchmark@example.test commit -qm second)
execute_process(COMMAND "${TEST_GIT_EXECUTABLE}" -C "${repo}" rev-parse HEAD
    OUTPUT_VARIABLE second_revision OUTPUT_STRIP_TRAILING_WHITESPACE)
regenerate()
if(second_revision STREQUAL first_revision)
    message(FATAL_ERROR "Test repository HEAD did not advance")
endif()
require_contains("NOVELTEA_BENCHMARK_REVISION \"${second_revision}\"")
require_contains("NOVELTEA_BENCHMARK_SOURCE_DIRTY false")

# An empty commit also changes the source identity without touching C++ or
# regenerating the project's build system.
run_checked("${TEST_GIT_EXECUTABLE}" -C "${repo}" -c user.name=Benchmark
    -c user.email=benchmark@example.test commit --allow-empty -qm empty)
regenerate()
execute_process(COMMAND "${TEST_GIT_EXECUTABLE}" -C "${repo}" rev-parse HEAD
    OUTPUT_VARIABLE final_revision OUTPUT_STRIP_TRAILING_WHITESPACE)
require_contains("NOVELTEA_BENCHMARK_REVISION \"${final_revision}\"")
require_contains("NOVELTEA_BENCHMARK_SOURCE_DIRTY false")
