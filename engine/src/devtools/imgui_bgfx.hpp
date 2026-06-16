#pragma once

#include <cstdint>

struct ImDrawData;

namespace noveltea {

namespace assets { class AssetManager; }

class ImGuiBgfxRenderer {
public:
    ImGuiBgfxRenderer() = default;
    ~ImGuiBgfxRenderer();

    ImGuiBgfxRenderer(const ImGuiBgfxRenderer&) = delete;
    ImGuiBgfxRenderer& operator=(const ImGuiBgfxRenderer&) = delete;

    bool initialize(const assets::AssetManager& assets);
    void render(ImDrawData* draw_data, int width, int height);
    void shutdown();

private:
    void create_font_texture();

    bool m_initialized = false;

    uint16_t m_program = UINT16_MAX;
    uint16_t m_font_texture = UINT16_MAX;
    uint16_t m_sampler = UINT16_MAX;
    const assets::AssetManager* m_assets = nullptr;
};

} // namespace noveltea
