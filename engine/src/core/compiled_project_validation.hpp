#pragma once

#include "noveltea/core/compiled_project.hpp"

namespace noveltea::core::compiled::detail {

[[nodiscard]] Diagnostics validate_semantics(const CompiledProjectInput& input);

} // namespace noveltea::core::compiled::detail
