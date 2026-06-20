#include <noveltea/core/rich_text.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <charconv>
#include <cctype>
#include <cstdlib>
#include <map>
#include <sstream>

namespace noveltea::core {
namespace {

struct StyleTag {
    TextStyleType type = TextStyleType::None;
    std::string name;
    std::map<std::string, std::string> params;
};

std::string lower(std::string value)
{
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

std::vector<std::string> split(std::string_view value, char delimiter)
{
    std::vector<std::string> result;
    std::size_t begin = 0;
    while (begin <= value.size()) {
        auto end = value.find(delimiter, begin);
        if (end == std::string_view::npos)
            end = value.size();
        result.emplace_back(value.substr(begin, end - begin));
        if (end == value.size())
            break;
        begin = end + 1;
    }
    return result;
}

int parse_int(const std::string& value, int fallback = 0)
{
    int out = fallback;
    auto [ptr, ec] = std::from_chars(value.data(), value.data() + value.size(), out);
    if (ec != std::errc{})
        return fallback;
    return out;
}

float parse_float(const std::string& value, float fallback = 0.0f)
{
    char* end = nullptr;
    float out = std::strtof(value.c_str(), &end);
    return end == value.c_str() ? fallback : out;
}

RichTextColor parse_color(std::string value)
{
    value = lower(std::move(value));
    if (value == "black")
        return {};
    if (value.empty() || value[0] != '#')
        return {};

    value.erase(0, 1);
    while (value.size() < 3)
        value.insert(value.begin(), '0');
    if (value.size() == 3) {
        value = {value[0], value[0], value[1], value[1], value[2], value[2]};
    }
    while (value.size() < 6)
        value.push_back('0');
    if (value.size() != 6)
        return {};

    const int v = static_cast<int>(std::strtol(value.c_str(), nullptr, 16));
    return RichTextColor{
        static_cast<std::uint8_t>((v >> 16) & 0xff),
        static_cast<std::uint8_t>((v >> 8) & 0xff),
        static_cast<std::uint8_t>(v & 0xff),
        255,
    };
}

std::optional<TextEffect> effect_from_string(const std::string& raw)
{
    static const std::map<std::string, TextEffect> effects = {
        {"0", TextEffect::None},
        {"no", TextEffect::None},
        {"none", TextEffect::None},
        {"f", TextEffect::Fade},
        {"fade", TextEffect::Fade},
        {"fa", TextEffect::FadeAcross},
        {"fadeacross", TextEffect::FadeAcross},
        {"glow", TextEffect::Glow},
        {"g", TextEffect::Glow},
        {"n", TextEffect::Nod},
        {"nod", TextEffect::Nod},
        {"s", TextEffect::Shake},
        {"shake", TextEffect::Shake},
        {"p", TextEffect::Pop},
        {"pop", TextEffect::Pop},
        {"t", TextEffect::Tremble},
        {"tremble", TextEffect::Tremble},
        {"test", TextEffect::Test},
    };
    auto it = effects.find(lower(raw));
    if (it == effects.end())
        return std::nullopt;
    return it->second;
}

std::string replace_object_shorthand(std::string_view text)
{
    std::string result;
    std::size_t search = 0;
    std::size_t processed = 0;
    while (true) {
        auto start = text.find("[[", search);
        if (start == std::string_view::npos)
            break;
        auto end = text.find("]]", start);
        auto mid = text.find('|', start);
        if (end == std::string_view::npos)
            break;
        if (mid == std::string_view::npos || end < mid) {
            search = end + 2;
            continue;
        }
        result.append(text.substr(processed, start - processed));
        result += "[o=";
        result.append(text.substr(mid + 1, end - mid - 1));
        result += "]";
        result.append(text.substr(start + 2, mid - start - 2));
        result += "[/o]";
        processed = search = end + 2;
    }
    result.append(text.substr(processed));
    return result;
}

std::optional<std::string> parse_tag_at(std::string_view text, std::size_t start,
                                        std::size_t& end_out)
{
    static constexpr std::string_view allowed = " =_,.-#";
    if (start >= text.size() || text[start] != '[')
        return std::nullopt;
    std::string tag;
    for (std::size_t i = start + 1; i < text.size(); ++i) {
        unsigned char c = static_cast<unsigned char>(text[i]);
        if (std::isalnum(c) || allowed.find(static_cast<char>(c)) != std::string_view::npos) {
            tag.push_back(static_cast<char>(c));
        } else if (text[i] == ']') {
            end_out = i;
            return tag;
        } else if (text[i] == '/') {
            if (i == start + 1)
                tag.push_back('/');
            else
                return std::nullopt;
        } else {
            return std::nullopt;
        }
    }
    return std::nullopt;
}

void parse_single_arg(StyleTag& tag, std::string_view full, std::string key)
{
    auto parts = split(full, '=');
    tag.name = parts.empty() ? std::string{} : parts[0];
    if (parts.size() > 1)
        tag.params[std::move(key)] = parts[1];
}

void parse_key_values(StyleTag& tag, std::string_view full, bool make_lower)
{
    auto parts = split(full, ' ');
    tag.name = parts.empty() ? std::string{} : parts[0];
    for (std::size_t i = 1; i < parts.size(); ++i) {
        auto kv = split(parts[i], '=');
        if (kv.size() != 2)
            throw std::runtime_error("bad key/value tag");
        if (make_lower) {
            kv[0] = lower(std::move(kv[0]));
            kv[1] = lower(std::move(kv[1]));
        }
        tag.params[kv[0]] = kv[1];
    }
}

StyleTag parse_style_tag(std::string tag_full, bool& closing)
{
    if (tag_full.empty())
        throw std::runtime_error("empty tag");
    closing = tag_full[0] == '/';
    if (closing)
        tag_full.erase(0, 1);

    auto tag_lower = lower(tag_full);
    const char c = tag_lower.empty() ? '\0' : tag_lower[0];
    StyleTag tag;
    tag.name = split(tag_full, ' ')[0];

    if (c == 'a') {
        tag.type = TextStyleType::Animation;
        parse_key_values(tag, tag_full, true);
        std::map<std::string, std::string> normalized;
        for (const auto& [key, value] : tag.params) {
            if (key.empty())
                continue;
            switch (key[0]) {
            case 'e':
                normalized["effect"] = value;
                break;
            case 'f':
                normalized["func"] = value;
                break;
            case 't':
                normalized["time"] = value;
                break;
            case 'd':
                normalized["delay"] = value;
                break;
            case 'l':
                normalized["loop"] = value;
                break;
            case 's':
                normalized["speed"] = value;
                break;
            case 'c':
                normalized["cs"] = value;
                break;
            case 'v':
                normalized["value"] = value;
                break;
            case 'w':
                normalized["wait"] = value;
                break;
            }
        }
        tag.params = std::move(normalized);
    } else if (c == 'b') {
        tag.type = TextStyleType::Bold;
        if (tag_lower.size() > 1) {
            auto parts = split(tag_lower, '=');
            if (closing)
                parts.push_back("");
            tag.name = parts[0];
            if (parts.size() != 2)
                throw std::runtime_error("bad border tag");
            if (tag_lower[1] == 'c' || parts[0] == "border-color") {
                tag.type = TextStyleType::BorderColor;
                tag.params["color"] = parts[1];
            } else if (tag_lower[1] == 's' || parts[0] == "border-size") {
                tag.type = TextStyleType::BorderSize;
                tag.params["size"] = parts[1];
            }
        }
    } else if (c == 'c') {
        tag.type = TextStyleType::Color;
        parse_single_arg(tag, tag_full, "color");
    } else if (c == 'd') {
        tag.type = TextStyleType::Diff;
    } else if (c == 'i') {
        tag.type = TextStyleType::Italic;
    } else if (c == 'f') {
        tag.type = TextStyleType::Font;
        parse_single_arg(tag, tag_full, "id");
    } else if (c == 'o') {
        tag.type = TextStyleType::Object;
        parse_single_arg(tag, tag_full, "id");
    } else if (c == 'p') {
        tag.type = TextStyleType::PageBreak;
        parse_single_arg(tag, tag_full, "delay");
    } else if (c == 's') {
        if (tag_lower.size() > 1 && tag_lower[1] == 'h') {
            tag.type = TextStyleType::Shader;
            parse_key_values(tag, tag_full, false);
            if (tag.params.empty() && !closing)
                throw std::runtime_error("empty shader tag");
        } else {
            tag.type = TextStyleType::Size;
            parse_single_arg(tag, tag_full, "size");
        }
    } else if (c == 'x') {
        tag.type = TextStyleType::XOffset;
        parse_single_arg(tag, tag_full, "x");
    } else if (c == 'y') {
        tag.type = TextStyleType::YOffset;
        parse_single_arg(tag, tag_full, "y");
    } else {
        throw std::runtime_error("unknown tag");
    }
    return tag;
}

void apply_tag(RichTextStyle& style, RichTextAnimation& anim, const StyleTag& tag)
{
    switch (tag.type) {
    case TextStyleType::Bold:
        style.font_style |= FontBold;
        break;
    case TextStyleType::BorderColor:
        style.outline_color = parse_color(tag.params.at("color"));
        break;
    case TextStyleType::BorderSize:
        style.outline_thickness = std::max(parse_float(tag.params.at("size")), 0.0f);
        break;
    case TextStyleType::Color:
        style.color = parse_color(tag.params.at("color"));
        break;
    case TextStyleType::Diff:
        style.diff = true;
        style.color = {150, 0, 0, 255};
        break;
    case TextStyleType::Font:
        style.font_alias = tag.params.at("id");
        break;
    case TextStyleType::Italic:
        style.font_style |= FontItalic;
        break;
    case TextStyleType::Object:
        style.object_id = tag.params.at("id");
        break;
    case TextStyleType::Size:
        style.font_size = static_cast<unsigned int>(std::max(parse_int(tag.params.at("size")), 0));
        break;
    case TextStyleType::XOffset:
        style.x_offset = parse_int(tag.params.at("x"));
        break;
    case TextStyleType::YOffset:
        style.y_offset = parse_int(tag.params.at("y"));
        break;
    case TextStyleType::Shader:
        if (auto it = tag.params.find("f"); it != tag.params.end())
            style.fragment_shader_id = it->second;
        if (auto it = tag.params.find("v"); it != tag.params.end())
            style.vertex_shader_id = it->second;
        break;
    case TextStyleType::PageBreak:
        if (auto it = tag.params.find("delay"); it != tag.params.end()) {
            int delay = static_cast<int>(std::max(parse_float(it->second), 0.0f) * 1000.0f);
            anim.delay_ms += anim.delay_ms >= 0 ? delay : -delay;
            anim.wait_for_click = false;
        }
        break;
    case TextStyleType::Animation:
        for (const auto& [key, value] : tag.params) {
            if (key == "effect") {
                if (auto effect = effect_from_string(value))
                    anim.type = *effect;
                const int default_delay = anim.type == TextEffect::FadeAcross ? -1 : 0;
                if (!tag.params.contains("delay"))
                    anim.delay_ms = default_delay;
                if (!tag.params.contains("time"))
                    anim.duration_ms = default_delay;
            } else if (key == "func") {
                anim.equation = value;
            } else if (key == "loop") {
                auto values = split(value, ',');
                anim.loop_count = parse_int(values[0]);
                if (values.size() > 1)
                    anim.loop_delay_ms = static_cast<int>(parse_float(values[1]) * 1000.0f);
                if (values.size() > 2)
                    anim.loop_yoyo = values[2] != "0";
            } else if (key == "delay") {
                anim.delay_ms = static_cast<int>(parse_float(value) * 1000.0f);
            } else if (key == "time") {
                anim.duration_ms = static_cast<int>(parse_float(value) * 1000.0f);
            } else if (key == "speed") {
                anim.speed = std::max(parse_float(value, 1.0f), 0.01f);
            } else if (key == "cs") {
                anim.skippable = value == "1";
            } else if (key == "value") {
                anim.value = value;
            } else if (key == "wait") {
                anim.wait_for_click = value == "1";
            }
        }
        break;
    default:
        break;
    }
}

RichTextRun make_run(std::string text, const std::vector<StyleTag>& stack,
                     const RichTextParseOptions& options, bool new_group, bool start_on_new_line)
{
    RichTextRun run;
    run.text = std::move(text);
    run.style = options.default_style;
    run.animation = options.default_animation;
    run.new_group = new_group;
    run.start_on_new_line = start_on_new_line;
    for (const auto& tag : stack)
        apply_tag(run.style, run.animation, tag);
    return run;
}

void append_run_text(RichTextDocument& document, const RichTextRun& run)
{
    if (run.start_on_new_line && !document.plain_text.empty())
        document.plain_text.push_back('\n');
    document.plain_text += run.text;
}

nlohmann::json color_json(const RichTextColor& c)
{
    return {{"r", c.r}, {"g", c.g}, {"b", c.b}, {"a", c.a}};
}

nlohmann::json animation_json(const RichTextAnimation& a)
{
    return {
        {"type", static_cast<int>(a.type)},
        {"equation", a.equation},
        {"value", a.value},
        {"duration_ms", a.duration_ms},
        {"delay_ms", a.delay_ms},
        {"loop_count", a.loop_count},
        {"loop_delay_ms", a.loop_delay_ms},
        {"speed", a.speed},
        {"loop_yoyo", a.loop_yoyo},
        {"skippable", a.skippable},
        {"wait_for_click", a.wait_for_click},
    };
}

nlohmann::json style_json(const RichTextStyle& s)
{
    return {
        {"font_alias", s.font_alias},
        {"object_id", s.object_id},
        {"vertex_shader_id", s.vertex_shader_id},
        {"fragment_shader_id", s.fragment_shader_id},
        {"x_offset", s.x_offset},
        {"y_offset", s.y_offset},
        {"font_size", s.font_size},
        {"font_style", s.font_style},
        {"color", color_json(s.color)},
        {"outline_color", color_json(s.outline_color)},
        {"outline_thickness", s.outline_thickness},
        {"diff", s.diff},
    };
}

nlohmann::json run_json(const RichTextRun& r)
{
    return {
        {"text", r.text},
        {"style", style_json(r.style)},
        {"animation", animation_json(r.animation)},
        {"new_group", r.new_group},
        {"start_on_new_line", r.start_on_new_line},
    };
}

} // namespace

RichTextDocument parse_rich_text(std::string_view input, const RichTextParseOptions& options)
{
    RichTextDocument document;
    document.source = std::string(input);

    std::string text = replace_object_shorthand(input);
    std::vector<StyleTag> stack;
    std::ostringstream buffer;
    bool new_group = true;
    bool new_line = false;

    auto push_run = [&](bool force = false) {
        auto value = buffer.str();
        if (value.empty() && !new_line && !force)
            return;
        auto run = make_run(value, stack, options, new_group, new_line);
        append_run_text(document, run);
        document.runs.push_back(std::move(run));
        new_group = false;
        new_line = false;
        buffer.str("");
        buffer.clear();
        stack.erase(std::remove_if(stack.begin(), stack.end(),
                                   [](const StyleTag& tag) {
                                       return tag.type == TextStyleType::XOffset ||
                                              tag.type == TextStyleType::YOffset;
                                   }),
                    stack.end());
    };

    for (std::size_t i = 0; i < text.size(); ++i) {
        const char c = text[i];
        if (c == '[') {
            if (i + 1 < text.size() && text[i + 1] == '!') {
                buffer << c;
                ++i;
                continue;
            }
            std::size_t tag_end = i;
            auto tag_text = parse_tag_at(text, i, tag_end);
            if (!tag_text) {
                buffer << c;
                continue;
            }
            try {
                bool closing = false;
                auto tag = parse_style_tag(*tag_text, closing);
                if (tag.type == TextStyleType::PageBreak) {
                    if (closing)
                        throw std::runtime_error("closing page break");
                    stack.push_back(tag);
                    push_run(true);
                    int delay = 0;
                    if (auto it = tag.params.find("delay"); it != tag.params.end())
                        delay = static_cast<int>(std::max(parse_float(it->second), 0.0f) * 1000.0f);
                    document.page_breaks.push_back(RichTextPageBreak{document.runs.size(), delay});
                    stack.pop_back();
                    new_group = true;
                    i = tag_end;
                    continue;
                }

                auto it = std::find_if(stack.rbegin(), stack.rend(), [&](const StyleTag& active) {
                    return active.name == tag.name;
                });
                if (closing && it == stack.rend()) {
                    i = tag_end;
                    continue;
                }

                push_run();
                if (tag.type == TextStyleType::Animation || tag.type == TextStyleType::XOffset ||
                    tag.type == TextStyleType::YOffset || tag.type == TextStyleType::Shader) {
                    new_group = true;
                }
                if (closing) {
                    stack.erase(std::next(it).base());
                } else {
                    stack.push_back(std::move(tag));
                }
                i = tag_end;
            } catch (const std::exception&) {
                buffer << c;
            }
        } else if (c == '\n') {
            push_run();
            new_line = true;
        } else {
            buffer << c;
        }
    }

    if (buffer.str().empty() && !document.runs.empty() && new_group &&
        !document.runs.back().animation.wait_for_click)
        push_run(true);
    push_run(text.empty());
    return document;
}

std::string strip_rich_text_tags(std::string_view text) { return parse_rich_text(text).plain_text; }

RichTextDocument diff_room_description(std::string_view previous, std::string_view current,
                                       const RichTextParseOptions& options)
{
    const std::string prev_plain = strip_rich_text_tags(previous);
    const std::string curr(current);
    const std::string curr_plain = strip_rich_text_tags(current);
    if (prev_plain.empty() || curr_plain == prev_plain)
        return parse_rich_text(current, options);

    std::size_t prefix = 0;
    while (prefix < prev_plain.size() && prefix < curr_plain.size() &&
           prev_plain[prefix] == curr_plain[prefix])
        ++prefix;
    std::size_t suffix = 0;
    while (suffix + prefix < prev_plain.size() && suffix + prefix < curr_plain.size() &&
           prev_plain[prev_plain.size() - suffix - 1] ==
               curr_plain[curr_plain.size() - suffix - 1]) {
        ++suffix;
    }

    std::string marked;
    marked += curr_plain.substr(0, prefix);
    marked += "[d]";
    marked += curr_plain.substr(prefix, curr_plain.size() - prefix - suffix);
    marked += "[/d]";
    marked += curr_plain.substr(curr_plain.size() - suffix);
    (void)curr;
    return parse_rich_text(marked, options);
}

std::vector<RichTextPage> paginate_rich_text(const RichTextDocument& document,
                                             std::size_t max_plain_chars)
{
    if (max_plain_chars == 0)
        max_plain_chars = document.plain_text.empty() ? 1 : document.plain_text.size();

    std::vector<RichTextPage> pages;
    RichTextPage page;
    std::size_t count = 0;

    auto flush = [&]() {
        if (!page.runs.empty() || !page.plain_text.empty()) {
            pages.push_back(std::move(page));
            page = {};
            count = 0;
        }
    };

    std::size_t next_break = 0;
    for (std::size_t i = 0; i < document.runs.size(); ++i) {
        while (next_break < document.page_breaks.size() &&
               document.page_breaks[next_break].run_index == i) {
            flush();
            ++next_break;
        }

        const auto& run = document.runs[i];
        if (run.text.empty())
            continue;
        std::size_t offset = 0;
        while (offset < run.text.size()) {
            const std::size_t remaining = max_plain_chars - count;
            if (remaining == 0) {
                flush();
                continue;
            }
            RichTextRun part = run;
            const std::size_t take = std::min(remaining, run.text.size() - offset);
            part.text = run.text.substr(offset, take);
            offset += take;
            count += take;
            if (part.start_on_new_line && !page.plain_text.empty())
                page.plain_text.push_back('\n');
            page.plain_text += part.text;
            page.runs.push_back(std::move(part));
        }
    }
    flush();
    if (pages.empty())
        pages.push_back({});
    return pages;
}

std::vector<RichTextTimelineItem> make_rich_text_timeline(const RichTextDocument& document,
                                                          std::size_t max_plain_chars)
{
    std::vector<RichTextTimelineItem> result;
    auto pages = paginate_rich_text(document, max_plain_chars);
    for (std::size_t i = 0; i < pages.size(); ++i) {
        RichTextTimelineItem item;
        item.type = RichTextTimelineItem::Type::Text;
        item.page = std::move(pages[i]);
        result.push_back(std::move(item));
        if (i < document.page_breaks.size()) {
            RichTextTimelineItem br;
            br.type = RichTextTimelineItem::Type::PageBreak;
            br.delay_ms = document.page_breaks[i].delay_ms;
            result.push_back(std::move(br));
        }
    }
    return result;
}

nlohmann::json to_json(const RichTextDocument& document)
{
    nlohmann::json runs = nlohmann::json::array();
    for (const auto& run : document.runs)
        runs.push_back(run_json(run));
    nlohmann::json breaks = nlohmann::json::array();
    for (const auto& br : document.page_breaks)
        breaks.push_back({{"run_index", br.run_index}, {"delay_ms", br.delay_ms}});
    return {{"source", document.source},
            {"plain_text", document.plain_text},
            {"runs", std::move(runs)},
            {"page_breaks", std::move(breaks)}};
}

nlohmann::json to_json(const RichTextPage& page)
{
    nlohmann::json runs = nlohmann::json::array();
    for (const auto& run : page.runs)
        runs.push_back(run_json(run));
    return {{"plain_text", page.plain_text}, {"runs", std::move(runs)}};
}

nlohmann::json to_json(const RichTextTimelineItem& item)
{
    if (item.type == RichTextTimelineItem::Type::PageBreak)
        return {{"type", "page_break"}, {"delay_ms", item.delay_ms}};
    return {{"type", "text"}, {"page", to_json(item.page)}};
}

bool rich_text_from_json(const nlohmann::json& value, RichTextDocument& out)
{
    if (!value.is_object())
        return false;

    RichTextDocument document;
    document.source = value.value("source", "");
    document.plain_text = value.value("plain_text", "");

    const auto runs = value.find("runs");
    if (runs != value.end()) {
        if (!runs->is_array())
            return false;
        for (const auto& run_value : *runs) {
            if (!run_value.is_object())
                return false;
            RichTextRun run;
            run.text = run_value.value("text", "");
            run.new_group = run_value.value("new_group", false);
            run.start_on_new_line = run_value.value("start_on_new_line", false);

            const auto style_value = run_value.find("style");
            if (style_value != run_value.end() && style_value->is_object()) {
                run.style.font_alias = style_value->value("font_alias", "");
                run.style.object_id = style_value->value("object_id", "");
                run.style.vertex_shader_id = style_value->value("vertex_shader_id", "");
                run.style.fragment_shader_id = style_value->value("fragment_shader_id", "");
                run.style.x_offset = style_value->value("x_offset", 0);
                run.style.y_offset = style_value->value("y_offset", 0);
                run.style.font_size = style_value->value("font_size", 12u);
                run.style.font_style = style_value->value("font_style", 0u);
                run.style.outline_thickness = style_value->value("outline_thickness", 0.0f);
                run.style.diff = style_value->value("diff", false);

                const auto read_color = [](const nlohmann::json& color, RichTextColor& out_color) {
                    if (!color.is_object())
                        return;
                    out_color.r = static_cast<std::uint8_t>(color.value("r", 0));
                    out_color.g = static_cast<std::uint8_t>(color.value("g", 0));
                    out_color.b = static_cast<std::uint8_t>(color.value("b", 0));
                    out_color.a = static_cast<std::uint8_t>(color.value("a", 255));
                };
                if (const auto color = style_value->find("color"); color != style_value->end())
                    read_color(*color, run.style.color);
                if (const auto color = style_value->find("outline_color");
                    color != style_value->end())
                    read_color(*color, run.style.outline_color);
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
                break_value.value("run_index", std::size_t{}),
                break_value.value("delay_ms", 0),
            });
        }
    }

    out = std::move(document);
    return true;
}

} // namespace noveltea::core
