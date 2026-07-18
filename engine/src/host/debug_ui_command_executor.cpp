#include "host/debug_ui_command_executor.hpp"

#include "noveltea/runtime/runtime_command_gateway.hpp"
#include "noveltea/script/runtime_script_api.hpp"

#include <string>
#include <type_traits>
#include <utility>

namespace noveltea::host {
namespace {

core::Diagnostics command_error(std::string code, std::string message)
{
    return {{.code = std::move(code), .message = std::move(message)}};
}

} // namespace

core::Result<DebugUiCommandEffect, core::Diagnostics>
DebugUiCommandExecutor::execute(const DebugUiCommand& command,
                                runtime::RuntimeCommandGateway* gateway) const
{
    return std::visit(
        [gateway](const auto& value) -> core::Result<DebugUiCommandEffect, core::Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SetRenderPerfLoggingDebugCommand>) {
                return core::Result<DebugUiCommandEffect, core::Diagnostics>::success(
                    {.render_perf_logging = value.enabled});
            } else {
                if (!gateway) {
                    return core::Result<DebugUiCommandEffect, core::Diagnostics>::failure(
                        command_error("debug_ui.runtime_unavailable",
                                      "Debug UI runtime command requires a loaded game."));
                }

                runtime::RuntimeCapabilityIssuer issuer(*gateway, gateway->generation());
                auto capabilities = issuer.issue(runtime_capability_profile());
                if (!capabilities ||
                    capabilities->profile() != runtime::RuntimeCapabilityProfile::Tooling ||
                    !capabilities->can_command(runtime::RuntimeCapabilityGroup::Tooling) ||
                    !capabilities->can_command(runtime::RuntimeCapabilityGroup::Game)) {
                    return core::Result<DebugUiCommandEffect, core::Diagnostics>::failure(
                        command_error("debug_ui.tooling_capability_unavailable",
                                      "Debug UI command could not acquire Tooling capabilities."));
                }

                script::RuntimeScriptApi api;
                api.replace_capabilities(*capabilities);
                auto result = api.set_gameplay_paused(value.paused);
                api.clear_capabilities();
                if (!result) {
                    return core::Result<DebugUiCommandEffect, core::Diagnostics>::failure(
                        std::move(result).error());
                }
                return core::Result<DebugUiCommandEffect, core::Diagnostics>::success(
                    {.render_perf_logging = std::nullopt, .runtime_state_changed = true});
            }
        },
        command);
}

} // namespace noveltea::host
