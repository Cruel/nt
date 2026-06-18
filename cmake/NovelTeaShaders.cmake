include("${CMAKE_CURRENT_LIST_DIR}/NovelTeaShaderManifest.cmake")

function(noveltea_default_shader_variants out_var)
    if(EMSCRIPTEN)
        set(_variants essl-100)
    elseif(CMAKE_SYSTEM_NAME STREQUAL "Android")
        set(_variants essl-300)
    else()
        set(_variants glsl-120)
    endif()
    set(${out_var} "${_variants}" PARENT_SCOPE)
endfunction()

function(noveltea_get_shader_variant)
    cmake_parse_arguments(ARG "" "VARIANT;OUT_PLATFORM;OUT_PROFILE" "" ${ARGN})
    list(LENGTH NOVELTEA_SHADER_VARIANT_DATA _len)
    math(EXPR _last "${_len} - 1")
    foreach(_i RANGE 0 ${_last} 3)
        list(GET NOVELTEA_SHADER_VARIANT_DATA ${_i} _name)
        if(_name STREQUAL ARG_VARIANT)
            math(EXPR _platform_i "${_i} + 1")
            math(EXPR _profile_i "${_i} + 2")
            list(GET NOVELTEA_SHADER_VARIANT_DATA ${_platform_i} _platform)
            list(GET NOVELTEA_SHADER_VARIANT_DATA ${_profile_i} _profile)
            set(${ARG_OUT_PLATFORM} "${_platform}" PARENT_SCOPE)
            set(${ARG_OUT_PROFILE} "${_profile}" PARENT_SCOPE)
            return()
        endif()
    endforeach()
    message(FATAL_ERROR "Unknown NovelTea shader variant '${ARG_VARIANT}'")
endfunction()

function(noveltea_collect_shader_outputs)
    cmake_parse_arguments(ARG "" "OUTPUT_ROOT;OUT_VAR" "VARIANTS" ${ARGN})
    set(_outputs)
    foreach(_variant IN LISTS ARG_VARIANTS)
        noveltea_get_shader_variant(VARIANT "${_variant}" OUT_PLATFORM _platform OUT_PROFILE _profile)
        list(LENGTH NOVELTEA_SHADER_PROGRAMS _len)
        math(EXPR _last "${_len} - 1")
        foreach(_i RANGE 0 ${_last} 3)
            list(GET NOVELTEA_SHADER_PROGRAMS ${_i} _program)
            list(APPEND _outputs
                "${ARG_OUTPUT_ROOT}/shaders/bgfx/${_variant}/${_program}.vs.bin"
                "${ARG_OUTPUT_ROOT}/shaders/bgfx/${_variant}/${_program}.fs.bin")
        endforeach()
    endforeach()
    set(${ARG_OUT_VAR} "${_outputs}" PARENT_SCOPE)
endfunction()

function(noveltea_collect_shader_inputs source_dir out_var)
    set(_cmake_dir "${CMAKE_SOURCE_DIR}/cmake")
    set(_inputs
        "${_cmake_dir}/NovelTeaShaderManifest.cmake"
        "${_cmake_dir}/NovelTeaShaders.cmake"
        "${_cmake_dir}/CompileNovelTeaShaders.cmake"
        "${source_dir}/varying.def.sc")
    list(LENGTH NOVELTEA_SHADER_PROGRAMS _len)
    math(EXPR _last "${_len} - 1")
    foreach(_i RANGE 0 ${_last} 3)
        math(EXPR _vs_i "${_i} + 1")
        math(EXPR _fs_i "${_i} + 2")
        list(GET NOVELTEA_SHADER_PROGRAMS ${_vs_i} _vs)
        list(GET NOVELTEA_SHADER_PROGRAMS ${_fs_i} _fs)
        list(APPEND _inputs "${source_dir}/${_vs}" "${source_dir}/${_fs}")
    endforeach()
    set(${out_var} "${_inputs}" PARENT_SCOPE)
endfunction()

