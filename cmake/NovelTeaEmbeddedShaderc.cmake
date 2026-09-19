include(FetchContent)

if(NOT DEFINED NOVELTEA_BGFX_VERSION OR NOT DEFINED NOVELTEA_BGFX_ARCHIVE_SHA256)
    message(FATAL_ERROR "NovelTeaEmbeddedShaderc requires NOVELTEA_BGFX_VERSION and NOVELTEA_BGFX_ARCHIVE_SHA256")
endif()
set(NOVELTEA_BGFX_SHADERC_ARCHIVE_URL
    "https://github.com/bkaradzic/bgfx.cmake/releases/download/v${NOVELTEA_BGFX_VERSION}/bgfx.cmake.v${NOVELTEA_BGFX_VERSION}.tar.gz")
set(NOVELTEA_BGFX_SHADERC_ARCHIVE_SHA256 "${NOVELTEA_BGFX_ARCHIVE_SHA256}")
set(NOVELTEA_PREBUILT_SHADERC_ROOT "" CACHE PATH
    "Extracted nt-tools static shaderc closure; empty builds the pinned source locally")

function(noveltea_prepare_embedded_engine_shader_resources)
    file(GLOB _noveltea_engine_shader_files CONFIGURE_DEPENDS
        "${CMAKE_SOURCE_DIR}/engine/shaders/bgfx/*.sc")
    list(SORT _noveltea_engine_shader_files)
    set(_declarations "")
    set(_entries "")
    foreach(_shader_path IN LISTS _noveltea_engine_shader_files)
        get_filename_component(_shader_name "${_shader_path}" NAME)
        string(REGEX REPLACE "[^A-Za-z0-9_]" "_" _shader_symbol "${_shader_name}")
        file(SHA256 "${_shader_path}" _shader_sha256)
        file(READ "${_shader_path}" _shader_hex HEX)
        string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," _shader_bytes "${_shader_hex}")
        string(APPEND _declarations
            "inline constexpr std::uint8_t engine_shader_${_shader_symbol}_bytes[] = {${_shader_bytes}};\n")
        string(APPEND _entries
            "    {\"${_shader_name}\", \"${_shader_sha256}\", engine_shader_${_shader_symbol}_bytes},\n")
    endforeach()
    set(NOVELTEA_ENGINE_SHADER_RESOURCE_DECLARATIONS "${_declarations}" PARENT_SCOPE)
    set(NOVELTEA_ENGINE_SHADER_RESOURCE_ENTRIES "${_entries}" PARENT_SCOPE)
endfunction()

