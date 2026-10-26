#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace noveltea::cli {
struct NativeMessageProjection;

// Shared-definition draft for the staged native compiler. The returned value
// deliberately has no Compiled Project schema header or runnable programs.
// Only #557 may assemble this with the program lowerers into a runtime wire.
[[nodiscard]] nlohmann::json
lower_shared_authoring_project(const nlohmann::json& admitted_project,
                               const NativeMessageProjection& messages);

// Resolve the same Room Archetype/default overrides as shared-definition lowering.
// Program compilation must not independently interpret inherited Room records.
[[nodiscard]] nlohmann::json effective_room_authoring_data(const nlohmann::json& project,
                                                           const std::string& id, bool archetype);
} // namespace noveltea::cli
