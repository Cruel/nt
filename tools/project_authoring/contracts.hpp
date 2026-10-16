#pragma once

#include <string>
#include <string_view>
#include <optional>
#include <vector>

namespace noveltea::authoring {
struct Diagnostic {
    std::string path;
    std::string code;
    std::string message;
    std::string severity = "error";
};
struct ValidationResult {
    bool accepted = false;
    std::string effective_json;
    std::vector<Diagnostic> diagnostics;
};
// Certification boundary, not Project Workspace admission or cross-record validation.
ValidationResult validate_record(std::string_view contract, std::string_view source_json);
// Room-only sparse YAML source adapter for the parallel #477 session. Performs
// source-to-effective projection before the generated structural/semantic validator.
ValidationResult validate_room_source(std::string_view source_json);
ValidationResult validate_map_source(std::string_view source_json);
// Local domain invariants that do not require the rest of the Project.
// Input is an already-normalized Room or Map record; paths are record-relative.
ValidationResult validate_room_map_local(std::string_view family, std::string_view record_json);
struct MaterialPresetContract {
    std::string role;
    std::string hotspot_image;
    std::string hotspot_mask;
};
std::optional<MaterialPresetContract> material_preset_contract(std::string_view preset_id);
// Cross-record Room, Map, and Hotspot checks against a complete effective Project.
// Diagnostics use Project-absolute JSON Pointers; warnings and info do not reject.
ValidationResult validate_room_map_project(std::string_view effective_project_json);
std::string validation_result_json(const ValidationResult& result);
} // namespace noveltea::authoring
