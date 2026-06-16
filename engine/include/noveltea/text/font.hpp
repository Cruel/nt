#pragma once

#include <cstdint>
#include <filesystem>

namespace noveltea {

struct FontHandle {
    uint32_t id = 0;

    [[nodiscard]] explicit operator bool() const { return id != 0; }
    [[nodiscard]] friend bool operator==(FontHandle lhs, FontHandle rhs) = default;
};

struct FontDesc {
    std::filesystem::path asset_path;
    float base_pixel_size = 96.0f;
    bool sdf = true;
    uint16_t atlas_width = 1024;
    uint16_t atlas_height = 1024;
    int sdf_padding = 12;
    uint8_t sdf_onedge_value = 180;
    float sdf_pixel_dist_scale = 24.0f;
    float sdf_min_softness = 0.012f;
};

} // namespace noveltea
