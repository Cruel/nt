# Patch bgfx.cmake for Emscripten compatibility.

include("${CMAKE_CURRENT_LIST_DIR}/patch-bgfx-miniz.cmake")

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

# WebGL 2 exposes multisampled renderbuffers as core GLES 3 functionality, so Chromium does not
# need to advertise one of the legacy multisample extensions checked by bgfx. Include the GLES 3
# path when initializing the backend's maximum sample count; otherwise every requested MSAA target
# is silently clamped to a single-sample framebuffer.
set(renderer_file "bgfx/src/renderer_gl.cpp")
file(READ "${renderer_file}" renderer_content)

set(msaa_probe_before
    "if (s_extension[Extension::ARB_texture_multisample].m_supported\n\t\t\t\t||  s_extension[Extension::ANGLE_framebuffer_multisample].m_supported")
set(msaa_probe_after
    "if (m_gles3\n\t\t\t\t||  s_extension[Extension::ARB_texture_multisample].m_supported\n\t\t\t\t||  s_extension[Extension::ANGLE_framebuffer_multisample].m_supported")

string(FIND "${renderer_content}" "${msaa_probe_before}" msaa_probe_index)
if(NOT msaa_probe_index EQUAL -1)
    string(REPLACE "${msaa_probe_before}" "${msaa_probe_after}" renderer_content
                   "${renderer_content}")
else()
    string(FIND "${renderer_content}" "${msaa_probe_after}" patched_msaa_probe_index)
    if(patched_msaa_probe_index EQUAL -1)
        message(FATAL_ERROR "Unable to patch bgfx WebGL 2 MSAA capability detection")
    endif()
endif()

# The Emscripten pthread build does not return function pointers for these WebGL 2 core entry
# points through emscripten_webgl2_get_proc_address(), even though the statically linked wrappers
# are available. Supply those wrappers explicitly so the multisample allocation and resolve paths
# do not trap through null function pointers.
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
    "#\tinclude \"glimports.h\"\n\n\t\tif (_webGLVersion >= 2)\n\t\t{\n\t\t\tif (NULL == glRenderbufferStorageMultisample)\n\t\t\t{\n\t\t\t\tglRenderbufferStorageMultisample = &emscripten_glRenderbufferStorageMultisample;\n\t\t\t}\n\t\t\tif (NULL == glBlitFramebuffer)\n\t\t\t{\n\t\t\t\tglBlitFramebuffer = &emscripten_glBlitFramebuffer;\n\t\t\t}\n\t\t}\n\n#\tundef GL_EXTENSION")

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

# OpenGL ES exposes glDrawBuffers rather than desktop OpenGL's singular glDrawBuffer. Use the GLES
# call while selecting the resolve destination, and resolve multisampled color with GL_NEAREST as
# required by WebGL 2.
set(resolve_draw_buffer_before
    "\t\t\t\t\t\tGL_CHECK(glReadBuffer(GL_COLOR_ATTACHMENT0 + colorIdx) );\n\t\t\t\t\t\tGL_CHECK(glDrawBuffer(GL_COLOR_ATTACHMENT0 + colorIdx) );")
set(resolve_draw_buffer_after
    "\t\t\t\t\t\tGL_CHECK(glReadBuffer(GL_COLOR_ATTACHMENT0 + colorIdx) );\n\t\t\t\t\t\tif (BX_ENABLED(BGFX_CONFIG_RENDERER_OPENGL) )\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tGL_CHECK(glDrawBuffer(GL_COLOR_ATTACHMENT0 + colorIdx) );\n\t\t\t\t\t\t}\n\t\t\t\t\t\telse\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tconst GLenum drawBuffer = GL_COLOR_ATTACHMENT0 + colorIdx;\n\t\t\t\t\t\t\tGL_CHECK(glDrawBuffers(1, &drawBuffer) );\n\t\t\t\t\t\t}")

string(FIND "${renderer_content}" "${resolve_draw_buffer_before}" resolve_draw_buffer_index)
if(NOT resolve_draw_buffer_index EQUAL -1)
    string(REPLACE "${resolve_draw_buffer_before}" "${resolve_draw_buffer_after}"
                   renderer_content "${renderer_content}")
else()
    string(FIND "${renderer_content}" "${resolve_draw_buffer_after}"
           patched_resolve_draw_buffer_index)
    if(patched_resolve_draw_buffer_index EQUAL -1)
        message(FATAL_ERROR "Unable to patch bgfx WebGL 2 resolve draw-buffer selection")
    endif()
endif()

set(resolve_filter_before
    "\t\t\t\t\t\t\t, GL_COLOR_BUFFER_BIT\n\t\t\t\t\t\t\t, GL_LINEAR")
set(resolve_filter_after
    "\t\t\t\t\t\t\t, GL_COLOR_BUFFER_BIT\n\t\t\t\t\t\t\t, GL_NEAREST")
string(FIND "${renderer_content}" "${resolve_filter_before}" resolve_filter_index)
if(NOT resolve_filter_index EQUAL -1)
    string(REPLACE "${resolve_filter_before}" "${resolve_filter_after}" renderer_content
                   "${renderer_content}")
else()
    string(FIND "${renderer_content}" "${resolve_filter_after}" patched_resolve_filter_index)
    if(patched_resolve_filter_index EQUAL -1)
        message(FATAL_ERROR "Unable to patch bgfx WebGL 2 multisample resolve filter")
    endif()
endif()

file(WRITE "${renderer_file}" "${renderer_content}")
