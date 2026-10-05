option(NOVELTEA_ENABLE_COVERAGE "Instrument first-party native targets for GCC/gcov coverage" OFF)

if(NOVELTEA_ENABLE_COVERAGE)
    if(NOT CMAKE_CXX_COMPILER_ID STREQUAL "GNU" OR NOT CMAKE_C_COMPILER_ID STREQUAL "GNU"
        OR CMAKE_CROSSCOMPILING)
        message(FATAL_ERROR "NOVELTEA_ENABLE_COVERAGE requires a native GCC build")
    endif()

    function(noveltea_instrument_coverage directory)
        get_property(targets DIRECTORY "${directory}" PROPERTY BUILDSYSTEM_TARGETS)
        foreach(target IN LISTS targets)
            # These host targets are upstream source closures, not NovelTea implementation.
            if(target MATCHES "^noveltea_(bgfx_shaderc|bimg_texturec)_embedded$")
                continue()
            endif()
            get_target_property(type "${target}" TYPE)
            if(type MATCHES "^(STATIC_LIBRARY|SHARED_LIBRARY|MODULE_LIBRARY|OBJECT_LIBRARY|EXECUTABLE)$")
                target_compile_options("${target}" PRIVATE --coverage -O0 -g)
                if(NOT type STREQUAL "OBJECT_LIBRARY")
                    # Static libraries must propagate the gcov runtime to their final executable.
                    target_link_options("${target}" PUBLIC --coverage)
                endif()
            endif()
        endforeach()
        get_property(children DIRECTORY "${directory}" PROPERTY SUBDIRECTORIES)
        foreach(child IN LISTS children)
            if(child MATCHES "^${CMAKE_SOURCE_DIR}/(engine|apps|tests|tools)(/|$)")
                noveltea_instrument_coverage("${child}")
            endif()
        endforeach()
    endfunction()

    noveltea_instrument_coverage("${CMAKE_SOURCE_DIR}")
endif()
