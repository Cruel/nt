#pragma once

#include "noveltea/core/save_state_codec_port.hpp"
#include "noveltea/core/save_state.hpp"

#include <nlohmann/json.hpp>

#include <string>
#include <string_view>

namespace noveltea::core {

class JsonSaveStateCodec final : public SaveStateCodecPort {
public:
    [[nodiscard]] Result<void, Diagnostics> validate(const CompiledProject& project,
                                                     const SaveState& save,
                                                     std::string source_path = {}) const override;
    [[nodiscard]] Result<std::string, Diagnostics> encode(const CompiledProject& project,
                                                          const SaveState& save) const override;
    [[nodiscard]] Result<SaveState, Diagnostics>
    decode(const CompiledProject& project, std::string_view text,
           std::string source_path = {}) const override;
};

// The codec is the sole JSON boundary for the typed save contract. It validates and decodes
// SaveState values but does not restore SessionState; restoration is owned by the runtime/Flow
// layer after project-aware validation succeeds.
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
