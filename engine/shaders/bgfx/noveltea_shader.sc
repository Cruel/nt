#ifndef NOVELTEA_SHADER_SC
#define NOVELTEA_SHADER_SC

vec4 noveltea_premultiply_alpha(vec4 straight_rgba)
{
    return vec4(straight_rgba.rgb * straight_rgba.a, straight_rgba.a);
}

#endif // NOVELTEA_SHADER_SC
