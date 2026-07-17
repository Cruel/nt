#include "ui/rmlui/rmlui_lifecycle.hpp"
#include "ui/rmlui/rmlui_render_interface_bgfx.hpp"
#include "render/bgfx/bgfx_renderer_internal.hpp"

#include <catch2/catch_test_macros.hpp>

TEST_CASE("RmlUi lifecycle domains use engine absolute clocks")
{
    noveltea::core::RuntimeClockUpdate clocks;
    clocks.gameplay_time = std::chrono::microseconds{250'000};
    clocks.unscaled_presentation_time = std::chrono::microseconds{900'000};

    CHECK(noveltea::ui::rmlui::domain_time(clocks, noveltea::core::LayoutClockDomain::Gameplay) ==
          std::chrono::microseconds{250'000});
    CHECK(noveltea::ui::rmlui::domain_time(
              clocks, noveltea::core::LayoutClockDomain::UnscaledPresentation) ==
          std::chrono::microseconds{900'000});

    clocks.gameplay_delta = std::chrono::microseconds{0};
    clocks.unscaled_presentation_delta = std::chrono::microseconds{16'000};
    clocks.unscaled_presentation_time += clocks.unscaled_presentation_delta;
    CHECK(noveltea::ui::rmlui::domain_time(clocks, noveltea::core::LayoutClockDomain::Gameplay) ==
          std::chrono::microseconds{250'000});
    CHECK(noveltea::ui::rmlui::domain_time(
              clocks, noveltea::core::LayoutClockDomain::UnscaledPresentation) ==
          std::chrono::microseconds{916'000});
}

TEST_CASE("RmlUi lifecycle compatibility ignores non-context mount policy")
{
    noveltea::core::MountedLayoutPolicy first;
    first.plane = noveltea::core::PresentationPlane::GameUi;
    first.clock = noveltea::core::LayoutClockDomain::Gameplay;
    first.input = noveltea::core::LayoutInputMode::Normal;
    first.local_order = -10;
    first.visibility = noveltea::core::LayoutVisibility::Hidden;

    auto second = first;
    second.local_order = 20;
    second.visibility = noveltea::core::LayoutVisibility::Visible;
    second.gameplay_pause = noveltea::core::GameplayPausePolicy::PauseWhileVisible;

    CHECK(noveltea::ui::rmlui::lifecycle_compatibility(first) ==
          noveltea::ui::rmlui::lifecycle_compatibility(second));
    second.clock = noveltea::core::LayoutClockDomain::UnscaledPresentation;
    CHECK(noveltea::ui::rmlui::lifecycle_compatibility(first) !=
          noveltea::ui::rmlui::lifecycle_compatibility(second));
}

TEST_CASE("RmlUi composition groups preserve interleaved lifecycle order")
{
    using noveltea::core::LayoutClockDomain;
    using noveltea::core::LayoutInputMode;
    using noveltea::core::PresentationPlane;
    using noveltea::ui::rmlui::LifecycleContextKey;

    const LifecycleContextKey gameplay_before{PresentationPlane::GameUi, 0,
                                              LayoutClockDomain::Gameplay, LayoutInputMode::Normal};
    const LifecycleContextKey menu_middle{PresentationPlane::GameUi, 1,
                                          LayoutClockDomain::UnscaledPresentation,
                                          LayoutInputMode::BlockGameplay};
    const LifecycleContextKey gameplay_after{PresentationPlane::GameUi, 2,
                                             LayoutClockDomain::Gameplay, LayoutInputMode::Normal};

    CHECK(gameplay_before < menu_middle);
    CHECK(menu_middle < gameplay_after);
    CHECK(gameplay_before != gameplay_after);
}

TEST_CASE("only modal or consumed input stops lower RmlUi contexts")
{
    using noveltea::core::LayoutInputMode;
    using noveltea::ui::rmlui::stops_lower_presentation_input;

    CHECK_FALSE(stops_lower_presentation_input(LayoutInputMode::Normal, false));
    CHECK_FALSE(stops_lower_presentation_input(LayoutInputMode::BlockGameplay, false));
    CHECK(stops_lower_presentation_input(LayoutInputMode::Modal, false));
    CHECK(stops_lower_presentation_input(LayoutInputMode::Normal, true));
}

TEST_CASE("runtime presentation view ranges keep world transition below GameUi")
{
    using noveltea::core::PresentationPlane;
    using noveltea::ui::rmlui::rmlui_bgfx_plane_view_range;
    using noveltea::ui::rmlui::rmlui_bgfx_world_source_overlay_view_range;

    const auto source = rmlui_bgfx_world_source_overlay_view_range();
    const auto target = rmlui_bgfx_plane_view_range(PresentationPlane::WorldOverlay);
    const auto game_ui = rmlui_bgfx_plane_view_range(PresentationPlane::GameUi);
    const auto menu = rmlui_bgfx_plane_view_range(PresentationPlane::MenuOverlay);
    const auto modal = rmlui_bgfx_plane_view_range(PresentationPlane::Modal);

    CHECK(source.begin <= source.end);
    CHECK(source.end < target.begin);
    CHECK(target.begin <= target.end);
    CHECK(target.end < game_ui.begin);
    CHECK(game_ui.end < menu.begin);
    CHECK(menu.end < modal.begin);

    using namespace noveltea::bgfx_backend;
    CHECK(ViewWorldSourceOverlayEnd < ViewWorldTargetBackground);
    CHECK(ViewWorldTargetOverlayEnd < ViewWorldTransitionSourceComposite);
    CHECK(ViewWorldTransitionSourceComposite < ViewWorldTransitionTargetComposite);
    CHECK(ViewWorldTransitionTargetComposite < ViewGameTransition);
    CHECK(ViewGameTransition < ViewGameUiUnderlay);
    CHECK(ViewGameUiUnderlay < ViewGameUiBegin);
    CHECK(ViewGameUiEnd < ViewActiveText);
    CHECK(ViewActiveText < ViewMenuOverlayBegin);
    CHECK(ViewModalEnd < ViewTransitionUiBegin);
    CHECK(ViewTransitionUiEnd < ViewRmlDebugBegin);
    CHECK(ViewRmlDebugEnd < ViewDebugUI);
}
