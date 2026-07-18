#include "noveltea/core/editor_protocol.hpp"

#include <string>

namespace noveltea::core::editor {

Result<nlohmann::json, Diagnostics>
parse_editor_protocol_document(std::string_view text, const EditorRuntimeProtocolLimits& limits)
{
    if (text.size() > limits.max_document_bytes) {
        return Result<nlohmann::json, Diagnostics>::failure(Diagnostics{Diagnostic{
            .code = "editor_protocol.size_limit", .message = "Document exceeds size limit."}});
    }
    auto document = nlohmann::json::parse(text, nullptr, false);
    if (document.is_discarded()) {
        return Result<nlohmann::json, Diagnostics>::failure(Diagnostics{Diagnostic{
            .code = "editor_protocol.malformed_json", .message = "Malformed JSON document."}});
    }
    return Result<nlohmann::json, Diagnostics>::success(std::move(document));
}

} // namespace noveltea::core::editor
