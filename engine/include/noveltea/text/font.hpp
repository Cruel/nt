#pragma once

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>

namespace noveltea {

inline constexpr std::string_view kSystemFontAlias = "sys";
inline constexpr std::string_view kSystemIconFontAlias = "sysIcon";
inline constexpr std::string_view kSystemFontDisplayName = "Liberation Sans";
inline constexpr std::string_view kSystemFontFileName = "LiberationSans.ttf";
inline constexpr std::string_view kSystemIconFontFileName = "fontawesome.ttf";
inline constexpr std::string_view kSystemFontProjectAsset = "project:/rmlui/LiberationSans.ttf";
inline constexpr std::string_view kSystemFontAsset = "system:/fonts/LiberationSans.ttf";

struct FontHandle {
    uint32_t id = 0;

    [[nodiscard]] explicit operator bool() const { return id != 0; }
    [[nodiscard]] friend bool operator==(FontHandle lhs, FontHandle rhs) = default;
};

struct FontFamilyHandle {
    uint32_t id = 0;

    [[nodiscard]] explicit operator bool() const { return id != 0; }
    [[nodiscard]] friend bool operator==(FontFamilyHandle lhs, FontFamilyHandle rhs) = default;
};

enum FontStyleBits : uint32_t {
    TextFontRegular = 0,
    TextFontBold = 1u << 0,
    TextFontItalic = 1u << 1,
    TextFontUnderline = 1u << 2,
    TextFontStrike = 1u << 3,
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

struct FontFamilyDesc {
    std::string alias;
    FontDesc regular;
    std::optional<FontDesc> bold;
    std::optional<FontDesc> italic;
    std::optional<FontDesc> bold_italic;
    bool synthetic_styles = true;
};

struct ResolvedFont {
    FontHandle face{};
    std::string alias;
    uint32_t requested_style = TextFontRegular;
    uint32_t synthetic_style = TextFontRegular;
};

} // namespace noveltea
