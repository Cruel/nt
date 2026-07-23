include_guard(GLOBAL)

include(CheckCXXSourceCompiles)
include(FetchContent)

set(NOVELTEA_RMLUI_VERSION "6.2")
set(NOVELTEA_RMLUI_SOURCE_URL
    "https://github.com/mikke89/RmlUi/archive/refs/tags/6.2.tar.gz")
set(NOVELTEA_RMLUI_SOURCE_SHA256
    "814c3ff7b9666280338d8f0dda85979f5daf028d01c85fc8975431d1e2fd8e8b")
set(NOVELTEA_RMLUI_BASE_PATCH_REVISION "3c-text-scale-1")
set(NOVELTEA_RMLUI_PATCH_REVISION "5e-font-raster-scale-1")
set(NOVELTEA_RMLUI_PATCH_FILE
    "${CMAKE_SOURCE_DIR}/cmake/patches/rmlui-6.2-noveltea-presentation.patch")
set(NOVELTEA_RMLUI_FONT_RASTER_PATCH_FILE
    "${CMAKE_SOURCE_DIR}/cmake/patches/rmlui-6.2-noveltea-font-raster.patch")

function(_noveltea_write_rmlui_dependency_diagnostic
         provider source_dir patch_sha256 font_raster_patch_sha256)
    if(provider STREQUAL "FetchContent")
        set(_noveltea_rmlui_report_version "${NOVELTEA_RMLUI_VERSION}")
        set(_noveltea_rmlui_report_source_url "${NOVELTEA_RMLUI_SOURCE_URL}")
        set(_noveltea_rmlui_report_source_sha256 "${NOVELTEA_RMLUI_SOURCE_SHA256}")
        set(_noveltea_rmlui_report_patch_file "${NOVELTEA_RMLUI_PATCH_FILE}")
        set(_noveltea_rmlui_report_font_raster_patch_file
            "${NOVELTEA_RMLUI_FONT_RASTER_PATCH_FILE}")
        set(_noveltea_rmlui_report_patch_revision "${NOVELTEA_RMLUI_PATCH_REVISION}")
    else()
        set(_noveltea_rmlui_report_version "installed")
        set(_noveltea_rmlui_report_source_url "installed")
        set(_noveltea_rmlui_report_source_sha256 "installed")
        set(_noveltea_rmlui_report_patch_file "installed")
        set(_noveltea_rmlui_report_font_raster_patch_file "installed")
        set(_noveltea_rmlui_report_patch_revision "installed-api-verified")
    endif()

    file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/reports")
    file(WRITE "${CMAKE_BINARY_DIR}/reports/rmlui-dependency.txt"
        "provider=${provider}\n"
        "version=${_noveltea_rmlui_report_version}\n"
        "source_url=${_noveltea_rmlui_report_source_url}\n"
        "source_sha256=${_noveltea_rmlui_report_source_sha256}\n"
        "patch_file=${_noveltea_rmlui_report_patch_file}\n"
        "font_raster_patch_file=${_noveltea_rmlui_report_font_raster_patch_file}\n"
        "base_patch_revision=${NOVELTEA_RMLUI_BASE_PATCH_REVISION}\n"
        "patch_revision=${_noveltea_rmlui_report_patch_revision}\n"
        "patch_sha256=${patch_sha256}\n"
        "font_raster_patch_sha256=${font_raster_patch_sha256}\n"
        "source_dir=${source_dir}\n")
endfunction()

function(_noveltea_verify_installed_rmlui_extension_api)
    if(TARGET RmlUi::RmlUi)
        set(_noveltea_rmlui_probe_target RmlUi::RmlUi)
    elseif(TARGET RmlUi::Core)
        set(_noveltea_rmlui_probe_target RmlUi::Core)
    else()
        message(FATAL_ERROR
            "The installed RmlUi package did not expose RmlUi::RmlUi or RmlUi::Core.")
    endif()

    set(_noveltea_saved_required_libraries "${CMAKE_REQUIRED_LIBRARIES}")
    set(_noveltea_saved_required_definitions "${CMAKE_REQUIRED_DEFINITIONS}")
    set(CMAKE_REQUIRED_LIBRARIES "${_noveltea_rmlui_probe_target}")
    set(CMAKE_REQUIRED_DEFINITIONS
        -DRMLUI_CUSTOM_RTTI
        -DITLIB_FLAT_MAP_NO_THROW)
    unset(NOVELTEA_INSTALLED_RMLUI_HAS_REQUIRED_EXTENSION_API CACHE)
    check_cxx_source_compiles([[
        #include <RmlUi/Core/Context.h>
        #include <RmlUi/Core/Core.h>
        #include <type_traits>

        int main()
        {
            using Context = Rml::Context;
            static_assert(std::is_member_function_pointer_v<
                decltype(&Context::SetMediaQueryDimensions)>);
            static_assert(std::is_member_function_pointer_v<
                decltype(&Context::ClearMediaQueryDimensions)>);
            static_assert(std::is_member_function_pointer_v<
                decltype(&Context::GetMediaQueryDimensions)>);
            static_assert(std::is_member_function_pointer_v<
                decltype(&Context::SetTextScaleFactor)>);
            static_assert(std::is_member_function_pointer_v<
                decltype(&Context::GetTextScaleFactor)>);
            static_assert(std::is_member_function_pointer_v<
                decltype(&Context::SetFontRasterScale)>);
            static_assert(std::is_member_function_pointer_v<
                decltype(&Context::GetFontRasterScale)>);
            static_assert(std::is_pointer_v<
                decltype(&Rml::ReleaseFontRasterResources)>);
            return 0;
        }
    ]] NOVELTEA_INSTALLED_RMLUI_HAS_REQUIRED_EXTENSION_API)
    set(CMAKE_REQUIRED_LIBRARIES "${_noveltea_saved_required_libraries}")
    set(CMAKE_REQUIRED_DEFINITIONS "${_noveltea_saved_required_definitions}")

    if(NOT NOVELTEA_INSTALLED_RMLUI_HAS_REQUIRED_EXTENSION_API)
        message(FATAL_ERROR
            "NOVELTEA_FETCH_RMLUI=OFF selected an installed RmlUi package that does not expose "
            "NovelTea's required Context extension API: Set/Clear/GetMediaQueryDimensions and "
            "Set/GetTextScaleFactor, Set/GetFontRasterScale, and ReleaseFontRasterResources. "
            "Use the pinned FetchContent provider or install a package "
            "built from the complete NovelTea RmlUi patch revision.")
    endif()
