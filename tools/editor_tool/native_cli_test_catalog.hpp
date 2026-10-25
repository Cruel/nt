#pragma once

#include <nlohmann/json.hpp>

namespace noveltea::cli {

// Project and diagnostic values must originate from one native-admitted Project
// source generation. This does not compile gameplay or publish cache files.
[[nodiscard]] nlohmann::json
lower_test_catalog(const nlohmann::json& project, const nlohmann::json& source_diagnostics);

} // namespace noveltea::cli
