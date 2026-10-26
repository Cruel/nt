#pragma once

#include <cstddef>
#include <map>
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

// Per-Project exact-byte parse cache. A hit is only a parse reuse: filesystem
// identity is still verified by SourceAuthority on every physical observation.
class YamlDecodeCache {
public:
    std::map<std::string, YamlSourceResult, std::less<>> results;
    std::size_t input_bytes = 0;
};

// Reentrant, thread-local routing to a Project-owned parse cache. Standalone
// codec calls retain their uncached semantics.
class ScopedYamlDecodeCache {
public:
    explicit ScopedYamlDecodeCache(YamlDecodeCache& cache) noexcept;
    ~ScopedYamlDecodeCache();
    ScopedYamlDecodeCache(const ScopedYamlDecodeCache&) = delete;
    ScopedYamlDecodeCache& operator=(const ScopedYamlDecodeCache&) = delete;

private:
    YamlDecodeCache* previous_;
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
// Re-emit one restricted YAML document with 2-space indentation and preserved
// comments. Reject any emitter output that changes the decoded source value.
YamlSourceResult format_yaml_source(std::string_view source);

} // namespace noveltea::authoring
