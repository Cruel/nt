#pragma once

#include "noveltea/core/save_state.hpp"

#include <nlohmann/json.hpp>

#include <string>
#include <string_view>

namespace noveltea::core {

// The codec is the sole JSON boundary for the additive typed save contract. It does not restore a
// SessionState; Phase 8C owns reconstruction through FlowExecutor.
[[nodiscard]] Result<nlohmann::json, Diagnostics> encode_save_state(const CompiledProject& project,
                                                                    const SaveState& save);
[[nodiscard]] Result<SaveState, Diagnostics> decode_save_state_wire(const nlohmann::json& document,
                                                                    std::string source_path = {});
[[nodiscard]] Result<void, Diagnostics> validate_save_state(const CompiledProject& project,
                                                            const SaveState& save,
                                                            std::string source_path = {});
[[nodiscard]] Result<SaveState, Diagnostics> decode_save_state(const CompiledProject& project,
                                                               const nlohmann::json& document,
                                                               std::string source_path = {});
[[nodiscard]] Result<std::string, Diagnostics>
encode_save_state_text(const CompiledProject& project, const SaveState& save);
[[nodiscard]] Result<SaveState, Diagnostics> decode_save_state_text(const CompiledProject& project,
                                                                    std::string_view text,
                                                                    std::string source_path = {});

} // namespace noveltea::core
