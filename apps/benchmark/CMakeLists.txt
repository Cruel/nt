if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
    message(FATAL_ERROR "NOVELTEA_BUILD_BENCHMARK_APP currently supports Linux only (#422)")
endif()

add_executable(noveltea-benchmark-app main.cpp benchmark_options.cpp)
target_link_libraries(noveltea-benchmark-app PRIVATE SDL3::SDL3 bgfx::bgfx)
target_compile_definitions(noveltea-benchmark-app PRIVATE
    NOVELTEA_BENCHMARK_RESULTS_DIR="${CMAKE_BINARY_DIR}/benchmarks"
)
noveltea_apply_runtime_compiler_policy(noveltea-benchmark-app)
noveltea_apply_policy_warnings(noveltea-benchmark-app)

if(BUILD_TESTING)
    add_executable(noveltea-benchmark-options-tests
        benchmark_options.cpp
        benchmark_options_tests.cpp)
    noveltea_apply_runtime_compiler_policy(noveltea-benchmark-options-tests)
    noveltea_apply_policy_warnings(noveltea-benchmark-options-tests)
    add_test(NAME noveltea_benchmark_options COMMAND noveltea-benchmark-options-tests)
    add_test(NAME noveltea_benchmark_app_help COMMAND noveltea-benchmark-app --help)
    set_tests_properties(noveltea_benchmark_options noveltea_benchmark_app_help
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
