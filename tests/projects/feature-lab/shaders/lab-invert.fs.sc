$input v_texcoord0
#include <bgfx_shader.sh>
SAMPLER2D(s_texColor, 0);
void main()
{
    vec4 source = texture2D(s_texColor, v_texcoord0);
    gl_FragColor = vec4(vec3(source.a) - source.rgb, source.a);
}
