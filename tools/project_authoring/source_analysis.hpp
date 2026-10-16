#pragma once

#include "contracts.hpp"

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::authoring {

// Source-level projections are independent of YAML owner normalization. Offsets
// and locations refer to physical text, never to an expanded effective record.
struct ManagedSourceOccurrence {
    std::string kind; // local, named, plural, select
    std::string source;
    std::string source_path;
    std::string source_revision;
    std::size_t line = 1;
    std::size_t column = 1;
};

struct SourceReference {
    std::string kind; // script, template-link, template-use
    std::string target;
    std::size_t line = 1;
    std::size_t column = 1;
};

struct CursorSourceOccurrence {
    std::string name;
    std::size_t line = 1;
    std::size_t column = 1;
};

struct SourceAnalysis {
    std::string source_path;
    std::string source_revision;
    bool complete = true;
    std::vector<Diagnostic> diagnostics;
    std::vector<ManagedSourceOccurrence> messages;
    std::vector<SourceReference> references;
    std::vector<CursorSourceOccurrence> cursors;
};

// Certification-only native analyzer. Does not execute scripts, parse a Project
// through TypeScript, or modify the physical source being inspected.
SourceAnalysis analyze_project_text(std::string_view relative_path, std::string_view text);

} // namespace noveltea::authoring
