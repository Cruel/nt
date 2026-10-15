if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
    message(FATAL_ERROR "NOVELTEA_BUILD_BENCHMARK_APP currently supports Linux only (#422)")
endif()

find_package(nlohmann_json CONFIG REQUIRED)
execute_process(COMMAND git rev-parse HEAD
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    OUTPUT_VARIABLE NOVELTEA_BENCHMARK_REVISION
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET)
if(NOT NOVELTEA_BENCHMARK_REVISION)
    set(NOVELTEA_BENCHMARK_REVISION "unavailable")
endif()
execute_process(COMMAND git diff --quiet HEAD
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    RESULT_VARIABLE NOVELTEA_BENCHMARK_GIT_DIRTY_STATUS
    ERROR_QUIET)
if(NOVELTEA_BENCHMARK_GIT_DIRTY_STATUS EQUAL 0)
    set(NOVELTEA_BENCHMARK_SOURCE_DIRTY false)
else()
    set(NOVELTEA_BENCHMARK_SOURCE_DIRTY true)
endif()

add_library(noveltea-benchmark-runner STATIC
    benchmark_options.cpp benchmark_runner.cpp benchmark_report.cpp)
target_link_libraries(noveltea-benchmark-runner PUBLIC nlohmann_json::nlohmann_json)
target_compile_definitions(noveltea-benchmark-runner PUBLIC
    ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
target_compile_definitions(noveltea-benchmark-runner PRIVATE
    NOVELTEA_BENCHMARK_REVISION="${NOVELTEA_BENCHMARK_REVISION}"
    NOVELTEA_BENCHMARK_SOURCE_DIRTY=${NOVELTEA_BENCHMARK_SOURCE_DIRTY}
    NOVELTEA_BENCHMARK_BUILD_TYPE="${CMAKE_BUILD_TYPE}"
    NOVELTEA_BENCHMARK_COMPILER="${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}"
)
noveltea_apply_runtime_compiler_policy(noveltea-benchmark-runner)
noveltea_apply_policy_warnings(noveltea-benchmark-runner)

add_executable(noveltea-benchmark-app main.cpp)
target_link_libraries(noveltea-benchmark-app PRIVATE SDL3::SDL3 bgfx::bgfx noveltea-benchmark-runner)
target_compile_definitions(noveltea-benchmark-app PRIVATE
    NOVELTEA_BENCHMARK_RESULTS_DIR="${CMAKE_BINARY_DIR}/benchmarks"
)
noveltea_apply_runtime_compiler_policy(noveltea-benchmark-app)
noveltea_apply_policy_warnings(noveltea-benchmark-app)

if(BUILD_TESTING)
    add_executable(noveltea-benchmark-runner-tests benchmark_runner_tests.cpp)
    target_link_libraries(noveltea-benchmark-runner-tests PRIVATE noveltea-benchmark-runner)
    noveltea_apply_runtime_compiler_policy(noveltea-benchmark-runner-tests)
    noveltea_apply_policy_warnings(noveltea-benchmark-runner-tests)
    add_test(NAME noveltea_benchmark_runner COMMAND noveltea-benchmark-runner-tests)

    add_executable(noveltea-benchmark-report-tests benchmark_report_tests.cpp)
    target_link_libraries(noveltea-benchmark-report-tests PRIVATE noveltea-benchmark-runner)
    noveltea_apply_runtime_compiler_policy(noveltea-benchmark-report-tests)
    noveltea_apply_policy_warnings(noveltea-benchmark-report-tests)
    add_test(NAME noveltea_benchmark_report COMMAND noveltea-benchmark-report-tests)

    add_executable(noveltea-benchmark-options-tests benchmark_options_tests.cpp)
    target_link_libraries(noveltea-benchmark-options-tests PRIVATE noveltea-benchmark-runner)
    noveltea_apply_runtime_compiler_policy(noveltea-benchmark-options-tests)
    noveltea_apply_policy_warnings(noveltea-benchmark-options-tests)
    add_test(NAME noveltea_benchmark_options COMMAND noveltea-benchmark-options-tests)
    add_test(NAME noveltea_benchmark_app_help COMMAND noveltea-benchmark-app --help)
    set_tests_properties(noveltea_benchmark_options noveltea_benchmark_report noveltea_benchmark_runner noveltea_benchmark_app_help
        PROPERTIES LABELS "benchmark;graphics")

    find_program(NOVELTEA_XVFB_RUN NAMES xvfb-run)
    if(NOVELTEA_XVFB_RUN)
        add_test(NAME noveltea_benchmark_app_graphics_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --smoke --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-smoke.json")
        set_tests_properties(noveltea_benchmark_app_graphics_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "complete: 30 frames"
            TIMEOUT 45)
    endif()
endif()
