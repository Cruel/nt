#include "devtools/debug_ui.hpp"
#include "host/debug_ui_command_executor.hpp"

#include <catch2/catch_test_macros.hpp>

namespace noveltea {
class RuntimeUI;
}

namespace noveltea::host {
namespace {

template<typename T>
concept HasRuntimeUiBinding =
    requires(T& value, RuntimeUI* runtime_ui) { value.set_runtime_ui(runtime_ui); };

TEST_CASE("DebugUI has no production RuntimeUI binding")
{
    STATIC_REQUIRE_FALSE(HasRuntimeUiBinding<DebugUI>);
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
