$input v_texcoord0, v_color0

#include "bgfx_shader.sh"

SAMPLER2D(s_hotspotImage, 0);
uniform vec4 u_time;
uniform vec4 u_hotspotBounds;
uniform vec4 u_hotspotHovered;
uniform vec4 u_hotspotPressed;
uniform vec4 u_hotspotImageDimensions;
uniform vec4 u_hotspotMaskDimensions;

void main()
{
    vec2 texel = 1.0 / max(u_hotspotImageDimensions.xy, vec2(1.0));
    float coverage = texture2D(s_hotspotImage, v_texcoord0).a;
    float neighbor = min(
        min(texture2D(s_hotspotImage, v_texcoord0 + vec2(texel.x, 0.0)).a,
            texture2D(s_hotspotImage, v_texcoord0 - vec2(texel.x, 0.0)).a),
        min(texture2D(s_hotspotImage, v_texcoord0 + vec2(0.0, texel.y)).a,
            texture2D(s_hotspotImage, v_texcoord0 - vec2(0.0, texel.y)).a));
    float border = clamp(coverage - neighbor, 0.0, 1.0);
    float active = max(u_hotspotHovered.x, u_hotspotPressed.x);
    float sweep = 0.5 + 0.5 * sin((v_texcoord0.x + v_texcoord0.y) * 18.0 - u_time.x * 3.5);
    float intensity = mix(0.26, 0.46, u_hotspotPressed.x) + border * 0.44 + sweep * 0.12;
    float alpha = coverage * active * intensity;
    vec3 color = mix(vec3(0.08, 0.58, 0.92), vec3(0.48, 0.94, 1.0),
                     clamp(border + sweep * 0.35, 0.0, 1.0));
    gl_FragColor = vec4(color * alpha, alpha) * v_color0;
}
