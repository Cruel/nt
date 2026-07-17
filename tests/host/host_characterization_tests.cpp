#include "host/input_routing_contracts.hpp"

#include "noveltea/engine.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>

namespace noveltea::host {
namespace {

TEST_CASE("host input routing preserves devtools RuntimeUI Layout and gameplay order")
{
    constexpr std::array expected{
        HostInputRouteStage::PlatformLifecycle, HostInputRouteStage::Devtools,
        HostInputRouteStage::RuntimeUi,         HostInputRouteStage::MountedLayoutAdmission,
        HostInputRouteStage::Gameplay,
    };
    STATIC_REQUIRE(kHostInputRouteOrder == expected);

    const auto open = evaluate_host_input_routing(true, false, false);
    CHECK(open.devtools);
    CHECK(open.runtime_ui);
    CHECK(open.gameplay);

    const auto ui_consumed = evaluate_host_input_routing(true, true, false);
    CHECK(ui_consumed.devtools);
    CHECK(ui_consumed.runtime_ui);
    CHECK_FALSE(ui_consumed.gameplay);

    const auto layout_blocked = evaluate_host_input_routing(false, false, true);
    CHECK_FALSE(layout_blocked.devtools);
    CHECK(layout_blocked.runtime_ui);
    CHECK_FALSE(layout_blocked.gameplay);
}

TEST_CASE("Engine partial shutdown and unloaded preview reset are cleanup safe")
{
    Engine engine;
    const auto original_position = engine.demo_position();
    const bool original_preview_running = engine.preview_running();

    CHECK_FALSE(engine.is_running());
    CHECK_FALSE(engine.runtime_preview().reset());
    engine.shutdown();
    engine.shutdown();

    CHECK_FALSE(engine.is_running());
    CHECK(engine.demo_position().x == original_position.x);
    CHECK(engine.demo_position().y == original_position.y);
    CHECK(engine.preview_running() == original_preview_running);
}

} // namespace
} // namespace noveltea::host
