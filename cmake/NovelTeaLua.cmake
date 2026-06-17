include_guard(GLOBAL)

function(noveltea_normalize_lua_target)
    if(TARGET Lua::Lua)
        return()
    endif()
    if(DEFINED LUA_LIBRARIES AND DEFINED LUA_INCLUDE_DIR)
        add_library(Lua::Lua INTERFACE IMPORTED)
        set_target_properties(Lua::Lua PROPERTIES
            INTERFACE_LINK_LIBRARIES "${LUA_LIBRARIES}"
            INTERFACE_INCLUDE_DIRECTORIES "${LUA_INCLUDE_DIR}"
        )
    endif()
endfunction()

function(noveltea_provide_lua_dependencies)
    if(EMSCRIPTEN OR CMAKE_SYSTEM_NAME STREQUAL "Android")
        include(FetchContent)

        if(NOT TARGET Lua::Lua)
            FetchContent_Declare(
                lua_src
                URL https://www.lua.org/ftp/lua-5.5.0.tar.gz
                URL_HASH SHA256=57ccc32bbbd005cab75bcc52444052535af691789dba2b9016d5c50640d68b3d
                DOWNLOAD_EXTRACT_TIMESTAMP TRUE
            )
            FetchContent_MakeAvailable(lua_src)

            set(NOVELTEA_LUA_SOURCE_DIR "${lua_src_SOURCE_DIR}/src")
            file(GLOB NOVELTEA_LUA_SOURCES CONFIGURE_DEPENDS "${NOVELTEA_LUA_SOURCE_DIR}/*.c")
            list(FILTER NOVELTEA_LUA_SOURCES EXCLUDE REGEX "/lua\\.c$")
            list(FILTER NOVELTEA_LUA_SOURCES EXCLUDE REGEX "/luac\\.c$")
            add_library(noveltea_lua STATIC ${NOVELTEA_LUA_SOURCES})
            target_include_directories(noveltea_lua PUBLIC "${NOVELTEA_LUA_SOURCE_DIR}")
            set_target_properties(noveltea_lua PROPERTIES
                POSITION_INDEPENDENT_CODE ON
                C_STANDARD 99
                C_STANDARD_REQUIRED ON
                C_EXTENSIONS OFF
            )
            if(UNIX AND NOT EMSCRIPTEN AND NOT CMAKE_SYSTEM_NAME STREQUAL "Android")
                target_link_libraries(noveltea_lua PUBLIC m)
            endif()
            add_library(Lua::Lua INTERFACE IMPORTED GLOBAL)
            set_target_properties(Lua::Lua PROPERTIES
                INTERFACE_LINK_LIBRARIES noveltea_lua
                INTERFACE_INCLUDE_DIRECTORIES "${NOVELTEA_LUA_SOURCE_DIR}"
            )
        endif()

        if(NOT TARGET sol2::sol2)
            set(SOL2_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
            set(SOL2_BUILD_LUA OFF CACHE BOOL "" FORCE)
            set(SOL2_BUILD_TESTS OFF CACHE BOOL "" FORCE)
            set(SOL2_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
            set(SOL2_BUILD_DOCS OFF CACHE BOOL "" FORCE)
            FetchContent_Declare(
                sol2
                GIT_REPOSITORY https://github.com/ThePhD/sol2.git
                GIT_TAG v3.5.0
                GIT_SHALLOW FALSE
                PATCH_COMMAND "${CMAKE_COMMAND}" "-DSOL2_SOURCE_DIR=<SOURCE_DIR>" -P "${CMAKE_SOURCE_DIR}/cmake/patch-sol2-lua55.cmake"
            )
            FetchContent_MakeAvailable(sol2)
        endif()
    else()
        find_package(Lua REQUIRED)
        if(NOT LUA_VERSION_STRING VERSION_EQUAL "5.5.0")
            message(FATAL_ERROR "NovelTea requires Lua 5.5.0 exactly, found ${LUA_VERSION_STRING}")
        endif()
        noveltea_normalize_lua_target()
        if(NOT TARGET Lua::Lua)
            message(FATAL_ERROR "Lua 5.5 was found but no Lua::Lua target or LUA_LIBRARIES/LUA_INCLUDE_DIR variables were available")
        endif()
        find_package(sol2 CONFIG REQUIRED)
    endif()
endfunction()
