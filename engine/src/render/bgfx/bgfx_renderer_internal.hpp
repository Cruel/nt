#pragma once

#include <bgfx/bgfx.h>

#include <cstdint>

namespace noveltea::bgfx_backend {

enum ViewId : bgfx::ViewId {
    ViewGame2D = 0,
    ViewRuntimeUI = 1,
    ViewTextLab = 2,
    ViewDebugUI = 3,
};

bgfx::ShaderHandle load_embedded_shader(bgfx::RendererType::Enum type,
                                        const uint8_t* glsl,
                                        uint32_t glsl_len,
                                        const uint8_t* essl,
                                        uint32_t essl_len,
                                        const uint8_t* web,
                                        uint32_t web_len);

} // namespace noveltea::bgfx_backend
