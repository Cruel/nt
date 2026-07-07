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
if(EXISTS "${miniz_patch_file}")
  file(READ "${miniz_patch_file}" miniz_content)
  string(REPLACE
    [[${BIMG_DIR}/3rdparty/tinyexr/deps/miniz/miniz.h #]]
    [[${BIMG_DIR}/3rdparty/tinyexr/deps/miniz/miniz.* #]]
    miniz_content "${miniz_content}")
  file(WRITE "${miniz_patch_file}" "${miniz_content}")
endif()

set(image_decode_file "bimg/src/image_decode.cpp")
file(READ "${image_decode_file}" image_decode_content)
string(REPLACE
  "#include <miniz/miniz.c>\n#include <tinyexr/tinyexr.h>"
  "#include <tinyexr/tinyexr.h>"
  image_decode_content "${image_decode_content}")
file(WRITE "${image_decode_file}" "${image_decode_content}")
