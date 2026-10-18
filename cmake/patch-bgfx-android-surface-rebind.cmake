# The pinned bgfx Android EGL backend stores the ANativeWindow from initial
# creation in GlContext::m_nwh. bgfx::reset accepts a replacement main
# SwapChain::nwh but GlContext::resize previously used the stale handle. SDL3
# recreates the native window after an Android Activity's surface is destroyed.
# Update the handle before recreating EGLSurface, keeping the existing GL
# context and application-owned GPU resources alive across suspend/resume.
set(source_file "bgfx/src/glcontext_egl.cpp")
file(READ "${source_file}" source)
set(before "EGLNativeWindowType nwh = (EGLNativeWindowType )m_nwh;\n\t\t\teglMakeCurrent(m_display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);")
set(after "m_nwh = _swapChain.nwh;\n\t\t\tEGLNativeWindowType nwh = (EGLNativeWindowType )m_nwh;\n\t\t\teglMakeCurrent(m_display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);")
string(FIND "${source}" "${before}" before_offset)
if(NOT before_offset EQUAL -1)
    string(REPLACE "${before}" "${after}" source "${source}")
    file(WRITE "${source_file}" "${source}")
else()
    string(FIND "${source}" "${after}" patched_offset)
    if(patched_offset EQUAL -1)
        message(FATAL_ERROR "Pinned bgfx Android EGL surface-rebind patch did not match")
    endif()
endif()
