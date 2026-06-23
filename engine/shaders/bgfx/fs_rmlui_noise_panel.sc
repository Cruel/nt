$input v_texcoord0, v_color0

#include "bgfx_shader.sh"

uniform vec4 u_dimensions;

float hash21(vec2 p)
{
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

void main()
{
    vec2 uv = v_texcoord0;
    vec2 cells = max(u_dimensions.xy / 18.0, vec2(1.0, 1.0));
    float grain = hash21(floor(uv * cells));
    float stripe = smoothstep(0.48, 0.52, fract((uv.x + uv.y) * 6.0));

    vec3 base = mix(vec3(0.09, 0.17, 0.28), vec3(0.18, 0.35, 0.55), grain);
    base += stripe * 0.045;

    vec4 color = vec4(base * 0.72, 0.72);
    gl_FragColor = color * v_color0;
}
