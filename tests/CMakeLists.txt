include(Catch)

add_executable(noveltea_asset_tests
    assets/asset_path_tests.cpp
    assets/asset_manager_tests.cpp
    assets/asset_reader_tests.cpp
    assets/memory_asset_source_tests.cpp
    assets/directory_asset_source_tests.cpp
)
target_link_libraries(noveltea_asset_tests PRIVATE engine Catch2::Catch2WithMain)
catch_discover_tests(noveltea_asset_tests)

if(NOVELTEA_HAS_BGFX)
    add_executable(noveltea_render_tests
        render/shader_variant_tests.cpp
    )
    target_include_directories(noveltea_render_tests PRIVATE "${CMAKE_SOURCE_DIR}/engine/src")
    target_link_libraries(noveltea_render_tests PRIVATE engine Catch2::Catch2WithMain)
    catch_discover_tests(noveltea_render_tests)

    add_test(
        NAME noveltea_shader_verify
        COMMAND "${CMAKE_COMMAND}"
            "-DNOVELTEA_VERIFY_ONLY=ON"
            "-DNOVELTEA_SHADER_OUTPUT_ROOT=${NOVELTEA_ACTIVE_SHADER_ASSET_ROOT}"
            "-DNOVELTEA_SHADER_VARIANTS=${NOVELTEA_ACTIVE_SHADER_VARIANTS}"
            -P "${CMAKE_SOURCE_DIR}/cmake/CompileNovelTeaShaders.cmake"
    )
endif()

if(NOVELTEA_HAS_RMLUI)
    add_executable(noveltea_ui_tests
        ui/rmlui_file_interface_tests.cpp
    )
    target_include_directories(noveltea_ui_tests PRIVATE "${CMAKE_SOURCE_DIR}/engine/src")
    target_link_libraries(noveltea_ui_tests PRIVATE engine Catch2::Catch2WithMain)
    catch_discover_tests(noveltea_ui_tests)
endif()

add_test(
    NAME noveltea_no_committed_shader_headers
    COMMAND "${CMAKE_COMMAND}"
        "-DROOT=${CMAKE_SOURCE_DIR}"
        -P "${CMAKE_SOURCE_DIR}/tests/cmake/no_committed_shader_headers.cmake"
)
