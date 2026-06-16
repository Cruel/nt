#include "noveltea/renderer.hpp"

#include "noveltea/assets/assets.hpp"

#include <SDL3/SDL_log.h>
#include <bgfx/bgfx.h>

#include <cstdint>
#include <sstream>
#include <string>
#include <vector>

namespace noveltea {

uint16_t Renderer::load_ppm_texture(const std::filesystem::path& path)
{
    const auto resolved_path = resolve_asset_path(path);
    const auto bytes = read_binary_file(resolved_path);
    if (!bytes) {
        return UINT16_MAX;
    }

    std::string text(bytes->begin(), bytes->end());
    std::istringstream in(text);
    std::string magic;
    int width = 0;
    int height = 0;
    int max_value = 0;
    in >> magic >> width >> height >> max_value;
    if (magic != "P3" || width <= 0 || height <= 0 || max_value <= 0) {
        SDL_Log("[renderer] unsupported texture file %s (expected ASCII PPM P3)", resolved_path.string().c_str());
        return UINT16_MAX;
    }

    std::vector<uint32_t> pixels(static_cast<std::size_t>(width * height));
    for (int i = 0; i < width * height; ++i) {
        int r = 0;
        int g = 0;
        int b = 0;
        if (!(in >> r >> g >> b)) {
            SDL_Log("[renderer] incomplete PPM texture %s", resolved_path.string().c_str());
            return UINT16_MAX;
        }
        const auto scale = [max_value](int value) -> uint32_t {
            if (value < 0) value = 0;
            if (value > max_value) value = max_value;
            return static_cast<uint32_t>((value * 255) / max_value);
        };
        pixels[static_cast<std::size_t>(i)] = 0xff000000u
            | (scale(b) << 16)
            | (scale(g) << 8)
            | scale(r);
    }

    const bgfx::TextureHandle texture = bgfx::createTexture2D(
        static_cast<uint16_t>(width),
        static_cast<uint16_t>(height),
        false,
        1,
        bgfx::TextureFormat::RGBA8,
        BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP,
        bgfx::copy(pixels.data(), static_cast<uint32_t>(pixels.size() * sizeof(uint32_t))));

    if (!bgfx::isValid(texture)) {
        SDL_Log("[renderer] failed to create texture from %s", resolved_path.string().c_str());
        return UINT16_MAX;
    }
    SDL_Log("[renderer] loaded texture: %s (%dx%d)", resolved_path.string().c_str(), width, height);
    return texture.idx;
}

} // namespace noveltea
