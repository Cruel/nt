#include "noveltea/core/save_state_codec.hpp"

#include "save_state_codec/codec_internal.hpp"

#include <cstdint>
#include <utility>

namespace noveltea::core {
namespace {

bool valid_utf8(std::string_view text) noexcept
{
    std::size_t index = 0;
    while (index < text.size()) {
        const auto lead = static_cast<unsigned char>(text[index]);
        std::size_t continuation_count = 0;
        std::uint32_t code_point = 0;
        if (lead <= 0x7fU) {
            ++index;
            continue;
        }
        if ((lead & 0xe0U) == 0xc0U) {
            continuation_count = 1;
            code_point = lead & 0x1fU;
        } else if ((lead & 0xf0U) == 0xe0U) {
            continuation_count = 2;
            code_point = lead & 0x0fU;
        } else if ((lead & 0xf8U) == 0xf0U) {
            continuation_count = 3;
            code_point = lead & 0x07U;
        } else {
            return false;
        }
        if (index + continuation_count >= text.size())
            return false;
        for (std::size_t offset = 1; offset <= continuation_count; ++offset) {
            const auto continuation = static_cast<unsigned char>(text[index + offset]);
            if ((continuation & 0xc0U) != 0x80U)
                return false;
            code_point = (code_point << 6U) | (continuation & 0x3fU);
        }
        const bool overlong = (continuation_count == 1 && code_point < 0x80U) ||
                              (continuation_count == 2 && code_point < 0x800U) ||
                              (continuation_count == 3 && code_point < 0x10000U);
        if (overlong || code_point > 0x10ffffU || (code_point >= 0xd800U && code_point <= 0xdfffU))
            return false;
        index += continuation_count + 1;
    }
    return true;
}

bool json_strings_are_utf8(const nlohmann::json& value)
{
    if (value.is_string()) {
        const auto* text = value.get_ptr<const nlohmann::json::string_t*>();
        return text != nullptr && valid_utf8(*text);
    }
    if (value.is_array() || value.is_object()) {
        for (auto item = value.cbegin(); item != value.cend(); ++item) {
            if (value.is_object() && !valid_utf8(item.key()))
                return false;
            if (!json_strings_are_utf8(*item))
                return false;
        }
    }
    return true;
}

} // namespace

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

Result<std::string, Diagnostics> encode_save_state_text(const CompiledProject& project,
                                                        const SaveState& save)
{
    auto encoded = encode_save_state(project, save);
    const auto* document = encoded.value_if();
    if (document == nullptr)
        return Result<std::string, Diagnostics>::failure(encoded.error());
    if (!json_strings_are_utf8(*document))
        return Result<std::string, Diagnostics>::failure(Diagnostics{
            Diagnostic{.code = "save_codec.invalid_utf8",
                       .message = "Save state contains text that is not valid UTF-8."}});
    return Result<std::string, Diagnostics>::success(document->dump());
}

Result<SaveState, Diagnostics> decode_save_state_text(const CompiledProject& project,
                                                      std::string_view text,
                                                      std::string source_path)
{
    auto document = nlohmann::json::parse(text.begin(), text.end(), nullptr, false);
    if (document.is_discarded())
        return Result<SaveState, Diagnostics>::failure(
            Diagnostics{Diagnostic{.code = "save_codec.malformed_json",
                                   .message = "Save slot does not contain valid JSON.",
                                   .source_path = std::move(source_path)}});
    return decode_save_state(project, document, std::move(source_path));
}

} // namespace noveltea::core
