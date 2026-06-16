#include "bgfx_renderer_internal.hpp"

#include <cstdio>
#include <cstring>

namespace noveltea::bgfx_backend {

namespace {

const bgfx::Memory* shader_mem(const uint8_t* data, uint32_t size)
{
    const bgfx::Memory* mem = bgfx::alloc(size + 1);
    std::memcpy(mem->data, data, size);
    mem->data[size] = 0;
    return mem;
}

} // namespace

bgfx::ShaderHandle load_embedded_shader(bgfx::RendererType::Enum type,
                                        const uint8_t* glsl,
                                        uint32_t glsl_len,
                                        const uint8_t* essl,
                                        uint32_t essl_len,
                                        const uint8_t* web,
                                        uint32_t web_len)
{
    const uint8_t* data = nullptr;
    uint32_t len = 0;

    switch (type) {
    case bgfx::RendererType::OpenGL:
        data = glsl;
        len = glsl_len;
        break;
    case bgfx::RendererType::OpenGLES:
#if defined(NOVELTEA_PLATFORM_WEB)
        data = web;
        len = web_len;
#else
        data = essl;
        len = essl_len;
#endif
        break;
    default:
        std::fprintf(stderr, "[renderer] unsupported renderer type %d for embedded shader\n",
                     static_cast<int>(type));
        return BGFX_INVALID_HANDLE;
    }

    bgfx::ShaderHandle handle = bgfx::createShader(shader_mem(data, len));
    if (!bgfx::isValid(handle)) {
        std::fprintf(stderr, "[renderer] failed to create embedded shader\n");
    }
    return handle;
}

} // namespace noveltea::bgfx_backend
