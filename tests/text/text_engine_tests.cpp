#include "text/text_engine.hpp"

#include <catch2/catch_test_macros.hpp>
#include <graphemebreak.h>
#include <linebreak.h>

#include <algorithm>
#include <string>

using namespace noveltea;

namespace {

assets::AssetManager make_assets()
{
    assets::AssetManager assets;
    assets.mount_directory("project", NOVELTEA_SOURCE_DIR "/apps/sandbox/assets");
    return assets;
}

Text make_text(FontHandle font, std::string value, float size = 24.0f)
{
    Text text;
    text.font = font;
    text.value = std::move(value);
    text.bounds = {0.0f, 0.0f, 500.0f, 0.0f};
    text.style.size = size;
    text.language = "en";
    return text;
}

std::vector<PositionedGlyph> glyphs_for(const TextLayout& layout)
{
    std::vector<PositionedGlyph> glyphs;
    for (const auto& line : layout.lines) {
        for (const auto& run : line.visual_runs) {
            glyphs.insert(glyphs.end(), run.glyphs.begin(), run.glyphs.end());
        }
    }
    return glyphs;
}

} // namespace

TEST_CASE("TextEngine preserves UTF-8 byte clusters for multibyte input")
{
    auto assets = make_assets();
    noveltea::text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    auto layout = engine.layout_text(make_text(font, "caf\xC3\xA9"));
    const auto glyphs = glyphs_for(layout);
    REQUIRE_FALSE(glyphs.empty());
    CHECK(std::ranges::any_of(glyphs, [](const PositionedGlyph& glyph) {
        return glyph.source_byte_begin == 3 && glyph.source_byte_end == 5;
    }));
}

TEST_CASE("Combining marks and emoji ZWJ sequences are not corrupted by boundary handling")
{
    init_graphemebreak();

    const std::string combining = "e\xCC\x81";
    std::vector<char> combining_breaks(combining.size(), GRAPHEMEBREAK_NOBREAK);
    set_graphemebreaks_utf8(reinterpret_cast<const utf8_t*>(combining.data()), combining.size(), "en", combining_breaks.data());
    CHECK(combining_breaks[1] != GRAPHEMEBREAK_BREAK);

    auto assets = make_assets();
    noveltea::text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);
    const std::string zwj = "\xF0\x9F\x91\xA9\xE2\x80\x8D\xF0\x9F\x92\xBB";
    Text text = make_text(font, zwj, 24.0f);
    text.bounds.width = 1.0f;
    auto layout = engine.layout_text(text);
    CHECK(layout.metrics.line_count == 1);
}

TEST_CASE("HarfBuzz shapes Latin kerning and Arabic without byte reversal")
{
    auto assets = make_assets();
    noveltea::text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    const auto av = engine.measure_text(make_text(font, "AV")).width;
    const auto a_plus_v = engine.measure_text(make_text(font, "A")).width + engine.measure_text(make_text(font, "V")).width;
    CHECK(av < a_plus_v);

    Text arabic = make_text(font, "\xD8\xB3\xD9\x84\xD8\xA7\xD9\x85");
    arabic.direction = TextDirection::RightToLeft;
    arabic.language = "ar";
    auto layout = engine.layout_text(arabic);
    REQUIRE(layout.metrics.line_count == 1);
    REQUIRE_FALSE(layout.lines.front().visual_runs.empty());
    CHECK(layout.lines.front().visual_runs.front().direction == TextDirection::RightToLeft);
    CHECK_FALSE(layout.lines.front().visual_runs.front().glyphs.empty());
}

TEST_CASE("Mixed LTR and RTL text emits visual bidi runs")
{
    auto assets = make_assets();
    noveltea::text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    auto layout = engine.layout_text(make_text(font, "abc \xD7\xA9\xD7\x9C\xD7\x95\xD7\x9D def"));
    REQUIRE(layout.metrics.line_count == 1);
    CHECK(layout.lines.front().visual_runs.size() >= 3);
}

