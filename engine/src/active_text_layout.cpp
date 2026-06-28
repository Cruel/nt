#include <noveltea/active_text_layout.hpp>

#include "text/text_breaks.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <set>
#include <unordered_map>
#include <vector>

namespace noveltea {
namespace {

struct VisibleGlyphMetadata {
    uint32_t source_byte_begin = 0;
    uint32_t source_byte_end = 0;
    ActiveTextGlyph glyph;
};

struct VisibleTextPlan {
    ActiveTextFrame frame;
    std::string text;
    std::vector<VisibleGlyphMetadata> glyphs;
};

struct ShapedActiveGlyph {
    const VisibleGlyphMetadata* metadata = nullptr;
    PositionedGlyph positioned{};
    float advance = 0.0f;
    float line_height = 0.0f;
    bool has_positioned = false;
};

Color to_color(const core::RichTextColor& color)
{
    return Color::from_rgba8(color.r, color.g, color.b, color.a);
}

constexpr unsigned int kRichTextDefaultFontSize = 12;

uint32_t active_text_style_bits(unsigned int style) noexcept
{
    uint32_t bits = TextFontRegular;
    if ((style & core::FontBold) != 0) {
        bits |= TextFontBold;
    }
    if ((style & core::FontItalic) != 0) {
        bits |= TextFontItalic;
    }
    if ((style & core::FontUnderlined) != 0) {
        bits |= TextFontUnderline;
    }
    if ((style & core::FontStrikeThrough) != 0) {
        bits |= TextFontStrike;
    }
    return bits;
}

float resolved_glyph_size(const ActiveTextGlyph& glyph, const ActiveTextLayoutOptions& options)
{
    const float tagged =
        (glyph.style.font_size > 0 && glyph.style.font_size != kRichTextDefaultFontSize)
            ? static_cast<float>(glyph.style.font_size)
            : options.default_text_size;
    const bool highlighted = !options.highlight_object_id.empty() &&
                             glyph.style.object_id == options.highlight_object_id;
    return tagged * (highlighted ? std::max(options.highlight_font_size_multiplier, 0.01f) : 1.0f);
}

float animation_scale(const ActiveTextGlyph& glyph, const ActiveTextLayoutOptions& options)
{
    const bool highlighted = !options.highlight_object_id.empty() &&
                             glyph.style.object_id == options.highlight_object_id;
    return glyph.scale *
           (highlighted ? std::max(options.highlight_font_size_multiplier, 0.01f) : 1.0f);
}

VisibleTextPlan build_visible_text_plan(const core::RichTextDocument& document,
                                        const ActiveTextLayoutOptions& options,
                                        float reveal_progress)
{
    VisibleTextPlan plan;
    plan.frame =
        build_active_text_frame(document, ActiveTextOptions{.reveal_progress = reveal_progress,
                                                            .time_seconds = options.time_seconds});
    for (const auto& run_frame : plan.frame.runs) {
        for (const auto& glyph : run_frame.glyphs) {
            VisibleGlyphMetadata metadata;
            metadata.source_byte_begin = static_cast<uint32_t>(plan.text.size());
            plan.text += glyph.text;
            metadata.source_byte_end = static_cast<uint32_t>(plan.text.size());
            metadata.glyph = glyph;
            plan.glyphs.push_back(std::move(metadata));
        }
    }
    return plan;
}

VisibleTextPlan build_visible_text_plan(const core::RichTextDocument& document,
                                        const ActiveTextLayoutOptions& options)
{
    return build_visible_text_plan(document, options, options.reveal_progress);
}

ActiveTextGlyphVisual make_visual(const ActiveTextGlyph& glyph,
                                  const ActiveTextLayoutOptions& options)
{
    ActiveTextGlyphVisual visual;
    visual.text = glyph.text;
    visual.run_index = glyph.run_index;
    visual.glyph_index = glyph.glyph_index;
    visual.color = to_color(glyph.style.color);
    if (glyph.style.color.r == 0 && glyph.style.color.g == 0 && glyph.style.color.b == 0 &&
        glyph.style.color.a == 255) {
        visual.color = options.default_color;
    }
    visual.alpha = std::clamp(glyph.alpha, 0.0f, 1.0f);
    visual.font_alias = glyph.style.font_alias;
    visual.font_size =
        static_cast<unsigned int>(std::max(std::round(resolved_glyph_size(glyph, options)), 1.0f));
    visual.font_style = glyph.style.font_style;
    visual.scale = animation_scale(glyph, options);
    visual.offset = glyph.offset;
    visual.glow = glyph.glow;
    visual.object_id = glyph.style.object_id;
    visual.material_id = glyph.style.material_id;
    visual.vertex_shader_id = glyph.style.vertex_shader_id;
    visual.fragment_shader_id = glyph.style.fragment_shader_id;
    visual.diff = glyph.style.diff;
    visual.animation = glyph.animation;
    return visual;
}

const VisibleGlyphMetadata* metadata_for_range(const std::vector<VisibleGlyphMetadata>& glyphs,
                                               uint32_t begin, uint32_t end)
{
    const uint32_t resolved_end = std::max(end, static_cast<uint32_t>(begin + 1u));
    for (const auto& glyph : glyphs) {
        if (begin >= glyph.source_byte_begin && begin < glyph.source_byte_end) {
            return &glyph;
        }
    }
    for (const auto& glyph : glyphs) {
        if (glyph.source_byte_begin < resolved_end && begin < glyph.source_byte_end) {
            return &glyph;
        }
    }
    return nullptr;
}

void add_object_span_rect(ActiveTextLayout& layout,
                          std::unordered_map<std::string, std::size_t>& object_indices,
                          const ActiveTextGlyphVisual& visual)
{
    if (visual.object_id.empty()) {
        return;
    }
    auto [it, inserted] = object_indices.emplace(visual.object_id, layout.object_spans.size());
    if (inserted) {
        ActiveTextObjectSpan span;
        span.object_id = visual.object_id;
        layout.object_spans.push_back(std::move(span));
    }
    layout.object_spans[it->second].rects.push_back(visual.bounds);
}

bool is_collapsible_whitespace(const ActiveTextGlyph& glyph)
{
    return glyph.text == " " || glyph.text == "\t";
}

bool is_hard_break(const ActiveTextGlyph& glyph) { return glyph.text == "\n"; }

std::set<uint32_t> source_boundaries_for(const std::vector<VisibleGlyphMetadata>& glyphs,
                                         uint32_t text_size)
{
    std::set<uint32_t> boundaries;
    boundaries.insert(0u);
    boundaries.insert(text_size);
    for (const auto& glyph : glyphs) {
        boundaries.insert(glyph.source_byte_begin);
        boundaries.insert(glyph.source_byte_end);
    }
    return boundaries;
}

std::size_t skip_leading_collapsible_whitespace(const std::vector<ShapedActiveGlyph>& glyphs,
                                                std::size_t index)
{
    while (index < glyphs.size() && is_collapsible_whitespace(glyphs[index].metadata->glyph)) {
        ++index;
    }
    return index;
}

std::size_t trim_trailing_collapsible_whitespace(const std::vector<ShapedActiveGlyph>& glyphs,
                                                 std::size_t begin, std::size_t end)
{
    while (end > begin && is_collapsible_whitespace(glyphs[end - 1].metadata->glyph)) {
        --end;
    }
    return end;
}

ActiveTextLayout make_base_layout(const core::RichTextDocument& document,
                                  const ActiveTextLayoutOptions& options,
                                  const VisibleTextPlan& plan)
{
    ActiveTextLayout layout;
    layout.bounds = options.bounds;
    layout.page_break = !document.page_breaks.empty();
    layout.awaiting_continue = layout.page_break;
    layout.visible_glyph_count = plan.frame.visible_glyphs;
    layout.visible_text = plan.text;
    return layout;
}

StyledText make_styled_text(const VisibleTextPlan& plan, const ActiveTextLayoutOptions& options)
{
    StyledText text;
    text.value = plan.text;
    text.bounds = options.bounds;
    text.align = options.alignment;
    text.wrap = TextWrap::Word;
    text.language = options.language;

    text.spans.reserve(plan.glyphs.size());
    for (const auto& metadata : plan.glyphs) {
        if (metadata.glyph.text == "\n") {
            continue;
        }
        TextSpan span;
        span.source_byte_begin = metadata.source_byte_begin;
        span.source_byte_end = metadata.source_byte_end;
        span.font_alias = metadata.glyph.style.font_alias.empty() ? options.default_font_alias
                                                                  : metadata.glyph.style.font_alias;
        span.font_style = active_text_style_bits(metadata.glyph.style.font_style);
        span.size = resolved_glyph_size(metadata.glyph, options);
        span.color = to_color(metadata.glyph.style.color);
        if (metadata.glyph.style.color.r == 0 && metadata.glyph.style.color.g == 0 &&
            metadata.glyph.style.color.b == 0 && metadata.glyph.style.color.a == 255) {
            span.color = options.default_color;
        }
        span.alpha = std::clamp(metadata.glyph.alpha, 0.0f, 1.0f);
        text.spans.push_back(std::move(span));
    }
    if (text.spans.empty() && !text.value.empty()) {
        TextSpan span;
        span.source_byte_begin = 0;
        span.source_byte_end = static_cast<uint32_t>(text.value.size());
        span.font_alias = options.default_font_alias;
        span.size = options.default_text_size;
        span.color = options.default_color;
        text.spans.push_back(std::move(span));
    }
    return text;
}

} // namespace

std::optional<std::string> ActiveTextLayout::object_at(Vec2 logical_point) const
{
    for (const auto& span : object_spans) {
        for (const auto& rect : span.rects) {
            if (rect.contains(logical_point)) {
                return span.object_id;
            }
        }
    }
    return std::nullopt;
}

std::string active_text_visible_text(const core::RichTextDocument& document,
                                     const ActiveTextLayoutOptions& options)
{
    return build_visible_text_plan(document, options).text;
}

ActiveTextLayout build_active_text_layout(const core::RichTextDocument& document,
                                          const ActiveTextLayoutOptions& options)
{
    const auto plan = build_visible_text_plan(document, options);
    auto layout = make_base_layout(document, options, plan);

    std::unordered_map<std::string, std::size_t> object_indices;
    float x = options.bounds.x;
    float y = options.bounds.y;
    float line_width = 0.0f;
    float max_width = 0.0f;
    float current_line_height = std::max(options.default_text_size * options.line_spacing, 1.0f);

    const auto new_line = [&]() {
        max_width = std::max(max_width, line_width);
        x = options.bounds.x;
        y += current_line_height;
        line_width = 0.0f;
        current_line_height = std::max(options.default_text_size * options.line_spacing, 1.0f);
    };

    for (const auto& metadata : plan.glyphs) {
        const auto& glyph = metadata.glyph;
        const float size = resolved_glyph_size(glyph, options);
        const float advance = glyph.text == "\t" ? size : size * 0.55f;
        const float line_height = std::max(size * options.line_spacing, 1.0f);
        current_line_height = std::max(current_line_height, line_height);

        if (glyph.text == "\n") {
            new_line();
            continue;
        }
        if (options.bounds.width > 0.0f && x > options.bounds.x &&
            x + advance > options.bounds.x + options.bounds.width) {
            new_line();
        }
        if (options.bounds.height > 0.0f &&
            y + line_height > options.bounds.y + options.bounds.height) {
            break;
        }

        auto visual = make_visual(glyph, options);
        visual.source_byte_begin = metadata.source_byte_begin;
        visual.source_byte_end = metadata.source_byte_end;
        visual.bounds = {x, y, advance, line_height};
        add_object_span_rect(layout, object_indices, visual);

        layout.glyphs.push_back(std::move(visual));
        x += advance;
        line_width = x - options.bounds.x;
    }

    max_width = std::max(max_width, line_width);
    layout.metrics.width =
        options.bounds.width > 0.0f ? std::min(max_width, options.bounds.width) : max_width;
    layout.metrics.height =
        layout.glyphs.empty() ? 0.0f : (y - options.bounds.y) + current_line_height;
    layout.metrics.line_height = current_line_height;
    layout.metrics.line_count =
        layout.glyphs.empty()
            ? 0u
            : static_cast<uint32_t>(
                  std::floor((layout.metrics.height + 0.5f) / std::max(current_line_height, 1.0f)));
    return layout;
}

ActiveTextLayout build_active_text_layout(const core::RichTextDocument& document,
                                          const ActiveTextLayoutOptions& options,
                                          const TextLayout& shaped_layout)
{
    const auto plan = build_visible_text_plan(document, options);
    auto layout = make_base_layout(document, options, plan);
    layout.bounds = shaped_layout.bounds;
    layout.metrics = shaped_layout.metrics;
    layout.used_shaped_layout = true;

    std::unordered_map<std::string, std::size_t> object_indices;
    const float line_height =
        std::max(shaped_layout.metrics.line_height,
                 std::max(options.default_text_size * options.line_spacing, 1.0f));

    for (const auto& line : shaped_layout.lines) {
        for (const auto& run : line.visual_runs) {
            for (const auto& positioned : run.glyphs) {
                const auto* metadata = metadata_for_range(plan.glyphs, positioned.source_byte_begin,
                                                          positioned.source_byte_end);
                if (!metadata) {
                    continue;
                }
                if (metadata->glyph.text == "\n") {
                    continue;
                }

                auto visual = make_visual(metadata->glyph, options);
                visual.source_byte_begin = positioned.source_byte_begin;
                visual.source_byte_end = positioned.source_byte_end;
                visual.shaped_glyph = positioned;
                visual.has_shaped_glyph = true;

                const float advance_width = std::max(positioned.advance.x, 1.0f);
                const float height = line_height;
                visual.bounds = {positioned.position.x + visual.offset.x,
                                 line.baseline - line_height + visual.offset.y, advance_width,
                                 height};
                add_object_span_rect(layout, object_indices, visual);
                layout.glyphs.push_back(std::move(visual));
            }
        }
    }

    return layout;
}

ActiveTextLayout build_active_text_layout(const core::RichTextDocument& document,
                                          const ActiveTextLayoutOptions& options,
                                          const ActiveTextStyledShaper& shape_text)
{
    if (!shape_text) {
        return build_active_text_layout(document, options);
    }
    const auto full_plan = build_visible_text_plan(document, options, 1.0f);
    auto styled = make_styled_text(full_plan, options);
    auto shaped = shape_text(styled);
    if (shaped.lines.empty()) {
        return build_active_text_layout(document, options);
    }
    return build_active_text_layout(document, options, shaped);
}

ActiveTextLayout build_active_text_layout(const core::RichTextDocument& document,
                                          const ActiveTextLayoutOptions& options, FontHandle font,
                                          const ActiveTextShaper& shape_text)
{
    const auto full_plan = build_visible_text_plan(document, options, 1.0f);
    const auto visible_plan = build_visible_text_plan(document, options);
    auto layout = make_base_layout(document, options, visible_plan);
    layout.used_shaped_layout = true;

    if (!font || !shape_text) {
        return build_active_text_layout(document, options);
    }

    const std::size_t visible_glyph_count = visible_plan.frame.visible_glyphs;
    std::vector<ShapedActiveGlyph> shaped_glyphs;
    shaped_glyphs.reserve(full_plan.glyphs.size());
    const auto source_boundaries =
        source_boundaries_for(full_plan.glyphs, static_cast<uint32_t>(full_plan.text.size()));
    const auto breaks = text::collect_text_breaks(full_plan.text, options.language);

    for (const auto& metadata : full_plan.glyphs) {
        const auto& glyph = metadata.glyph;
        ShapedActiveGlyph shaped_glyph;
        shaped_glyph.metadata = &metadata;
        const float size = resolved_glyph_size(glyph, options);
        shaped_glyph.line_height = std::max(size * options.line_spacing, 1.0f);

        if (!is_hard_break(glyph)) {
            Text text;
            text.value = glyph.text;
            text.font = font;
            text.bounds = {0.0f, 0.0f, 0.0f, 0.0f};
            text.style.size = size;
            text.wrap = TextWrap::NoWrap;
            text.align = TextAlign::Start;
            text.language = options.language;
            const auto shaped = shape_text(text);

            shaped_glyph.advance = glyph.text == "\t" ? size : size * 0.55f;
            if (!shaped.lines.empty() && !shaped.lines.front().visual_runs.empty() &&
                !shaped.lines.front().visual_runs.front().glyphs.empty()) {
                shaped_glyph.positioned = shaped.lines.front().visual_runs.front().glyphs.front();
                shaped_glyph.advance = std::max(shaped_glyph.positioned.advance.x, 1.0f);
                shaped_glyph.has_positioned = true;
            }
        }
        shaped_glyphs.push_back(shaped_glyph);
    }

    std::unordered_map<std::string, std::size_t> object_indices;
    float y = options.bounds.y;
    float max_width = 0.0f;
    float max_line_height = std::max(options.default_text_size * options.line_spacing, 1.0f);
    uint32_t line_count = 0;

    const auto emit_line = [&](std::size_t begin, std::size_t end) {
        begin = skip_leading_collapsible_whitespace(shaped_glyphs, begin);
        end = trim_trailing_collapsible_whitespace(shaped_glyphs, begin, end);
        if (begin >= end) {
            return;
        }

        float x = options.bounds.x;
        float line_height = std::max(options.default_text_size * options.line_spacing, 1.0f);
        for (std::size_t i = begin; i < end; ++i) {
            line_height = std::max(line_height, shaped_glyphs[i].line_height);
        }
        for (std::size_t i = begin; i < end; ++i) {
            const auto& shaped_glyph = shaped_glyphs[i];
            const auto& metadata = *shaped_glyph.metadata;
            const auto& glyph = metadata.glyph;
            if (glyph.glyph_index < visible_glyph_count) {
                auto visual = make_visual(glyph, options);
                visual.source_byte_begin = metadata.source_byte_begin;
                visual.source_byte_end = metadata.source_byte_end;
                visual.bounds = {x + visual.offset.x, y + visual.offset.y, shaped_glyph.advance,
                                 line_height};
                if (shaped_glyph.has_positioned) {
                    auto positioned = shaped_glyph.positioned;
                    positioned.source_byte_begin = metadata.source_byte_begin;
                    positioned.source_byte_end = metadata.source_byte_end;
                    positioned.position = {x,
                                           y + std::max(resolved_glyph_size(glyph, options), 1.0f)};
                    positioned.synthetic_font_style =
                        active_text_style_bits(glyph.style.font_style) &
                        (TextFontBold | TextFontItalic);
                    positioned.logical_pixel_size = resolved_glyph_size(glyph, options);
                    visual.shaped_glyph = positioned;
                    visual.has_shaped_glyph = true;
                }
                add_object_span_rect(layout, object_indices, visual);
                layout.glyphs.push_back(std::move(visual));
            }
            x += shaped_glyph.advance;
        }

        max_width = std::max(max_width, x - options.bounds.x);
        max_line_height = std::max(max_line_height, line_height);
        y += line_height;
        ++line_count;
    };

    const float wrap_width = options.bounds.width;
    std::size_t line_begin = skip_leading_collapsible_whitespace(shaped_glyphs, 0);
    std::size_t candidate_break = line_begin;
    float line_width = 0.0f;

    for (std::size_t index = line_begin; index < shaped_glyphs.size(); ++index) {
        const auto& glyph = shaped_glyphs[index].metadata->glyph;
        if (is_hard_break(glyph)) {
            emit_line(line_begin, index);
            line_begin = skip_leading_collapsible_whitespace(shaped_glyphs, index + 1u);
            index = line_begin == 0 ? 0 : line_begin - 1u;
            candidate_break = line_begin;
            line_width = 0.0f;
            continue;
        }

        const float next_width = line_width + shaped_glyphs[index].advance;
        const bool legal_break_after = text::text_legal_line_break_boundary(
            full_plan.text, breaks, shaped_glyphs[index].metadata->source_byte_end,
            source_boundaries);
        if (wrap_width > 0.0f && line_width > 0.0f && next_width > wrap_width) {
            if (candidate_break > line_begin) {
                emit_line(line_begin, candidate_break);
                line_begin = skip_leading_collapsible_whitespace(shaped_glyphs, candidate_break);
                index = line_begin == 0 ? 0 : line_begin - 1u;
                candidate_break = line_begin;
                line_width = 0.0f;
                continue;
            }
            emit_line(line_begin, index);
            line_begin = index;
            candidate_break = line_begin;
            line_width = 0.0f;
            --index;
            continue;
        }

        line_width = next_width;
        if (legal_break_after) {
            candidate_break = index + 1u;
        }
        if (text::text_mandatory_line_break_boundary(full_plan.text, breaks,
                                                     shaped_glyphs[index].metadata->source_byte_end,
                                                     source_boundaries)) {
            emit_line(line_begin, index + 1u);
            line_begin = skip_leading_collapsible_whitespace(shaped_glyphs, index + 1u);
            index = line_begin == 0 ? 0 : line_begin - 1u;
            candidate_break = line_begin;
            line_width = 0.0f;
        }
    }
    emit_line(line_begin, shaped_glyphs.size());
    layout.metrics.width =
        options.bounds.width > 0.0f ? std::min(max_width, options.bounds.width) : max_width;
    layout.metrics.height = line_count == 0 ? 0.0f : (y - options.bounds.y);
    layout.metrics.line_height = max_line_height;
    layout.metrics.line_count = line_count;
    layout.bounds.height = std::max(layout.bounds.height, layout.metrics.height);
    return layout;
}

} // namespace noveltea
