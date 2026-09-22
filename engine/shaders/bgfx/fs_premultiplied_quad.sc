$input v_texcoord0, v_color0

#include "bgfx_shader.sh"

SAMPLER2D(s_texColor, 0);

void main()
{
    vec4 texel = texture2D(s_texColor, v_texcoord0);
    gl_FragColor = vec4(texel.rgb * v_color0.rgb * v_color0.a, texel.a * v_color0.a);
}
