include(FetchContent)
FetchContent_Declare(libvpx
    URL https://github.com/webmproject/libvpx/archive/refs/tags/v1.16.0.tar.gz
    URL_HASH SHA256=7a479a3c66b9f5d5542a4c6a1b7d3768a983b1e5c14c60a9396edc9b649e015c
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_GetProperties(libvpx)
if(NOT libvpx_POPULATED)
    FetchContent_Populate(libvpx)
endif()
find_package(Perl REQUIRED)
file(MAKE_DIRECTORY "${libvpx_BINARY_DIR}")
execute_process(COMMAND "${CMAKE_COMMAND}" -E env
    "CC=${CMAKE_C_COMPILER} --target=${CMAKE_C_COMPILER_TARGET} --sysroot=${CMAKE_SYSROOT}"
    "AR=${CMAKE_AR}" "CFLAGS=${CMAKE_C_FLAGS}"
    "${libvpx_SOURCE_DIR}/configure" --target=generic-gnu --disable-vp8
    --disable-vp9-encoder --disable-examples --disable-tools --disable-docs
    --disable-unit-tests --disable-runtime-cpu-detect --enable-pic
    WORKING_DIRECTORY "${libvpx_BINARY_DIR}"
    RESULT_VARIABLE _vpx_config_result
    OUTPUT_FILE "${libvpx_BINARY_DIR}/noveltea-configure.log"
    ERROR_FILE "${libvpx_BINARY_DIR}/noveltea-configure-error.log")
if(NOT _vpx_config_result EQUAL 0)
    message(FATAL_ERROR "Android libvpx configuration failed; see ${libvpx_BINARY_DIR}/noveltea-configure-error.log")
endif()
foreach(_rtcd IN ITEMS vp9 vpx_dsp vpx_scale)
    if(_rtcd STREQUAL "vp9")
        set(_definitions "vp9/common/vp9_rtcd_defs.pl")
    elseif(_rtcd STREQUAL "vpx_dsp")
        set(_definitions "vpx_dsp/vpx_dsp_rtcd_defs.pl")
    else()
        set(_definitions "vpx_scale/vpx_scale_rtcd.pl")
    endif()
    execute_process(COMMAND "${PERL_EXECUTABLE}" "${libvpx_SOURCE_DIR}/build/make/rtcd.pl"
        --arch=generic "--config=${libvpx_BINARY_DIR}/libs-generic-gnu.mk" "--sym=${_rtcd}_rtcd"
        "${libvpx_SOURCE_DIR}/${_definitions}"
        OUTPUT_FILE "${libvpx_BINARY_DIR}/${_rtcd}_rtcd.h"
        RESULT_VARIABLE _rtcd_result)
    if(NOT _rtcd_result EQUAL 0)
        message(FATAL_ERROR "Android libvpx runtime dispatch generation failed")
    endif()
endforeach()
execute_process(COMMAND sh "${libvpx_SOURCE_DIR}/build/make/version.sh"
    "${libvpx_SOURCE_DIR}" "${libvpx_BINARY_DIR}/vpx_version.h"
    WORKING_DIRECTORY "${libvpx_BINARY_DIR}" RESULT_VARIABLE _vpx_version_result)
if(NOT _vpx_version_result EQUAL 0)
    message(FATAL_ERROR "Android libvpx version header generation failed")
endif()
# Portable C decoder fallback; encoder interfaces and architecture-specific objects stay out.
# CMake owns compilation, so the normal inherited build parallelism applies on Android too.
file(GLOB _vpx_sources CONFIGURE_DEPENDS
    "${libvpx_SOURCE_DIR}/vpx/src/*.c"
    "${libvpx_SOURCE_DIR}/vpx_mem/*.c"
    "${libvpx_SOURCE_DIR}/vpx_scale/*.c"
    "${libvpx_SOURCE_DIR}/vpx_scale/generic/*.c"
    "${libvpx_SOURCE_DIR}/vp9/common/*.c"
    "${libvpx_SOURCE_DIR}/vp9/decoder/*.c")
list(FILTER _vpx_sources EXCLUDE REGEX "/(vpx_encoder|vp9_debugmodes|vp9_mfqe|vp9_postproc|postproc)\\.c$")
foreach(_dsp_source prob bitreader bitreader_buffer intrapred vpx_convolve loopfilter inv_txfm vpx_dsp_rtcd)
    list(APPEND _vpx_sources "${libvpx_SOURCE_DIR}/vpx_dsp/${_dsp_source}.c")
endforeach()
add_library(noveltea_vpx STATIC ${_vpx_sources}
    "${libvpx_SOURCE_DIR}/vp9/vp9_dx_iface.c"
    "${libvpx_SOURCE_DIR}/vp9/vp9_iface_common.c"
    "${libvpx_SOURCE_DIR}/vpx_util/vpx_thread.c"
    "${libvpx_BINARY_DIR}/vpx_config.c")
target_include_directories(noveltea_vpx SYSTEM PUBLIC "${libvpx_SOURCE_DIR}" "${libvpx_BINARY_DIR}")
set_target_properties(noveltea_vpx PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_link_libraries(noveltea_vpx PRIVATE m)
add_library(unofficial::libvpx::libvpx ALIAS noveltea_vpx)
