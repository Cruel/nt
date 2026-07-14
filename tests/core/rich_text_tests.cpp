#include <noveltea/core/rich_text.hpp>
#include <noveltea/core/rich_text_codec.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

using namespace noveltea::core;

TEST_CASE("Rich text parser preserves old BBCode style semantics")
{
    auto doc =
        parse_rich_text("[b]bo[/b][i]ld[/i] [u]under[/u] [strike]hit[/strike] [c=#bed]color[/c] "
                        "[f=body][s=18]font[/s][/f]");

    REQUIRE(doc.plain_text == "bold under hit color font");
    REQUIRE(doc.runs.size() == 10);
    CHECK((doc.runs[0].style.font_style & FontBold) != 0);
    CHECK((doc.runs[1].style.font_style & FontBold) == 0);
    CHECK((doc.runs[1].style.font_style & FontItalic) != 0);
    CHECK((doc.runs[3].style.font_style & FontUnderlined) != 0);
    CHECK((doc.runs[5].style.font_style & FontStrikeThrough) != 0);
    CHECK(doc.runs[7].style.color.r == 0xbb);
    CHECK(doc.runs[7].style.color.g == 0xee);
    CHECK(doc.runs[7].style.color.b == 0xdd);
    CHECK(doc.runs[9].style.font_alias == "body");
    CHECK(doc.runs[9].style.font_size == 18);
}

TEST_CASE("Rich text parser handles object shorthand page breaks offsets and animation")
{
    auto doc = parse_rich_text(
        "[[key|object-id]] [x=4][y=-2]nudge[p=1.5][a1 e=p cs=0 t=1 wait=1]pop[/a1]");

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

TEST_CASE("Rich text parser accepts material and shader ids with slash namespaces")
{
    auto doc = parse_rich_text(
        "[mat id=demo/active_text_default]material[/mat] "
        "[shader v=demo/active_text_glow_shader f=demo/active_text_glow_shader]shader[/shader]");

    REQUIRE(doc.plain_text == "material shader");
    REQUIRE_FALSE(doc.runs.empty());
    bool found_material_run = false;
    bool found_shader_run = false;
    for (const auto& run : doc.runs) {
        if (run.text == "material") {
            CHECK(run.style.material_id == "demo/active_text_default");
            found_material_run = true;
        }
        if (run.text == "shader") {
            CHECK(run.style.vertex_shader_id == "demo/active_text_glow_shader");
            CHECK(run.style.fragment_shader_id == "demo/active_text_glow_shader");
            found_shader_run = true;
        }
    }
    CHECK(found_material_run);
    CHECK(found_shader_run);
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

TEST_CASE("Rich text JSON round-trips semantic document data")
{
    auto doc = parse_rich_text(
        "[[Key|key-object]] [b][i]bold[/i][/b] [c=#bed]color[/c][p=0.5][a1 e=s t=2]shake[/a1]");

    RichTextDocument copy;
    REQUIRE(decode_rich_text_document(encode_rich_text_document(doc), copy));

    CHECK(copy.source == doc.source);
    CHECK(copy.plain_text == doc.plain_text);
    REQUIRE(copy.runs.size() == doc.runs.size());
    CHECK(copy.runs[0].style.object_id == "key-object");
    CHECK((copy.runs[2].style.font_style & FontBold) != 0);
    CHECK((copy.runs[2].style.font_style & FontItalic) != 0);
    CHECK(copy.runs[4].style.color.r == 0xbb);
    bool found_shake = false;
    for (const auto& run : copy.runs) {
        if (run.animation.type == TextEffect::Shake && run.animation.duration_ms == 2000) {
            found_shake = true;
        }
    }
    CHECK(found_shake);
    REQUIRE(copy.page_breaks.size() == 1);
    CHECK(copy.page_breaks[0].delay_ms == 500);
}

TEST_CASE("Rich text codec keeps its named wire shape and rejects malformed collections")
{
    const auto encoded = encode_rich_text_document(parse_rich_text("[b]hello[/b]"));
    REQUIRE(encoded.is_object());
    CHECK(encoded.at("source") == "[b]hello[/b]");
    CHECK(encoded.at("plain_text") == "hello");
    REQUIRE(encoded.at("runs").is_array());
    REQUIRE(encoded.at("page_breaks").is_array());

    RichTextDocument output;
    CHECK_FALSE(decode_rich_text_document(nlohmann::json::array(), output));
    CHECK_FALSE(decode_rich_text_document(nlohmann::json{{"runs", "not-an-array"}}, output));
    CHECK_FALSE(decode_rich_text_document(
        nlohmann::json{{"runs", nlohmann::json::array({"not-an-object"})}}, output));
    CHECK_FALSE(decode_rich_text_document(nlohmann::json{{"page_breaks", "not-an-array"}}, output));
}
