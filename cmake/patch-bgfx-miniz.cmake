# Patch bgfx.cmake's bimg TinyEXR integration.
#
# NovelTea supplies MINIZ_LIBRARIES and MINIZ_INCLUDE_DIR before bgfx.cmake is
# configured, causing bimg and bimg_decode to link the canonical standalone
# miniz target instead of compiling TinyEXR's vendored copy. TinyEXR's
# implementation translation unit also directly includes its vendored miniz.c,
# which would still create a second provider; remove that implementation include.

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

set(tinyexr_header "bimg/3rdparty/tinyexr/tinyexr.h")
if(NOT EXISTS "${tinyexr_header}")
  message(FATAL_ERROR "bimg TinyEXR header not found: ${tinyexr_header}")
endif()

file(READ "${tinyexr_header}" tinyexr_content)
set(vendored_miniz_include "#include <miniz/miniz.h>")
set(canonical_miniz_include "#include <miniz.h>")
string(FIND "${tinyexr_content}" "${vendored_miniz_include}" vendored_miniz_include_index)
string(FIND "${tinyexr_content}" "${canonical_miniz_include}" canonical_miniz_include_index)
if(NOT vendored_miniz_include_index EQUAL -1)
  string(REPLACE
    "${vendored_miniz_include}"
    "${canonical_miniz_include}"
    tinyexr_content "${tinyexr_content}")
  file(WRITE "${tinyexr_header}" "${tinyexr_content}")
elseif(canonical_miniz_include_index EQUAL -1)
  message(FATAL_ERROR
    "TinyEXR miniz include changed; refusing to continue without dependency review")
endif()
