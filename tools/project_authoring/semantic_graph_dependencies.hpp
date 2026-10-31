#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace noveltea::authoring {

// Validation consumes the same schema-typed relationships as the native
// semantic graph. Paths are absolute Project JSON pointers (not ID tokens).
struct SemanticGraphDependency {
    std::string target_owner;
    std::vector<std::string> target_impact_paths;
};

std::vector<SemanticGraphDependency>
semantic_graph_record_dependencies(std::string_view owner, std::string_view normalized_json);

} // namespace noveltea::authoring
