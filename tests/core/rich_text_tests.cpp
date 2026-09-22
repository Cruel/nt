#include <noveltea/core/rich_text.hpp>
#include <noveltea/core/rich_text_codec.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string_view>

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

TEST_CASE("Rich text single-argument long-form tags close by canonical tag name")
{
    const auto doc = parse_rich_text("[font id=body]body[/font] default");

    REQUIRE(doc.runs.size() == 2u);
    CHECK(doc.runs[0].text == "body");
    CHECK(doc.runs[0].style.font_alias == "body");
    CHECK(doc.runs[1].text == " default");
    CHECK(doc.runs[1].style.font_alias.empty());
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

TEST_CASE("Rich text parser accepts material ids with slash namespaces and rejects shader markup")
{
    const auto material = parse_rich_text("[mat id=demo/active_text_default]material[/mat]");

    REQUIRE(material.plain_text == "material");
    bool found_material_run = false;
    for (const auto& run : material.runs) {
        if (run.text == "material") {
            CHECK(run.style.material_id == "demo/active_text_default");
            found_material_run = true;
        }
    }
    CHECK(found_material_run);

    const auto shader = parse_rich_text(
        "[shader v=demo/active_text_glow_shader f=demo/active_text_glow_shader]shader[/shader]");
    CHECK_FALSE(shader.diagnostics.empty());
}

TEST_CASE("Rich text material markup requires an explicit id and rejects duplicate attributes")
{
    const auto missing_id = parse_rich_text("[mat u_gain=1]text[/mat]");
    REQUIRE_FALSE(missing_id.diagnostics.empty());
    CHECK(missing_id.diagnostics.front().code == "rich_text.invalid_material_tag");
    CHECK(missing_id.diagnostics.front().severity == ErrorSeverity::Error);

    const auto duplicate = parse_rich_text("[mat id=demo/text u_gain=1 u_gain=2]text[/mat]");
    REQUIRE_FALSE(duplicate.diagnostics.empty());
    CHECK(duplicate.diagnostics.front().code == "rich_text.invalid_material_tag");
    CHECK(duplicate.diagnostics.front().message.find("duplicate") != std::string::npos);
}

TEST_CASE("Nested rich text Materials completely shadow outer occurrence attributes")
{
    const auto doc = parse_rich_text(
        "[mat id=outer u_outer=1]before [mat id=inner u_inner=2]inner[/mat] after[/mat]");
    REQUIRE(doc.diagnostics.empty());
    const auto nonempty = [&](std::string_view text) -> const RichTextRun* {
        const auto found = std::find_if(doc.runs.begin(), doc.runs.end(),
                                        [&](const auto& run) { return run.text == text; });
        return found == doc.runs.end() ? nullptr : &*found;
    };
    const auto* before = nonempty("before ");
    const auto* inner = nonempty("inner");
    const auto* after = nonempty(" after");
    REQUIRE(before != nullptr);
    REQUIRE(inner != nullptr);
    REQUIRE(after != nullptr);
    CHECK(before->style.material_id == "outer");
    REQUIRE(before->style.material_attributes.size() == 1u);
    CHECK(before->style.material_attributes[0].name == "u_outer");
    CHECK(inner->style.material_id == "inner");
    REQUIRE(inner->style.material_attributes.size() == 1u);
    CHECK(inner->style.material_attributes[0].name == "u_inner");
    CHECK(after->style.material_id == "outer");
    REQUIRE(after->style.material_attributes.size() == 1u);
    CHECK(after->style.material_attributes[0].name == "u_outer");
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
    REQUIRE_FALSE(doc.runs.empty());
    doc.runs[0].style.material_id = "text/effect";
    doc.runs[0].style.material_attributes = {{"u_gain", "1.5"}};
    doc.runs[0].style.material_overrides = {
        {"u_enabled", RichTextMaterialValue{true}},
        {"u_gain", RichTextMaterialValue{1.5f}},
        {"u_tint", RichTextMaterialValue{RichTextMaterialColor{1.0f, 0.5f, 0.0f, 1.0f}}},
    };

    RichTextDocument copy;
    REQUIRE(decode_rich_text_document(encode_rich_text_document(doc), copy));

    CHECK(copy.source == doc.source);
    CHECK(copy.plain_text == doc.plain_text);
    REQUIRE(copy.runs.size() == doc.runs.size());
    CHECK(copy.runs[0].style.object_id == "key-object");
    CHECK(copy.runs[0].style.material_id == "text/effect");
    CHECK(copy.runs[0].style.material_attributes == doc.runs[0].style.material_attributes);
    CHECK(copy.runs[0].style.material_overrides == doc.runs[0].style.material_overrides);
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
