#include "noveltea/core/rich_text_codec.hpp"

#include "noveltea/core/json_access.hpp"

#include <nlohmann/json.hpp>

#include <cstdint>
#include <string>
#include <utility>

namespace noveltea::core {
namespace {

nlohmann::json encode_color(const RichTextColor& color)
{
    return {{"r", color.r}, {"g", color.g}, {"b", color.b}, {"a", color.a}};
}

nlohmann::json encode_animation(const RichTextAnimation& animation)
{
    return {
        {"type", static_cast<int>(animation.type)},
        {"equation", animation.equation},
        {"value", animation.value},
        {"duration_ms", animation.duration_ms},
        {"delay_ms", animation.delay_ms},
        {"loop_count", animation.loop_count},
        {"loop_delay_ms", animation.loop_delay_ms},
        {"speed", animation.speed},
        {"loop_yoyo", animation.loop_yoyo},
        {"skippable", animation.skippable},
        {"wait_for_click", animation.wait_for_click},
    };
}

nlohmann::json encode_style(const RichTextStyle& style)
{
    return {
        {"font_alias", style.font_alias},
        {"material_id", style.material_id},
        {"object_id", style.object_id},
        {"vertex_shader_id", style.vertex_shader_id},
        {"fragment_shader_id", style.fragment_shader_id},
        {"x_offset", style.x_offset},
        {"y_offset", style.y_offset},
        {"font_size", style.font_size},
        {"font_style", style.font_style},
        {"color", encode_color(style.color)},
        {"outline_color", encode_color(style.outline_color)},
        {"outline_thickness", style.outline_thickness},
        {"diff", style.diff},
    };
}

nlohmann::json encode_run(const RichTextRun& run)
{
    return {
        {"text", run.text},
        {"style", encode_style(run.style)},
        {"animation", encode_animation(run.animation)},
        {"new_group", run.new_group},
        {"start_on_new_line", run.start_on_new_line},
    };
}

void decode_color(const nlohmann::json& value, RichTextColor& color)
{
    if (!value.is_object())
        return;
    color.r = static_cast<std::uint8_t>(json_access::value_or(value, "r", 0));
    color.g = static_cast<std::uint8_t>(json_access::value_or(value, "g", 0));
    color.b = static_cast<std::uint8_t>(json_access::value_or(value, "b", 0));
    color.a = static_cast<std::uint8_t>(json_access::value_or(value, "a", 255));
}

} // namespace

nlohmann::json encode_rich_text_document(const RichTextDocument& document)
{
    nlohmann::json runs = nlohmann::json::array();
    for (const auto& run : document.runs)
        runs.push_back(encode_run(run));
    nlohmann::json breaks = nlohmann::json::array();
    for (const auto& page_break : document.page_breaks) {
        breaks.push_back({{"run_index", page_break.run_index}, {"delay_ms", page_break.delay_ms}});
    }
    return {{"source", document.source},
            {"plain_text", document.plain_text},
            {"runs", std::move(runs)},
            {"page_breaks", std::move(breaks)}};
}

nlohmann::json encode_rich_text_page(const RichTextPage& page)
{
    nlohmann::json runs = nlohmann::json::array();
    for (const auto& run : page.runs)
        runs.push_back(encode_run(run));
    return {{"plain_text", page.plain_text}, {"runs", std::move(runs)}};
}

nlohmann::json encode_rich_text_timeline_item(const RichTextTimelineItem& item)
{
    if (item.type == RichTextTimelineItem::Type::PageBreak)
        return {{"type", "page_break"}, {"delay_ms", item.delay_ms}};
    return {{"type", "text"}, {"page", encode_rich_text_page(item.page)}};
}

bool decode_rich_text_document(const nlohmann::json& value, RichTextDocument& out)
{
    if (!value.is_object())
        return false;

    RichTextDocument document;
    document.source = json_access::value_or(value, "source", std::string());
    document.plain_text = json_access::value_or(value, "plain_text", std::string());

    const auto runs = value.find("runs");
    if (runs != value.end()) {
        if (!runs->is_array())
            return false;
        for (const auto& run_value : *runs) {
            if (!run_value.is_object())
                return false;
            RichTextRun run;
            run.text = json_access::value_or(run_value, "text", std::string());
            run.new_group = json_access::value_or(run_value, "new_group", false);
            run.start_on_new_line = json_access::value_or(run_value, "start_on_new_line", false);

            const auto style_value = run_value.find("style");
            if (style_value != run_value.end() && style_value->is_object()) {
                run.style.font_alias = style_value->value("font_alias", "");
                run.style.material_id = style_value->value("material_id", "");
                run.style.object_id = style_value->value("object_id", "");
                run.style.vertex_shader_id = style_value->value("vertex_shader_id", "");
                run.style.fragment_shader_id = style_value->value("fragment_shader_id", "");
                run.style.x_offset = style_value->value("x_offset", 0);
                run.style.y_offset = style_value->value("y_offset", 0);
                run.style.font_size = style_value->value("font_size", 12u);
                run.style.font_style = style_value->value("font_style", 0u);
                run.style.outline_thickness = style_value->value("outline_thickness", 0.0f);
                run.style.diff = style_value->value("diff", false);
                if (const auto color = style_value->find("color"); color != style_value->end())
                    decode_color(*color, run.style.color);
                if (const auto color = style_value->find("outline_color");
                    color != style_value->end()) {
                    decode_color(*color, run.style.outline_color);
                }
            }

            const auto animation_value = run_value.find("animation");
            if (animation_value != run_value.end() && animation_value->is_object()) {
                run.animation.type = static_cast<TextEffect>(animation_value->value("type", 0));
                run.animation.equation = animation_value->value("equation", "quad");
                run.animation.value = animation_value->value("value", "");
                run.animation.duration_ms = animation_value->value("duration_ms", 0);
                run.animation.delay_ms = animation_value->value("delay_ms", 0);
                run.animation.loop_count = animation_value->value("loop_count", 0);
                run.animation.loop_delay_ms = animation_value->value("loop_delay_ms", 0);
                run.animation.speed = animation_value->value("speed", 1.0f);
                run.animation.loop_yoyo = animation_value->value("loop_yoyo", true);
                run.animation.skippable = animation_value->value("skippable", true);
                run.animation.wait_for_click = animation_value->value("wait_for_click", false);
            }
            document.runs.push_back(std::move(run));
        }
    }

    const auto page_breaks = value.find("page_breaks");
    if (page_breaks != value.end()) {
        if (!page_breaks->is_array())
            return false;
        for (const auto& break_value : *page_breaks) {
            if (!break_value.is_object())
                return false;
            document.page_breaks.push_back(RichTextPageBreak{
                json_access::value_or(break_value, "run_index", std::size_t{}),
                json_access::value_or(break_value, "delay_ms", 0),
            });
        }
    }

    out = std::move(document);
    return true;
}

} // namespace noveltea::core
