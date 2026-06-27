#include <noveltea/active_text_layout.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
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

Color to_color(const core::RichTextColor& color)
{
    return Color::from_rgba8(color.r, color.g, color.b, color.a);
}

float glyph_size(const ActiveTextGlyph& glyph, const ActiveTextLayoutOptions& options)
{
    const float tagged = glyph.style.font_size > 0 ? static_cast<float>(glyph.style.font_size)
                                                   : options.default_text_size;
    const bool highlighted = !options.highlight_object_id.empty() &&
                             glyph.style.object_id == options.highlight_object_id;
    return tagged * (highlighted ? std::max(options.highlight_font_size_multiplier, 0.01f) : 1.0f);
}

VisibleTextPlan build_visible_text_plan(const core::RichTextDocument& document,
                                        const ActiveTextLayoutOptions& options)
{
    VisibleTextPlan plan;
    plan.frame = build_active_text_frame(
        document, ActiveTextOptions{.reveal_progress = options.reveal_progress,
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
        visual.color = Color::from_rgba8(247, 244, 237);
    }
    visual.alpha = std::clamp(glyph.alpha, 0.0f, 1.0f);
    visual.font_alias = glyph.style.font_alias;
    visual.font_size = glyph.style.font_size;
    visual.font_style = glyph.style.font_style;
    const float base_size = std::max(options.default_text_size, 1.0f);
    visual.scale = glyph.scale * std::max(glyph_size(glyph, options) / base_size, 0.01f);
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
        const float size = glyph_size(glyph, options);
        const float advance = glyph.text == "\t" ? size : size * 0.55f;
        const float line_height = std::max(size * options.line_spacing * glyph.scale, 1.0f);
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
        visual.bounds = {x, y, advance * visual.scale, line_height};
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

                const float advance_width = std::max(positioned.advance.x, 1.0f) * visual.scale;
                const float height = line_height * visual.scale;
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

} // namespace noveltea
