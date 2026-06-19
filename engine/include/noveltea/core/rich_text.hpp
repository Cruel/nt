#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json_fwd.hpp>

namespace noveltea::core {

enum class TextStyleType : int {
    None = 0,
    Animation = 1,
    Bold,
    BorderColor,
    BorderSize,
    Color,
    Diff,
    Font,
    Italic,
    Object,
    PageBreak,
    Size,
    Shader,
    XOffset,
    YOffset,
};

enum class TextEffect : int {
    None = 0,
    Fade = 1,
    FadeAcross,
    Glow,
    Nod,
    Shake,
    Test,
    Tremble,
    Pop,
};

enum FontStyle : unsigned int {
    FontRegular = 0,
    FontBold = 1u << 0,
    FontItalic = 1u << 1,
    FontUnderlined = 1u << 2,
    FontStrikeThrough = 1u << 3,
};

struct RichTextColor {
    std::uint8_t r = 0;
    std::uint8_t g = 0;
    std::uint8_t b = 0;
    std::uint8_t a = 255;
};

struct RichTextAnimation {
    TextEffect type = TextEffect::None;
    std::string equation = "quad";
    std::string value;
    int duration_ms = 0;
    int delay_ms = 0;
    int loop_count = 0;
    int loop_delay_ms = 0;
    float speed = 1.0f;
    bool loop_yoyo = true;
    bool skippable = true;
    bool wait_for_click = false;
};

struct RichTextStyle {
    std::string font_alias;
    std::string object_id;
    std::string vertex_shader_id;
    std::string fragment_shader_id;
    int x_offset = 0;
    int y_offset = 0;
    unsigned int font_size = 12;
    unsigned int font_style = FontRegular;
    RichTextColor color{};
    RichTextColor outline_color{};
    float outline_thickness = 0.0f;
    bool diff = false;
};

struct RichTextRun {
    std::string text;
    RichTextStyle style;
    RichTextAnimation animation;
    bool new_group = false;
    bool start_on_new_line = false;
};

struct RichTextPageBreak {
    std::size_t run_index = 0;
    int delay_ms = 0;
};

struct RichTextDocument {
    std::string source;
    std::string plain_text;
    std::vector<RichTextRun> runs;
    std::vector<RichTextPageBreak> page_breaks;
};

struct RichTextParseOptions {
    RichTextStyle default_style{};
    RichTextAnimation default_animation{};
};

struct RichTextPage {
    std::string plain_text;
    std::vector<RichTextRun> runs;
};

struct RichTextTimelineItem {
    enum class Type {
        Text,
        PageBreak
    };
    Type type = Type::Text;
    RichTextPage page;
    int delay_ms = 0;
};

[[nodiscard]] RichTextDocument parse_rich_text(std::string_view text,
                                               const RichTextParseOptions& options = {});
[[nodiscard]] std::string strip_rich_text_tags(std::string_view text);
[[nodiscard]] RichTextDocument diff_room_description(std::string_view previous,
                                                     std::string_view current,
                                                     const RichTextParseOptions& options = {});
[[nodiscard]] std::vector<RichTextPage> paginate_rich_text(const RichTextDocument& document,
                                                           std::size_t max_plain_chars);
[[nodiscard]] std::vector<RichTextTimelineItem>
make_rich_text_timeline(const RichTextDocument& document, std::size_t max_plain_chars);

[[nodiscard]] nlohmann::json to_json(const RichTextDocument& document);
[[nodiscard]] nlohmann::json to_json(const RichTextPage& page);
[[nodiscard]] nlohmann::json to_json(const RichTextTimelineItem& item);

} // namespace noveltea::core
