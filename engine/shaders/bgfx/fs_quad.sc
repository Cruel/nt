$input v_texcoord0, v_color0

#include "bgfx_shader.sh"

SAMPLER2D(s_texColor, 0);
uniform vec4 u_useTexture;

void main()
{
    vec4 texel = texture2D(s_texColor, v_texcoord0);
    gl_FragColor = v_color0 * mix(vec4(1.0, 1.0, 1.0, 1.0), texel, u_useTexture.x);
}
