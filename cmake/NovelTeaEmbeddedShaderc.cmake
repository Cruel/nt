include(FetchContent)

set(NOVELTEA_BGFX_SHADERC_ARCHIVE_URL
    "https://github.com/bkaradzic/bgfx.cmake/releases/download/v1.129.8940-496/bgfx.cmake.v1.129.8940-496.tar.gz")
set(NOVELTEA_BGFX_SHADERC_ARCHIVE_SHA256
    "0fa0482d3b09ae262c9c7fc54a7193022510313f1250077caad5ff18504fce02")
set(NOVELTEA_PREBUILT_SHADERC_ROOT "" CACHE PATH
    "Extracted nt-tools static shaderc closure; empty builds the pinned source locally")

function(noveltea_configure_embedded_shaderc)
    if(TARGET noveltea_bgfx_shaderc_embedded)
        return()
    endif()

    if(NOVELTEA_PREBUILT_SHADERC_ROOT)
        get_filename_component(_noveltea_shaderc_root "${NOVELTEA_PREBUILT_SHADERC_ROOT}" ABSOLUTE)
        set(_noveltea_shaderc_import "${_noveltea_shaderc_root}/cmake/noveltea_shaderc_toolchain.cmake")
        set(_noveltea_shader_resource "${_noveltea_shaderc_root}/resources/bgfx_shader.sh")
        set(_noveltea_compute_resource "${_noveltea_shaderc_root}/resources/bgfx_compute.sh")
        foreach(_noveltea_shaderc_file IN ITEMS
                "${_noveltea_shaderc_import}"
                "${_noveltea_shader_resource}"
                "${_noveltea_compute_resource}")
            if(NOT EXISTS "${_noveltea_shaderc_file}")
                message(FATAL_ERROR "NovelTea prebuilt shaderc closure is incomplete: ${_noveltea_shaderc_file}")
            endif()
        endforeach()

        include("${_noveltea_shaderc_import}")
        if(NOT TARGET noveltea_shaderc::embedded)
            message(FATAL_ERROR "NovelTea prebuilt shaderc closure did not define noveltea_shaderc::embedded")
        endif()
        add_library(noveltea_bgfx_shaderc_embedded ALIAS noveltea_shaderc::embedded)

        set(_resource_dir "${CMAKE_BINARY_DIR}/generated/noveltea-bgfx-toolchain")
        file(MAKE_DIRECTORY "${_resource_dir}")
        file(SHA256 "${_noveltea_shader_resource}" NOVELTEA_BGFX_SHADER_RESOURCE_SHA256)
        file(SHA256 "${_noveltea_compute_resource}" NOVELTEA_BGFX_COMPUTE_RESOURCE_SHA256)
        file(READ "${_noveltea_shader_resource}" NOVELTEA_BGFX_SHADER_RESOURCE_HEX HEX)
        file(READ "${_noveltea_compute_resource}" NOVELTEA_BGFX_COMPUTE_RESOURCE_HEX HEX)
        string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," NOVELTEA_BGFX_SHADER_RESOURCE_BYTES
               "${NOVELTEA_BGFX_SHADER_RESOURCE_HEX}")
        string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," NOVELTEA_BGFX_COMPUTE_RESOURCE_BYTES
               "${NOVELTEA_BGFX_COMPUTE_RESOURCE_HEX}")
        configure_file(
            "${CMAKE_SOURCE_DIR}/engine/src/render/embedded_bgfx_resources.hpp.in"
            "${_resource_dir}/embedded_bgfx_resources.hpp"
            @ONLY)

        set(NOVELTEA_EMBEDDED_SHADERC_INCLUDE_DIR "${_noveltea_shaderc_root}/include/bgfx/tools/shaderc" PARENT_SCOPE)
        set(NOVELTEA_EMBEDDED_SHADERC_GENERATED_DIR "${_resource_dir}" PARENT_SCOPE)
        return()
    endif()

    set(BGFX_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(BGFX_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(BGFX_INSTALL OFF CACHE BOOL "" FORCE)
    set(BGFX_BUILD_TOOLS ON CACHE BOOL "" FORCE)
    set(BGFX_BUILD_TOOLS_BIN2C OFF CACHE BOOL "" FORCE)
    set(BGFX_BUILD_TOOLS_GEOMETRY OFF CACHE BOOL "" FORCE)
    set(BGFX_BUILD_TOOLS_TEXTURE OFF CACHE BOOL "" FORCE)
    set(BGFX_BUILD_TOOLS_SHADER ON CACHE BOOL "" FORCE)
    set(BGFX_CUSTOM_TARGETS OFF CACHE BOOL "" FORCE)
    set(BGFX_CONFIG_MULTITHREADED OFF CACHE BOOL "" FORCE)

    find_package(Git REQUIRED)

    FetchContent_Declare(
        noveltea_bgfx_shaderc_source
        URL "${NOVELTEA_BGFX_SHADERC_ARCHIVE_URL}"
        URL_HASH "SHA256=${NOVELTEA_BGFX_SHADERC_ARCHIVE_SHA256}"
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE
        PATCH_COMMAND "${CMAKE_COMMAND}"
            "-DNOVELTEA_GIT_EXECUTABLE=${GIT_EXECUTABLE}"
            "-DNOVELTEA_PATCH_SOURCE_DIR=<SOURCE_DIR>"
            "-DNOVELTEA_PATCH_FILE=${CMAKE_SOURCE_DIR}/cmake/patches/bgfx-shaderc-fcpp-value-stack.patch"
            -P "${CMAKE_SOURCE_DIR}/cmake/ApplyGitPatchOnce.cmake"
    )
    FetchContent_MakeAvailable(noveltea_bgfx_shaderc_source)

    if(NOT TARGET shaderc)
        message(FATAL_ERROR "Pinned bgfx source did not define its shaderc target")
    endif()
    if(NOVELTEA_ENABLE_SANITIZERS AND TARGET glsl-optimizer AND
       CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        # Mesa's legacy arena-allocated AST nodes and bit-packed flags bypass C++ object-lifetime
        # and scalar-value rules assumed by UBSan. Keep AddressSanitizer enabled on this dependency.
        target_compile_options(glsl-optimizer PRIVATE -fno-sanitize=undefined)
    endif()

    get_target_property(_shaderc_sources shaderc SOURCES)
    get_target_property(_shaderc_links shaderc LINK_LIBRARIES)
    if(NOT _shaderc_sources OR NOT _shaderc_links)
        message(FATAL_ERROR "Pinned bgfx shaderc target did not expose its source/link closure")
    endif()

    add_library(noveltea_bgfx_shaderc_embedded STATIC ${_shaderc_sources})
    set_target_properties(noveltea_bgfx_shaderc_embedded PROPERTIES POSITION_INDEPENDENT_CODE ON)
    target_compile_definitions(noveltea_bgfx_shaderc_embedded PRIVATE
        main=noveltea_bgfx_shaderc_embedded_cli_main)
    # shaderc is a build-host/editor tool. Keep its exact upstream host dependency
    # closure (including RTTI/exceptions where enabled) separate from the shipped
    # game-runtime compiler policy.
    target_link_libraries(noveltea_bgfx_shaderc_embedded PRIVATE ${_shaderc_links})

    foreach(_link IN LISTS _shaderc_links)
        if(TARGET "${_link}")
            get_target_property(_link_type "${_link}" TYPE)
            if(_link_type STREQUAL "STATIC_LIBRARY")
                set_target_properties("${_link}" PROPERTIES POSITION_INDEPENDENT_CODE ON)
            endif()
        endif()
    endforeach()
    target_include_directories(noveltea_bgfx_shaderc_embedded PUBLIC
        "${noveltea_bgfx_shaderc_source_SOURCE_DIR}/bgfx/tools/shaderc"
        "${noveltea_bgfx_shaderc_source_SOURCE_DIR}/bgfx/src"
        "${noveltea_bgfx_shaderc_source_SOURCE_DIR}/bx/include")
    set_target_properties(shaderc PROPERTIES EXCLUDE_FROM_ALL TRUE)

    set(_resource_dir "${CMAKE_BINARY_DIR}/generated/noveltea-bgfx-toolchain")
    file(MAKE_DIRECTORY "${_resource_dir}")
    set(_shader_resource
        "${noveltea_bgfx_shaderc_source_SOURCE_DIR}/bgfx/src/bgfx_shader.sh")
    set(_compute_resource
        "${noveltea_bgfx_shaderc_source_SOURCE_DIR}/bgfx/src/bgfx_compute.sh")
    file(SHA256 "${_shader_resource}" NOVELTEA_BGFX_SHADER_RESOURCE_SHA256)
    file(SHA256 "${_compute_resource}" NOVELTEA_BGFX_COMPUTE_RESOURCE_SHA256)
    file(READ "${_shader_resource}" NOVELTEA_BGFX_SHADER_RESOURCE_HEX HEX)
    file(READ "${_compute_resource}" NOVELTEA_BGFX_COMPUTE_RESOURCE_HEX HEX)
    string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," NOVELTEA_BGFX_SHADER_RESOURCE_BYTES
           "${NOVELTEA_BGFX_SHADER_RESOURCE_HEX}")
    string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," NOVELTEA_BGFX_COMPUTE_RESOURCE_BYTES
           "${NOVELTEA_BGFX_COMPUTE_RESOURCE_HEX}")
    configure_file(
        "${CMAKE_SOURCE_DIR}/engine/src/render/embedded_bgfx_resources.hpp.in"
        "${_resource_dir}/embedded_bgfx_resources.hpp"
        @ONLY)

    set(NOVELTEA_EMBEDDED_SHADERC_INCLUDE_DIR
        "${noveltea_bgfx_shaderc_source_SOURCE_DIR}/bgfx/tools/shaderc" PARENT_SCOPE)
    set(NOVELTEA_EMBEDDED_SHADERC_GENERATED_DIR "${_resource_dir}" PARENT_SCOPE)
    set(NOVELTEA_EMBEDDED_SHADERC_SOURCE_DIR "${noveltea_bgfx_shaderc_source_SOURCE_DIR}" PARENT_SCOPE)
endfunction()
