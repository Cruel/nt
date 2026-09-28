#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/devtools_console.hpp"
#include "noveltea/devtools_snapshot.hpp"
#include "noveltea/devtools_trace.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace noveltea::devtools {

struct DevtoolsBuildIdentity {
    std::string engine_version;
    std::string build_configuration;
    std::string target_platform;
    std::string host_platform;
    std::string renderer;
};

struct DevtoolsRmlUiSummary {
    std::vector<DevtoolsRmlUiContextSnapshot> contexts;
    RmlUiDebuggerSnapshot debugger;
};

struct DevtoolsDebugReport {
    std::uint32_t format_version = 1;
    DevtoolsBuildIdentity build;
    std::vector<std::string> capabilities;
    DevtoolsSnapshot snapshot;
    core::Diagnostics diagnostics;
    DevtoolsRmlUiSummary rmlui;
    ConsoleDelta console;
    TraceDelta trace;
};

} // namespace noveltea::devtools
