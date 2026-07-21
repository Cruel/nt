#include <noveltea/active_text_layout.hpp>
#include <noveltea/assets/asset_manager.hpp>
#include <noveltea/text/text.hpp>

#include "text/text_engine.hpp"

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

using namespace noveltea;
using namespace noveltea::core;

namespace {

assets::AssetManager make_assets()
{
    assets::AssetManager assets;
    assets.mount_directory("project", NOVELTEA_SOURCE_DIR "/apps/sandbox/assets");
    return assets;
}

Text make_shaping_text(FontHandle font, std::string value, Rect bounds, float size = 20.0f)
{
    Text text;
    text.font = font;
    text.value = std::move(value);
    text.bounds = bounds;
    text.style.size = size;
    text.wrap = TextWrap::Word;
    text.language = "en";
    return text;
}

} // namespace

TEST_CASE("ActiveTextLayout reveals UTF-8 glyphs without splitting codepoints")
{
    const auto doc = parse_rich_text("caf\xC3\xA9");

    const auto layout = build_active_text_layout(
        doc, ActiveTextLayoutOptions{.bounds = {0.0f, 0.0f, 400.0f, 100.0f},
                                     .default_text_size = 20.0f,
                                     .reveal_progress = 0.75f});

    CHECK(layout.visible_glyph_count == 3);
    REQUIRE(layout.glyphs.size() == 3);
    CHECK(layout.glyphs[0].text == "c");
    CHECK(layout.glyphs[2].text == "f");
}

TEST_CASE("ActiveTextLayout can map rich text metadata onto shaped glyph positions")
{
    auto assets = make_assets();
    text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    const auto doc = parse_rich_text("Look [[Key|key-object]] now");
    const ActiveTextLayoutOptions options{.bounds = {10.0f, 20.0f, 400.0f, 100.0f},
                                          .default_text_size = 20.0f};
    const auto visible = active_text_visible_text(doc, options);
    const auto shaped = engine.layout_text(
        make_shaping_text(font, visible, options.bounds, options.default_text_size));
    const auto layout = build_active_text_layout(doc, options, shaped);

    CHECK(layout.used_shaped_layout);
    CHECK(layout.visible_text == visible);
    REQUIRE_FALSE(layout.glyphs.empty());
    REQUIRE_FALSE(shaped.lines.empty());
    REQUIRE_FALSE(shaped.lines.front().visual_runs.empty());
    REQUIRE_FALSE(shaped.lines.front().visual_runs.front().glyphs.empty());
    CHECK(layout.glyphs.front().has_shaped_glyph);
    CHECK(layout.glyphs.front().bounds.x ==
          Catch::Approx(shaped.lines.front().visual_runs.front().glyphs.front().position.x));
    REQUIRE_FALSE(layout.object_spans.empty());
    REQUIRE_FALSE(layout.object_spans[0].rects.empty());
    const auto rect = layout.object_spans[0].rects.front();
    CHECK(layout.object_at({rect.x + 1.0f, rect.y + 1.0f}) == "key-object");
}

TEST_CASE("ActiveTextLayout uses default color for uncolored rich text")
{
    const auto doc = parse_rich_text("default [c=#336699]colored[/c]");
    const auto layout = build_active_text_layout(
        doc, ActiveTextLayoutOptions{.bounds = {0.0f, 0.0f, 400.0f, 100.0f},
                                     .default_color = Color::from_rgba8(10, 20, 30)});

    REQUIRE_FALSE(layout.glyphs.empty());
    CHECK(layout.glyphs.front().color.r == Catch::Approx(10.0f / 255.0f));
    CHECK(layout.glyphs.front().color.g == Catch::Approx(20.0f / 255.0f));
    CHECK(layout.glyphs.front().color.b == Catch::Approx(30.0f / 255.0f));
    const auto colored = std::find_if(layout.glyphs.begin(), layout.glyphs.end(),
                                      [](const auto& glyph) { return glyph.text == "c"; });
    REQUIRE(colored != layout.glyphs.end());
    CHECK(colored->color.r == Catch::Approx(0x33 / 255.0f));
    CHECK(colored->color.g == Catch::Approx(0x66 / 255.0f));
    CHECK(colored->color.b == Catch::Approx(0x99 / 255.0f));
}

