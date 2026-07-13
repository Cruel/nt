#include "noveltea/core/save_state_codec.hpp"

#include "save_state_codec/codec_internal.hpp"

#include <utility>

namespace noveltea::core {

Result<nlohmann::json, Diagnostics> encode_save_state(const CompiledProject& project,
                                                      const SaveState& save)
{
    return save_state_codec::encode_save_state_impl(project, save);
}

Result<SaveState, Diagnostics> decode_save_state_wire(const nlohmann::json& document,
                                                      std::string source_path)
{
    return save_state_codec::decode_save_state_wire_impl(document, std::move(source_path));
}

Result<void, Diagnostics> validate_save_state(const CompiledProject& project, const SaveState& save,
                                              std::string source_path)
{
    return save_state_codec::validate_save_state_impl(project, save, std::move(source_path));
}

Result<SaveState, Diagnostics> decode_save_state(const CompiledProject& project,
                                                 const nlohmann::json& document,
                                                 std::string source_path)
{
    return save_state_codec::decode_save_state_impl(project, document, std::move(source_path));
}

} // namespace noveltea::core