endfunction()

function(noveltea_provide_rmlui_dependency)
    if(NOT NOVELTEA_FETCH_RMLUI AND
       (EMSCRIPTEN OR CMAKE_SYSTEM_NAME STREQUAL "Android"))
        message(FATAL_ERROR
            "Web and Android must build the pinned patched RmlUi source. "
            "Configure with NOVELTEA_FETCH_RMLUI=ON.")
    endif()

    if(NOVELTEA_FETCH_RMLUI)
        if(NOT TARGET Freetype::Freetype)
            noveltea_provide_freetype_dependency()
        endif()

        if(NOT EXISTS "${NOVELTEA_RMLUI_PATCH_FILE}")
            message(FATAL_ERROR
                "Missing repository-owned RmlUi patch: ${NOVELTEA_RMLUI_PATCH_FILE}")
        endif()
        if(NOT EXISTS "${NOVELTEA_RMLUI_FONT_RASTER_PATCH_FILE}")
            message(FATAL_ERROR
                "Missing repository-owned RmlUi font-raster patch: "
                "${NOVELTEA_RMLUI_FONT_RASTER_PATCH_FILE}")
        endif()
        file(SHA256 "${NOVELTEA_RMLUI_PATCH_FILE}" _noveltea_rmlui_patch_sha256)
        file(SHA256 "${NOVELTEA_RMLUI_FONT_RASTER_PATCH_FILE}"
            _noveltea_rmlui_font_raster_patch_sha256)
        find_package(Git REQUIRED)

        set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
        set(RMLUI_SAMPLES OFF CACHE BOOL "" FORCE)
        set(RMLUI_TESTS OFF CACHE BOOL "" FORCE)
        set(RMLUI_LUA_BINDINGS ON CACHE BOOL "" FORCE)
        set(RMLUI_LUA_BINDINGS_LIBRARY lua CACHE STRING "" FORCE)
        set(RMLUI_LOTTIE_PLUGIN OFF CACHE BOOL "" FORCE)
        set(RMLUI_SVG_PLUGIN OFF CACHE BOOL "" FORCE)
        set(RMLUI_HARFBUZZ_SAMPLE OFF CACHE BOOL "" FORCE)
        set(RMLUI_PRECOMPILED_HEADERS OFF CACHE BOOL "" FORCE)
        set(RMLUI_COMPILER_OPTIONS OFF CACHE BOOL "" FORCE)
        set(RMLUI_FONT_ENGINE "freetype" CACHE STRING "" FORCE)
        set(RMLUI_CUSTOM_RTTI ON CACHE BOOL "" FORCE)

        FetchContent_Declare(
            RmlUi
            URL "${NOVELTEA_RMLUI_SOURCE_URL}"
            URL_HASH "SHA256=${NOVELTEA_RMLUI_SOURCE_SHA256}"
            DOWNLOAD_EXTRACT_TIMESTAMP TRUE
            PATCH_COMMAND
                "${CMAKE_COMMAND}"
                "-DSOURCE_DIR=<SOURCE_DIR>"
                "-DPATCH_FILE=${NOVELTEA_RMLUI_PATCH_FILE}"
                "-DEXPECTED_PATCH_SHA256=${_noveltea_rmlui_patch_sha256}"
                "-DEXPECTED_PATCH_REVISION=${NOVELTEA_RMLUI_BASE_PATCH_REVISION}"
                "-DALTERNATE_EXPECTED_PATCH_REVISION=${NOVELTEA_RMLUI_PATCH_REVISION}"
                "-DGIT_EXECUTABLE=${GIT_EXECUTABLE}"
                -P "${CMAKE_SOURCE_DIR}/cmake/ApplyRepositoryPatch.cmake"
            COMMAND
                "${CMAKE_COMMAND}"
                "-DSOURCE_DIR=<SOURCE_DIR>"
                "-DPATCH_FILE=${NOVELTEA_RMLUI_FONT_RASTER_PATCH_FILE}"
                "-DEXPECTED_PATCH_SHA256=${_noveltea_rmlui_font_raster_patch_sha256}"
                "-DEXPECTED_PATCH_REVISION=${NOVELTEA_RMLUI_PATCH_REVISION}"
                "-DGIT_EXECUTABLE=${GIT_EXECUTABLE}"
                -P "${CMAKE_SOURCE_DIR}/cmake/ApplyRepositoryPatch.cmake"
        )
        FetchContent_MakeAvailable(RmlUi)
        FetchContent_GetProperties(RmlUi SOURCE_DIR _noveltea_rmlui_source_dir)

        set(_noveltea_rmlui_marker
            "${_noveltea_rmlui_source_dir}/Include/RmlUi/Core/NovelTeaPatch.h")
        if(NOT EXISTS "${_noveltea_rmlui_marker}")
            message(FATAL_ERROR
                "The fetched RmlUi source is missing the NovelTea patch marker after population: "
                "${_noveltea_rmlui_marker}")
        endif()
        file(READ "${_noveltea_rmlui_marker}" _noveltea_rmlui_marker_contents)
        if(NOT _noveltea_rmlui_marker_contents MATCHES
           "RMLUI_NOVELTEA_PATCH_REVISION[ \t]+\"${NOVELTEA_RMLUI_PATCH_REVISION}\"")
            message(FATAL_ERROR
                "The fetched RmlUi patch marker does not report expected revision "
                "${NOVELTEA_RMLUI_PATCH_REVISION}.")
        endif()

        foreach(_noveltea_dependency IN ITEMS rmlui_core rmlui_lua rmlui_debugger)
            noveltea_apply_runtime_dependency_policy(${_noveltea_dependency})
        endforeach()

        set(NOVELTEA_RMLUI_PROVIDER "FetchContent" CACHE INTERNAL "" FORCE)
        set(NOVELTEA_RMLUI_SOURCE_DIR "${_noveltea_rmlui_source_dir}" CACHE INTERNAL "" FORCE)
        set(NOVELTEA_RMLUI_CONFIGURED_SOURCE_SHA256
            "${NOVELTEA_RMLUI_SOURCE_SHA256}" CACHE INTERNAL "" FORCE)
        set(NOVELTEA_RMLUI_CONFIGURED_PATCH_REVISION
            "${NOVELTEA_RMLUI_PATCH_REVISION}" CACHE INTERNAL "" FORCE)
        set(NOVELTEA_RMLUI_CONFIGURED_PATCH_SHA256
            "${_noveltea_rmlui_patch_sha256}+${_noveltea_rmlui_font_raster_patch_sha256}"
            CACHE INTERNAL "" FORCE)
        _noveltea_write_rmlui_dependency_diagnostic(
            "FetchContent" "${_noveltea_rmlui_source_dir}"
            "${_noveltea_rmlui_patch_sha256}"
            "${_noveltea_rmlui_font_raster_patch_sha256}")
        message(STATUS
            "NovelTea RmlUi: provider=FetchContent version=${NOVELTEA_RMLUI_VERSION} "
            "source_sha256=${NOVELTEA_RMLUI_SOURCE_SHA256} "
            "patch=${NOVELTEA_RMLUI_PATCH_REVISION} "
            "patch_sha256=${_noveltea_rmlui_patch_sha256} "
            "font_raster_patch_sha256=${_noveltea_rmlui_font_raster_patch_sha256}")
    else()
        find_package(RmlUi CONFIG REQUIRED)
        _noveltea_verify_installed_rmlui_extension_api()
        set(NOVELTEA_RMLUI_PROVIDER "installed-extension-api-verified" CACHE INTERNAL "" FORCE)
        set(NOVELTEA_RMLUI_SOURCE_DIR "" CACHE INTERNAL "" FORCE)
        set(NOVELTEA_RMLUI_CONFIGURED_SOURCE_SHA256 "installed" CACHE INTERNAL "" FORCE)
        set(NOVELTEA_RMLUI_CONFIGURED_PATCH_REVISION "installed-api-verified"
            CACHE INTERNAL "" FORCE)
        set(NOVELTEA_RMLUI_CONFIGURED_PATCH_SHA256 "installed" CACHE INTERNAL "" FORCE)
        _noveltea_write_rmlui_dependency_diagnostic(
            "installed-extension-api-verified" "" "installed" "installed")
        message(STATUS "NovelTea RmlUi: provider=installed-extension-api-verified")
    endif()

    if(NOT TARGET RmlUi::Lua)
        message(FATAL_ERROR
            "RmlUi::Lua is required for the NovelTea engine. The selected RmlUi provider must "
            "build or export the official Lua bindings against NovelTea's Lua target.")
    endif()
endfunction()
