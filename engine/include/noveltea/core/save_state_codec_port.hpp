#pragma once

#include "noveltea/core/save_state.hpp"

#include <string>
#include <string_view>

namespace noveltea::core {

class SaveStateCodecPort {
public:
    virtual ~SaveStateCodecPort() = default;

    [[nodiscard]] virtual Result<void, Diagnostics>
    validate(const CompiledProject& project, const SaveState& save,
             std::string source_path = {}) const = 0;
    [[nodiscard]] virtual Result<std::string, Diagnostics>
    encode(const CompiledProject& project, const SaveState& save) const = 0;
    [[nodiscard]] virtual Result<SaveState, Diagnostics>
    decode(const CompiledProject& project, std::string_view text,
           std::string source_path = {}) const = 0;
};

} // namespace noveltea::core
