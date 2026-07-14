function(noveltea_provide_miniaudio out_var)
    unset(_noveltea_miniaudio_include_dir CACHE)
    find_path(_noveltea_miniaudio_include_dir "miniaudio.h")

    if(NOT _noveltea_miniaudio_include_dir AND NOT EMSCRIPTEN AND NOT CMAKE_SYSTEM_NAME STREQUAL "Android")
        if(EXISTS "$CACHE{VCPKG_INSTALLED_DIR}/$CACHE{VCPKG_TARGET_TRIPLET}/include/miniaudio.h")
            set(_noveltea_miniaudio_include_dir
                "$CACHE{VCPKG_INSTALLED_DIR}/$CACHE{VCPKG_TARGET_TRIPLET}/include")
        endif()
        file(GLOB _noveltea_vcpkg_include_roots
            "${CMAKE_BINARY_DIR}/vcpkg_installed/*/include"
            "${VCPKG_INSTALLED_DIR}/*/include"
            "${_VCPKG_INSTALLED_DIR}/*/include")
        foreach(_root ${_noveltea_vcpkg_include_roots}
            "${CMAKE_SOURCE_DIR}/build/linux-debug/vcpkg_installed/x64-linux/include"
            "${CMAKE_SOURCE_DIR}/vcpkg_installed/x64-linux/include"
            "$ENV{VCPKG_ROOT}/installed/x64-linux/include")
            if(EXISTS "${_root}/miniaudio.h")
                set(_noveltea_miniaudio_include_dir "${_root}")
                break()
            endif()
        endforeach()
    endif()

    if(NOT _noveltea_miniaudio_include_dir)
        include(FetchContent)
        FetchContent_Declare(
            miniaudio
            URL https://github.com/mackron/miniaudio/archive/refs/tags/0.11.25.tar.gz
            DOWNLOAD_EXTRACT_TIMESTAMP TRUE
        )
        FetchContent_MakeAvailable(miniaudio)
        set(_noveltea_miniaudio_include_dir "${miniaudio_SOURCE_DIR}")
    endif()

    if(NOT EXISTS "${_noveltea_miniaudio_include_dir}/miniaudio.h")
        message(FATAL_ERROR "miniaudio.h not found")
    endif()
    set(${out_var} "${_noveltea_miniaudio_include_dir}" PARENT_SCOPE)
endfunction()