TEST_CASE("ActiveTextLayout resolves default rich text size to runtime default when shaping")
{
    auto assets = make_assets();
    text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    const auto doc = parse_rich_text("ActiveText");
    const ActiveTextLayoutOptions options{.bounds = {0.0f, 0.0f, 400.0f, 100.0f},
                                          .default_text_size = 17.0f};
    const auto layout = build_active_text_layout(
        doc, options, font, [&](const Text& text) { return engine.layout_text(text); });

    REQUIRE_FALSE(layout.glyphs.empty());
    CHECK(layout.used_shaped_layout);
    CHECK(layout.bounds.x == Catch::Approx(options.bounds.x));
    CHECK(layout.bounds.y == Catch::Approx(options.bounds.y));
    CHECK(layout.bounds.width == Catch::Approx(options.bounds.width));
    CHECK(layout.bounds.height == Catch::Approx(options.bounds.height));
    CHECK(layout.glyphs.front().font_size == 17u);
    CHECK(layout.glyphs.front().scale == Catch::Approx(1.0f));
    CHECK(layout.glyphs.front().shaped_glyph.logical_pixel_size == Catch::Approx(17.0f));
    CHECK(layout.glyphs.front().shaped_glyph.raster_pixel_size == Catch::Approx(17.0f));
    CHECK(layout.glyphs[1].bounds.x > layout.glyphs[0].bounds.x);
    CHECK(layout.glyphs[1].bounds.x - layout.glyphs[0].bounds.x < 20.0f);
}

TEST_CASE("ActiveTextLayout shapes explicit size tags with matching advances")
{
    auto assets = make_assets();
    text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    const auto doc = parse_rich_text("a [s=40]large[/s] z");
    const ActiveTextLayoutOptions options{.bounds = {0.0f, 0.0f, 600.0f, 120.0f},
                                          .default_text_size = 17.0f};
    const auto layout = build_active_text_layout(
        doc, options, font, [&](const Text& text) { return engine.layout_text(text); });

    REQUIRE(layout.glyphs.size() >= 8);
    const auto large = std::find_if(layout.glyphs.begin(), layout.glyphs.end(),
                                    [](const auto& glyph) { return glyph.text == "l"; });
    REQUIRE(large != layout.glyphs.end());
    CHECK(large->font_size == 40u);
    CHECK(large->has_shaped_glyph);
    CHECK(large->shaped_glyph.logical_pixel_size == Catch::Approx(40.0f));
    CHECK(std::next(large)->bounds.x > large->bounds.x);
    CHECK(std::next(large)->bounds.x - large->bounds.x > 4.0f);
}

TEST_CASE("ActiveTextLayout wraps at words and trims leading whitespace")
{
    auto assets = make_assets();
    text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    const auto doc = parse_rich_text("one two three four");
    const ActiveTextLayoutOptions options{.bounds = {0.0f, 0.0f, 78.0f, 20.0f},
                                          .default_text_size = 17.0f};
    const auto layout = build_active_text_layout(
        doc, options, font, [&](const Text& text) { return engine.layout_text(text); });

    REQUIRE(layout.metrics.line_count >= 2);
    CHECK(layout.bounds.height >= layout.metrics.height);
    bool found_line_start = false;
    for (std::size_t i = 1; i < layout.glyphs.size(); ++i) {
        if (layout.glyphs[i].bounds.y > layout.glyphs[i - 1].bounds.y) {
            found_line_start = true;
            CHECK(layout.glyphs[i].text != " ");
            CHECK(layout.glyphs[i].bounds.x == Catch::Approx(options.bounds.x));
        }
    }
    CHECK(found_line_start);
}

TEST_CASE("ActiveTextLayout wraps CJK text using libunibreak without spaces")
{
    auto assets = make_assets();
    text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    const auto doc = parse_rich_text(
        "\xE6\x97\xA5\xE6\x9C\xAC\xE8\xAA\x9E\xE3\x83\x86\xE3\x82\xAD\xE3\x82\xB9\xE3\x83\x88");
    const ActiveTextLayoutOptions options{
        .bounds = {0.0f, 0.0f, 38.0f, 180.0f}, .default_text_size = 17.0f, .language = "ja"};
    const auto layout = build_active_text_layout(
        doc, options, font, [&](const Text& text) { return engine.layout_text(text); });

    REQUIRE(layout.metrics.line_count >= 2);
    bool found_line_start = false;
    for (std::size_t i = 1; i < layout.glyphs.size(); ++i) {
        if (layout.glyphs[i].bounds.y > layout.glyphs[i - 1].bounds.y) {
            found_line_start = true;
            CHECK(layout.glyphs[i].bounds.x == Catch::Approx(options.bounds.x));
        }
    }
    CHECK(found_line_start);
}

