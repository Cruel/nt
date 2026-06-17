#pragma once

#include <cstdint>
#include <string>
#include <variant>

namespace noveltea::script {

using ScriptValue = std::variant<std::monostate, bool, std::int64_t, double, std::string>;

} // namespace noveltea::script
