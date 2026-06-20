#include <noveltea/active_text.hpp>

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

using namespace noveltea;
using namespace noveltea::core;

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
