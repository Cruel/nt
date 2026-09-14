#pragma once

#include "noveltea/core/layout_contracts.hpp"
#include "noveltea/core/result.hpp"

#include <string>
#include <string_view>

namespace noveltea::core {

// JSON terminates here; callers receive an owning, backend-neutral value tree.
[[nodiscard]] Result<PersistableValue, std::string> decode_data_asset(std::string_view source);

} // namespace noveltea::core
