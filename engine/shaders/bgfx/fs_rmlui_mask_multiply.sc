$input v_texcoord0

#include "bgfx_shader.sh"

SAMPLER2D(s_texColor, 0);
SAMPLER2D(s_mask, 1);

void main()
{
    vec4 texel = texture2D(s_texColor, v_texcoord0);
    float mask_alpha = texture2D(s_mask, v_texcoord0).a;
    gl_FragColor = texel * mask_alpha;
}
