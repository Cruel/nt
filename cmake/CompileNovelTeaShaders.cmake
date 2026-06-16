include("${CMAKE_CURRENT_LIST_DIR}/NovelTeaShaderManifest.cmake")
include("${CMAKE_CURRENT_LIST_DIR}/NovelTeaShaders.cmake")

if(NOT DEFINED NOVELTEA_SHADER_SOURCE_DIR)
    set(NOVELTEA_SHADER_SOURCE_DIR "${CMAKE_CURRENT_LIST_DIR}/../engine/shaders/bgfx")
endif()
if(NOT DEFINED NOVELTEA_SHADER_OUTPUT_ROOT)
    message(FATAL_ERROR "NOVELTEA_SHADER_OUTPUT_ROOT is required")
endif()
if(NOT DEFINED NOVELTEA_SHADER_VARIANTS)
    message(FATAL_ERROR "NOVELTEA_SHADER_VARIANTS is required")
endif()

function(_required_outputs out_var)
    noveltea_collect_shader_outputs(
        VARIANTS ${NOVELTEA_SHADER_VARIANTS}
        OUTPUT_ROOT "${NOVELTEA_SHADER_OUTPUT_ROOT}"
        OUT_VAR _outputs)
    set(${out_var} "${_outputs}" PARENT_SCOPE)
endfunction()

if(NOVELTEA_VERIFY_ONLY)
    _required_outputs(_outputs)
    set(_missing)
    foreach(_output IN LISTS _outputs)
        if(NOT EXISTS "${_output}")
            list(APPEND _missing "${_output}")
        endif()
    endforeach()
    if(_missing)
        list(JOIN _missing "\n  " _message)
        message(FATAL_ERROR "Missing NovelTea shader binaries:\n  ${_message}")
    endif()
    return()
endif()

if(NOT NOVELTEA_SHADERC_EXECUTABLE OR NOT EXISTS "${NOVELTEA_SHADERC_EXECUTABLE}")
    message(FATAL_ERROR "NOVELTEA_SHADERC_EXECUTABLE is not an executable host shaderc: ${NOVELTEA_SHADERC_EXECUTABLE}")
endif()
if(NOT NOVELTEA_BGFX_SHADER_INCLUDE_DIR OR NOT EXISTS "${NOVELTEA_BGFX_SHADER_INCLUDE_DIR}/bgfx_shader.sh")
    message(FATAL_ERROR "NOVELTEA_BGFX_SHADER_INCLUDE_DIR must contain bgfx_shader.sh: ${NOVELTEA_BGFX_SHADER_INCLUDE_DIR}")
endif()

foreach(_variant IN LISTS NOVELTEA_SHADER_VARIANTS)
    noveltea_get_shader_variant(VARIANT "${_variant}" OUT_PLATFORM _platform OUT_PROFILE _profile)
    set(_out_dir "${NOVELTEA_SHADER_OUTPUT_ROOT}/shaders/bgfx/${_variant}")
    file(MAKE_DIRECTORY "${_out_dir}")
    list(LENGTH NOVELTEA_SHADER_PROGRAMS _len)
    math(EXPR _last "${_len} - 1")
    foreach(_i RANGE 0 ${_last} 3)
        list(GET NOVELTEA_SHADER_PROGRAMS ${_i} _program)
        math(EXPR _vs_i "${_i} + 1")
        math(EXPR _fs_i "${_i} + 2")
        list(GET NOVELTEA_SHADER_PROGRAMS ${_vs_i} _vs)
        list(GET NOVELTEA_SHADER_PROGRAMS ${_fs_i} _fs)
        foreach(_stage vs fs)
            if(_stage STREQUAL "vs")
                set(_source "${_vs}")
                set(_type vertex)
            else()
                set(_source "${_fs}")
                set(_type fragment)
            endif()
            set(_output "${_out_dir}/${_program}.${_stage}.bin")
            execute_process(
                COMMAND "${NOVELTEA_SHADERC_EXECUTABLE}"
                    -f "${NOVELTEA_SHADER_SOURCE_DIR}/${_source}"
                    -o "${_output}"
                    --type "${_type}"
                    --platform "${_platform}"
                    --profile "${_profile}"
                    -i "${NOVELTEA_SHADER_SOURCE_DIR}"
                    -i "${NOVELTEA_BGFX_SHADER_INCLUDE_DIR}"
                RESULT_VARIABLE _result
            )
            if(NOT _result EQUAL 0)
                message(FATAL_ERROR "shaderc failed for ${_source} (${_variant})")
            endif()
        endforeach()
    endforeach()
endforeach()
