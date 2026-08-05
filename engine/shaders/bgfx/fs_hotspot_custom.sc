$input v_texcoord0, v_color0

#include "bgfx_shader.sh"

SAMPLER2D(s_hotspotImage, 0);
SAMPLER2D(s_hotspotMask, 1);
uniform vec4 u_time;
uniform vec4 u_hotspotBounds;
uniform vec4 u_hotspotHovered;
uniform vec4 u_hotspotPressed;
uniform vec4 u_hotspotImageDimensions;
uniform vec4 u_hotspotMaskDimensions;

float hotspotCoverage(vec2 uv)
{
    vec2 lower = u_hotspotBounds.xy;
    vec2 upper = lower + u_hotspotBounds.zw;
    float inside = step(lower.x, uv.x) * step(lower.y, uv.y) * step(uv.x, upper.x) *
                   step(uv.y, upper.y);
    return texture2D(s_hotspotMask, uv).r * texture2D(s_hotspotImage, uv).a * inside;
}

void main()
{
    vec2 texel = 1.0 / max(u_hotspotMaskDimensions.xy, vec2(1.0));
    float coverage = hotspotCoverage(v_texcoord0);
    float neighbor = min(
        min(hotspotCoverage(v_texcoord0 + vec2(texel.x, 0.0)),
            hotspotCoverage(v_texcoord0 - vec2(texel.x, 0.0))),
        min(hotspotCoverage(v_texcoord0 + vec2(0.0, texel.y)),
            hotspotCoverage(v_texcoord0 - vec2(0.0, texel.y))));
    float border = clamp(coverage - neighbor, 0.0, 1.0);
    float interaction = max(u_hotspotHovered.x, u_hotspotPressed.x);
    float sweep = 0.5 + 0.5 * sin((v_texcoord0.x + v_texcoord0.y) * 18.0 - u_time.x * 3.5);
    float intensity = mix(0.24, 0.44, u_hotspotPressed.x) + border * 0.46 + sweep * 0.12;
    float alpha = coverage * interaction * intensity;
    vec3 color = mix(vec3(0.08, 0.58, 0.92), vec3(0.48, 0.94, 1.0),
                     clamp(border + sweep * 0.35, 0.0, 1.0));
    gl_FragColor = vec4(color * alpha, alpha) * v_color0;
}
