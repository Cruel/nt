#pragma once

#include "noveltea/core/compiled_project.hpp"

namespace noveltea::core::compiled::detail {

[[nodiscard]] std::vector<std::string> message_selector_contract(const LocalizationEntry& entry);

[[nodiscard]] Diagnostics validate_semantics(const CompiledProjectInput& input);

} // namespace noveltea::core::compiled::detail
