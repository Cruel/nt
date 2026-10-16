#pragma once

#include "contracts.hpp"

#include <jsoncons/json.hpp>

#include <string>
#include <string_view>
#include <vector>

namespace noveltea::authoring {
bool is_canonical_localization_locale(std::string_view locale);
void apply_localization_operation(std::string_view operation, jsoncons::ojson& value,
                                  const std::string& path, std::vector<Diagnostic>& errors);
} // namespace noveltea::authoring
