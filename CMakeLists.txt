cmake_minimum_required(VERSION 3.24)
project(noveltea VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

option(NOVELTEA_BUILD_SANDBOX "Build the sandbox application" ON)
option(NOVELTEA_USE_IMGUI "Include Dear ImGui debug overlay" ON)

add_subdirectory(engine)

if(NOVELTEA_BUILD_SANDBOX)
    add_subdirectory(apps/sandbox)
endif()
