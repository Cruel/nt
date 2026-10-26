#pragma once
#include <nlohmann/json.hpp>

namespace noveltea::cli {
// Throws for missing or unsupported FFmpeg installations.
nlohmann::json inspect_native_media_tool();
} // namespace noveltea::cli
