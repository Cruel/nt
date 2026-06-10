# Patch bgfx.cmake for Emscripten compatibility.

set(patch_file "cmake/bimg/CMakeLists.txt")

file(READ "${patch_file}" content)

string(REPLACE
  "include(3rdparty/etc2.cmake)\ninclude(3rdparty/nvtt.cmake)"
  "if(NOT EMSCRIPTEN)\ninclude(3rdparty/etc2.cmake)\ninclude(3rdparty/nvtt.cmake)\nendif()"
  content "${content}")

string(REPLACE
  "include(bimg_encode.cmake)"
  "if(NOT EMSCRIPTEN)\ninclude(bimg_encode.cmake)\nendif()"
  content "${content}")

file(WRITE "${patch_file}" "${content}")
