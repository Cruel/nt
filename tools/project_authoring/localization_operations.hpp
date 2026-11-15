#pragma once

#include "contracts.hpp"

#include <jsoncons/json.hpp>

#include <string>
#include <string_view>
#include <set>
#include <vector>

namespace noveltea::authoring {
bool is_canonical_localization_locale(std::string_view locale);
bool is_localization_system_message_key(std::string_view key);
void apply_localization_operation(std::string_view operation, jsoncons::ojson& value,
                                  const std::string& path, std::vector<Diagnostic>& errors);
// Run the authoritative cross-fragment translation rules for exactly the
// Messages whose generated structured-source contributions changed.
void validate_changed_localization_translations(const jsoncons::ojson& model,
                                                const std::set<std::string>& message_ids,
                                                std::vector<Diagnostic>& errors);
} // namespace noveltea::authoring
