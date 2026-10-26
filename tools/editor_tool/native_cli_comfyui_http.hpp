#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace noveltea::cli {
struct ComfyUiHttpResult {
    bool ok = false;
    bool timed_out = false;
    nlohmann::ordered_json body;
};

// HTTP responses are capped; failed requests never expose remote bodies as CLI diagnostics.
ComfyUiHttpResult comfyui_get_json(const std::string& server, const std::string& endpoint,
                                   int timeout_ms);

// Same origin/hostname/default-port/path identity as the editor's
// comfyUiServerIdentity(), for shared verification-cache records.
std::string comfyui_server_identity(const std::string& server);
} // namespace noveltea::cli
