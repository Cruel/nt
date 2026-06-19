#pragma once

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/text/text.hpp"

#include <cstdint>
#include <cstddef>
#include <memory>
#include <optional>
#include <string_view>
#include <string>
#include <unordered_map>
#include <vector>

namespace noveltea::text {

struct FontMetrics {
    float ascender = 0.0f;
    float descender = 0.0f;
    float line_gap = 0.0f;
    float line_height = 0.0f;
};

struct GlyphBitmap {
    uint32_t width = 0;
    uint32_t height = 0;
    int32_t bearing_x = 0;
    int32_t bearing_y = 0;
    Vec2 advance{};
    std::vector<uint8_t> coverage;
};

struct GlyphAtlasUpload {
    uint16_t width = 0;
    uint16_t height = 0;
    uint16_t glyph_x = 0;
    uint16_t glyph_y = 0;
    std::vector<uint8_t> rgba;
};

struct FontFaceAccess {
    void* ft_face = nullptr;
    void* hb_font = nullptr;
};

class TextEngine {
public:
    explicit TextEngine(const assets::AssetManager& assets);
    ~TextEngine();

    TextEngine(const TextEngine&) = delete;
    TextEngine& operator=(const TextEngine&) = delete;

    [[nodiscard]] bool valid() const;
    [[nodiscard]] FontHandle load_font(const FontDesc& desc);
    [[nodiscard]] TextLayout layout_text(const Text& text) const;
    [[nodiscard]] TextLayout layout_text(const Text& text, float scale) const;
    [[nodiscard]] TextMetrics measure_text(const Text& text) const;
    [[nodiscard]] TextMetrics measure_text(FontHandle font, std::string_view value,
                                           float size) const;
    [[nodiscard]] std::optional<GlyphBitmap> rasterize_glyph(FontHandle font, uint32_t glyph_id,
                                                             float raster_pixel_size) const;
    [[nodiscard]] FontMetrics metrics(FontHandle font, float pixel_size) const;
    [[nodiscard]] uint32_t glyph_index(FontHandle font, uint32_t codepoint) const;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

[[nodiscard]] uint32_t normalize_raster_pixel_size(float pixel_size);
[[nodiscard]] uint32_t glyph_cache_pixel_size_key(float pixel_size);
[[nodiscard]] std::optional<size_t> unibreak_marker_index_for_boundary(std::string_view value,
                                                                       size_t offset);
[[nodiscard]] bool is_utf8_boundary(std::string_view value, size_t offset);
[[nodiscard]] GlyphAtlasUpload make_padded_glyph_upload(const GlyphBitmap& bitmap,
                                                        uint16_t padding);

struct AtlasRect {
    uint16_t page = 0;
    uint16_t x = 0;
    uint16_t y = 0;
    uint16_t width = 0;
    uint16_t height = 0;
};

class ShelfAtlasPacker {
public:
    ShelfAtlasPacker(uint16_t width, uint16_t height, uint16_t padding);
    [[nodiscard]] AtlasRect add(uint16_t width, uint16_t height);
    [[nodiscard]] uint16_t width() const { return m_width; }
    [[nodiscard]] uint16_t height() const { return m_height; }
    [[nodiscard]] uint16_t page_count() const { return static_cast<uint16_t>(m_pages.size()); }

private:
    struct Page {
        uint16_t x = 0;
        uint16_t y = 0;
        uint16_t row_height = 0;
    };

    uint16_t m_width = 0;
    uint16_t m_height = 0;
    uint16_t m_padding = 0;
    std::vector<Page> m_pages;
};

} // namespace noveltea::text
