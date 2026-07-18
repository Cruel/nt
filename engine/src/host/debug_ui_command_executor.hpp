#pragma once

#include "host/debug_ui_contracts.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/runtime/runtime_capabilities.hpp"

#include <optional>

namespace noveltea::runtime {
class RuntimeCommandGateway;
}

namespace noveltea::host {

struct DebugUiCommandEffect {
    std::optional<bool> render_perf_logging;
    bool runtime_state_changed = false;
};

class DebugUiCommandExecutor final {
public:
    [[nodiscard]] static constexpr runtime::RuntimeCapabilityProfile runtime_capability_profile()
    {
        return runtime::RuntimeCapabilityProfile::Tooling;
    }

    [[nodiscard]] core::Result<DebugUiCommandEffect, core::Diagnostics>
    execute(const DebugUiCommand& command, runtime::RuntimeCommandGateway* gateway) const;
};

} // namespace noveltea::host
