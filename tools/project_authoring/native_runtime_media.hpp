#pragma once

#include <nlohmann/json.hpp>
#include <filesystem>
#include <functional>

namespace noveltea::cli {

// Prepare the private runtime representation of semantic video Animation
// motions. Failure is an exception; the caller discards the candidate artifact.
void prepare_native_runtime_media(nlohmann::json& artifact, const nlohmann::json& project,
                                  const nlohmann::json& source_revisions,
                                  const std::filesystem::path& root,
                                  const std::function<bool()>& cancelled);

} // namespace noveltea::cli
