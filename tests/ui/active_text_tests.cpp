#include <noveltea/active_text.hpp>

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>

using namespace noveltea;
using namespace noveltea::core;

namespace {

const ActiveTextGlyph& first_glyph(const ActiveTextFrame& frame)
{
    REQUIRE(frame.runs.size() == 1);
    REQUIRE(frame.runs[0].glyphs.size() >= 1);
    return frame.runs[0].glyphs[0];
}

} // namespace

TEST_CASE("ActiveTextFrame reveals UTF-8 glyphs without corrupting codepoint boundaries")
{
    const auto doc = parse_rich_text("[b]caf\xC3\xA9[/b]");

    const auto frame = build_active_text_frame(doc, ActiveTextOptions{.reveal_progress = 0.75f});

    CHECK(frame.total_glyphs == 4);
    CHECK(frame.visible_glyphs == 3);
    REQUIRE(frame.runs.size() == 1);
    REQUIRE(frame.runs[0].glyphs.size() == 3);
    CHECK(frame.runs[0].glyphs[0].text == "c");
    CHECK(frame.runs[0].glyphs[2].text == "f");
    CHECK((frame.runs[0].glyphs[0].style.font_style & FontBold) != 0);
}

TEST_CASE("ActiveTextFrame reveals grapheme clusters without splitting combining marks")
{
    const auto doc = parse_rich_text("e\xCC\x81x");

    const auto frame = build_active_text_frame(doc, ActiveTextOptions{.reveal_progress = 0.5f});

    CHECK(frame.total_glyphs == 2);
    CHECK(frame.visible_glyphs == 1);
    REQUIRE(frame.runs.size() == 1);
    REQUIRE(frame.runs[0].glyphs.size() == 1);
    CHECK(frame.runs[0].glyphs[0].text == "e\xCC\x81");
}

TEST_CASE("ActiveTextFrame preserves object shader and offset metadata")
{
    const auto doc =
        parse_rich_text("[sh f=frag v=vert][x=4][y=-2][[Key|key-object]][/y][/x][/sh]");

    const auto frame = build_active_text_frame(doc);

    REQUIRE(frame.runs.size() == 1);
    REQUIRE(frame.runs[0].glyphs.size() == 3);
    const auto& glyph = frame.runs[0].glyphs[0];
    CHECK(glyph.style.object_id == "key-object");
    CHECK(glyph.style.fragment_shader_id == "frag");
    CHECK(glyph.style.vertex_shader_id == "vert");
    CHECK(glyph.offset.x == Catch::Approx(4.0f));
    CHECK(glyph.offset.y == Catch::Approx(-2.0f));
}

TEST_CASE("ActiveTextFrame preserves material metadata from [mat] tag")
{
    const auto doc = parse_rich_text("[mat id=my_material][[Key|key-object]][/mat]");

    const auto frame = build_active_text_frame(doc);

    REQUIRE(frame.runs.size() == 1);
    REQUIRE(frame.runs[0].glyphs.size() == 3);
    const auto& glyph = frame.runs[0].glyphs[0];
    CHECK(glyph.style.object_id == "key-object");
    CHECK(glyph.style.material_id == "my_material");
}

TEST_CASE("ActiveTextFrame computes deterministic effect state")
{
    const auto shake_doc = parse_rich_text("[a1 e=s t=1]abc[/a1]");
    const auto shake_a =
        build_active_text_frame(shake_doc, ActiveTextOptions{.time_seconds = 0.25});
    const auto shake_b =
        build_active_text_frame(shake_doc, ActiveTextOptions{.time_seconds = 0.25});
    const auto shake_c =
        build_active_text_frame(shake_doc, ActiveTextOptions{.time_seconds = 0.50});

    REQUIRE(shake_a.runs.size() == 1);
    REQUIRE(shake_a.runs[0].glyphs.size() == 3);
    CHECK(shake_a.runs[0].glyphs[1].offset.x == Catch::Approx(shake_b.runs[0].glyphs[1].offset.x));
    CHECK(shake_a.runs[0].glyphs[1].offset.y == Catch::Approx(shake_b.runs[0].glyphs[1].offset.y));
    CHECK(shake_a.runs[0].glyphs[1].offset.x != Catch::Approx(shake_c.runs[0].glyphs[1].offset.x));

    const auto fade_doc = parse_rich_text("[a1 e=f t=1]a[/a1]");
    const auto fade = build_active_text_frame(fade_doc, ActiveTextOptions{.time_seconds = 0.5});
    REQUIRE(fade.runs.size() == 1);
    REQUIRE(fade.runs[0].glyphs.size() == 1);
    CHECK(fade.runs[0].glyphs[0].alpha == Catch::Approx(0.5f));

    const auto pop_doc = parse_rich_text("[a1 e=p t=1]a[/a1]");
    const auto pop = build_active_text_frame(pop_doc, ActiveTextOptions{.time_seconds = 0.0});
    REQUIRE(pop.runs.size() == 1);
    REQUIRE(pop.runs[0].glyphs.size() == 1);
    CHECK(pop.runs[0].glyphs[0].scale > 1.0f);
}

