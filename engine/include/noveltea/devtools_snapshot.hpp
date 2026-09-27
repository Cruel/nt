#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"
#include "noveltea/surface.hpp"

#include <cstdint>
#include <optional>
#include <string>

namespace noveltea::devtools {

struct RuntimeDebugSnapshot {
    runtime::RuntimePublication publication;
    core::Diagnostics diagnostics;
    bool preview_running = false;
};

struct DevtoolsHostSnapshot {
    HostSurfaceMetrics surface{};
    std::string platform;
    std::string renderer;
    std::optional<std::uint64_t> host_generation;
};

struct DevtoolsToolingSnapshot {
    bool preview_running = false;
    bool render_perf_logging = false;
    bool native_debug_ui_available = false;
    bool native_debug_ui_enabled = false;
};

struct DevtoolsSnapshot {
    DevtoolsHostSnapshot host;
    DevtoolsToolingSnapshot tooling;
    std::optional<RuntimeDebugSnapshot> runtime;
};

} // namespace noveltea::devtools
