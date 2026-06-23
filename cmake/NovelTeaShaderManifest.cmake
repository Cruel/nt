set(NOVELTEA_SHADER_PROGRAMS
    triangle vs_triangle.sc fs_triangle.sc
    quad     vs_quad.sc     fs_quad.sc
    text     vs_text.sc     fs_text.sc
    imgui    vs_imgui.sc    fs_imgui.sc
    rmlui    vs_rmlui.sc    fs_rmlui.sc
    rmlui_composite vs_rmlui_composite.sc fs_rmlui_composite.sc
    rmlui_composite_filter vs_rmlui_composite.sc fs_rmlui_composite_filter.sc
    rmlui_copy vs_rmlui_composite.sc fs_rmlui_composite.sc
    rmlui_opacity vs_rmlui_composite.sc fs_rmlui_opacity.sc
    rmlui_color_matrix vs_rmlui_composite.sc fs_rmlui_color_matrix.sc
    rmlui_mask_multiply vs_rmlui_composite.sc fs_rmlui_mask_multiply.sc
    rmlui_blur vs_rmlui_blur.sc fs_rmlui_blur.sc
    rmlui_drop_shadow vs_rmlui_composite.sc fs_rmlui_drop_shadow.sc
    rmlui_gradient vs_rmlui.sc fs_rmlui_gradient.sc
)

set(NOVELTEA_SHADER_VARIANT_DATA
    glsl-120 linux   120
    essl-100 asm.js  100_es
    essl-300 android 300_es
)
