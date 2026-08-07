#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "noveltea/jobs/inline_job_executor.hpp"
#include "noveltea/text/text_asset_loader.hpp"
#include "text/text_engine.hpp"
#include "ui/rmlui/active_text_presenter.hpp"

#include <cmath>
#include <limits>
#include <memory>
#include <variant>

namespace {

noveltea::core::TypedRuntimeUIViewState make_room_view(std::string description,
                                                       bool can_continue = false)
{
    const auto room = noveltea::core::RoomId::create("room");
    REQUIRE(room);
    noveltea::core::TypedRuntimeUIViewState view;
    view.mode = "room";
    view.room =
        noveltea::core::RoomView{.room = *room.value_if(),
                                 .description = std::move(description),
                                 .description_markup = noveltea::core::TextMarkup::ActiveText};
    view.can_continue = can_continue;
    return view;
}

noveltea::ui::rmlui::ActiveTextPresenterSurface surface(float text_scale = 1.0f,
                                                        float font_raster_scale = 1.0f)
{
    return {.bounds = {10.0f, 20.0f, 400.0f, 100.0f},
            .text_scale_factor = text_scale,
            .font_raster_scale = font_raster_scale};
}

noveltea::assets::ResidencyBudget font_test_budget()
{
    constexpr std::uint64_t budget = 16u * 1024u * 1024u;
    return {.source_bytes = budget,
            .prepared_cpu_bytes = budget,
            .gpu_bytes = budget,
            .audio_bytes = budget,
            .temporary_bytes = budget};
}

} // namespace

TEST_CASE("ActiveTextPresenter completion phase is independent of arbitrary RmlUi state")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::ActiveTextPresenter presenter(diagnostics);
    auto view = make_room_view("Presented text");

    presenter.advance(&view, 0.0f);
    CHECK(presenter.presentation_phase() == noveltea::core::ActiveTextPresentationPhase::Reveal);

    presenter.refresh_layout(&view, std::nullopt);
    CHECK(presenter.render_snapshot().glyphs.empty());
    CHECK(presenter.presentation_phase() == noveltea::core::ActiveTextPresentationPhase::Reveal);

    presenter.advance(&view, 2.0f);
    CHECK(presenter.presentation_phase() == noveltea::core::ActiveTextPresentationPhase::Stable);

    presenter.advance(nullptr, 0.01f);
    CHECK(presenter.presentation_phase() == noveltea::core::ActiveTextPresentationPhase::Fade);
}

TEST_CASE("ActiveTextPresenter returns typed activation without dispatching it")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::ActiveTextPresenter presenter(diagnostics);
    auto view = make_room_view("Continue", true);

    presenter.advance(&view, 2.0f);
    presenter.refresh_layout(&view, surface());
    const auto activation = presenter.activate(&view, 0.0f, 0.0f);

    CHECK(activation.consumed);
    CHECK_FALSE(activation.local_state_changed);
    REQUIRE(activation.input);
    CHECK(std::holds_alternative<noveltea::core::ContinueInput>(*activation.input));
}

TEST_CASE("ActiveTextPresenter owns local page playback but not desired gameplay state")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::ActiveTextPresenter presenter(diagnostics);
    auto view = make_room_view("First[p]Second");

    presenter.advance(&view, 2.0f);
    presenter.refresh_layout(&view, surface());
    CHECK(presenter.render_snapshot().visible_text == "First");

    const auto next_page = presenter.activate(&view, 0.0f, 0.0f);
    CHECK(next_page.consumed);
    CHECK(next_page.local_state_changed);
    CHECK_FALSE(next_page.input);

    presenter.advance(&view, 2.0f);
    presenter.refresh_layout(&view, surface());
    CHECK(presenter.render_snapshot().visible_text == "Second");

    auto replacement = make_room_view("Replacement first[p]Replacement second");
    presenter.advance(&replacement, 2.0f);
    presenter.refresh_layout(&replacement, surface());
    CHECK(presenter.render_snapshot().visible_text == "Replacement first");
}

TEST_CASE("ActiveTextPresenter scales its fixed base size inside the supplied logical box")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::ActiveTextPresenter presenter(diagnostics);
    auto view = make_room_view("Scaled ActiveText");
    presenter.advance(&view, 2.0f);

    presenter.refresh_layout(&view, surface(1.5f, 3.0f));
    const auto& layout = presenter.render_snapshot();
    REQUIRE_FALSE(layout.glyphs.empty());
    CHECK(layout.bounds.x == Catch::Approx(10.0f));
    CHECK(layout.bounds.y == Catch::Approx(20.0f));
    CHECK(layout.bounds.width == Catch::Approx(400.0f));
    CHECK(layout.bounds.height == Catch::Approx(100.0f));
    CHECK(layout.glyphs.front().font_size == 26u);
    CHECK(layout.glyphs.front().bounds.x >= layout.bounds.x);
    CHECK(layout.glyphs.front().bounds.y >= layout.bounds.y);
    CHECK(layout.glyphs.front().bounds.x + layout.glyphs.front().bounds.width <=
          layout.bounds.x + layout.bounds.width);
    CHECK(layout.glyphs.front().bounds.y + layout.glyphs.front().bounds.height <=
          layout.bounds.y + layout.bounds.height);
}

