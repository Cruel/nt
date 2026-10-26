#pragma once

#include <nlohmann/json.hpp>

namespace noveltea::cli {

// Compiles a single already-admitted native Project generation. This does not
// read a warmed runtime artifact, mutate authoring data, or publish a cache.
// Callers must pin and recheck source authority around the compilation.
[[nodiscard]] nlohmann::json compile_native_compiled_project(const nlohmann::json& project);

} // namespace noveltea::cli