TEST_CASE("ActiveTextFrame applies easing aliases and animation delays")
{
    const auto linear_doc = parse_rich_text("[a1 e=f f=linear t=1 d=0.25]a[/a1]");

    CHECK(first_glyph(build_active_text_frame(linear_doc, ActiveTextOptions{.time_seconds = 0.20}))
              .alpha == Catch::Approx(0.0f));
    CHECK(first_glyph(build_active_text_frame(linear_doc, ActiveTextOptions{.time_seconds = 0.75}))
              .alpha == Catch::Approx(0.5f));

    const auto ease_in_doc = parse_rich_text("[a1 e=f f=ease-in t=1]a[/a1]");
    const auto ease_out_doc = parse_rich_text("[a1 e=f f=ease-out t=1]a[/a1]");
    const auto ease_in_out_doc = parse_rich_text("[a1 e=f f=ease-in-out t=1]a[/a1]");

    CHECK(first_glyph(build_active_text_frame(ease_in_doc, ActiveTextOptions{.time_seconds = 0.5}))
              .alpha == Catch::Approx(0.25f));
    CHECK(first_glyph(build_active_text_frame(ease_out_doc, ActiveTextOptions{.time_seconds = 0.5}))
              .alpha == Catch::Approx(0.75f));
    CHECK(first_glyph(
              build_active_text_frame(ease_in_out_doc, ActiveTextOptions{.time_seconds = 0.5}))
              .alpha == Catch::Approx(0.5f));
}

TEST_CASE("ActiveTextFrame applies loop delay, finite loops, and yoyo")
{
    const auto loop_doc = parse_rich_text("[a1 e=f f=linear t=1 l=2,0.5,1]a[/a1]");

    CHECK(first_glyph(build_active_text_frame(loop_doc, ActiveTextOptions{.time_seconds = 0.50}))
              .alpha == Catch::Approx(0.5f));
    CHECK(first_glyph(build_active_text_frame(loop_doc, ActiveTextOptions{.time_seconds = 1.25}))
              .alpha == Catch::Approx(1.0f));
    CHECK(first_glyph(build_active_text_frame(loop_doc, ActiveTextOptions{.time_seconds = 1.75}))
              .alpha == Catch::Approx(0.75f));
    CHECK(first_glyph(build_active_text_frame(loop_doc, ActiveTextOptions{.time_seconds = 3.10}))
              .alpha == Catch::Approx(0.0f));

    const auto no_yoyo_doc = parse_rich_text("[a1 e=f f=linear t=1 l=1,0,0]a[/a1]");
    CHECK(first_glyph(build_active_text_frame(no_yoyo_doc, ActiveTextOptions{.time_seconds = 2.0}))
              .alpha == Catch::Approx(1.0f));
}

TEST_CASE("ActiveTextFrame staggers FadeAcross by run-local glyph index")
{
    const auto doc = parse_rich_text("prefix [a1 e=fa f=linear t=1 v=100]abc[/a1]");

    const auto frame = build_active_text_frame(doc, ActiveTextOptions{.time_seconds = 0.15});

    REQUIRE(frame.runs.size() == 2);
    REQUIRE(frame.runs[1].glyphs.size() == 3);
    CHECK(frame.runs[1].glyphs[0].run_glyph_index == 0);
    CHECK(frame.runs[1].glyphs[1].run_glyph_index == 1);
    CHECK(frame.runs[1].glyphs[0].alpha == Catch::Approx(0.15f).margin(0.002f));
    CHECK(frame.runs[1].glyphs[1].alpha == Catch::Approx(0.05f).margin(0.002f));
    CHECK(frame.runs[1].glyphs[2].alpha == Catch::Approx(0.0f));
}

