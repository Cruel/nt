#pragma once

#include <nlohmann/json.hpp>
#include <string_view>

namespace noveltea::cli {

// A nonpublishable projection from one native-admitted, normalized Project.
// `ids` maps stable Message identities to package-local numeric identities;
// `sourceEntries` and `translatedEntries` are compiled catalog entries, not
// authoring records. Gameplay lowering consumes the same mapping.
struct NativeMessageProjection {
    nlohmann::json ids;
    nlohmann::json source_entries;
    nlohmann::json translated_entries;
    nlohmann::json compiled_texts;
    nlohmann::json lowered_project;
    nlohmann::json rewritten_sources;
    nlohmann::json rewritten_rml;
};

[[nodiscard]] NativeMessageProjection lower_authoring_messages(const nlohmann::json& project);
[[nodiscard]] nlohmann::json lower_authoring_text(const nlohmann::json& project,
                                                  const NativeMessageProjection& messages,
                                                  const nlohmann::json& text,
                                                  std::string_view semantic_path);
[[nodiscard]] nlohmann::json lower_authoring_message_value(const nlohmann::json& project,
                                                           const NativeMessageProjection& messages,
                                                           const nlohmann::json& value);

} // namespace noveltea::cli
