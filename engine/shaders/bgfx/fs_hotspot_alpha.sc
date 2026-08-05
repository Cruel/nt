$input v_texcoord0, v_color0

#include "bgfx_shader.sh"

SAMPLER2D(s_hotspotImage, 0);
uniform vec4 u_hotspotBounds;
uniform vec4 u_hotspotHovered;
uniform vec4 u_hotspotPressed;
uniform vec4 u_hotspotImageDimensions;
uniform vec4 u_hotspotMaskDimensions;

void main()
{
    float coverage = texture2D(s_hotspotImage, v_texcoord0).a;
    float intensity = mix(0.42, 0.72, u_hotspotPressed.x);
    vec3 sheen = mix(vec3(0.10, 0.68, 0.94), vec3(0.35, 0.88, 1.0), v_texcoord0.y);
    float alpha = coverage * intensity * u_hotspotHovered.x;
    gl_FragColor = vec4(sheen * alpha, alpha) * v_color0;
}
