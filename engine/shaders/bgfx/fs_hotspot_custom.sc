$input v_texcoord0, v_color0

#include "bgfx_shader.sh"

SAMPLER2D(s_hotspotImage, 0);
SAMPLER2D(s_hotspotMask, 1);
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
    float imageAlpha = texture2D(s_hotspotImage, v_texcoord0).a;
    float coverage = texture2D(s_hotspotMask, v_texcoord0).r * imageAlpha * inside;
    float edgeWidth = max(1.0 / max(u_hotspotImageDimensions.x, 1.0),
                          1.0 / max(u_hotspotImageDimensions.y, 1.0));
    vec2 edgeDistance = min(v_texcoord0 - lower, upper - v_texcoord0);
    float border = 1.0 - smoothstep(edgeWidth, edgeWidth * 3.0,
                                    min(edgeDistance.x, edgeDistance.y));
    float intensity = mix(0.34, 0.62, u_hotspotPressed.x);
    float alpha = coverage * u_hotspotHovered.x * (intensity + border * 0.28);
    vec3 color = mix(vec3(0.08, 0.58, 0.92), vec3(0.42, 0.92, 1.0), border);
    gl_FragColor = vec4(color * alpha, alpha) * v_color0;
}