TEST_CASE("ActiveTextLayout precomputes final wrapping before reveal")
{
    auto assets = make_assets();
    text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    const auto doc = parse_rich_text("one two three four");
    const ActiveTextLayoutOptions full_options{
        .bounds = {0.0f, 0.0f, 78.0f, 160.0f}, .default_text_size = 17.0f, .reveal_progress = 1.0f};
    const ActiveTextLayoutOptions partial_options{
        .bounds = full_options.bounds, .default_text_size = 17.0f, .reveal_progress = 0.55f};
    const auto full = build_active_text_layout(
        doc, full_options, font, [&](const Text& text) { return engine.layout_text(text); });
    const auto partial = build_active_text_layout(
        doc, partial_options, font, [&](const Text& text) { return engine.layout_text(text); });

    REQUIRE(partial.glyphs.size() > 4);
    for (const auto& glyph : partial.glyphs) {
        const auto matching =
            std::find_if(full.glyphs.begin(), full.glyphs.end(), [&](const auto& full_glyph) {
                return full_glyph.glyph_index == glyph.glyph_index;
            });
        REQUIRE(matching != full.glyphs.end());
        CHECK(glyph.bounds.x == Catch::Approx(matching->bounds.x));
        CHECK(glyph.bounds.y == Catch::Approx(matching->bounds.y));
    }
}

TEST_CASE("ActiveTextLayout styled sizes affect final wrapping before reveal")
{
    auto assets = make_assets();
    text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    const auto doc = parse_rich_text("aa [s=48]wide[/s] tail");
    const ActiveTextLayoutOptions full_options{
        .bounds = {0.0f, 0.0f, 95.0f, 220.0f}, .default_text_size = 17.0f, .reveal_progress = 1.0f};
    const ActiveTextLayoutOptions partial_options{
        .bounds = full_options.bounds, .default_text_size = 17.0f, .reveal_progress = 0.6f};
    const auto shape_text = [&](const Text& text) { return engine.layout_text(text); };
    const auto full = build_active_text_layout(doc, full_options, font, shape_text);
    const auto partial = build_active_text_layout(doc, partial_options, font, shape_text);

    REQUIRE(full.metrics.line_count >= 2);
    REQUIRE_FALSE(partial.glyphs.empty());
    for (const auto& glyph : partial.glyphs) {
        const auto matching =
            std::find_if(full.glyphs.begin(), full.glyphs.end(), [&](const auto& full_glyph) {
                return full_glyph.glyph_index == glyph.glyph_index;
            });
        REQUIRE(matching != full.glyphs.end());
        CHECK(glyph.bounds.x == Catch::Approx(matching->bounds.x));
        CHECK(glyph.bounds.y == Catch::Approx(matching->bounds.y));
    }
}

TEST_CASE("ActiveTextLayout object hit rectangles survive styled span boundaries")
{
    auto assets = make_assets();
    text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    const auto doc = parse_rich_text("Look [[B[s=42]ig[/s]|big-object]] now");
    const ActiveTextLayoutOptions options{.bounds = {10.0f, 20.0f, 120.0f, 180.0f},
                                          .default_text_size = 18.0f};
    const auto layout = build_active_text_layout(
        doc, options, font, [&](const Text& text) { return engine.layout_text(text); });

    REQUIRE(layout.used_shaped_layout);
    REQUIRE_FALSE(layout.object_spans.empty());
    CHECK(layout.object_spans.front().rects.size() >= 1);
    bool found_hit = false;
    for (const auto& rect : layout.object_spans.front().rects) {
        if (layout.object_at({rect.x + 1.0f, rect.y + 1.0f}) == "big-object") {
            found_hit = true;
        }
    }
    CHECK(found_hit);
}

