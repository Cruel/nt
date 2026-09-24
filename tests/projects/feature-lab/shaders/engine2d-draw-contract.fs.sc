$input v_texcoord0, v_color0
#include <bgfx_shader.sh>
#include "noveltea_shader.sc"

SAMPLER2D(s_texColor, 0);
uniform vec4 u_strength;

void main()
{
    vec4 source = texture2D(s_texColor, v_texcoord0) * v_color0;
    float strength = clamp(u_strength.x, 0.0, 1.0);
    vec3 tint = mix(vec3(1.0), vec3(0.35, 0.85, 1.0), strength);
    gl_FragColor = noveltea_premultiply_alpha(vec4(source.rgb * tint, source.a));
}
