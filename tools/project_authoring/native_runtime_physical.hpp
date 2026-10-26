#pragma once

#include <nlohmann/json.hpp>

#include <functional>
#include <string>

namespace noveltea::cli {

// Physical preparation is deliberately separate from pure artifact assembly.
// The caller owns the admitted Project generation and must prove it remains
// current before and after this operation, including before publication.
[[nodiscard]] nlohmann::json
prepare_native_runtime_physical(const nlohmann::json& artifact, const nlohmann::json& admitted,
                                const std::string& project_root,
                                const std::function<bool()>& cancelled = {});

} // namespace noveltea::cli