function(noveltea_configure_embedded_shaderc)
    if(TARGET noveltea_bgfx_shaderc_embedded)
        return()
    endif()

    noveltea_prepare_embedded_engine_shader_resources()

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
        if(NOT TARGET noveltea_texturec::embedded)
            message(FATAL_ERROR "NovelTea prebuilt shaderc closure did not define noveltea_texturec::embedded")
        endif()
        add_library(noveltea_bgfx_shaderc_embedded ALIAS noveltea_shaderc::embedded)
        add_library(noveltea_bimg_texturec_embedded ALIAS noveltea_texturec::embedded)

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

    if(TARGET shaderc AND TARGET texturec AND NOVELTEA_BGFX_SOURCE_DIR)
        set(noveltea_bgfx_shaderc_source_SOURCE_DIR "${NOVELTEA_BGFX_SOURCE_DIR}")
    else()
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

        FetchContent_Declare(
            noveltea_bgfx_shaderc_source
            URL "${NOVELTEA_BGFX_SHADERC_ARCHIVE_URL}"
            URL_HASH "SHA256=${NOVELTEA_BGFX_SHADERC_ARCHIVE_SHA256}"
            DOWNLOAD_EXTRACT_TIMESTAMP TRUE
        )
        FetchContent_MakeAvailable(noveltea_bgfx_shaderc_source)
        if(NOT TARGET texturec)
            include("${noveltea_bgfx_shaderc_source_SOURCE_DIR}/cmake/bimg/texturec.cmake")
        endif()
    endif()

    if(NOT TARGET shaderc)
        message(FATAL_ERROR "Pinned bgfx source did not define its shaderc target")
    endif()
    if(NOT TARGET texturec)
        message(FATAL_ERROR "Pinned bgfx source did not define its texturec target")
    endif()
    if(NOVELTEA_ENABLE_SANITIZERS AND TARGET glsl-optimizer AND
       CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        # Mesa's legacy arena-allocated AST nodes and bit-packed flags bypass C++ object-lifetime
        # and scalar-value rules assumed by UBSan. Keep AddressSanitizer enabled on this dependency.
        target_compile_options(glsl-optimizer PRIVATE -fno-sanitize=undefined)
    endif()

    get_target_property(_shaderc_sources shaderc SOURCES)
    get_target_property(_shaderc_links shaderc LINK_LIBRARIES)
    get_target_property(_shaderc_includes shaderc INCLUDE_DIRECTORIES)
    get_target_property(_shaderc_definitions shaderc COMPILE_DEFINITIONS)
    get_target_property(_shaderc_options shaderc COMPILE_OPTIONS)
    if(NOT _shaderc_sources OR NOT _shaderc_links)
        message(FATAL_ERROR "Pinned bgfx shaderc target did not expose its source/link closure")
    endif()

    add_library(noveltea_bgfx_shaderc_embedded STATIC ${_shaderc_sources})
    set_target_properties(noveltea_bgfx_shaderc_embedded PROPERTIES POSITION_INDEPENDENT_CODE ON)
    if(_shaderc_includes)
        target_include_directories(noveltea_bgfx_shaderc_embedded PRIVATE ${_shaderc_includes})
    endif()
    if(_shaderc_definitions)
        target_compile_definitions(noveltea_bgfx_shaderc_embedded PRIVATE ${_shaderc_definitions})
    endif()
    if(_shaderc_options)
        target_compile_options(noveltea_bgfx_shaderc_embedded PRIVATE ${_shaderc_options})
    endif()
    target_compile_definitions(noveltea_bgfx_shaderc_embedded PRIVATE
        main=noveltea_bgfx_shaderc_embedded_cli_main)
    # The runtime bx target is intentionally built without RTTI. Build the embedded shaderc
    # translation units with matching RTTI settings so subclasses of bx stream types do not emit
    # references to RTTI symbols that the runtime bx archive does not provide. Exceptions remain
    # enabled for the host tool and its compiler dependencies.
    if(MSVC)
        target_compile_options(noveltea_bgfx_shaderc_embedded PRIVATE /GR-)
    else()
        target_compile_options(noveltea_bgfx_shaderc_embedded PRIVATE -fno-rtti)
    endif()
    # shaderc is a build-host/editor tool. Keep its exact upstream host dependency closure
    # (including exceptions where enabled) separate from the shipped game-runtime compiler policy.
    target_link_libraries(noveltea_bgfx_shaderc_embedded PRIVATE ${_shaderc_links})

    get_target_property(_texturec_sources texturec SOURCES)
    get_target_property(_texturec_links texturec LINK_LIBRARIES)
    get_target_property(_texturec_includes texturec INCLUDE_DIRECTORIES)
    get_target_property(_texturec_definitions texturec COMPILE_DEFINITIONS)
    get_target_property(_texturec_options texturec COMPILE_OPTIONS)
    if(NOT _texturec_sources OR NOT _texturec_links)
        message(FATAL_ERROR "Pinned bgfx texturec target did not expose its source/link closure")
    endif()

    add_library(noveltea_bimg_texturec_embedded STATIC ${_texturec_sources})
    set_target_properties(noveltea_bimg_texturec_embedded PROPERTIES POSITION_INDEPENDENT_CODE ON)
    if(_texturec_includes)
        target_include_directories(noveltea_bimg_texturec_embedded PRIVATE ${_texturec_includes})
    endif()
    if(_texturec_definitions)
        target_compile_definitions(noveltea_bimg_texturec_embedded PRIVATE ${_texturec_definitions})
    endif()
    if(_texturec_options)
        target_compile_options(noveltea_bimg_texturec_embedded PRIVATE ${_texturec_options})
    endif()
    target_compile_definitions(noveltea_bimg_texturec_embedded PRIVATE
        NOVELTEA_BIMG_TEXTUREC_EMBEDDED=1)
    target_link_libraries(noveltea_bimg_texturec_embedded PRIVATE ${_texturec_links})

    foreach(_link IN LISTS _shaderc_links _texturec_links)
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
        "${noveltea_bgfx_shaderc_source_SOURCE_DIR}/bgfx/include"
        "${noveltea_bgfx_shaderc_source_SOURCE_DIR}/bimg/include"
        "${noveltea_bgfx_shaderc_source_SOURCE_DIR}/bx/include")
    set_target_properties(shaderc PROPERTIES EXCLUDE_FROM_ALL TRUE)
    set_target_properties(texturec PROPERTIES EXCLUDE_FROM_ALL TRUE)

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
endfunction()
