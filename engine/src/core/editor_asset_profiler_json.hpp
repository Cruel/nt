#pragma once

#include "noveltea/core/asset_telemetry.hpp"
#include "noveltea/core/result.hpp"

#include <cstdint>
#include <string>
#include <string_view>

namespace noveltea::core {

[[nodiscard]] bool parse_asset_profiler_decimal(std::string_view text,
                                                std::uint64_t& value) noexcept;
[[nodiscard]] std::string serialize_asset_profiler_snapshot(const AssetProfilerSnapshot& snapshot);
[[nodiscard]] std::string serialize_asset_profiler_delta(const AssetProfilerDelta& delta);
[[nodiscard]] std::string serialize_asset_profiler_failure(const Diagnostic& diagnostic);

} // namespace noveltea::core