TEST_CASE("ActiveTextLayout preserves run style object material and shader metadata")
{
    const auto doc =
        parse_rich_text("[mat id=ui_glow][sh f=frag v=vert][[Key|key-object]][/sh][/mat]");

    const auto layout = build_active_text_layout(
        doc, ActiveTextLayoutOptions{.bounds = {10.0f, 20.0f, 400.0f, 100.0f}});

    REQUIRE(layout.glyphs.size() == 3);
    const auto& glyph = layout.glyphs.front();
    CHECK(glyph.run_index == 0);
    CHECK(glyph.glyph_index == 0);
    CHECK(glyph.object_id == "key-object");
    CHECK(glyph.material_id == "ui_glow");
    CHECK(glyph.vertex_shader_id == "vert");
    CHECK(glyph.fragment_shader_id == "frag");
}

TEST_CASE("ActiveTextLayout preserves font alias size and style metadata")
{
    const auto doc = parse_rich_text(
        "[font id=body][s=30][b][i][u][strike]Styled[/strike][/u][/i][/b][/s][/font]");

    const auto layout = build_active_text_layout(
        doc, ActiveTextLayoutOptions{.bounds = {0.0f, 0.0f, 400.0f, 100.0f}});

    REQUIRE_FALSE(layout.glyphs.empty());
    const auto& glyph = layout.glyphs.front();
    CHECK(glyph.font_alias == "body");
    CHECK(glyph.font_size == 30u);
    CHECK((glyph.font_style & FontBold) != 0);
    CHECK((glyph.font_style & FontItalic) != 0);
    CHECK((glyph.font_style & FontUnderlined) != 0);
    CHECK((glyph.font_style & FontStrikeThrough) != 0);
}

TEST_CASE("ActiveTextLayout carries rich text synthetic style bits into shaped glyphs")
{
    auto assets = make_assets();
    noveltea::text::TextEngine engine(assets);
    const FontHandle font = engine.load_font(FontDesc{"project:/rmlui/LiberationSans.ttf"});
    REQUIRE(font);

    const auto doc = parse_rich_text("[b][i]Styled[/i][/b]");
    const ActiveTextLayoutOptions options{.bounds = {0.0f, 0.0f, 400.0f, 100.0f},
                                          .default_text_size = 24.0f};
    const auto layout = build_active_text_layout(
        doc, options, font, [&](const Text& text) { return engine.layout_text(text); });

    REQUIRE_FALSE(layout.glyphs.empty());
    REQUIRE(layout.glyphs.front().has_shaped_glyph);
    CHECK((layout.glyphs.front().shaped_glyph.synthetic_font_style & TextFontBold) != 0);
    CHECK((layout.glyphs.front().shaped_glyph.synthetic_font_style & TextFontItalic) != 0);
}

TEST_CASE("ActiveTextLayout maps colors alpha and deterministic effects")
{
    const auto doc = parse_rich_text("[c=#336699][a1 e=s t=1]ab[/a1][/c]");

    const auto a = build_active_text_layout(
        doc, ActiveTextLayoutOptions{.bounds = {0.0f, 0.0f, 400.0f, 100.0f}, .time_seconds = 0.25});
    const auto b = build_active_text_layout(
        doc, ActiveTextLayoutOptions{.bounds = {0.0f, 0.0f, 400.0f, 100.0f}, .time_seconds = 0.25});
    const auto c = build_active_text_layout(
        doc, ActiveTextLayoutOptions{.bounds = {0.0f, 0.0f, 400.0f, 100.0f}, .time_seconds = 0.5});

    REQUIRE(a.glyphs.size() == 2);
    CHECK(a.glyphs[0].color.r == Catch::Approx(0x33 / 255.0f));
    CHECK(a.glyphs[0].color.g == Catch::Approx(0x66 / 255.0f));
    CHECK(a.glyphs[0].color.b == Catch::Approx(0x99 / 255.0f));
    CHECK(a.glyphs[0].alpha == Catch::Approx(1.0f));
    CHECK(a.glyphs[1].offset.x == Catch::Approx(b.glyphs[1].offset.x));
    CHECK(a.glyphs[1].offset.y == Catch::Approx(b.glyphs[1].offset.y));
    CHECK(a.glyphs[1].offset.x != Catch::Approx(c.glyphs[1].offset.x));
}

