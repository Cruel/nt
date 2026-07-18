#include <catch2/catch_test_macros.hpp>

#include "ui/rmlui/active_text_presenter.hpp"

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

noveltea::ui::rmlui::ActiveTextPresenterSurface surface()
{
    return {.bounds = {10.0f, 20.0f, 400.0f, 100.0f}};
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
