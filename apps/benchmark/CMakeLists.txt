if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
    message(FATAL_ERROR "NOVELTEA_BUILD_BENCHMARK_APP currently supports Linux only (#422)")
endif()

find_package(nlohmann_json CONFIG REQUIRED)
# Refresh source identity at every build, even if no C++ inputs changed. Only
# change the generated header when identity changes, so ordinary builds stay incremental.
set(NOVELTEA_BENCHMARK_IDENTITY_HEADER
    "${CMAKE_CURRENT_BINARY_DIR}/generated/benchmark_source_identity.hpp")
add_custom_target(noveltea-benchmark-source-identity
    COMMAND "${CMAKE_COMMAND}"
        "-DSOURCE_ROOT=${PROJECT_SOURCE_DIR}"
        "-DOUTPUT_HEADER=${NOVELTEA_BENCHMARK_IDENTITY_HEADER}"
        -P "${PROJECT_SOURCE_DIR}/cmake/UpdateBenchmarkSourceIdentity.cmake"
    BYPRODUCTS "${NOVELTEA_BENCHMARK_IDENTITY_HEADER}"
    VERBATIM)

add_library(noveltea-benchmark-runner STATIC
    benchmark_options.cpp benchmark_runner.cpp benchmark_report.cpp reference_scene.cpp)
add_dependencies(noveltea-benchmark-runner noveltea-benchmark-source-identity)
target_include_directories(noveltea-benchmark-runner PRIVATE
    "${CMAKE_CURRENT_BINARY_DIR}/generated")
