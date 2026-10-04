$input v_texcoord0, v_color0

#include "bgfx_shader.sh"
#include "noveltea_shader.sc"

SAMPLER2D(s_hotspotImage, 0);
SAMPLER2D(s_hotspotMask, 1);
uniform vec4 u_time;
uniform vec4 u_hotspotBounds;
uniform vec4 u_hotspotHovered;
uniform vec4 u_hotspotPressed;
uniform vec4 u_hotspotImageDimensions;
uniform vec4 u_hotspotMaskDimensions;

void main()
{
    vec2 lower = u_hotspotBounds.xy;
    vec2 upper = lower + u_hotspotBounds.zw;
    float inside = step(lower.x, v_texcoord0.x) * step(lower.y, v_texcoord0.y) *
                   step(v_texcoord0.x, upper.x) * step(v_texcoord0.y, upper.y);
    float coverage = texture2D(s_hotspotMask, v_texcoord0).r *
                     texture2D(s_hotspotImage, v_texcoord0).a * inside;
    float interaction = max(u_hotspotHovered.x, u_hotspotPressed.x);
    vec3 tint = mix(vec3(1.0, 0.2, 0.7), vec3(1.0, 0.9, 0.1), u_hotspotPressed.x);
    vec4 output_color = noveltea_premultiply_alpha(vec4(tint, coverage * interaction * 0.65));
    gl_FragColor = vec4(output_color.rgb * v_color0.rgb * v_color0.a,
                        output_color.a * v_color0.a);
}
