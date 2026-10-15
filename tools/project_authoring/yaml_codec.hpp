#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::authoring {

// Paths are RFC 6901 pointers into *physical* sparse source, not an expanded Project.
struct YamlSourceLocation {
    std::string path;
    std::size_t begin = 0;
    std::size_t end = 0;
    std::size_t line = 0;   // 1-based
    std::size_t column = 0; // 1-based
    bool has_comment = false;
};

struct YamlSourceResult {
    bool accepted = false;
    std::string source;      // exact bytes, including comments, BOM-free spelling and whitespace
    std::string source_json; // JSON representation of *explicit* fields; omission is not null
    std::vector<YamlSourceLocation> locations;
    std::string error;
    std::optional<std::size_t> error_offset;
};

enum class YamlCommentDisposition {
    Keep,
    Remove
};

enum class YamlEditOperation {
    Upsert,
    Add,
    Replace,
    Remove
};

struct YamlValueEdit {
    std::string path;
    // JSON literal, not YAML. A replacement is interpreted in source space (bare typed refs,
    // abbreviated Conditions etc.), before semantic schema expansion.
    std::string value_json;
    YamlCommentDisposition comments = YamlCommentDisposition::Keep;
    // If the new value is this declared source omission default, omit an unannotated key.
    // Commented defaults remain explicitly present for Keep, as in #449.
    std::optional<std::string> omission_default_json;
    YamlEditOperation operation = YamlEditOperation::Upsert;
};

// Parallel certification-only host codec: no production writer, schema or workspace authority.
YamlSourceResult open_yaml_source(std::string_view source);
YamlSourceResult edit_yaml_source(std::string_view source, const std::vector<YamlValueEdit>& edits);

} // namespace noveltea::authoring
