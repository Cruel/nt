$input v_texcoord0, v_color0
#include <bgfx_shader.sh>
#include "noveltea_shader.sc"
SAMPLER2D(s_texColor, 0);
SAMPLER2D(s_pattern, 1);
uniform vec4 u_tiles;
uniform vec4 u_mix;
void main()
{
    vec2 uv = v_texcoord0 * max(u_tiles.x, 1.0);
    vec4 draw = texture2D(s_texColor, uv) * v_color0;
    vec4 pattern = texture2D(s_pattern, uv);
    vec3 color = mix(draw.rgb, pattern.rgb, clamp(u_mix.x, 0.0, 1.0));
    gl_FragColor = noveltea_premultiply_alpha(vec4(color, draw.a));
}