target_link_libraries(noveltea-benchmark-runner PUBLIC nlohmann_json::nlohmann_json)
target_compile_definitions(noveltea-benchmark-runner PUBLIC
    ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
target_compile_definitions(noveltea-benchmark-runner PRIVATE
    NOVELTEA_BENCHMARK_BUILD_TYPE="${CMAKE_BUILD_TYPE}"
    NOVELTEA_BENCHMARK_COMPILER="${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}"
)
noveltea_apply_runtime_compiler_policy(noveltea-benchmark-runner)
noveltea_apply_policy_warnings(noveltea-benchmark-runner)

# Benchmark ImGui is independent of engine devtools, including in optimized builds.
find_package(imgui CONFIG REQUIRED)
add_executable(noveltea-benchmark-app
    main.cpp benchmark_dashboard.cpp benchmark_completed_run.cpp raw_bgfx_geometry.cpp
    standalone_rmlui.cpp integrated_rmlui.cpp)
target_link_libraries(noveltea-benchmark-app PRIVATE SDL3::SDL3 bgfx::bgfx
    imgui::imgui rmlui_bgfx::rmlui_bgfx RmlUi::Core noveltea_engine noveltea-benchmark-runner)
noveltea_attach_generated_shaders(noveltea-benchmark-app)
noveltea_attach_runtime_assets(noveltea-benchmark-app)
target_compile_definitions(noveltea-benchmark-app PRIVATE
    NOVELTEA_BENCHMARK_RESULTS_DIR="${CMAKE_BINARY_DIR}/benchmarks"
    NOVELTEA_BENCHMARK_SHADER_ROOT="assets/shaders/bgfx/glsl-330"
    NOVELTEA_BENCHMARK_FONT_PATH="assets/fonts/LiberationSans.ttf"
)
# The benchmark is relocatable: stage the same generated common system
# shaders and font as the runtime, without its Engine asset-management graph.
add_custom_target(noveltea-benchmark-stage-assets
    COMMAND "${CMAKE_COMMAND}" -E make_directory
        "${CMAKE_CURRENT_BINARY_DIR}/assets/fonts"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
        "${PROJECT_SOURCE_DIR}/engine/assets/system/fonts/LiberationSans.ttf"
        "${CMAKE_CURRENT_BINARY_DIR}/assets/fonts/LiberationSans.ttf"
    COMMAND "${CMAKE_COMMAND}" -E copy_directory
        "${NOVELTEA_ACTIVE_SHADER_ASSET_ROOT}/shaders/bgfx/glsl-330"
        "${CMAKE_CURRENT_BINARY_DIR}/assets/shaders/bgfx/glsl-330"
    # The integrated scenario needs the real Engine Lua bootstrap, UI baseline,
    # fonts and generated shaders in its *own* system:/ mount.
    COMMAND "${CMAKE_COMMAND}" -E copy_directory
        "${PROJECT_SOURCE_DIR}/engine/assets/system"
        "${CMAKE_CURRENT_BINARY_DIR}/assets/system"
    COMMAND "${CMAKE_COMMAND}" -E copy_directory
        "${NOVELTEA_ACTIVE_SHADER_ASSET_ROOT}/shaders"
        "${CMAKE_CURRENT_BINARY_DIR}/assets/system/shaders"
    VERBATIM)
if(TARGET noveltea-shaders)
    add_dependencies(noveltea-benchmark-stage-assets noveltea-shaders)
endif()
# Run staging even when only shader assets change and C++ does not relink.
add_dependencies(noveltea-benchmark-app noveltea-benchmark-stage-assets)
noveltea_apply_runtime_compiler_policy(noveltea-benchmark-app)
noveltea_apply_policy_warnings(noveltea-benchmark-app)

if(BUILD_TESTING)
    add_executable(noveltea-benchmark-runner-tests benchmark_runner_tests.cpp)
    target_link_libraries(noveltea-benchmark-runner-tests PRIVATE noveltea-benchmark-runner)
    noveltea_apply_runtime_compiler_policy(noveltea-benchmark-runner-tests)
    noveltea_apply_policy_warnings(noveltea-benchmark-runner-tests)
    add_test(NAME noveltea_benchmark_runner COMMAND noveltea-benchmark-runner-tests)
    add_test(NAME noveltea_benchmark_source_identity
        COMMAND "${CMAKE_COMMAND}"
            "-DTEST_ROOT=${CMAKE_CURRENT_BINARY_DIR}/source-identity-test"
            -P "${PROJECT_SOURCE_DIR}/cmake/TestBenchmarkSourceIdentity.cmake")

    add_executable(noveltea-benchmark-report-tests benchmark_report_tests.cpp)
    target_link_libraries(noveltea-benchmark-report-tests PRIVATE noveltea-benchmark-runner)
    noveltea_apply_runtime_compiler_policy(noveltea-benchmark-report-tests)
    noveltea_apply_policy_warnings(noveltea-benchmark-report-tests)
    add_test(NAME noveltea_benchmark_report COMMAND noveltea-benchmark-report-tests)

    add_executable(noveltea-benchmark-completed-run-tests
        benchmark_completed_run_tests.cpp benchmark_completed_run.cpp)
    target_link_libraries(noveltea-benchmark-completed-run-tests PRIVATE noveltea-benchmark-runner)
    noveltea_apply_runtime_compiler_policy(noveltea-benchmark-completed-run-tests)
    noveltea_apply_policy_warnings(noveltea-benchmark-completed-run-tests)
    add_test(NAME noveltea_benchmark_completed_run COMMAND noveltea-benchmark-completed-run-tests)

    add_executable(noveltea-benchmark-scene-tests reference_scene_tests.cpp)
    target_link_libraries(noveltea-benchmark-scene-tests PRIVATE noveltea-benchmark-runner)
    noveltea_apply_runtime_compiler_policy(noveltea-benchmark-scene-tests)
    noveltea_apply_policy_warnings(noveltea-benchmark-scene-tests)
    add_test(NAME noveltea_benchmark_reference_scene COMMAND noveltea-benchmark-scene-tests)

    add_executable(noveltea-benchmark-options-tests benchmark_options_tests.cpp)
    target_link_libraries(noveltea-benchmark-options-tests PRIVATE noveltea-benchmark-runner)
    noveltea_apply_runtime_compiler_policy(noveltea-benchmark-options-tests)
    noveltea_apply_policy_warnings(noveltea-benchmark-options-tests)
    add_test(NAME noveltea_benchmark_options COMMAND noveltea-benchmark-options-tests)
    add_test(NAME noveltea_benchmark_app_help COMMAND noveltea-benchmark-app --help)
    set_tests_properties(noveltea_benchmark_options noveltea_benchmark_report noveltea_benchmark_runner noveltea_benchmark_source_identity noveltea_benchmark_reference_scene noveltea_benchmark_completed_run noveltea_benchmark_app_help
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
        add_test(NAME noveltea_benchmark_geometry_graphics_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --scenario raw-bgfx-geometry --rect-count 24 --rect-scale 0.75 --smoke
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-geometry-smoke.json")
        set_tests_properties(noveltea_benchmark_geometry_graphics_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "complete: 30 frames"
            TIMEOUT 45)
        add_test(NAME noveltea_benchmark_rmlui_graphics_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --scenario standalone-rmlui-simple --smoke
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-rmlui-smoke.json")
        set_tests_properties(noveltea_benchmark_rmlui_graphics_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "complete: 30 frames"
            TIMEOUT 60)
        add_test(NAME noveltea_benchmark_integrated_rmlui_graphics_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --scenario integrated-rmlui-production --smoke
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-integrated-rmlui-smoke.json")
        set_tests_properties(noveltea_benchmark_integrated_rmlui_graphics_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "complete: 30 frames"
            TIMEOUT 90)
        add_test(NAME noveltea_benchmark_integrated_rmlui_repeat_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --scenario integrated-rmlui-production --smoke --repeats 2
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-integrated-rmlui-repeat.json")
        set_tests_properties(noveltea_benchmark_integrated_rmlui_repeat_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "complete: 60 frames across 2 trial"
            TIMEOUT 120)
        add_test(NAME noveltea_benchmark_integrated_rmlui_controlled_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --scenario integrated-rmlui-controlled --smoke
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-integrated-rmlui-controlled.json")
        set_tests_properties(noveltea_benchmark_integrated_rmlui_controlled_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "complete: 30 frames"
            TIMEOUT 90)
        add_test(NAME noveltea_benchmark_integrated_rmlui_dashboard_lifecycle_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --scenario integrated-rmlui-production --dashboard-smoke
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-integrated-lifecycle.json")
        set_tests_properties(noveltea_benchmark_integrated_rmlui_dashboard_lifecycle_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "dashboard cycle 3 complete"
            TIMEOUT 120)
        # Presented pixel check, outside all benchmark sampling. Optional on
        # minimal builders that do not install ImageMagick and Python.
        find_program(NOVELTEA_IMAGEMAGICK_IMPORT NAMES import)
        find_program(NOVELTEA_XWININFO NAMES xwininfo)
        find_package(Python3 COMPONENTS Interpreter QUIET)
        if(NOVELTEA_IMAGEMAGICK_IMPORT AND NOVELTEA_XWININFO AND Python3_Interpreter_FOUND)
            add_test(NAME noveltea_benchmark_dashboard_visual_smoke
                COMMAND "${NOVELTEA_XVFB_RUN}" -a "${Python3_EXECUTABLE}"
                    "${CMAKE_CURRENT_SOURCE_DIR}/dashboard_visual_smoke.py"
                    "$<TARGET_FILE:noveltea-benchmark-app>")
            set_tests_properties(noveltea_benchmark_dashboard_visual_smoke PROPERTIES
                LABELS "benchmark;graphics;visual"
                PASS_REGULAR_EXPRESSION "standalone and integrated text visibly equivalent"
                TIMEOUT 80)
        endif()
        add_test(NAME noveltea_benchmark_rmlui_dashboard_lifecycle_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --scenario standalone-rmlui-simple --dashboard-smoke
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-rmlui-dashboard-smoke.json")
        set_tests_properties(noveltea_benchmark_rmlui_dashboard_lifecycle_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "dashboard cycle 3 complete"
            TIMEOUT 60)
        add_test(NAME noveltea_benchmark_geometry_dashboard_lifecycle_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --scenario raw-bgfx-geometry --dashboard-smoke
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-geometry-dashboard-smoke.json")
        set_tests_properties(noveltea_benchmark_geometry_dashboard_lifecycle_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "dashboard cycle 3 complete"
            TIMEOUT 60)
        add_test(NAME noveltea_benchmark_dashboard_lifecycle_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --dashboard-smoke
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-dashboard-smoke.json")
        set_tests_properties(noveltea_benchmark_dashboard_lifecycle_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "dashboard cycle 3 complete"
            TIMEOUT 60)
    endif()
endif()
