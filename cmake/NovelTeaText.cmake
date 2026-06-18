include_guard(GLOBAL)

function(noveltea_alias_imported_target alias target)
    if(TARGET "${alias}" OR NOT TARGET "${target}")
        return()
    endif()
    add_library("${alias}" INTERFACE IMPORTED GLOBAL)
    target_link_libraries("${alias}" INTERFACE "${target}")
endfunction()

function(noveltea_provide_freetype_dependency)
    if(TARGET Freetype::Freetype)
        return()
    endif()

    if(EMSCRIPTEN)
        add_library(Freetype::Freetype INTERFACE IMPORTED GLOBAL)
        target_compile_options(Freetype::Freetype INTERFACE -sUSE_FREETYPE=1)
        target_link_options(Freetype::Freetype INTERFACE -sUSE_FREETYPE=1)
        return()
    endif()

    if(CMAKE_SYSTEM_NAME STREQUAL "Android")
        include(FetchContent)
        set(FT_DISABLE_ZLIB ON CACHE BOOL "" FORCE)
        set(FT_DISABLE_BZIP2 ON CACHE BOOL "" FORCE)
        set(FT_DISABLE_PNG ON CACHE BOOL "" FORCE)
        set(FT_DISABLE_HARFBUZZ ON CACHE BOOL "" FORCE)
        set(FT_DISABLE_BROTLI ON CACHE BOOL "" FORCE)
        FetchContent_Declare(
            freetype
            GIT_REPOSITORY https://gitlab.freedesktop.org/freetype/freetype.git
            GIT_TAG VER-2-14-3
            GIT_SHALLOW TRUE
        )
        FetchContent_MakeAvailable(freetype)
        if(TARGET freetype AND NOT TARGET Freetype::Freetype)
            add_library(Freetype::Freetype ALIAS freetype)
        endif()
        return()
    endif()

    find_package(freetype CONFIG REQUIRED)
    if(TARGET freetype AND NOT TARGET Freetype::Freetype)
        add_library(Freetype::Freetype ALIAS freetype)
    endif()
endfunction()

