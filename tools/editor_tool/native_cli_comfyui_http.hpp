#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace noveltea::cli {
struct ComfyUiHttpResult {
    bool ok = false;
    bool timed_out = false;
    nlohmann::ordered_json body;
    std::string bytes;
};

// HTTP responses are capped; failed requests never expose remote bodies as CLI diagnostics.
ComfyUiHttpResult comfyui_get_json(const std::string& server, const std::string& endpoint,
                                   int timeout_ms);
ComfyUiHttpResult comfyui_request(const std::string& server, const std::string& endpoint,
                                  int timeout_ms, const std::string& method = "GET",
                                  const std::string& payload = {},
                                  const std::string& content_type = "application/json",
                                  std::size_t maximum = 1024 * 1024);

// Same origin/hostname/default-port/path identity as the editor's
// comfyUiServerIdentity(), for shared verification-cache records.
std::string comfyui_server_identity(const std::string& server);
} // namespace noveltea::cli
