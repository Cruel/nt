$input v_texcoord0, v_color0
#include <bgfx_shader.sh>
#include "noveltea_shader.sc"
SAMPLER2D(s_textAtlas, 0);
uniform vec4 u_tint;
uniform vec4 u_amount;
void main()
{
    float alpha = texture2D(s_textAtlas, v_texcoord0).a * v_color0.a;
    vec3 color = mix(v_color0.rgb, u_tint.rgb, clamp(u_amount.x, 0.0, 1.0));
    gl_FragColor = noveltea_premultiply_alpha(vec4(color, alpha * u_tint.a));
}