TEST_CASE("ActiveTextPresenter preserves fractional effect offsets in context logical space")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::ActiveTextPresenter presenter(diagnostics);
    auto view = make_room_view("[a1 e=s t=1][[Key|key-object]][/a1]");
    presenter.advance(&view, 2.0f);
    presenter.advance(&view, 0.25f);
    presenter.refresh_layout(&view, surface(1.25f));

    const auto& layout = presenter.render_snapshot();
    REQUIRE_FALSE(layout.glyphs.empty());
    REQUIRE_FALSE(layout.object_spans.empty());
    CHECK(layout.glyphs.front().offset.x != Catch::Approx(0.0f));
    CHECK(layout.glyphs.front().offset.y != Catch::Approx(0.0f));
    CHECK(layout.glyphs.front().offset.x !=
          Catch::Approx(std::round(layout.glyphs.front().offset.x)));
    CHECK(layout.glyphs.front().offset.y !=
          Catch::Approx(std::round(layout.glyphs.front().offset.y)));
    const auto& hit_rect = layout.object_spans.front().rects.front();
    const noveltea::Vec2 logical_hit{hit_rect.x + hit_rect.width * 0.5f,
                                     hit_rect.y + hit_rect.height * 0.5f};
    REQUIRE(layout.object_at(logical_hit));
    CHECK(*layout.object_at(logical_hit) == "key-object");
}

TEST_CASE("ActiveTextPresenter reacquires its font after project font generation changes")
{
    noveltea::jobs::InlineJobExecutor executor;
    auto residency = std::make_shared<noveltea::assets::AssetResidencyManager>(font_test_budget());
    noveltea::assets::AssetManager assets;
    assets.mount_directory("project", NOVELTEA_SOURCE_DIR "/engine/assets/system");
    assets.mount_directory("system", NOVELTEA_SOURCE_DIR "/engine/assets/system");
    REQUIRE(assets.configure_async_requests(executor, residency));

    noveltea::core::Diagnostics diagnostics;
    noveltea::text::TextEngine text_engine(assets);
    REQUIRE(text_engine.valid());
    noveltea::text::TextFontAssetLoader font_loader(assets, text_engine);
    assets.bind_font_loader(&font_loader);
    noveltea::ui::rmlui::ActiveTextPresenter presenter(diagnostics);
    presenter.initialize(assets,
                         [&text_engine](const noveltea::StyledText& text, float raster_scale) {
                             return text_engine.layout_text(text, raster_scale);
                         });
    noveltea::assets::FontAssetConfig font_config;
    font_config.default_alias = "body";
    font_config.families.push_back({.alias = "body",
                                    .regular = {.asset_path = "project:/fonts/LiberationSans.ttf"},
                                    .synthetic_styles = true});
    assets.configure_fonts(std::move(font_config));

    const std::string rich_text = "[font id=sys]System[/font] project default";
    const auto parsed = noveltea::core::parse_rich_text(rich_text);
    REQUIRE(parsed.runs.size() >= 2u);
    CHECK(parsed.runs.front().style.font_alias == "sys");
    CHECK(parsed.runs.back().style.font_alias.empty());
    auto view = make_room_view(rich_text);
    bool ready = false;
    for (std::size_t iteration = 0; iteration < 1024 && !ready; ++iteration) {
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        presenter.refresh_layout(&view, surface());
        ready = presenter.has_font_lease() && presenter.render_snapshot().used_shaped_layout;
        if (!ready)
            (void)executor.advance_one_step();
    }
    REQUIRE(ready);
    const auto& layout = presenter.render_snapshot();
    REQUIRE(layout.glyphs.size() > 6u);
    REQUIRE(layout.glyphs.front().has_shaped_glyph);
    REQUIRE(layout.glyphs.back().has_shaped_glyph);
    const auto renderer_system_font =
        text_engine.resolve_font("sys", noveltea::TextFontRegular).face;
    const auto renderer_body_font =
        text_engine.resolve_font("body", noveltea::TextFontRegular).face;
    REQUIRE(renderer_system_font);
    REQUIRE(renderer_body_font);
    CHECK(renderer_system_font != renderer_body_font);
    CHECK(layout.glyphs.front().shaped_glyph.font == renderer_system_font);
    CHECK(layout.glyphs.back().font_alias.empty());
    CHECK(layout.glyphs.back().shaped_glyph.font.id == renderer_body_font.id);

    // A source-generation change discards the old typed leases and reacquires the configured
    // default/inline families into the same authoritative shaping registry.
    assets.configure_fonts(assets.font_config());
    ready = false;
    for (std::size_t iteration = 0; iteration < 1024 && !ready; ++iteration) {
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        presenter.refresh_layout(&view, surface());
        ready = presenter.has_font_lease() && presenter.render_snapshot().used_shaped_layout;
        if (!ready)
            (void)executor.advance_one_step();
    }
    REQUIRE(ready);
    CHECK(text_engine.resolve_font("body", noveltea::TextFontRegular).face);

    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    REQUIRE(executor.shutdown_complete());
}