function(noveltea_find_shader_tools)
    set(options REQUIRED)
    cmake_parse_arguments(ARG "${options}" "OUT_SHADERC;OUT_BGFX_INCLUDE" "" ${ARGN})

    set(_shaderc "${NOVELTEA_SHADERC_EXECUTABLE}")
    if(NOT _shaderc AND DEFINED ENV{SHADERC})
        set(_shaderc "$ENV{SHADERC}")
    endif()
    if(NOT _shaderc)
        find_program(_shaderc_found shaderc)
        set(_shaderc "${_shaderc_found}")
    endif()
    if(NOT _shaderc)
        foreach(_root "${VCPKG_INSTALLED_DIR}" "${CMAKE_BINARY_DIR}/vcpkg_installed" "${CMAKE_SOURCE_DIR}/vcpkg_installed")
            foreach(_triplet "${VCPKG_HOST_TRIPLET}" "x64-linux" "${CMAKE_HOST_SYSTEM_PROCESSOR}-linux" "${VCPKG_TARGET_TRIPLET}")
                if(EXISTS "${_root}/${_triplet}/tools/bgfx/shaderc")
                    set(_shaderc "${_root}/${_triplet}/tools/bgfx/shaderc")
                    break()
                endif()
            endforeach()
        endforeach()
    endif()
    if(ARG_REQUIRED AND (NOT _shaderc OR NOT EXISTS "${_shaderc}"))
        message(FATAL_ERROR "shaderc host executable not found. Set NOVELTEA_SHADERC_EXECUTABLE or SHADERC, or install bgfx[tools].")
    endif()

    set(_bgfx_include "${NOVELTEA_BGFX_SHADER_INCLUDE_DIR}")
    if(NOT _bgfx_include)
        foreach(_root "${VCPKG_INSTALLED_DIR}" "${CMAKE_BINARY_DIR}/vcpkg_installed" "${CMAKE_SOURCE_DIR}/vcpkg_installed")
            foreach(_triplet "${VCPKG_HOST_TRIPLET}" "x64-linux" "${CMAKE_HOST_SYSTEM_PROCESSOR}-linux" "${VCPKG_TARGET_TRIPLET}")
                if(EXISTS "${_root}/${_triplet}/include/bgfx/bgfx_shader.sh")
                    set(_bgfx_include "${_root}/${_triplet}/include/bgfx")
                    break()
                endif()
            endforeach()
        endforeach()
    endif()
    if(ARG_REQUIRED AND (NOT _bgfx_include OR NOT EXISTS "${_bgfx_include}/bgfx_shader.sh"))
        message(FATAL_ERROR "bgfx_shader.sh not found. Set NOVELTEA_BGFX_SHADER_INCLUDE_DIR to the bgfx shader include directory.")
    endif()

    set(${ARG_OUT_SHADERC} "${_shaderc}" PARENT_SCOPE)
    set(${ARG_OUT_BGFX_INCLUDE} "${_bgfx_include}" PARENT_SCOPE)
endfunction()

function(noveltea_add_shader_target)
    cmake_parse_arguments(ARG "" "TARGET;SHADERC;SOURCE_DIR;OUTPUT_ROOT;BGFX_INCLUDE_DIR" "VARIANTS" ${ARGN})
    noveltea_collect_shader_outputs(VARIANTS ${ARG_VARIANTS} OUTPUT_ROOT "${ARG_OUTPUT_ROOT}" OUT_VAR _outputs)
    noveltea_collect_shader_inputs("${ARG_SOURCE_DIR}" _inputs)
    list(JOIN ARG_VARIANTS ";" _variants_arg)
    add_custom_command(
        OUTPUT ${_outputs}
        COMMAND "${CMAKE_COMMAND}"
            "-DNOVELTEA_SHADERC_EXECUTABLE=${ARG_SHADERC}"
            "-DNOVELTEA_SHADER_SOURCE_DIR=${ARG_SOURCE_DIR}"
            "-DNOVELTEA_SHADER_OUTPUT_ROOT=${ARG_OUTPUT_ROOT}"
            "-DNOVELTEA_SHADER_VARIANTS=${_variants_arg}"
            "-DNOVELTEA_BGFX_SHADER_INCLUDE_DIR=${ARG_BGFX_INCLUDE_DIR}"
            -P "${CMAKE_SOURCE_DIR}/cmake/CompileNovelTeaShaders.cmake"
        DEPENDS ${_inputs}
        COMMENT "Compiling NovelTea bgfx shaders"
        VERBATIM
    )
    add_custom_target(${ARG_TARGET} DEPENDS ${_outputs})
endfunction()
