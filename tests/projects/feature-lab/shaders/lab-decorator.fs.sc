$input v_texcoord0, v_color0
#include <bgfx_shader.sh>
SAMPLER2D(s_texColor, 0);
void main()
{
    vec4 source = texture2D(s_texColor, v_texcoord0) * v_color0;
    gl_FragColor = vec4(source.rgb * vec3(0.3, 0.7, 1.0), source.a);
}