function(noveltea_provide_text_dependencies)
    noveltea_provide_freetype_dependency()

    if((EMSCRIPTEN OR CMAKE_SYSTEM_NAME STREQUAL "Android") AND NOT TARGET SheenBidi::SheenBidi)
        include(FetchContent)
        set(SB_CONFIG_EXPERIMENTAL_TEXT_API OFF CACHE BOOL "" FORCE)
        set(SB_CONFIG_UNITY ON CACHE BOOL "" FORCE)
        set(BUILD_GENERATOR OFF CACHE BOOL "" FORCE)
        set(ENABLE_COVERAGE OFF CACHE BOOL "" FORCE)
        set(ENABLE_ASAN OFF CACHE BOOL "" FORCE)
        set(ENABLE_UBSAN OFF CACHE BOOL "" FORCE)
        FetchContent_Declare(
            SheenBidi
            URL https://github.com/Tehreer/SheenBidi/archive/v3.0.0.tar.gz
            URL_HASH SHA512=67c8ef7bea9fc677fbb83601403b40bcc274842597df53a699fd5758f4f170ac5d1fc9a719d590da25f6a72769fe59a2a1cf57e54f0ef6859561bfb77c0c72c4
            DOWNLOAD_EXTRACT_TIMESTAMP TRUE
        )
        FetchContent_MakeAvailable(SheenBidi)
    endif()

    if((EMSCRIPTEN OR CMAKE_SYSTEM_NAME STREQUAL "Android") AND NOT TARGET libunibreak::libunibreak)
        include(FetchContent)
        FetchContent_Declare(
            libunibreak_src
            URL https://github.com/adah1972/libunibreak/archive/libunibreak_7_0.tar.gz
            URL_HASH SHA512=50271605be1645698df7ef5b97ae6bbc75b7228ea1aa26a261f33afd8e264e63c37c190d8d7f3a93f87d60b627a68ec90f2f7f55ef08486e5a8bd667c4a372f6
            DOWNLOAD_EXTRACT_TIMESTAMP TRUE
        )
        FetchContent_GetProperties(libunibreak_src)
        if(NOT libunibreak_src_POPULATED)
            if(POLICY CMP0169)
                cmake_policy(PUSH)
                cmake_policy(SET CMP0169 OLD)
            endif()
            FetchContent_Populate(libunibreak_src)
            if(POLICY CMP0169)
                cmake_policy(POP)
            endif()
            add_library(unibreak STATIC
                "${libunibreak_src_SOURCE_DIR}/src/linebreak.c"
                "${libunibreak_src_SOURCE_DIR}/src/linebreakdata.c"
                "${libunibreak_src_SOURCE_DIR}/src/linebreakdef.c"
                "${libunibreak_src_SOURCE_DIR}/src/wordbreak.c"
                "${libunibreak_src_SOURCE_DIR}/src/wordbreakdata.c"
                "${libunibreak_src_SOURCE_DIR}/src/graphemebreak.c"
                "${libunibreak_src_SOURCE_DIR}/src/graphemebreakdata.c"
                "${libunibreak_src_SOURCE_DIR}/src/emojidef.c"
                "${libunibreak_src_SOURCE_DIR}/src/eastasianwidthdef.c"
                "${libunibreak_src_SOURCE_DIR}/src/eastasianwidthdata.c"
                "${libunibreak_src_SOURCE_DIR}/src/unibreakbase.c"
                "${libunibreak_src_SOURCE_DIR}/src/unibreakdef.c"
            )
            target_include_directories(unibreak PUBLIC "${libunibreak_src_SOURCE_DIR}/src")
            add_library(libunibreak::libunibreak ALIAS unibreak)
        endif()
    endif()

    if(EMSCRIPTEN)
        if(NOT TARGET harfbuzz::harfbuzz)
            add_library(harfbuzz_emscripten INTERFACE)
            target_compile_options(harfbuzz_emscripten INTERFACE -sUSE_HARFBUZZ=1)
            target_link_options(harfbuzz_emscripten INTERFACE -sUSE_HARFBUZZ=1)
            add_library(harfbuzz::harfbuzz ALIAS harfbuzz_emscripten)
        endif()
    elseif(CMAKE_SYSTEM_NAME STREQUAL "Android" AND NOT TARGET harfbuzz::harfbuzz)
        include(FetchContent)
        set(HB_HAVE_FREETYPE ON CACHE BOOL "" FORCE)
        set(HB_HAVE_CAIRO OFF CACHE BOOL "" FORCE)
        set(HB_HAVE_GRAPHITE2 OFF CACHE BOOL "" FORCE)
        set(HB_HAVE_GLIB OFF CACHE BOOL "" FORCE)
        set(HB_HAVE_ICU OFF CACHE BOOL "" FORCE)
        set(HB_BUILD_UTILS OFF CACHE BOOL "" FORCE)
        set(HB_BUILD_SUBSET OFF CACHE BOOL "" FORCE)
        set(HB_BUILD_RASTER OFF CACHE BOOL "" FORCE)
        set(HB_BUILD_VECTOR OFF CACHE BOOL "" FORCE)
        set(HB_BUILD_GPU OFF CACHE BOOL "" FORCE)
        FetchContent_Declare(
            harfbuzz
            URL https://github.com/harfbuzz/harfbuzz/archive/14.2.1.tar.gz
            URL_HASH SHA512=b7642a81eb021bf96cf8c91c5ebdde7f4fdfd40c76db722f00cf001125f4b81b954d08485774d2b23318d49b1e954fa0189ba8f10db56d148f33f9d90891d0cb
            DOWNLOAD_EXTRACT_TIMESTAMP TRUE
        )
        FetchContent_MakeAvailable(harfbuzz)
        if(TARGET harfbuzz AND NOT TARGET harfbuzz::harfbuzz)
            add_library(harfbuzz::harfbuzz ALIAS harfbuzz)
        endif()
    else()
        find_package(harfbuzz CONFIG REQUIRED)
    endif()
    if(NOT TARGET SheenBidi::SheenBidi)
        find_package(SheenBidi CONFIG REQUIRED)
    endif()
    if(NOT TARGET libunibreak::libunibreak)
        find_package(libunibreak CONFIG REQUIRED)
    endif()

    noveltea_alias_imported_target(noveltea_text_freetype Freetype::Freetype)
    if(NOT TARGET noveltea_text_freetype AND TARGET freetype)
        noveltea_alias_imported_target(noveltea_text_freetype freetype)
    endif()

    noveltea_alias_imported_target(noveltea_text_harfbuzz harfbuzz::harfbuzz)
    if(NOT TARGET noveltea_text_harfbuzz AND TARGET harfbuzz)
        noveltea_alias_imported_target(noveltea_text_harfbuzz harfbuzz)
    endif()

    noveltea_alias_imported_target(noveltea_text_sheenbidi SheenBidi::SheenBidi)
    if(NOT TARGET noveltea_text_sheenbidi AND TARGET SheenBidi)
        noveltea_alias_imported_target(noveltea_text_sheenbidi SheenBidi)
    endif()

    noveltea_alias_imported_target(noveltea_text_unibreak libunibreak::libunibreak)
    if(NOT TARGET noveltea_text_unibreak AND TARGET unibreak)
        noveltea_alias_imported_target(noveltea_text_unibreak unibreak)
    endif()

    foreach(_target IN ITEMS noveltea_text_freetype noveltea_text_harfbuzz noveltea_text_sheenbidi noveltea_text_unibreak)
        if(NOT TARGET "${_target}")
            message(FATAL_ERROR "NovelTea text dependency target '${_target}' was not created")
        endif()
    endforeach()
endfunction()
