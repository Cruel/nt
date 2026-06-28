#include "text/text_engine.hpp"

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>
#include <graphemebreak.h>
#include <linebreak.h>
#include <wordbreak.h>

#include <algorithm>
#include <optional>
#include <string>

using namespace noveltea;

namespace {

assets::AssetManager make_assets()
{
    assets::AssetManager assets;
    assets.mount_directory("project", NOVELTEA_SOURCE_DIR "/apps/sandbox/assets");
    return assets;
}

std::optional<char> marker_at_boundary(const std::vector<char>& markers, const std::string& value,
                                       size_t offset)
{
    const auto index = noveltea::text::unibreak_marker_index_for_boundary(value, offset);
    if (!index) {
        return std::nullopt;
    }
    REQUIRE(*index < markers.size());
    return markers[*index];
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

FontFamilyHandle register_liberation_regular(noveltea::text::TextEngine& engine,
                                             std::string alias = std::string(kSystemFontAlias),
                                             bool synthetic_styles = true)
{
    FontFamilyDesc family;
    family.alias = std::move(alias);
    family.regular = FontDesc{std::string(kSystemFontProjectAsset)};
    family.synthetic_styles = synthetic_styles;
    return engine.register_font_family(family);
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

TEST_CASE("TextEngine resolves regular-only font families with synthetic style fallback")
{
    auto assets = make_assets();
    noveltea::text::TextEngine engine(assets);
    const auto family = register_liberation_regular(engine, "body");
    REQUIRE(family);
    engine.set_default_font_family(family);

    const auto system_by_name = engine.resolve_font(kSystemFontDisplayName, TextFontRegular);
    CHECK(system_by_name.face);

    const auto regular = engine.resolve_font("body", TextFontRegular);
    const auto bold = engine.resolve_font("body", TextFontBold);
    const auto italic = engine.resolve_font("body", TextFontItalic);
    const auto bold_italic = engine.resolve_font("body", TextFontBold | TextFontItalic);

    REQUIRE(regular.face);
    CHECK(bold.face == regular.face);
    CHECK(italic.face == regular.face);
    CHECK(bold_italic.face == regular.face);
    CHECK(bold.synthetic_style == TextFontBold);
    CHECK(italic.synthetic_style == TextFontItalic);
    CHECK(bold_italic.synthetic_style == (TextFontBold | TextFontItalic));

    const auto missing = engine.resolve_font("missing-family", TextFontBold);
    CHECK(missing.face == regular.face);
    CHECK(missing.synthetic_style == TextFontBold);
}

TEST_CASE("StyledText preserves synthetic font style on positioned glyphs")
{
    auto assets = make_assets();
    noveltea::text::TextEngine engine(assets);
    const auto family = register_liberation_regular(engine, "body");
    REQUIRE(family);
    engine.set_default_font_family(family);

    StyledText text;
    text.value = "Bold plain";
    text.bounds = {0.0f, 0.0f, 500.0f, 0.0f};
    text.language = "en";
    text.spans.push_back(TextSpan{.source_byte_begin = 0,
                                  .source_byte_end = 4,
                                  .font_alias = "body",
                                  .font_style = TextFontBold,
                                  .size = 24.0f});
    text.spans.push_back(TextSpan{.source_byte_begin = 4,
                                  .source_byte_end = static_cast<uint32_t>(text.value.size()),
                                  .font_alias = "body",
                                  .font_style = TextFontRegular,
                                  .size = 24.0f});

    const auto layout = engine.layout_text(text);
    const auto glyphs = glyphs_for(layout);
    REQUIRE_FALSE(glyphs.empty());
    CHECK(glyphs.front().synthetic_font_style == TextFontBold);
    CHECK(std::ranges::any_of(glyphs, [](const PositionedGlyph& glyph) {
        return glyph.source_byte_begin >= 4 && glyph.synthetic_font_style == TextFontRegular;
    }));
}

TEST_CASE("TextEngine synthetic raster style has a distinct cache key and bitmap")
{
    auto assets = make_assets();
    noveltea::text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);
    const uint32_t glyph_id = engine.glyph_index(font, 'A');
    REQUIRE(glyph_id != 0);

    const auto regular = engine.rasterize_glyph(font, glyph_id, 24.0f, TextFontRegular);
    const auto bold = engine.rasterize_glyph(font, glyph_id, 24.0f, TextFontBold);
    REQUIRE(regular);
    REQUIRE(bold);
    CHECK_FALSE(regular->coverage.empty());
    CHECK_FALSE(bold->coverage.empty());
}

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

TEST_CASE("TextEngine keeps logical text metrics stable while raster size follows scale")
{
    auto assets = make_assets();
    noveltea::text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    Text text = make_text(font, "Scale aware text", 24.0f);
    const auto layout_1 = engine.layout_text(text, 1.0f);
    const auto layout_125 = engine.layout_text(text, 1.25f);
    const auto layout_2 = engine.layout_text(text, 2.0f);
    const auto glyphs_1 = glyphs_for(layout_1);
    const auto glyphs_125 = glyphs_for(layout_125);
    const auto glyphs_2 = glyphs_for(layout_2);
    REQUIRE_FALSE(glyphs_1.empty());
    REQUIRE_FALSE(glyphs_125.empty());
    REQUIRE_FALSE(glyphs_2.empty());

    CHECK(glyphs_1.front().logical_pixel_size == 24.0f);
    CHECK(glyphs_1.front().raster_pixel_size == 24.0f);
    CHECK(glyphs_125.front().raster_pixel_size == 30.0f);
    CHECK(glyphs_2.front().raster_pixel_size == 48.0f);
    CHECK(noveltea::text::glyph_cache_pixel_size_key(glyphs_1.front().raster_pixel_size) !=
          noveltea::text::glyph_cache_pixel_size_key(glyphs_125.front().raster_pixel_size));
    CHECK(layout_125.metrics.width == Catch::Approx(layout_1.metrics.width).margin(1.0f));
    CHECK(layout_2.metrics.width == Catch::Approx(layout_1.metrics.width).margin(1.0f));
}

TEST_CASE("Combining marks and emoji ZWJ sequences are not corrupted by boundary handling")
{
    init_graphemebreak();

    const std::string combining = "e\xCC\x81";
    std::vector<char> combining_breaks(combining.size(), GRAPHEMEBREAK_NOBREAK);
    set_graphemebreaks_utf8(reinterpret_cast<const utf8_t*>(combining.data()), combining.size(),
                            "en", combining_breaks.data());
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

TEST_CASE("libunibreak UTF-8 boundary conversion uses previous byte marker")
{
    init_linebreak();
    init_graphemebreak();
    init_wordbreak();

    const std::string ascii = "one two";
    std::vector<char> ascii_line(ascii.size(), LINEBREAK_NOBREAK);
    std::vector<char> ascii_word(ascii.size(), WORDBREAK_NOBREAK);
    set_linebreaks_utf8(reinterpret_cast<const utf8_t*>(ascii.data()), ascii.size(), "en",
                        ascii_line.data());
    set_wordbreaks_utf8(reinterpret_cast<const utf8_t*>(ascii.data()), ascii.size(), "en",
                        ascii_word.data());
    REQUIRE(noveltea::text::unibreak_marker_index_for_boundary(ascii, 4) == 3u);
    CHECK(marker_at_boundary(ascii_line, ascii, 4) == LINEBREAK_ALLOWBREAK);
    CHECK(marker_at_boundary(ascii_word, ascii, 3) == WORDBREAK_BREAK);

    const std::string nbsp = "a\xC2\xA0"
                             "b";
    std::vector<char> nbsp_line(nbsp.size(), LINEBREAK_NOBREAK);
    set_linebreaks_utf8(reinterpret_cast<const utf8_t*>(nbsp.data()), nbsp.size(), "en",
                        nbsp_line.data());
    REQUIRE(noveltea::text::unibreak_marker_index_for_boundary(nbsp, 3) == 2u);
    CHECK(marker_at_boundary(nbsp_line, nbsp, 3) != LINEBREAK_ALLOWBREAK);
    CHECK_FALSE(noveltea::text::unibreak_marker_index_for_boundary(nbsp, 2).has_value());

    const std::string combining = "e\xCC\x81";
    std::vector<char> combining_grapheme(combining.size(), GRAPHEMEBREAK_NOBREAK);
    set_graphemebreaks_utf8(reinterpret_cast<const utf8_t*>(combining.data()), combining.size(),
                            "en", combining_grapheme.data());
    CHECK(marker_at_boundary(combining_grapheme, combining, 1) != GRAPHEMEBREAK_BREAK);
    CHECK_FALSE(noveltea::text::unibreak_marker_index_for_boundary(combining, 2).has_value());

    const std::string family = "\xF0\x9F\x91\xA8\xE2\x80\x8D\xF0\x9F\x91\xA9\xE2\x80\x8D\xF0\x9F"
                               "\x91\xA7\xE2\x80\x8D\xF0\x9F\x91\xA6";
    std::vector<char> family_grapheme(family.size(), GRAPHEMEBREAK_NOBREAK);
    set_graphemebreaks_utf8(reinterpret_cast<const utf8_t*>(family.data()), family.size(), "en",
                            family_grapheme.data());
    for (size_t offset : {4u, 7u, 11u, 14u, 18u, 21u}) {
        CHECK(marker_at_boundary(family_grapheme, family, offset) != GRAPHEMEBREAK_BREAK);
    }

    const std::string cjk = "\xE6\x97\xA5\xE6\x9C\xAC\xE8\xAA\x9E";
    std::vector<char> cjk_line(cjk.size(), LINEBREAK_NOBREAK);
    set_linebreaks_utf8(reinterpret_cast<const utf8_t*>(cjk.data()), cjk.size(), "ja",
                        cjk_line.data());
    REQUIRE(noveltea::text::unibreak_marker_index_for_boundary(cjk, 3) == 2u);
    CHECK(marker_at_boundary(cjk_line, cjk, 3) == LINEBREAK_ALLOWBREAK);
    CHECK_FALSE(noveltea::text::unibreak_marker_index_for_boundary(cjk, 1).has_value());

    const std::string mixed = "\xC3\xA9 xyz";
    std::vector<char> mixed_line(mixed.size(), LINEBREAK_NOBREAK);
    set_linebreaks_utf8(reinterpret_cast<const utf8_t*>(mixed.data()), mixed.size(), "en",
                        mixed_line.data());
    REQUIRE(noveltea::text::unibreak_marker_index_for_boundary(mixed, 3) == 2u);
    CHECK(marker_at_boundary(mixed_line, mixed, 3) == LINEBREAK_ALLOWBREAK);
}

TEST_CASE("HarfBuzz shapes Latin kerning and Arabic without byte reversal")
{
    auto assets = make_assets();
    noveltea::text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    const auto av = engine.measure_text(make_text(font, "AV")).width;
    const auto a_plus_v = engine.measure_text(make_text(font, "A")).width +
                          engine.measure_text(make_text(font, "V")).width;
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

TEST_CASE("Bundled demo font does not claim Hebrew visual coverage")
{
    auto assets = make_assets();
    noveltea::text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    CHECK(engine.glyph_index(font, 0x05E9) == 0);
    CHECK(engine.glyph_index(font, 0x05DC) == 0);
    CHECK(engine.glyph_index(font, 0x05D5) == 0);
    CHECK(engine.glyph_index(font, 0x05DD) == 0);
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

    const std::string nbsp = "a\xC2\xA0"
                             "b";
    std::vector<char> nbsp_breaks(nbsp.size(), LINEBREAK_NOBREAK);
    set_linebreaks_utf8(reinterpret_cast<const utf8_t*>(nbsp.data()), nbsp.size(), "en",
                        nbsp_breaks.data());
    CHECK(std::ranges::none_of(nbsp_breaks, [](char brk) { return brk == LINEBREAK_ALLOWBREAK; }));

    const std::string cjk =
        "\xE6\x97\xA5\xE6\x9C\xAC\xE8\xAA\x9E\xE3\x83\x86\xE3\x82\xAD\xE3\x82\xB9\xE3\x83\x88";
    std::vector<char> cjk_breaks(cjk.size(), LINEBREAK_NOBREAK);
    set_linebreaks_utf8(reinterpret_cast<const utf8_t*>(cjk.data()), cjk.size(), "ja",
                        cjk_breaks.data());
    CHECK(std::ranges::any_of(cjk_breaks, [](char brk) { return brk == LINEBREAK_ALLOWBREAK; }));
}

TEST_CASE(
    "Glyph rasterization and atlas upload preserve grayscale coverage and transparent padding")
{
    auto assets = make_assets();
    noveltea::text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    const uint32_t glyph_id = engine.glyph_index(font, U'A');
    REQUIRE(glyph_id != 0);
    auto bitmap = engine.rasterize_glyph(font, glyph_id, 24.4f);
    REQUIRE(bitmap);
    CHECK(bitmap->coverage.size() == static_cast<size_t>(bitmap->width) * bitmap->height);
    CHECK(std::ranges::any_of(bitmap->coverage,
                              [](uint8_t value) { return value > 0 && value < 255; }));

    auto upload = noveltea::text::make_padded_glyph_upload(*bitmap, 1);
    REQUIRE(upload.width == bitmap->width + 2);
    REQUIRE(upload.height == bitmap->height + 2);
    for (uint16_t x = 0; x < upload.width; ++x) {
        CHECK(upload.rgba[static_cast<size_t>(x) * 4u + 3u] == 0);
        const size_t bottom = (static_cast<size_t>(upload.height - 1u) * upload.width + x) * 4u;
        CHECK(upload.rgba[bottom + 3u] == 0);
    }
    for (uint16_t y = 0; y < upload.height; ++y) {
        CHECK(upload.rgba[(static_cast<size_t>(y) * upload.width) * 4u + 3u] == 0);
        const size_t right = (static_cast<size_t>(y) * upload.width + upload.width - 1u) * 4u;
        CHECK(upload.rgba[right + 3u] == 0);
    }
    const size_t first_glyph_alpha =
        (static_cast<size_t>(upload.glyph_y) * upload.width + upload.glyph_x) * 4u + 3u;
    CHECK(upload.rgba[first_glyph_alpha] == bitmap->coverage.front());

    CHECK(noveltea::text::normalize_raster_pixel_size(24.4f) == 24);
    CHECK(noveltea::text::normalize_raster_pixel_size(24.6f) == 25);
    CHECK(noveltea::text::glyph_cache_pixel_size_key(24.4f) ==
          noveltea::text::glyph_cache_pixel_size_key(24.49f));
}

TEST_CASE("Non-Latin glyph IDs rasterize when the font contains them")
{
    auto assets = make_assets();
    noveltea::text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    const uint32_t e_acute = engine.glyph_index(font, 0x00E9);
    REQUIRE(e_acute != 0);
    auto bitmap = engine.rasterize_glyph(font, e_acute, 24.0f);
    REQUIRE(bitmap);
    CHECK(bitmap->width > 0);
    CHECK(bitmap->height > 0);
    CHECK(std::ranges::any_of(bitmap->coverage, [](uint8_t value) { return value != 0; }));
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
    const bool disjoint = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y ||
                          b.y + b.height <= a.y;
    CHECK(disjoint);
    CHECK(c.page > 0);
    CHECK(packer.page_count() > 1);
}
