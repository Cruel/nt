#include "imgui_bgfx.hpp"

#include <bgfx/bgfx.h>
#include <bgfx/platform.h>

#include <imgui.h>

#include <SDL3/SDL.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <algorithm>

#include "render/bgfx/bgfx_shader_loader.hpp"

namespace noveltea {

// ---------------------------------------------------------------------------
// ImGuiBgfxRenderer
// ---------------------------------------------------------------------------

ImGuiBgfxRenderer::~ImGuiBgfxRenderer()
{
    shutdown();
}

bool ImGuiBgfxRenderer::initialize(const assets::AssetManager& assets)
{
    if (m_initialized) return true;
    m_assets = &assets;

    m_program = bgfx_backend::BgfxShaderLoader(assets).load_program(bgfx_backend::SystemShader::ImGui).idx;
    if (!bgfx::isValid(bgfx::ProgramHandle{m_program})) {
        SDL_Log("[imgui_bgfx] shader load failed");
        return false;
    }

    m_sampler = bgfx::createUniform("s_tex", bgfx::UniformType::Sampler).idx;

    create_font_texture();

    m_initialized = true;
    SDL_Log("[imgui_bgfx] initialized");
    return true;
}

void ImGuiBgfxRenderer::shutdown()
{
    if (!m_initialized) return;

    if (bgfx::isValid(bgfx::TextureHandle{m_font_texture})) {
        bgfx::destroy(bgfx::TextureHandle{m_font_texture});
        m_font_texture = UINT16_MAX;
    }

    if (bgfx::isValid(bgfx::UniformHandle{m_sampler})) {
        bgfx::destroy(bgfx::UniformHandle{m_sampler});
        m_sampler = UINT16_MAX;
    }

    if (bgfx::isValid(bgfx::ProgramHandle{m_program})) {
        bgfx::destroy(bgfx::ProgramHandle{m_program});
        m_program = UINT16_MAX;
    }

    m_initialized = false;
    SDL_Log("[imgui_bgfx] shutdown");
}

void ImGuiBgfxRenderer::create_font_texture()
{
    ImGuiIO& io = ImGui::GetIO();

    unsigned char* pixels = nullptr;
    int width = 0;
    int height = 0;
    io.Fonts->GetTexDataAsRGBA32(&pixels, &width, &height);

    if (!pixels || width <= 0 || height <= 0) {
        SDL_Log("[imgui_bgfx] font atlas contains no data");
        return;
    }

    const bgfx::Memory* mem = bgfx::copy(pixels, width * height * 4);

    m_font_texture = bgfx::createTexture2D(
        static_cast<uint16_t>(width),
        static_cast<uint16_t>(height),
        false,
        1,
        bgfx::TextureFormat::RGBA8,
        BGFX_TEXTURE_NONE
        | BGFX_SAMPLER_MIN_POINT
        | BGFX_SAMPLER_MAG_POINT
        | BGFX_SAMPLER_MIP_POINT,
        mem
    ).idx;

    if (!bgfx::isValid(bgfx::TextureHandle{m_font_texture})) {
        SDL_Log("[imgui_bgfx] font texture creation failed");
        return;
    }

    io.Fonts->TexID = (ImTextureID)(uintptr_t)(m_font_texture);

    SDL_Log("[imgui_bgfx] font texture created: %dx%d", width, height);
}

void ImGuiBgfxRenderer::render(ImDrawData* draw_data, int width, int height)
{
    (void)width;
    (void)height;

    if (!m_initialized || !draw_data) {
        return;
    }

    bgfx::touch(250);

    if (draw_data->CmdListsCount == 0) {
        return;
    }

    const float fbScaleX = draw_data->FramebufferScale.x;
    const float fbScaleY = draw_data->FramebufferScale.y;
    const float fbWidthF  = draw_data->DisplaySize.x * fbScaleX;
    const float fbHeightF = draw_data->DisplaySize.y * fbScaleY;
    if (fbWidthF <= 0.0f || fbHeightF <= 0.0f) {
        return;
    }

    const uint16_t fbWidth  = static_cast<uint16_t>(fbWidthF);
    const uint16_t fbHeight = static_cast<uint16_t>(fbHeightF);

    bgfx::setViewName(250, "ImGui");
    bgfx::setViewRect(250, 0, 0, fbWidth, fbHeight);
    bgfx::setViewClear(250, BGFX_CLEAR_NONE);

    const float x = draw_data->DisplayPos.x;
    const float y = draw_data->DisplayPos.y;
    const float displayWidth = draw_data->DisplaySize.x;
    const float displayHeight = draw_data->DisplaySize.y;
    const float left = x;
    const float right = x + displayWidth;
    const float bottom = y + displayHeight;
    const float top = y;
    const float near = 0.0f;
    const float far = 1000.0f;
    const bool homogeneousDepth = bgfx::getCaps()->homogeneousDepth;

    const float aa = 2.0f / (right - left);
    const float bb = 2.0f / (top - bottom);
    const float cc = (homogeneousDepth ? 2.0f : 1.0f) / (far - near);
    const float dd = (left + right) / (left - right);
    const float ee = (top + bottom) / (bottom - top);
    const float ff = homogeneousDepth
        ? (near + far) / (near - far)
        : near / (near - far);

    float ortho[16] = {};
    ortho[0] = aa;
    ortho[5] = bb;
    ortho[10] = -cc;
    ortho[12] = dd;
    ortho[13] = ee;
    ortho[14] = ff;
    ortho[15] = 1.0f;

    bgfx::setViewTransform(250, NULL, ortho);
    bgfx::setViewMode(250, bgfx::ViewMode::Sequential);

    bgfx::VertexLayout layout;
    layout.begin()
        .add(bgfx::Attrib::Position,  2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::TexCoord0, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::Color0,    4, bgfx::AttribType::Uint8, true)
        .end();

    const bgfx::ProgramHandle  program {m_program};
    const bgfx::UniformHandle  sampler {m_sampler};

    const uint64_t state = BGFX_STATE_WRITE_RGB
                         | BGFX_STATE_WRITE_A
                         | BGFX_STATE_BLEND_FUNC(BGFX_STATE_BLEND_SRC_ALPHA, BGFX_STATE_BLEND_INV_SRC_ALPHA)
                         | BGFX_STATE_MSAA;

    const ImVec2 displayPos = draw_data->DisplayPos;

    for (int n = 0; n < draw_data->CmdListsCount; ++n) {
        const ImDrawList* cmdList = draw_data->CmdLists[n];
        const uint32_t numVertices = static_cast<uint32_t>(cmdList->VtxBuffer.Size);
        const uint32_t numIndices  = static_cast<uint32_t>(cmdList->IdxBuffer.Size);

        if (numVertices == 0 || numIndices == 0) continue;

        bgfx::TransientVertexBuffer tvb;
        bgfx::TransientIndexBuffer tib;

        if (bgfx::getAvailTransientVertexBuffer(numVertices, layout) < numVertices
            || bgfx::getAvailTransientIndexBuffer(numIndices, sizeof(ImDrawIdx) == 4) < numIndices) {
            SDL_Log("[imgui_bgfx] transient buffers unavailable: vertices=%u indices=%u",
                    numVertices, numIndices);
            break;
        }

        bgfx::allocTransientVertexBuffer(&tvb, numVertices, layout);
        bgfx::allocTransientIndexBuffer(&tib, numIndices, sizeof(ImDrawIdx) == 4);

        std::memcpy(tvb.data, cmdList->VtxBuffer.Data,
                    numVertices * sizeof(ImDrawVert));
        std::memcpy(tib.data, cmdList->IdxBuffer.Data,
                    numIndices * sizeof(ImDrawIdx));

        bgfx::Encoder* encoder = bgfx::begin();

        for (int i = 0; i < cmdList->CmdBuffer.Size; ++i) {
            const ImDrawCmd* cmd = &cmdList->CmdBuffer[i];

            if (cmd->UserCallback) {
                cmd->UserCallback(cmdList, cmd);
                continue;
            }

            if (cmd->ElemCount == 0) {
                continue;
            }

            const float clipMinX = (cmd->ClipRect.x - displayPos.x) * fbScaleX;
            const float clipMinY = (cmd->ClipRect.y - displayPos.y) * fbScaleY;
            const float clipMaxX = (cmd->ClipRect.z - displayPos.x) * fbScaleX;
            const float clipMaxY = (cmd->ClipRect.w - displayPos.y) * fbScaleY;

            const uint16_t scX = static_cast<uint16_t>(
                std::max(clipMinX, 0.0f));
            const uint16_t scY = static_cast<uint16_t>(
                std::max(clipMinY, 0.0f));
            const uint16_t scW = static_cast<uint16_t>(
                std::max(std::min(clipMaxX, fbWidthF) - static_cast<float>(scX), 0.0f));
            const uint16_t scH = static_cast<uint16_t>(
                std::max(std::min(clipMaxY, fbHeightF) - static_cast<float>(scY), 0.0f));

            if (scW == 0 || scH == 0) {
                continue;
            }

            const uint16_t texIdx = static_cast<uint16_t>(
                static_cast<uint64_t>(cmd->GetTexID()));
            const bgfx::TextureHandle texture {texIdx};

            encoder->setScissor(scX, scY, scW, scH);
            encoder->setTexture(0, sampler, texture);
            encoder->setState(state);
            encoder->setVertexBuffer(0, &tvb, cmd->VtxOffset, numVertices);
            encoder->setIndexBuffer(&tib, cmd->IdxOffset, cmd->ElemCount);

            encoder->submit(250, program);
        }

        bgfx::end(encoder);
    }
}

} // namespace noveltea
