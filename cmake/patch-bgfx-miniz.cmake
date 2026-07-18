# Patch bgfx.cmake's bimg TinyEXR/miniz integration.
#
# bimg/src/image_decode.cpp defines TINYEXR_IMPLEMENTATION and also includes
# TinyEXR's vendored miniz.c directly. bgfx.cmake separately adds the same
# vendored miniz.c to bimg/bimg_decode through MINIZ_SOURCES. Android's lld
# treats those as duplicate global mz_* definitions. Keep the normal
# bgfx.cmake miniz source list so one vendored miniz object provides both
# TinyEXR's zlib-style APIs and NovelTea's ZIP package APIs, but remove the
# extra direct include from image_decode.cpp.

set(miniz_patch_file "cmake/bimg/3rdparty/miniz.cmake")
if(NOT EXISTS "${miniz_patch_file}")
  message(FATAL_ERROR "bgfx.cmake miniz integration file not found: ${miniz_patch_file}")
endif()

file(READ "${miniz_patch_file}" miniz_content)
set(miniz_header_glob [[${BIMG_DIR}/3rdparty/tinyexr/deps/miniz/miniz.h #]])
set(miniz_source_glob [[${BIMG_DIR}/3rdparty/tinyexr/deps/miniz/miniz.* #]])
string(FIND "${miniz_content}" "${miniz_header_glob}" miniz_header_glob_index)
string(FIND "${miniz_content}" "${miniz_source_glob}" miniz_source_glob_index)
if(NOT miniz_header_glob_index EQUAL -1)
  string(REPLACE
    "${miniz_header_glob}"
    "${miniz_source_glob}"
    miniz_content "${miniz_content}")
  file(WRITE "${miniz_patch_file}" "${miniz_content}")
elseif(miniz_source_glob_index EQUAL -1)
  message(FATAL_ERROR
    "bgfx.cmake miniz source declaration changed; refusing to continue without duplicate-symbol review")
endif()

set(image_decode_file "bimg/src/image_decode.cpp")
if(NOT EXISTS "${image_decode_file}")
  message(FATAL_ERROR "bimg image decoder not found: ${image_decode_file}")
endif()

file(READ "${image_decode_file}" image_decode_content)
set(tinyexr_with_miniz "#include <miniz/miniz.c>\n#include <tinyexr/tinyexr.h>")
set(tinyexr_without_miniz "#include <tinyexr/tinyexr.h>")
string(FIND "${image_decode_content}" "${tinyexr_with_miniz}" tinyexr_with_miniz_index)
string(FIND "${image_decode_content}" "${tinyexr_without_miniz}" tinyexr_without_miniz_index)
if(NOT tinyexr_with_miniz_index EQUAL -1)
  string(REPLACE
    "${tinyexr_with_miniz}"
    "${tinyexr_without_miniz}"
    image_decode_content "${image_decode_content}")
  file(WRITE "${image_decode_file}" "${image_decode_content}")
elseif(tinyexr_without_miniz_index EQUAL -1)
  message(FATAL_ERROR
    "bimg TinyEXR integration changed; refusing to continue without duplicate-symbol review")
endif()