TEST_CASE("Explicit newlines and height constraints produce deterministic line metrics")
{
    auto assets = make_assets();
    noveltea::text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    auto layout = engine.layout_text(make_text(font, "one\ntwo\nthree"));
    CHECK(layout.metrics.line_count == 3);
    CHECK(layout.lines[0].source_byte_end == 3);
    CHECK(layout.lines[1].source_byte_begin == 4);

    Text constrained = make_text(font, "one two three four five six seven", 20.0f);
    constrained.bounds = {0.0f, 0.0f, 80.0f, 24.0f};
    auto overflow = engine.layout_text(constrained);
    CHECK(overflow.overflowed);
    CHECK(overflow.metrics.line_count == 1);
}

TEST_CASE("Wrapping respects no-break spaces and CJK line break opportunities")
{
    init_linebreak();

    const std::string nbsp = "a\xC2\xA0" "b";
    std::vector<char> nbsp_breaks(nbsp.size(), LINEBREAK_NOBREAK);
    set_linebreaks_utf8(reinterpret_cast<const utf8_t*>(nbsp.data()), nbsp.size(), "en", nbsp_breaks.data());
    CHECK(std::ranges::none_of(nbsp_breaks, [](char brk) { return brk == LINEBREAK_ALLOWBREAK; }));

    const std::string cjk = "\xE6\x97\xA5\xE6\x9C\xAC\xE8\xAA\x9E\xE3\x83\x86\xE3\x82\xAD\xE3\x82\xB9\xE3\x83\x88";
    std::vector<char> cjk_breaks(cjk.size(), LINEBREAK_NOBREAK);
    set_linebreaks_utf8(reinterpret_cast<const utf8_t*>(cjk.data()), cjk.size(), "ja", cjk_breaks.data());
    CHECK(std::ranges::any_of(cjk_breaks, [](char brk) { return brk == LINEBREAK_ALLOWBREAK; }));
}

TEST_CASE("Wrapping, alignment, justification, and repeated layout are stable")
{
    auto assets = make_assets();
    noveltea::text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    Text wrapped = make_text(font, "one two three four five", 20.0f);
    wrapped.bounds.width = 95.0f;
    auto wrapped_layout = engine.layout_text(wrapped);
    CHECK(wrapped_layout.metrics.line_count > 1);
    CHECK(wrapped_layout.lines.front().source_byte_end < wrapped.value.size());

    Text centered = make_text(font, "center", 20.0f);
    centered.bounds.width = 240.0f;
    centered.align = TextAlign::Center;
    auto start = engine.layout_text(make_text(font, "center", 20.0f));
    auto center = engine.layout_text(centered);
    CHECK(glyphs_for(center).front().position.x > glyphs_for(start).front().position.x);

    Text end = centered;
    end.align = TextAlign::End;
    auto end_layout = engine.layout_text(end);
    CHECK(glyphs_for(end_layout).front().position.x > glyphs_for(center).front().position.x);

    Text justify = make_text(font, "a b\nc", 20.0f);
    justify.align = TextAlign::Justify;
    justify.bounds.width = 140.0f;
    auto justified = engine.layout_text(justify);
    REQUIRE(justified.lines.size() >= 2);
    CHECK(justified.lines.front().width == justify.bounds.width);

    auto repeated = engine.layout_text(wrapped);
    CHECK(repeated.metrics.width == wrapped_layout.metrics.width);
    CHECK(repeated.metrics.height == wrapped_layout.metrics.height);
    CHECK(repeated.metrics.line_count == wrapped_layout.metrics.line_count);
}

TEST_CASE("ShelfAtlasPacker creates non-overlapping pages")
{
    noveltea::text::ShelfAtlasPacker packer(16, 16, 1);
    const auto a = packer.add(6, 6);
    const auto b = packer.add(6, 6);
    const auto c = packer.add(14, 14);

    CHECK(a.page == 0);
    CHECK(b.page == 0);
    const bool disjoint = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    CHECK(disjoint);
    CHECK(c.page > 0);
    CHECK(packer.page_count() > 1);
}
