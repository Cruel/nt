$input v_texcoord0

#include "bgfx_shader.sh"

SAMPLER2D(s_texColor, 0);
uniform vec4 u_tint;

void main()
{
    vec4 texel = texture2D(s_texColor, v_texcoord0);
    gl_FragColor = vec4(texel.rgb * u_tint.rgb, texel.a * u_tint.a);
}
