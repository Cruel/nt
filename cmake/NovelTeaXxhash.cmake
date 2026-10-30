include(FetchContent)

# Header-only XXH3; the pinned upstream source is used by native host tooling
# and the engine without adding a shared-library or runtime linker dependency.
if(NOT TARGET noveltea_xxhash)
    FetchContent_Declare(noveltea_xxhash_source
        GIT_REPOSITORY https://github.com/Cyan4973/xxHash.git
        GIT_TAG c87183a77d67f7d37e3d2d1b7eaac5e7c695e4f0
        GIT_SHALLOW FALSE
        SOURCE_SUBDIR noveltea-no-upstream-build
    )
    FetchContent_MakeAvailable(noveltea_xxhash_source)
    add_library(noveltea_xxhash INTERFACE)
    target_include_directories(noveltea_xxhash SYSTEM INTERFACE
        "${noveltea_xxhash_source_SOURCE_DIR}")
endif()
