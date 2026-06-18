#pragma once

#include <cstdint>
#include <filesystem>

namespace noveltea {

struct FontHandle {
    uint32_t id = 0;

    [[nodiscard]] explicit operator bool() const { return id != 0; }
    [[nodiscard]] friend bool operator==(FontHandle lhs, FontHandle rhs) = default;
};

enum class HintingMode {
    Default,
    None,
    Light,
    Monochrome,
};

struct FontDesc {
    std::filesystem::path asset_path;
    uint32_t face_index = 0;
    HintingMode hinting = HintingMode::Default;
};

} // namespace noveltea
