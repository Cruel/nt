$input v_texcoord0, v_color0

#include "bgfx_shader.sh"

SAMPLER2D(s_textAtlas, 0);

void main()
{
    vec4 color = v_color0;
    color.a *= texture2D(s_textAtlas, v_texcoord0).a;
    gl_FragColor = color;
}
