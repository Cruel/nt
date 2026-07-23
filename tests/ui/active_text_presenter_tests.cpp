#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "noveltea/jobs/inline_job_executor.hpp"
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
    assets.mount_directory("project", NOVELTEA_SOURCE_DIR "/apps/sandbox/assets");
    REQUIRE(assets.configure_async_requests(executor, residency));

    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::ActiveTextPresenter presenter(diagnostics);
    presenter.initialize(assets);
    assets.configure_fonts({});

    auto view = make_room_view("Generation-aware ActiveText");
    bool ready = false;
    for (std::size_t iteration = 0; iteration < 1024 && !ready; ++iteration) {
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        presenter.refresh_layout(&view, surface());
        ready = presenter.has_font_lease();
        if (!ready)
            (void)executor.advance_one_step();
    }
    REQUIRE(ready);
    CHECK_FALSE(presenter.render_snapshot().glyphs.empty());
    CHECK(std::none_of(diagnostics.begin(), diagnostics.end(), [](const auto& diagnostic) {
        return diagnostic.code == "runtime_ui.active_text_font_lease_missing";
    }));

    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    REQUIRE(executor.shutdown_complete());
}
