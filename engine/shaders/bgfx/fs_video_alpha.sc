$input v_texcoord0, v_color0

#include "bgfx_shader.sh"
#include "noveltea_shader.sc"

SAMPLER2D(s_texColor, 0);
SAMPLER2D(s_videoAlpha, 1);

void main()
{
    vec4 color = v_color0 * texture2D(s_texColor, v_texcoord0);
    float mask = texture2D(s_videoAlpha, v_texcoord0).r;
    gl_FragColor = noveltea_premultiply_alpha(vec4(color.rgb, color.a * mask));
}
