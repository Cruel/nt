#pragma once

#include "noveltea/core/runtime_user_settings.hpp"

#include <nlohmann/json.hpp>

#include <string>
#include <string_view>

namespace noveltea::core {

[[nodiscard]] Result<nlohmann::json, Diagnostics>
encode_runtime_user_settings(const RuntimeUserSettings& settings);
[[nodiscard]] Result<RuntimeUserSettings, Diagnostics>
decode_runtime_user_settings(const nlohmann::json& document, std::string source_path = {});
[[nodiscard]] Result<std::string, Diagnostics>
encode_runtime_user_settings_text(const RuntimeUserSettings& settings);
[[nodiscard]] Result<RuntimeUserSettings, Diagnostics>
decode_runtime_user_settings_text(std::string_view text, std::string source_path = {});

} // namespace noveltea::core