TEST_CASE("ActiveTextLayout carries effect metadata without changing layout advances")
{
    const auto plain_doc = parse_rich_text("ab");
    const auto effect_doc = parse_rich_text("[a1 e=p f=linear t=1 v=0.5]a[/a1][a1 e=g s=1]b[/a1]");
    const ActiveTextLayoutOptions options{
        .bounds = {0.0f, 0.0f, 400.0f, 100.0f}, .default_text_size = 20.0f, .time_seconds = 0.0};

    const auto plain = build_active_text_layout(plain_doc, options);
    const auto effect = build_active_text_layout(effect_doc, options);

    REQUIRE(plain.glyphs.size() == 2);
    REQUIRE(effect.glyphs.size() == 2);
    CHECK(effect.glyphs[0].scale == Catch::Approx(1.5f));
    CHECK(effect.glyphs[1].glow == Catch::Approx(0.5f));
    CHECK(effect.glyphs[0].bounds.width == Catch::Approx(plain.glyphs[0].bounds.width));
    CHECK(effect.glyphs[1].bounds.x == Catch::Approx(plain.glyphs[1].bounds.x));
}

TEST_CASE("ActiveTextLayout splits local page breaks into selectable pages")
{
    const auto doc = parse_rich_text("First[p]Second[a1 w=1] wait[/a1]Third");

    CHECK(active_text_page_count(doc) == 3);

    const auto first = build_active_text_layout(
        doc, ActiveTextLayoutOptions{.bounds = {0.0f, 0.0f, 400.0f, 100.0f}, .page_index = 0});
    const auto second = build_active_text_layout(
        doc, ActiveTextLayoutOptions{.bounds = {0.0f, 0.0f, 400.0f, 100.0f}, .page_index = 1});
    const auto third = build_active_text_layout(
        doc, ActiveTextLayoutOptions{.bounds = {0.0f, 0.0f, 400.0f, 100.0f}, .page_index = 2});

    CHECK(first.visible_text == "First");
    CHECK(first.page_break);
    CHECK(first.awaiting_continue);
    CHECK(second.visible_text == "Second wait");
    CHECK(second.page_break);
    CHECK(second.awaiting_continue);
    CHECK(third.visible_text == "Third");
    CHECK_FALSE(third.page_break);
    CHECK_FALSE(third.awaiting_continue);
}

TEST_CASE("ActiveTextLayout applies playback alpha to glyph visuals")
{
    const auto doc = parse_rich_text("[a1 e=f f=linear t=1]a[/a1]");

    const auto layout = build_active_text_layout(
        doc, ActiveTextLayoutOptions{.bounds = {0.0f, 0.0f, 400.0f, 100.0f},
                                     .reveal_progress = 1.0f,
                                     .alpha = 0.5f,
                                     .time_seconds = 0.5});

    REQUIRE(layout.glyphs.size() == 1);
    CHECK(layout.alpha == Catch::Approx(0.5f));
    CHECK(layout.glyphs.front().alpha == Catch::Approx(0.25f));
}

TEST_CASE("ActiveTextLayout hit tests object spans")
{
    const auto doc = parse_rich_text("Look [[Key|key-object]] now");

    const auto layout = build_active_text_layout(
        doc, ActiveTextLayoutOptions{.bounds = {10.0f, 20.0f, 400.0f, 100.0f},
                                     .default_text_size = 20.0f});

    REQUIRE_FALSE(layout.object_spans.empty());
    REQUIRE_FALSE(layout.object_spans[0].rects.empty());
    const auto rect = layout.object_spans[0].rects[0];
    CHECK(layout.object_at({rect.x + 1.0f, rect.y + 1.0f}) == "key-object");
    CHECK_FALSE(layout.object_at({0.0f, 0.0f}).has_value());
}

TEST_CASE("ActiveTextLayout preserves page break and awaiting continue state")
{
    const auto doc = parse_rich_text("[p=25]next");

    const auto layout = build_active_text_layout(
        doc, ActiveTextLayoutOptions{.bounds = {0.0f, 0.0f, 400.0f, 100.0f}});

    CHECK(layout.page_break);
    CHECK(layout.awaiting_continue);
}
