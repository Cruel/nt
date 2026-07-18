#include "host/host_input_router.hpp"

#include "noveltea/engine.hpp"
#include "noveltea/runtime_preview_controller.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <vector>

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

    HostInputRouter router;
    const auto presentation = make_presentation_metrics(make_surface_metrics(1280, 720, 1280, 720));
    std::vector<HostInputRouteStage> observed;
    const auto routed =
        router.route({.kind = NormalizedHostEventKind::KeyDown,
                      .proposed_runtime_input = core::RuntimeInputMessage{core::ContinueInput{}}},
                     {.presentation = &presentation, .devtools_enabled = true},
                     {.debug =
                          [&] {
                              observed.push_back(HostInputRouteStage::Devtools);
                              return DebugInputResult{};
                          },
                      .runtime_ui =
                          [&] {
                              observed.push_back(HostInputRouteStage::RuntimeUi);
                              return RuntimeUiInputResult{};
                          }});

    REQUIRE(observed.size() == 2);
    CHECK(observed[0] == HostInputRouteStage::Devtools);
    CHECK(observed[1] == HostInputRouteStage::RuntimeUi);
    CHECK(routed.route_diagnostics.gameplay_admitted);
    REQUIRE(routed.runtime_inputs.size() == 1);
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
