set(NOVELTEA_SHADER_PROGRAMS
    triangle vs_triangle.sc fs_triangle.sc
    quad     vs_quad.sc     fs_quad.sc
    text     vs_text.sc     fs_text.sc
    imgui    vs_imgui.sc    fs_imgui.sc
    rmlui    vs_rmlui.sc    fs_rmlui.sc
)

set(NOVELTEA_SHADER_VARIANT_DATA
    glsl-120 linux   120
    essl-100 asm.js  100_es
    essl-300 android 300_es
)
