# Patch bgfx.cmake for Emscripten compatibility.

include("${CMAKE_CURRENT_LIST_DIR}/patch-bgfx-miniz.cmake")

# bimg's encoder-only third parties are not needed by the runtime Web build and some of them are
# not Emscripten-clean. Keep bimg_decode available, including WebP, while excluding encode tooling.
set(patch_file "cmake/bimg/CMakeLists.txt")
file(READ "${patch_file}" content)

set(encoder_third_parties_before
    "include(3rdparty/etc2.cmake)\ninclude(3rdparty/nvtt.cmake)")
set(encoder_third_parties_after
    "if(NOT EMSCRIPTEN)\ninclude(3rdparty/etc2.cmake)\ninclude(3rdparty/nvtt.cmake)\nendif()")
string(FIND "${content}" "${encoder_third_parties_before}" encoder_third_parties_index)
if(NOT encoder_third_parties_index EQUAL -1)
    string(REPLACE "${encoder_third_parties_before}" "${encoder_third_parties_after}" content
                   "${content}")
else()
    string(FIND "${content}" "${encoder_third_parties_after}" patched_encoder_third_parties_index)
    if(patched_encoder_third_parties_index EQUAL -1)
        message(FATAL_ERROR "Unable to patch bgfx bimg encoder third parties for Emscripten")
    endif()
endif()

set(bimg_encode_before "include(bimg_encode.cmake)")
set(bimg_encode_after "if(NOT EMSCRIPTEN)\ninclude(bimg_encode.cmake)\nendif()")
string(FIND "${content}" "${bimg_encode_before}" bimg_encode_index)
if(NOT bimg_encode_index EQUAL -1)
    string(REPLACE "${bimg_encode_before}" "${bimg_encode_after}" content "${content}")
else()
    string(FIND "${content}" "${bimg_encode_after}" patched_bimg_encode_index)
    if(patched_bimg_encode_index EQUAL -1)
        message(FATAL_ERROR "Unable to disable bimg_encode for Emscripten")
    endif()
endif()

file(WRITE "${patch_file}" "${content}")

# Emscripten pthread builds do not return function pointers for these WebGL 2 core entry points
# through emscripten_webgl2_get_proc_address(), although the statically linked wrappers exist.
# Supply those wrappers after bgfx's normal import pass when necessary.
set(html5_context_file "bgfx/src/glcontext_html5.cpp")
file(READ "${html5_context_file}" html5_context_content)

set(webgl2_static_declarations_before
    "extern \"C\" void* emscripten_webgl2_get_proc_address(const char *name_);\n\nnamespace bgfx")
set(webgl2_static_declarations_after
    "extern \"C\" void* emscripten_webgl2_get_proc_address(const char *name_);\nextern \"C\" void emscripten_glRenderbufferStorageMultisample(\n\tGLenum target, GLsizei samples, GLenum internalformat, GLsizei width, GLsizei height);\nextern \"C\" void emscripten_glBlitFramebuffer(\n\tGLint srcX0, GLint srcY0, GLint srcX1, GLint srcY1,\n\tGLint dstX0, GLint dstY0, GLint dstX1, GLint dstY1,\n\tGLbitfield mask, GLenum filter);\n\nnamespace bgfx")

string(FIND "${html5_context_content}" "${webgl2_static_declarations_before}"
       webgl2_static_declarations_index)
if(NOT webgl2_static_declarations_index EQUAL -1)
    string(REPLACE "${webgl2_static_declarations_before}" "${webgl2_static_declarations_after}"
                   html5_context_content "${html5_context_content}")
else()
    string(FIND "${html5_context_content}" "${webgl2_static_declarations_after}"
           patched_webgl2_static_declarations_index)
    if(patched_webgl2_static_declarations_index EQUAL -1)
        message(FATAL_ERROR "Unable to patch bgfx WebGL 2 static function declarations")
    endif()
endif()

set(webgl2_static_fallback_before
    "#\tinclude \"glimports.h\"\n\n#\tundef GL_EXTENSION")
set(webgl2_static_fallback_after
    "#\tinclude \"glimports.h\"\n\n\t\tif (s_attrs.majorVersion >= 2)\n\t\t{\n\t\t\tif (NULL == glRenderbufferStorageMultisample)\n\t\t\t{\n\t\t\t\tglRenderbufferStorageMultisample = &emscripten_glRenderbufferStorageMultisample;\n\t\t\t}\n\t\t\tif (NULL == glBlitFramebuffer)\n\t\t\t{\n\t\t\t\tglBlitFramebuffer = &emscripten_glBlitFramebuffer;\n\t\t\t}\n\t\t}\n\n#\tundef GL_EXTENSION")

# Normalize an already-patched checkout from the older bgfx API before checking the current form.
string(REPLACE "if (_webGLVersion >= 2)" "if (s_attrs.majorVersion >= 2)"
       html5_context_content "${html5_context_content}")
string(FIND "${html5_context_content}" "${webgl2_static_fallback_before}"
       webgl2_static_fallback_index)
if(NOT webgl2_static_fallback_index EQUAL -1)
    string(REPLACE "${webgl2_static_fallback_before}" "${webgl2_static_fallback_after}"
                   html5_context_content "${html5_context_content}")
else()
    string(FIND "${html5_context_content}" "${webgl2_static_fallback_after}"
           patched_webgl2_static_fallback_index)
    if(patched_webgl2_static_fallback_index EQUAL -1)
        message(FATAL_ERROR "Unable to patch bgfx WebGL 2 static function fallback")
    endif()
endif()

file(WRITE "${html5_context_file}" "${html5_context_content}")
