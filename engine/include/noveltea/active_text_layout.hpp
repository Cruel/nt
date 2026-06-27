#pragma once

#include <noveltea/active_text.hpp>
#include <noveltea/math/geometry.hpp>
#include <noveltea/text/text.hpp>
#include <noveltea/text/text_layout.hpp>

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace noveltea {

struct ActiveTextLayoutOptions {
    Rect bounds{};
    std::string default_font_alias;
    float default_text_size = 24.0f;
    float line_spacing = 1.2f;
    TextAlign alignment = TextAlign::Start;
    std::string language = "und";
    Color default_color = Color::from_rgba8(247, 244, 237);
    float reveal_progress = 1.0f;
    double time_seconds = 0.0;
    std::string highlight_object_id;
    float highlight_font_size_multiplier = 1.0f;
};

struct ActiveTextGlyphVisual {
    std::string text;
    std::size_t run_index = 0;
    std::size_t glyph_index = 0;
    uint32_t source_byte_begin = 0;
    uint32_t source_byte_end = 0;
    Rect bounds{};
    Color color{1.0f, 1.0f, 1.0f, 1.0f};
    float alpha = 1.0f;
    std::string font_alias;
    unsigned int font_size = 12;
    unsigned int font_style = core::FontRegular;
    float scale = 1.0f;
    Vec2 offset{};
    float glow = 0.0f;
    std::string object_id;
    std::string material_id;
    std::string vertex_shader_id;
    std::string fragment_shader_id;
    bool diff = false;
    core::RichTextAnimation animation{};
    PositionedGlyph shaped_glyph{};
    bool has_shaped_glyph = false;
};

struct ActiveTextObjectSpan {
    std::string object_id;
    std::vector<Rect> rects;
};

struct ActiveTextLayout {
    Rect bounds{};
    TextMetrics metrics{};
    std::size_t visible_glyph_count = 0;
    std::string visible_text;
    std::vector<ActiveTextGlyphVisual> glyphs;
    std::vector<ActiveTextObjectSpan> object_spans;
    bool page_break = false;
    bool awaiting_continue = false;
    bool used_shaped_layout = false;

    [[nodiscard]] std::optional<std::string> object_at(Vec2 logical_point) const;
};

[[nodiscard]] std::string active_text_visible_text(const core::RichTextDocument& document,
                                                   const ActiveTextLayoutOptions& options = {});

[[nodiscard]] ActiveTextLayout
build_active_text_layout(const core::RichTextDocument& document,
                         const ActiveTextLayoutOptions& options = {});

[[nodiscard]] ActiveTextLayout build_active_text_layout(const core::RichTextDocument& document,
                                                        const ActiveTextLayoutOptions& options,
                                                        const TextLayout& shaped_layout);

using ActiveTextShaper = std::function<TextLayout(const Text&)>;

[[nodiscard]] ActiveTextLayout build_active_text_layout(const core::RichTextDocument& document,
                                                        const ActiveTextLayoutOptions& options,
                                                        FontHandle font,
                                                        const ActiveTextShaper& shape_text);

} // namespace noveltea
