$input v_texcoord0

#include "bgfx_shader.sh"

SAMPLER2D(s_videoY, 0);
SAMPLER2D(s_videoU, 1);
SAMPLER2D(s_videoV, 2);
uniform vec4 u_videoColor;

void main()
{
    float y = texture2D(s_videoY, v_texcoord0).r;
    float u = texture2D(s_videoU, v_texcoord0).r - 128.0 / 255.0;
    float v = texture2D(s_videoV, v_texcoord0).r - 128.0 / 255.0;
    if (u_videoColor.x < 0.5) {
        y = (y - 16.0 / 255.0) * (255.0 / 219.0);
        u *= 255.0 / 224.0;
        v *= 255.0 / 224.0;
    }
    vec3 rgb;
    if (u_videoColor.y > 0.5)
        rgb = vec3(y + 1.5748 * v, y - 0.187324 * u - 0.468124 * v, y + 1.8556 * u);
    else
        rgb = vec3(y + 1.402 * v, y - 0.344136 * u - 0.714136 * v, y + 1.772 * u);
    gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
