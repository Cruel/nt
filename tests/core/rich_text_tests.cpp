#include <noveltea/core/rich_text.hpp>

#include <catch2/catch_test_macros.hpp>

using namespace noveltea::core;

TEST_CASE("Rich text parser preserves old BBCode style semantics")
{
    auto doc = parse_rich_text("[b]bo[/b][i]ld[/i] [c=#bed]color[/c] [f=body][s=18]font[/s][/f]");

    REQUIRE(doc.plain_text == "bold color font");
    REQUIRE(doc.runs.size() == 6);
    CHECK((doc.runs[0].style.font_style & FontBold) != 0);
    CHECK((doc.runs[1].style.font_style & FontBold) == 0);
    CHECK((doc.runs[1].style.font_style & FontItalic) != 0);
    CHECK(doc.runs[3].style.color.r == 0xbb);
    CHECK(doc.runs[3].style.color.g == 0xee);
    CHECK(doc.runs[3].style.color.b == 0xdd);
    CHECK(doc.runs[5].style.font_alias == "body");
    CHECK(doc.runs[5].style.font_size == 18);
}

TEST_CASE("Rich text parser handles object shorthand page breaks offsets and animation")
{
    auto doc = parse_rich_text("[[key|object-id]] [x=4][y=-2]nudge[p=1.5][a1 e=p cs=0 t=1 wait=1]pop[/a1]");

    REQUIRE(doc.plain_text == "key nudgepop");
    REQUIRE(doc.page_breaks.size() == 1);
    CHECK(doc.page_breaks[0].delay_ms == 1500);
    CHECK(doc.runs[0].style.object_id == "object-id");
    CHECK(doc.runs[2].style.x_offset == 4);
    CHECK(doc.runs[2].style.y_offset == -2);
    CHECK(doc.runs.back().animation.type == TextEffect::Pop);
    CHECK(doc.runs.back().animation.duration_ms == 1000);
    CHECK_FALSE(doc.runs.back().animation.skippable);
    CHECK(doc.runs.back().animation.wait_for_click);
}

TEST_CASE("Rich text parser recovers from malformed and unmatched tags like the old parser")
{
    CHECK(strip_rich_text_tags("te[/i]st") == "test");
    CHECK(strip_rich_text_tags("te[!i]st[!/i]") == "te[i]st[/i]");
    CHECK(strip_rich_text_tags("[unknown]x") == "[unknown]x");
}

TEST_CASE("Room description diff marks changed plain text as diff runs")
{
    auto doc = diff_room_description("You see a door.", "You see an open door.");

    REQUIRE(doc.plain_text == "You see an open door.");
    bool found_diff = false;
    for (const auto& run : doc.runs) {
        if (run.style.diff && run.text == "n open") {
            found_diff = true;
        }
    }
    CHECK(found_diff);
}

TEST_CASE("Rich text pagination and timeline split semantic documents without render dependencies")
{
    auto doc = parse_rich_text("[b]abcd[/b][p=0.25]efgh");
    auto pages = paginate_rich_text(doc, 2);

    REQUIRE(pages.size() == 4);
    CHECK(pages[0].plain_text == "ab");
    CHECK((pages[0].runs[0].style.font_style & FontBold) != 0);
    CHECK(pages[2].plain_text == "ef");

    auto timeline = make_rich_text_timeline(doc, 4);
    REQUIRE(timeline.size() == 3);
    CHECK(timeline[0].type == RichTextTimelineItem::Type::Text);
    CHECK(timeline[1].type == RichTextTimelineItem::Type::PageBreak);
    CHECK(timeline[1].delay_ms == 250);
}
