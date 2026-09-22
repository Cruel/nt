$input v_texcoord0, v_color0

#include "bgfx_shader.sh"

SAMPLER2D(s_texColor, 0);

void main()
{
    vec4 color = v_color0 * texture2D(s_texColor, v_texcoord0);
    gl_FragColor = vec4(color.rgb * color.a, color.a);
}
