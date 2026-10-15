#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace noveltea::authoring {
struct Diagnostic {
    std::string path;
    std::string code;
    std::string message;
};
struct ValidationResult {
    bool accepted = false;
    std::string effective_json;
    std::vector<Diagnostic> diagnostics;
};
// Certification boundary, not Project Workspace admission or cross-record validation.
ValidationResult validate_record(std::string_view contract, std::string_view source_json);
std::string validation_result_json(const ValidationResult& result);
} // namespace noveltea::authoring
