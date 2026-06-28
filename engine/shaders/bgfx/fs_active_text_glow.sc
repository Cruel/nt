$input v_texcoord0, v_color0

#include "bgfx_shader.sh"

SAMPLER2D(s_textAtlas, 0);
uniform vec4 u_time;

void main()
{
    float alpha = texture2D(s_textAtlas, v_texcoord0).a;
    float pulse = 0.72 + 0.28 * sin(u_time.x * 4.0);

    vec3 glow_color = vec3(1.0, 0.78, 0.18);
    vec3 fill_color = mix(v_color0.rgb, glow_color, 0.65);
    vec3 color = fill_color * (1.0 + pulse * 0.35);

    gl_FragColor = vec4(color, alpha * v_color0.a);
}
