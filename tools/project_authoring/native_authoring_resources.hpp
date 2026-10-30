#pragma once

#include <nlohmann/json.hpp>

namespace noveltea::cli {
struct NativeMessageProjection;
}

namespace noveltea::cli {

// Partial, nonpublishable C++ authoring lowering. The result covers static
// Asset, Animation, and Script resource wire tables only. Gameplay programs,
// localization and Save Contracts must be provided by the complete compiler
// before this can become a prepared runtime artifact.
[[nodiscard]] nlohmann::json
lower_static_authoring_resources(const nlohmann::json& admitted_project);

// Lightweight gameplay identity/property slice. This is not a complete
// compiled Project and must never be passed to runtime cache publication.
[[nodiscard]] nlohmann::json
lower_static_authoring_identity(const nlohmann::json& admitted_project);

[[nodiscard]] nlohmann::json
lower_authoring_global_properties(const nlohmann::json& admitted_project,
                                  const NativeMessageProjection& messages);

} // namespace noveltea::cli
