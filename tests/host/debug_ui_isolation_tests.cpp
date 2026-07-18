#include "devtools/debug_ui.hpp"
#include "host/debug_ui_command_executor.hpp"

#include <catch2/catch_test_macros.hpp>

#include <type_traits>

namespace noveltea {
class RuntimeUI;
}

namespace noveltea::host {
namespace {

template<typename T>
concept HasRuntimeUiBinding =
    requires(T& value, RuntimeUI* runtime_ui) { value.set_runtime_ui(runtime_ui); };

TEST_CASE("DebugUI consumes typed observations without a production RuntimeUI dependency")
{
    STATIC_REQUIRE_FALSE(HasRuntimeUiBinding<DebugUI>);
    STATIC_REQUIRE(std::is_same_v<decltype(DebugUiObservationSnapshot::runtime_observations),
                                  std::span<const core::RuntimeObservation>>);
    STATIC_REQUIRE(std::is_same_v<decltype(DebugUiObservationSnapshot::runtime_events),
                                  std::span<const runtime::RuntimeEvent>>);
    STATIC_REQUIRE(std::is_same_v<decltype(DebugUiObservationSnapshot::runtime_diagnostics),
                                  std::span<const core::Diagnostic>>);
    STATIC_REQUIRE(std::is_same_v<decltype(DebugUiObservationSnapshot::host_generation),
                                  std::optional<HostGeneration>>);
}

TEST_CASE("DebugUI runtime commands require the Tooling capability profile")
{
    constexpr auto profile = DebugUiCommandExecutor::runtime_capability_profile();
    STATIC_REQUIRE(profile == runtime::RuntimeCapabilityProfile::Tooling);
    constexpr auto descriptor = runtime::describe(profile);
    STATIC_REQUIRE((descriptor.command_groups &
                    runtime::capability_bit(runtime::RuntimeCapabilityGroup::Tooling)) != 0);
    STATIC_REQUIRE((descriptor.command_groups &
                    runtime::capability_bit(runtime::RuntimeCapabilityGroup::Game)) != 0);

    DebugUiCommandExecutor executor;
    const auto unavailable = executor.execute(SetGameplayPausedDebugCommand{true}, nullptr);
    REQUIRE_FALSE(unavailable);
    REQUIRE(unavailable.error().size() == 1);
    CHECK(unavailable.error().front().code == "debug_ui.runtime_unavailable");
}

TEST_CASE("DebugUI host commands use the same typed seam without a runtime")
{
    DebugUiCommandExecutor executor;
    const auto executed = executor.execute(SetRenderPerfLoggingDebugCommand{true}, nullptr);
    REQUIRE(executed);
    REQUIRE(executed.value_if()->render_perf_logging.has_value());
    CHECK(*executed.value_if()->render_perf_logging);
    CHECK_FALSE(executed.value_if()->runtime_state_changed);
}

} // namespace
} // namespace noveltea::host
