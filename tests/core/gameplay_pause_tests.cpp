#include "noveltea/core/gameplay_pause.hpp"
#include "noveltea/core/runtime_clock.hpp"

#include <catch2/catch_test_macros.hpp>

namespace {

noveltea::core::MountedLayoutInstance mounted(std::uint64_t id,
                                              noveltea::core::GameplayPausePolicy pause,
                                              noveltea::core::LayoutVisibility visibility)
{
    using namespace noveltea::core;
    return {.instance = MountedLayoutInstanceId::from_number(id),
            .layout = LayoutId::create("layout").value(),
            .owner = MountedLayoutOwner::Shell,
            .policy = {.gameplay_pause = pause, .visibility = visibility}};
}

} // namespace

TEST_CASE("effective gameplay pause derives independent sources")
{
    using namespace noveltea::core;
    const std::vector layouts{
        mounted(1, GameplayPausePolicy::PauseWhileVisible, LayoutVisibility::Visible),
        mounted(2, GameplayPausePolicy::Continue, LayoutVisibility::Visible),
        mounted(3, GameplayPausePolicy::PauseWhileVisible, LayoutVisibility::Hidden)};
    const auto pause = derive_effective_gameplay_pause(true, layouts, true);
    REQUIRE(pause.paused);
    REQUIRE(pause.active_sources.size() == 3);
    CHECK(pause.active_sources[0].kind == GameplayPauseSourceKind::ExplicitSession);
    CHECK(pause.active_sources[1].layout_instance == layouts[0].instance);
    CHECK(pause.active_sources[2].kind == GameplayPauseSourceKind::PlatformSuspension);
}

TEST_CASE("platform and engine suspension remain distinguishable pause sources")
{
    using namespace noveltea::core;
    const std::vector<MountedLayoutInstance> layouts;
    const auto pause = derive_effective_gameplay_pause(false, layouts, true, true);
    REQUIRE(pause.paused);
    REQUIRE(pause.active_sources.size() == 2);
    CHECK(pause.active_sources[0].kind == GameplayPauseSourceKind::PlatformSuspension);
    CHECK(pause.active_sources[1].kind == GameplayPauseSourceKind::EngineSuspension);
}

TEST_CASE("removing one pause requester cannot clear another")
{
    using namespace noveltea::core;
    std::vector layouts{
        mounted(1, GameplayPausePolicy::PauseWhileVisible, LayoutVisibility::Visible),
        mounted(2, GameplayPausePolicy::PauseWhileVisible, LayoutVisibility::Visible)};
    CHECK(derive_effective_gameplay_pause(false, layouts, false).active_sources.size() == 2);
    layouts.erase(layouts.begin());
    CHECK(derive_effective_gameplay_pause(false, layouts, false).paused);
    layouts[0].policy.visibility = LayoutVisibility::Hidden;
    CHECK_FALSE(derive_effective_gameplay_pause(false, layouts, false).paused);
}

TEST_CASE("derived pause freezes gameplay clock while unscaled time remains live")
{
    using namespace noveltea::core;
    const std::vector layouts{
        mounted(7, GameplayPausePolicy::PauseWhileVisible, LayoutVisibility::Visible)};
    const auto pause = derive_effective_gameplay_pause(false, layouts, false);
    RuntimeClock clock;
    const auto update = clock.advance(0.1, pause.paused, false);
    REQUIRE(update);
    CHECK(update.value().gameplay_delta == std::chrono::microseconds{0});
    CHECK(update.value().unscaled_presentation_delta == std::chrono::microseconds{100000});
}
