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
