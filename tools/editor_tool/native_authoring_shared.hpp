#pragma once

#include <nlohmann/json.hpp>

namespace noveltea::cli {
struct NativeMessageProjection;

// Shared-definition draft for the staged native compiler. The returned value
// deliberately has no Compiled Project schema header or runnable programs.
// Only #557 may assemble this with the program lowerers into a runtime wire.
[[nodiscard]] nlohmann::json
lower_shared_authoring_project(const nlohmann::json& admitted_project,
                               const NativeMessageProjection& messages);
} // namespace noveltea::cli
