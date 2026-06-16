$input v_texcoord0, v_color0

#include "bgfx_shader.sh"

SAMPLER2D(s_textAtlas, 0);
uniform vec4 u_textSdf;
uniform vec4 u_textOutlineColor;
uniform vec4 u_textShadowColor;
uniform vec4 u_textShadow;

void main()
{
    float dist = texture2D(s_textAtlas, v_texcoord0).a;
    float softness = max(fwidth(dist), u_textSdf.y);
    float glyphAlpha = smoothstep(u_textSdf.x - softness, u_textSdf.x + softness, dist);

    vec4 color = v_color0;
    float outlineWidth = u_textSdf.z;
    if (outlineWidth > 0.0)
    {
        float outlineAlpha = smoothstep(u_textSdf.x - outlineWidth - softness, u_textSdf.x - outlineWidth + softness, dist);
        color = mix(u_textOutlineColor, color, glyphAlpha);
        color.a *= max(glyphAlpha, outlineAlpha);
    }
    else
    {
        color.a *= glyphAlpha;
    }

    if (u_textShadowColor.a > 0.0)
    {
        float shadowDist = texture2D(s_textAtlas, v_texcoord0 - u_textShadow.xy).a;
        float shadowSoftness = softness + max(u_textShadow.z, 0.0);
        float shadowAlpha = smoothstep(u_textSdf.x - shadowSoftness, u_textSdf.x + shadowSoftness, shadowDist);
        vec4 shadow = u_textShadowColor;
        shadow.a *= shadowAlpha;
        color = shadow * (1.0 - color.a) + color;
    }

    gl_FragColor = color;
}