TEST_CASE("ActiveTextFrame delays wave-style effects until their local start time")
{
    const auto nod_doc = parse_rich_text("[a1 e=n d=0.5 v=3 s=1]a[/a1]");
    CHECK(first_glyph(build_active_text_frame(nod_doc, ActiveTextOptions{.time_seconds = 0.25}))
              .offset.y == Catch::Approx(0.0f));
    CHECK(first_glyph(build_active_text_frame(nod_doc, ActiveTextOptions{.time_seconds = 0.75}))
              .offset.y == Catch::Approx(3.0f));

    const auto glow_doc = parse_rich_text("[a1 e=g d=0.5 s=1]a[/a1]");
    CHECK(first_glyph(build_active_text_frame(glow_doc, ActiveTextOptions{.time_seconds = 0.25}))
              .glow == Catch::Approx(0.0f));
    CHECK(first_glyph(build_active_text_frame(glow_doc, ActiveTextOptions{.time_seconds = 0.75}))
              .glow == Catch::Approx(1.0f));
}

TEST_CASE("ActiveTextFrame projects each V1 effect into renderer-facing fields")
{
    RichTextParseOptions alpha_options;
    alpha_options.default_style.color.a = 128;
    const auto fade_doc = parse_rich_text("[a1 e=f f=linear t=1]a[/a1]", alpha_options);
    CHECK(first_glyph(build_active_text_frame(fade_doc, ActiveTextOptions{.time_seconds = 0.5}))
              .alpha == Catch::Approx((128.0f / 255.0f) * 0.5f));

    const auto pop_doc = parse_rich_text("[a1 e=p f=linear t=1 v=0.5]a[/a1]");
    CHECK(first_glyph(build_active_text_frame(pop_doc, ActiveTextOptions{.time_seconds = 0.0}))
              .scale == Catch::Approx(1.5f));
    CHECK(first_glyph(build_active_text_frame(pop_doc, ActiveTextOptions{.time_seconds = 1.0}))
              .scale == Catch::Approx(1.0f));

    const auto nod_doc = parse_rich_text("[a1 e=n v=3 s=1]a[/a1]");
    CHECK(first_glyph(build_active_text_frame(nod_doc, ActiveTextOptions{.time_seconds = 0.25}))
              .offset.y == Catch::Approx(3.0f));

    const auto shake_doc = parse_rich_text("[a1 e=s v=4]a[/a1]");
    const auto shake =
        first_glyph(build_active_text_frame(shake_doc, ActiveTextOptions{.time_seconds = 0.25}));
    CHECK(std::abs(shake.offset.x) <= 4.0f);
    CHECK(std::abs(shake.offset.y) <= 4.0f);
    CHECK((std::abs(shake.offset.x) > 0.01f || std::abs(shake.offset.y) > 0.01f));

    const auto tremble_doc = parse_rich_text("[a1 e=t v=0.5]a[/a1]");
    const auto tremble =
        first_glyph(build_active_text_frame(tremble_doc, ActiveTextOptions{.time_seconds = 0.25}));
    CHECK(std::abs(tremble.offset.x) <= 0.5f);
    CHECK(std::abs(tremble.offset.y) <= 0.5f);

    const auto glow_doc = parse_rich_text("[a1 e=g s=1]a[/a1]");
    CHECK(first_glyph(build_active_text_frame(glow_doc, ActiveTextOptions{.time_seconds = 0.25}))
              .glow == Catch::Approx(1.0f));

    const auto test_doc = parse_rich_text("[a1 e=test f=linear t=1]a[/a1]");
    const auto test =
        first_glyph(build_active_text_frame(test_doc, ActiveTextOptions{.time_seconds = 0.5}));
    CHECK(test.glow == Catch::Approx(0.675f));
    CHECK(test.offset.y == Catch::Approx(0.0f).margin(0.0001f));
}
