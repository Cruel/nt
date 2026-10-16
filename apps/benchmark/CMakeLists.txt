if(NOT CMAKE_SYSTEM_NAME MATCHES "^(Linux|Android|Emscripten)$")
    message(FATAL_ERROR "NOVELTEA_BUILD_BENCHMARK_APP supports Linux, Android, and Web")
endif()

if(NOT TARGET nlohmann_json::nlohmann_json)
    find_package(nlohmann_json CONFIG REQUIRED)
endif()
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
    benchmark_options.cpp benchmark_runner.cpp benchmark_frame_driven.cpp
    benchmark_report.cpp reference_scene.cpp reference_workloads.cpp)
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
if((ANDROID OR EMSCRIPTEN) AND NOT TARGET imgui::imgui)
    include(FetchContent)
    FetchContent_Declare(imgui
        URL https://github.com/ocornut/imgui/archive/refs/tags/v1.92.8-docking.tar.gz
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
    FetchContent_MakeAvailable(imgui)
    add_library(noveltea-benchmark-imgui STATIC
        "${imgui_SOURCE_DIR}/imgui.cpp"
        "${imgui_SOURCE_DIR}/imgui_draw.cpp"
        "${imgui_SOURCE_DIR}/imgui_tables.cpp"
        "${imgui_SOURCE_DIR}/imgui_widgets.cpp"
        "${imgui_SOURCE_DIR}/backends/imgui_impl_sdl3.cpp")
    target_include_directories(noveltea-benchmark-imgui PUBLIC
        "${imgui_SOURCE_DIR}" "${imgui_SOURCE_DIR}/backends")
    target_link_libraries(noveltea-benchmark-imgui PUBLIC SDL3::SDL3)
    noveltea_apply_runtime_dependency_policy(noveltea-benchmark-imgui)
    add_library(imgui::imgui ALIAS noveltea-benchmark-imgui)
elseif(NOT TARGET imgui::imgui)
    find_package(imgui CONFIG REQUIRED)
endif()
set(NOVELTEA_BENCHMARK_APP_SOURCES
    main.cpp benchmark_dashboard.cpp benchmark_completed_run.cpp raw_bgfx_geometry.cpp
    raw_bgfx_workloads.cpp
    standalone_rmlui.cpp integrated_rmlui.cpp empty_engine.cpp)
if(ANDROID)
    add_library(noveltea-benchmark-app SHARED ${NOVELTEA_BENCHMARK_APP_SOURCES})
    target_link_options(noveltea-benchmark-app PRIVATE "LINKER:-z,max-page-size=16384")
    set(NOVELTEA_BENCHMARK_SHADER_VARIANT "essl-300")
    set(NOVELTEA_BENCHMARK_RESULT_ROOT "")
elseif(EMSCRIPTEN)
    add_executable(noveltea-benchmark-app ${NOVELTEA_BENCHMARK_APP_SOURCES})
    set_target_properties(noveltea-benchmark-app PROPERTIES OUTPUT_NAME "benchmark" SUFFIX ".html")
    set(NOVELTEA_BENCHMARK_SHADER_VARIANT "essl-300")
    set(NOVELTEA_BENCHMARK_RESULT_ROOT "/results")
else()
    add_executable(noveltea-benchmark-app ${NOVELTEA_BENCHMARK_APP_SOURCES})
    set(NOVELTEA_BENCHMARK_SHADER_VARIANT "glsl-330")
    set(NOVELTEA_BENCHMARK_RESULT_ROOT "${CMAKE_BINARY_DIR}/benchmarks")
endif()
target_link_libraries(noveltea-benchmark-app PRIVATE SDL3::SDL3 bgfx::bgfx
    imgui::imgui rmlui_bgfx::rmlui_bgfx RmlUi::Core noveltea_engine noveltea-benchmark-runner)
noveltea_attach_generated_shaders(noveltea-benchmark-app)
noveltea_attach_runtime_assets(noveltea-benchmark-app)
target_compile_definitions(noveltea-benchmark-app PRIVATE
    NOVELTEA_BENCHMARK_RESULTS_DIR="${NOVELTEA_BENCHMARK_RESULT_ROOT}"
    NOVELTEA_BENCHMARK_SHADER_ROOT="shaders/bgfx/${NOVELTEA_BENCHMARK_SHADER_VARIANT}"
    NOVELTEA_BENCHMARK_FONT_PATH="fonts/LiberationSans.ttf"
)
# The benchmark is relocatable: stage the same generated common system
# shaders and font as the runtime, without its Engine asset-management graph.
if(NOT ANDROID AND NOT EMSCRIPTEN)
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
endif()
if(EMSCRIPTEN)
    set(NOVELTEA_WEB_BENCHMARK_ASSETS "${CMAKE_CURRENT_BINARY_DIR}/assets")
    add_custom_target(noveltea-benchmark-web-assets
        COMMAND "${CMAKE_COMMAND}" -E make_directory
            "${NOVELTEA_WEB_BENCHMARK_ASSETS}/fonts"
            "${NOVELTEA_WEB_BENCHMARK_ASSETS}/shaders/bgfx/essl-300"
        COMMAND "${CMAKE_COMMAND}" -E copy_if_different
            "${PROJECT_SOURCE_DIR}/engine/assets/system/fonts/LiberationSans.ttf"
            "${NOVELTEA_WEB_BENCHMARK_ASSETS}/fonts/LiberationSans.ttf"
        COMMAND "${CMAKE_COMMAND}" -E copy_directory
            "${NOVELTEA_ACTIVE_SHADER_ASSET_ROOT}/shaders/bgfx/essl-300"
            "${NOVELTEA_WEB_BENCHMARK_ASSETS}/shaders/bgfx/essl-300"
        COMMAND "${CMAKE_COMMAND}" -E copy_directory
            "${PROJECT_SOURCE_DIR}/engine/assets/system"
            "${NOVELTEA_WEB_BENCHMARK_ASSETS}/system"
        COMMAND "${CMAKE_COMMAND}" -E copy_directory
            "${NOVELTEA_ACTIVE_SHADER_ASSET_ROOT}/shaders"
            "${NOVELTEA_WEB_BENCHMARK_ASSETS}/system/shaders"
        VERBATIM)
    if(TARGET noveltea-shaders)
        add_dependencies(noveltea-benchmark-web-assets noveltea-shaders)
    endif()
    add_dependencies(noveltea-benchmark-app noveltea-benchmark-web-assets)
    target_link_options(noveltea-benchmark-app PRIVATE
        -sUSE_WEBGL2=1 -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=0 -sFORCE_FILESYSTEM=1
        -sSTACK_SIZE=131072
        "SHELL:--shell-file ${PROJECT_SOURCE_DIR}/web/benchmark_shell.html"
        "SHELL:--preload-file ${NOVELTEA_WEB_BENCHMARK_ASSETS}@/assets")
    # --preload-file is consumed at link time. Track changes to the complete
    # production Engine system asset tree, not just the dashboard shaders.
    file(GLOB_RECURSE NOVELTEA_WEB_BENCHMARK_SYSTEM_ASSETS CONFIGURE_DEPENDS
        "${PROJECT_SOURCE_DIR}/engine/assets/system/*")
    include("${PROJECT_SOURCE_DIR}/cmake/NovelTeaShaderManifest.cmake")
    noveltea_collect_shader_outputs(
        VARIANTS essl-300
        OUTPUT_ROOT "${NOVELTEA_ACTIVE_SHADER_ASSET_ROOT}"
        OUT_VAR NOVELTEA_WEB_BENCHMARK_SHADERS)
    set_property(TARGET noveltea-benchmark-app APPEND PROPERTY
        LINK_DEPENDS
            "${PROJECT_SOURCE_DIR}/web/benchmark_shell.html"
            ${NOVELTEA_WEB_BENCHMARK_SYSTEM_ASSETS}
            ${NOVELTEA_WEB_BENCHMARK_SHADERS})
    if(CMAKE_BUILD_TYPE STREQUAL "MinSizeRel" OR CMAKE_BUILD_TYPE STREQUAL "Release")
        target_compile_options(noveltea-benchmark-app PRIVATE -flto)
        target_link_options(noveltea-benchmark-app PRIVATE -flto)
    endif()
endif()
noveltea_apply_runtime_compiler_policy(noveltea-benchmark-app)
noveltea_apply_policy_warnings(noveltea-benchmark-app)

if(BUILD_TESTING AND NOT ANDROID)
    add_executable(noveltea-benchmark-frame-driven-tests benchmark_frame_driven_tests.cpp)
    target_link_libraries(noveltea-benchmark-frame-driven-tests PRIVATE noveltea-benchmark-runner)
    noveltea_apply_runtime_compiler_policy(noveltea-benchmark-frame-driven-tests)
    noveltea_apply_policy_warnings(noveltea-benchmark-frame-driven-tests)
    add_test(NAME noveltea_benchmark_frame_driven COMMAND noveltea-benchmark-frame-driven-tests)

    add_executable(noveltea-benchmark-suite-tests benchmark_suite_tests.cpp)
    target_link_libraries(noveltea-benchmark-suite-tests PRIVATE noveltea-benchmark-runner)
    noveltea_apply_runtime_compiler_policy(noveltea-benchmark-suite-tests)
    noveltea_apply_policy_warnings(noveltea-benchmark-suite-tests)
    add_test(NAME noveltea_benchmark_suite COMMAND noveltea-benchmark-suite-tests)

    add_executable(noveltea-benchmark-runner-tests benchmark_runner_tests.cpp)
    target_link_libraries(noveltea-benchmark-runner-tests PRIVATE noveltea-benchmark-runner)
    noveltea_apply_runtime_compiler_policy(noveltea-benchmark-runner-tests)
    noveltea_apply_policy_warnings(noveltea-benchmark-runner-tests)
    add_test(NAME noveltea_benchmark_runner COMMAND noveltea-benchmark-runner-tests)

    add_executable(noveltea-benchmark-bgfx-diagnostics-tests
        benchmark_bgfx_diagnostics_tests.cpp)
    target_link_libraries(noveltea-benchmark-bgfx-diagnostics-tests PRIVATE bgfx::bgfx)
    noveltea_apply_runtime_compiler_policy(noveltea-benchmark-bgfx-diagnostics-tests)
    noveltea_apply_policy_warnings(noveltea-benchmark-bgfx-diagnostics-tests)
    add_test(NAME noveltea_benchmark_bgfx_diagnostics
        COMMAND noveltea-benchmark-bgfx-diagnostics-tests)
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

    add_executable(noveltea-benchmark-empty-engine-tests
        empty_engine_tests.cpp empty_engine.cpp integrated_rmlui.cpp)
    target_link_libraries(noveltea-benchmark-empty-engine-tests PRIVATE
        noveltea_engine noveltea-benchmark-runner SDL3::SDL3 bgfx::bgfx)
    target_compile_definitions(noveltea-benchmark-empty-engine-tests PRIVATE
        NOVELTEA_BENCHMARK_RESULTS_DIR="${NOVELTEA_BENCHMARK_RESULT_ROOT}")
    add_dependencies(noveltea-benchmark-empty-engine-tests noveltea-benchmark-stage-assets)
    noveltea_apply_runtime_compiler_policy(noveltea-benchmark-empty-engine-tests)
    noveltea_apply_policy_warnings(noveltea-benchmark-empty-engine-tests)
    set_tests_properties(noveltea_benchmark_options noveltea_benchmark_report noveltea_benchmark_runner noveltea_benchmark_source_identity noveltea_benchmark_reference_scene noveltea_benchmark_completed_run noveltea_benchmark_bgfx_diagnostics noveltea_benchmark_app_help
        PROPERTIES LABELS "benchmark;graphics")

    find_program(NOVELTEA_XVFB_RUN NAMES xvfb-run)
    if(NOVELTEA_XVFB_RUN)
        find_program(NOVELTEA_BENCHMARK_NODE NAMES node)
        if(NOVELTEA_BENCHMARK_NODE)
            set(NOVELTEA_BENCHMARK_CANONICAL_REPORT
                "${CMAKE_BINARY_DIR}/benchmarks/ctest-stage1-canonical.json")
            add_test(NAME noveltea_benchmark_stage1_configuration_smoke
                COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                    --config "${CMAKE_CURRENT_SOURCE_DIR}/stage1-unattended.json"
                    --output "${NOVELTEA_BENCHMARK_CANONICAL_REPORT}")
            set_tests_properties(noveltea_benchmark_stage1_configuration_smoke PROPERTIES
                LABELS "benchmark;graphics;smoke"
                FIXTURES_SETUP benchmark_stage1_report TIMEOUT 90)
            add_test(NAME noveltea_benchmark_stage1_report_certification
                COMMAND "${NOVELTEA_BENCHMARK_NODE}"
                    "${PROJECT_SOURCE_DIR}/scripts/benchmark-stage1-validate.mjs"
                    --config "${CMAKE_CURRENT_SOURCE_DIR}/stage1-unattended.json"
                    --report "${NOVELTEA_BENCHMARK_CANONICAL_REPORT}" --platform Linux)
            set_tests_properties(noveltea_benchmark_stage1_report_certification PROPERTIES
                LABELS "benchmark;graphics;smoke"
                FIXTURES_REQUIRED benchmark_stage1_report)
        endif()
        add_test(NAME noveltea_benchmark_empty_engine_integration
            COMMAND "${NOVELTEA_XVFB_RUN}" -a
                "$<TARGET_FILE:noveltea-benchmark-empty-engine-tests>")
        set_tests_properties(noveltea_benchmark_empty_engine_integration PROPERTIES
            LABELS "benchmark;graphics;integration" TIMEOUT 120)
        add_test(NAME noveltea_benchmark_empty_engine_graphics_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --scenario engine-empty --smoke --repeats 2
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-engine-empty.json")
        set_tests_properties(noveltea_benchmark_empty_engine_graphics_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "complete: 60 frames across 2 trial"
            TIMEOUT 120)
        add_test(NAME noveltea_benchmark_empty_engine_dashboard_lifecycle_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --scenario engine-empty --dashboard-smoke
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-empty-engine-lifecycle.json")
        set_tests_properties(noveltea_benchmark_empty_engine_dashboard_lifecycle_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "dashboard cycle 3 complete"
            TIMEOUT 120)
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
        foreach(raw_workload clear single-quad textured offscreen draw-calls)
            add_test(NAME "noveltea_benchmark_raw_${raw_workload}_graphics_smoke"
                COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                    --scenario "raw-bgfx-${raw_workload}" --smoke --repeats 2
                    --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-raw-${raw_workload}.json")
            set_tests_properties("noveltea_benchmark_raw_${raw_workload}_graphics_smoke"
                PROPERTIES LABELS "benchmark;graphics;smoke"
                PASS_REGULAR_EXPRESSION "complete: 60 frames across 2 trial"
                TIMEOUT 120)
        endforeach()
        add_test(NAME noveltea_benchmark_raw_scaled_graphics_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --scenario raw-bgfx-draw-calls --draw-calls 7 --quad-count 9
                --texture-size 64 --coverage 0.375 --smoke
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-raw-scaled.json")
        set_tests_properties(noveltea_benchmark_raw_scaled_graphics_smoke
            PROPERTIES LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "complete: 30 frames"
            TIMEOUT 120)
        add_test(NAME noveltea_benchmark_composition_direct_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --scenario raw-bgfx-composition --smoke --repeats 2
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-composition-direct.json")
        set_tests_properties(noveltea_benchmark_composition_direct_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "complete: 60 frames across 2 trial"
            TIMEOUT 120)
        add_test(NAME noveltea_benchmark_composition_offscreen_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --scenario raw-bgfx-composition --composition-path offscreen
                --composite-passes 4 --target-scale 0.5 --coverage 0.375
                --no-transparent-overlay --smoke --repeats 2
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-composition-offscreen.json")
        set_tests_properties(noveltea_benchmark_composition_offscreen_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "complete: 60 frames across 2 trial"
            TIMEOUT 120)
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
        add_test(NAME noveltea_benchmark_quick_suite_graphics_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --quick-suite --smoke
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-quick-suite.json")
        set_tests_properties(noveltea_benchmark_quick_suite_graphics_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "Quick Suite complete"
            TIMEOUT 180)
        add_test(NAME noveltea_benchmark_quick_suite_after_composition_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --scenario raw-bgfx-composition --composition-path offscreen
                --composite-passes 2 --target-scale 0.5 --msaa-samples 2
                --no-transparent-overlay --quick-suite --smoke
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-quick-suite-composition.json")
        set_tests_properties(noveltea_benchmark_quick_suite_after_composition_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "Quick Suite complete"
            TIMEOUT 180)
        add_test(NAME noveltea_benchmark_quick_suite_dashboard_smoke
            COMMAND "${NOVELTEA_XVFB_RUN}" -a "$<TARGET_FILE:noveltea-benchmark-app>"
                --dashboard-smoke --quick-suite
                --output "${CMAKE_BINARY_DIR}/benchmarks/ctest-quick-suite-dashboard.json")
        set_tests_properties(noveltea_benchmark_quick_suite_dashboard_smoke PROPERTIES
            LABELS "benchmark;graphics;smoke"
            PASS_REGULAR_EXPRESSION "dashboard cycle 3 complete"
            TIMEOUT 240)
        # Presented pixel check, outside all benchmark sampling. Optional on
        # minimal builders that do not install ImageMagick and Python.
        find_program(NOVELTEA_IMAGEMAGICK_IMPORT NAMES import)
        find_program(NOVELTEA_XWININFO NAMES xwininfo)
        find_package(Python3 COMPONENTS Interpreter QUIET)
        if(NOVELTEA_IMAGEMAGICK_IMPORT AND NOVELTEA_XWININFO AND Python3_Interpreter_FOUND)
            add_test(NAME noveltea_benchmark_composition_visual_smoke
                COMMAND "${NOVELTEA_XVFB_RUN}" -a "${Python3_EXECUTABLE}"
                    "${CMAKE_CURRENT_SOURCE_DIR}/composition_visual_smoke.py"
                    "$<TARGET_FILE:noveltea-benchmark-app>")
            set_tests_properties(noveltea_benchmark_composition_visual_smoke PROPERTIES
                LABELS "benchmark;graphics;visual"
                PASS_REGULAR_EXPRESSION "composition: direct/offscreen mismatches"
                TIMEOUT 65)
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
