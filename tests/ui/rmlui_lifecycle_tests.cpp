#include "ui/rmlui/rmlui_lifecycle.hpp"
#include "ui/rmlui/rmlui_host_input.hpp"
#include "ui/rmlui/rmlui_render_interface_bgfx.hpp"
#include "ui/rmlui/rmlui_system_interface_sdl3.hpp"
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

TEST_CASE("Current RmlUi context sharing ignores non-context mount policy")
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
                                              LayoutClockDomain::Gameplay, LayoutInputMode::Normal,
                                              noveltea::core::MountedLayoutOwner::Gameplay};
    const LifecycleContextKey menu_middle{
        PresentationPlane::GameUi, 1, LayoutClockDomain::UnscaledPresentation,
        LayoutInputMode::BlockGameplay, noveltea::core::MountedLayoutOwner::Shell};
    const LifecycleContextKey gameplay_after{PresentationPlane::GameUi, 2,
                                             LayoutClockDomain::Gameplay, LayoutInputMode::Normal,
                                             noveltea::core::MountedLayoutOwner::Gameplay};

    CHECK(gameplay_before < menu_middle);
    CHECK(menu_middle < gameplay_after);
    CHECK(gameplay_before != gameplay_after);
}

TEST_CASE("RmlUi lifecycle contexts isolate Layout event authority")
{
    using noveltea::core::LayoutClockDomain;
    using noveltea::core::LayoutInputMode;
    using noveltea::core::MountedLayoutOwner;
    using noveltea::core::PresentationPlane;
    using noveltea::ui::rmlui::LifecycleContextKey;

    const LifecycleContextKey gameplay{PresentationPlane::GameUi, 0, LayoutClockDomain::Gameplay,
                                       LayoutInputMode::Normal, MountedLayoutOwner::Gameplay};
    const LifecycleContextKey shell{PresentationPlane::GameUi, 0, LayoutClockDomain::Gameplay,
                                    LayoutInputMode::Normal, MountedLayoutOwner::Shell};

    CHECK(gameplay != shell);
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

TEST_CASE("RmlUi pointer events are projected separately for each context")
{
    const auto presentation = noveltea::make_presentation_metrics(
        noveltea::make_host_surface_metrics(1920, 1080, 3840, 2160),
        {.reference = {.size = {1920, 1080}}});
    REQUIRE(presentation);
    const auto unscaled = noveltea::resolve_context_metrics(presentation.value(), 1.0f, true);
    const auto scaled = noveltea::resolve_context_metrics(presentation.value(), 1.25f, true);
    REQUIRE(unscaled);
    REQUIRE(scaled);

    SDL_Event source{};
    source.type = SDL_EVENT_MOUSE_MOTION;
    const noveltea::PresentationTransform transform{presentation.value()};
    const SDL_Event unscaled_event = noveltea::ui::rmlui::project_pointer_event_to_context(
        source, {960.0f, 540.0f}, transform, unscaled.value());
    const SDL_Event scaled_event = noveltea::ui::rmlui::project_pointer_event_to_context(
        source, {960.0f, 540.0f}, transform, scaled.value());

    CHECK(unscaled_event.motion.x == 960.0f);
    CHECK(unscaled_event.motion.y == 540.0f);
    CHECK(scaled_event.motion.x == 768.0f);
    CHECK(scaled_event.motion.y == 432.0f);
}

TEST_CASE("SDL text input area projects context caret coordinates into host logical space")
{
    const auto presentation = noveltea::make_presentation_metrics(
        noveltea::make_host_surface_metrics(1000, 800, 1500, 1200),
        {.reference = {.size = {1920, 1080}}});
    REQUIRE(presentation);
    const auto context = noveltea::resolve_context_metrics(presentation.value(), 1.25f, true);
    REQUIRE(context);

    const auto area = noveltea::ui::rmlui::project_text_input_area_to_host_logical(
        presentation.value(), context.value(), {768.0f, 432.0f}, 32.0f);
    CHECK(area.x == 500);
    CHECK(area.y == 400);
    CHECK(area.width == 1);
    CHECK(area.height == 20);
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
    CHECK(ViewWorldTargetContent < ViewWorldOrdinaryComposite);
    CHECK(ViewWorldOrdinaryComposite < ViewWorldNativeOverlay);
    CHECK(ViewWorldNativeOverlay < ViewWorldTargetOverlayBegin);
    CHECK(ViewGameLayerForeground == ViewWorldNativeOverlay);
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
