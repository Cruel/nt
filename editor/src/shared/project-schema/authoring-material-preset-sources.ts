export const builtInMaterialShaderSources = {
  'engine:/vs_quad.sc': `$input a_position, a_texcoord0, a_color0
$output v_texcoord0, v_color0

#include "bgfx_shader.sh"

void main()
{
    gl_Position = mul(u_modelViewProj, vec4(a_position.xy, 0.0, 1.0));
    v_texcoord0 = a_texcoord0;
    v_color0 = a_color0;
}
`,
  'engine:/fs_quad.sc': `$input v_texcoord0, v_color0

#include "bgfx_shader.sh"

SAMPLER2D(s_texColor, 0);

void main()
{
    vec4 color = v_color0 * texture2D(s_texColor, v_texcoord0);
    gl_FragColor = vec4(color.rgb * color.a, color.a);
}
`,
  'engine:/vs_text.sc': `$input a_position, a_texcoord0, a_color0
$output v_texcoord0, v_color0

#include "bgfx_shader.sh"

void main()
{
    gl_Position = mul(u_modelViewProj, vec4(a_position.xy, 0.0, 1.0));
    v_texcoord0 = a_texcoord0;
    v_color0 = a_color0;
}
`,
  'engine:/fs_text.sc': `$input v_texcoord0, v_color0

#include "bgfx_shader.sh"

SAMPLER2D(s_textAtlas, 0);

void main()
{
    vec4 color = v_color0;
    color.a *= texture2D(s_textAtlas, v_texcoord0).a;
    gl_FragColor = vec4(color.rgb * color.a, color.a);
}
`,
  'engine:/vs_rmlui.sc': `$input a_position, a_color0, a_texcoord0
$output v_texcoord0, v_color0

uniform vec4 u_translate;
uniform mat4 u_projection;
uniform mat4 u_transform;

#include "bgfx_shader.sh"

void main()
{
    mat4 real_transform = mul(u_projection, u_transform);
    vec4 translated_pos = vec4(a_position.xy + u_translate.xy, 0.0, 1.0);
    gl_Position = mul(real_transform, translated_pos);

    v_color0 = a_color0;
    v_texcoord0 = a_texcoord0;
}
`,
  'engine:/fs_rmlui.sc': `$input v_texcoord0, v_color0

#include "bgfx_shader.sh"

SAMPLER2D(s_texColor, 0);

void main()
{
    vec4 texel = texture2D(s_texColor, v_texcoord0);
    gl_FragColor = v_color0 * texel;
}
`,
  'engine:/vs_postprocess_tint.sc': `$input a_position, a_texcoord0
$output v_texcoord0

#include "bgfx_shader.sh"

void main()
{
    gl_Position = mul(u_modelViewProj, vec4(a_position.xy, 0.0, 1.0));
    v_texcoord0 = a_texcoord0;
}
`,
  'engine:/fs_postprocess_tint.sc': `$input v_texcoord0

#include "bgfx_shader.sh"

SAMPLER2D(s_texColor, 0);
uniform vec4 u_tint;

void main()
{
    vec4 texel = texture2D(s_texColor, v_texcoord0);
    gl_FragColor = vec4(texel.rgb * u_tint.rgb * u_tint.a, texel.a * u_tint.a);
}
`,
  'engine:/fs_hotspot_alpha.sc': `$input v_texcoord0, v_color0

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
    float interaction = max(u_hotspotHovered.x, u_hotspotPressed.x);
    float sweep = 0.5 + 0.5 * sin((v_texcoord0.x + v_texcoord0.y) * 18.0 - u_time.x * 3.5);
    float intensity = mix(0.26, 0.46, u_hotspotPressed.x) + border * 0.44 + sweep * 0.12;
    float alpha = coverage * interaction * intensity;
    vec3 color = mix(vec3(0.08, 0.58, 0.92), vec3(0.48, 0.94, 1.0),
                     clamp(border + sweep * 0.35, 0.0, 1.0));
    vec4 premultiplied = vec4(color * alpha, alpha);
    gl_FragColor = vec4(premultiplied.rgb * v_color0.rgb * v_color0.a,
                        premultiplied.a * v_color0.a);
}
`,
  'engine:/fs_hotspot_custom.sc': `$input v_texcoord0, v_color0

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
    vec4 premultiplied = vec4(color * alpha, alpha);
    gl_FragColor = vec4(premultiplied.rgb * v_color0.rgb * v_color0.a,
                        premultiplied.a * v_color0.a);
}
`,
  'engine:/varying.def.sc': `vec2 a_position  : POSITION;
vec2 a_texcoord0 : TEXCOORD0;
vec4 a_color0    : COLOR0;
vec4 v_color     : COLOR0;
vec4 v_color0    : COLOR0;
vec2 v_texcoord0 : TEXCOORD0;
vec2 v_blur0     : TEXCOORD1;
vec2 v_blur1     : TEXCOORD2;
vec2 v_blur2     : TEXCOORD3;
vec2 v_blur3     : TEXCOORD4;
`,
} as const;

export type BuiltInMaterialShaderSourcePath = keyof typeof builtInMaterialShaderSources;

export function builtInMaterialShaderSource(path: string): string | null {
  return Object.prototype.hasOwnProperty.call(builtInMaterialShaderSources, path)
    ? builtInMaterialShaderSources[path as BuiltInMaterialShaderSourcePath]
    : null;
}
