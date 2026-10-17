#pragma once

#include "contracts.hpp"

#include <cstddef>
#include <map>
#include <optional>
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
    std::map<std::string, std::string> cases;
    std::optional<std::string> context;
    std::optional<std::string> translator_note;
    bool has_runtime_arguments = false;
    // Nullopt means dynamically computed table keys; an empty vector denotes
    // a statically known empty table (or absent arguments).
    std::optional<std::vector<std::string>> runtime_argument_names;
    bool lua_call = false;
    std::size_t call_start_utf16 = 0;
    std::size_t call_end_utf16 = 0;
    std::size_t member_start_utf16 = 0;
    std::size_t member_end_utf16 = 0;
    std::optional<std::size_t> source_start_utf16;
    std::optional<std::size_t> source_end_utf16;
    std::optional<std::size_t> selector_start_utf16;
    std::optional<std::size_t> selector_end_utf16;
    std::optional<std::size_t> cases_start_utf16;
    std::optional<std::size_t> cases_end_utf16;
    std::optional<std::size_t> runtime_args_start_utf16;
    std::optional<std::size_t> runtime_args_end_utf16;
    std::optional<std::size_t> metadata_start_utf16;
    std::optional<std::size_t> metadata_end_utf16;
    std::optional<std::size_t> rml_open_end_utf16;
    std::optional<std::size_t> rml_content_end_utf16;
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

struct LuaLiteralOccurrence {
    std::string value;
    std::string kind; // quoted or long-bracket
    std::size_t start_utf16 = 0;
    std::size_t end_utf16 = 0;
    std::size_t line = 1;
    std::size_t column = 1;
    std::size_t end_line = 1;
    std::size_t end_column = 1;
};

struct SourceAnalysis {
    std::string source_path;
    std::string source_revision;
    // Retained for stable managed occurrence fingerprinting; not serialized
    // into the Node addon analysis payload.
    std::string source_text;
    bool complete = true;
    std::vector<Diagnostic> diagnostics;
    std::vector<ManagedSourceOccurrence> messages;
    std::vector<SourceReference> references;
    // Complete native lexical evidence for CLI source usages, including
    // escaped and long-bracket strings. Not part of the Node addon payload.
    std::vector<LuaLiteralOccurrence> lua_literals;
    std::vector<CursorSourceOccurrence> cursors;
};

// Certification-only native analyzer. Does not execute scripts, parse a Project
// through TypeScript, or modify the physical source being inspected.
SourceAnalysis analyze_project_text(std::string_view relative_path, std::string_view text,
                                    bool collect_lexical_literals = false);

} // namespace noveltea::authoring
