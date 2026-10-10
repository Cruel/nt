if(EMSCRIPTEN)
    return()
endif()

include(FetchContent)
FetchContent_Declare(libwebm
    URL https://github.com/webmproject/libwebm/archive/refs/tags/libwebm-1.0.0.32.tar.gz
    URL_HASH SHA256=7fd5e085bda9f8031cf2ad2a1e52d9b7b29cba9c0b96ad2ce794ce89e4249eb8
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_GetProperties(libwebm)
if(NOT libwebm_POPULATED)
    FetchContent_Populate(libwebm)
endif()
# Only the status-returning parser enters players, not the muxer or upstream tools.
add_library(noveltea_webm_parser STATIC "${libwebm_SOURCE_DIR}/mkvparser/mkvparser.cc")
target_include_directories(noveltea_webm_parser SYSTEM PUBLIC "${libwebm_SOURCE_DIR}")
set_target_properties(noveltea_webm_parser PROPERTIES POSITION_INDEPENDENT_CODE ON)
noveltea_apply_runtime_dependency_policy(noveltea_webm_parser)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    FetchContent_Declare(libva_headers
        URL https://github.com/intel/libva/archive/refs/tags/2.23.0.tar.gz
        URL_HASH SHA256=b10aceb30e93ddf13b2030eb70079574ba437be9b3b76065caf28a72c07e23e7
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    )
    FetchContent_GetProperties(libva_headers)
    if(NOT libva_headers_POPULATED)
        FetchContent_Populate(libva_headers)
    endif()
    set(VA_API_MAJOR_VERSION 1)
    set(VA_API_MINOR_VERSION 23)
    set(VA_API_MICRO_VERSION 0)
    set(VA_API_VERSION 1.23.0)
    configure_file("${libva_headers_SOURCE_DIR}/va/va_version.h.in"
        "${libva_headers_BINARY_DIR}/va/va_version.h" @ONLY)
    target_include_directories(noveltea_engine SYSTEM PRIVATE
        "${libva_headers_SOURCE_DIR}" "${libva_headers_BINARY_DIR}")
endif()
if(ANDROID)
    include(NovelTeaAndroidVpx)
else()
    find_package(unofficial-libvpx CONFIG REQUIRED)
endif()
target_link_libraries(noveltea_engine PRIVATE noveltea_webm_parser unofficial::libvpx::libvpx)
if(ANDROID)
    target_link_libraries(noveltea_engine PRIVATE mediandk)
elseif(WIN32)
    target_link_libraries(noveltea_engine PRIVATE mfplat mfuuid d3d11 dxgi ole32)
elseif(APPLE)
    target_link_libraries(noveltea_engine PRIVATE "-framework CoreMedia" "-framework CoreVideo" "-framework VideoToolbox")
endif()
