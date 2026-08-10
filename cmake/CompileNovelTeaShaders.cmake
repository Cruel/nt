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

if(NOT NOVELTEA_CLI_EXECUTABLE OR NOT EXISTS "${NOVELTEA_CLI_EXECUTABLE}")
    message(FATAL_ERROR "NOVELTEA_CLI_EXECUTABLE is not an executable NovelTea host CLI: ${NOVELTEA_CLI_EXECUTABLE}")
endif()
if(NOT NOVELTEA_BGFX_SHADER_INCLUDE_DIR OR NOT EXISTS "${NOVELTEA_BGFX_SHADER_INCLUDE_DIR}/bgfx_shader.sh")
    message(FATAL_ERROR "NOVELTEA_BGFX_SHADER_INCLUDE_DIR must contain bgfx_shader.sh: ${NOVELTEA_BGFX_SHADER_INCLUDE_DIR}")
endif()

function(_noveltea_json_string value out_var)
    set(_value "${value}")
    string(REPLACE "\\" "\\\\" _value "${_value}")
    string(REPLACE "\"" "\\\"" _value "${_value}")
    string(REPLACE "\n" "\\n" _value "${_value}")
    string(REPLACE "\r" "\\r" _value "${_value}")
    set(${out_var} "\"${_value}\"" PARENT_SCOPE)
endfunction()

set(_batch "[]")
set(_batch_index 0)
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
            set(_args
                -f "${NOVELTEA_SHADER_SOURCE_DIR}/${_source}"
                -o "${_output}"
                --type "${_type}"
                --platform "${_platform}"
                --profile "${_profile}"
                -i "${NOVELTEA_SHADER_SOURCE_DIR}"
                -i "${NOVELTEA_BGFX_SHADER_INCLUDE_DIR}")
            set(_command "[]")
            set(_arg_index 0)
            foreach(_arg IN LISTS _args)
                _noveltea_json_string("${_arg}" _json_arg)
                string(JSON _command SET "${_command}" ${_arg_index} "${_json_arg}")
                math(EXPR _arg_index "${_arg_index} + 1")
            endforeach()
            string(JSON _batch SET "${_batch}" ${_batch_index} "${_command}")
            math(EXPR _batch_index "${_batch_index} + 1")
        endforeach()
    endforeach()
endforeach()

set(_batch_file "${NOVELTEA_SHADER_OUTPUT_ROOT}/.noveltea-shaderc-batch.json")
file(WRITE "${_batch_file}" "${_batch}\n")
execute_process(
    COMMAND "${NOVELTEA_CLI_EXECUTABLE}" __shaderc-batch
    INPUT_FILE "${_batch_file}"
    RESULT_VARIABLE _result
)
file(REMOVE "${_batch_file}")
if(NOT _result EQUAL 0)
    message(FATAL_ERROR "NovelTea shader batch compilation failed with exit code ${_result}")
endif()
