#pragma once

#include <string>
#include <string_view>
#include <map>
#include <cstddef>
#include <optional>
#include <vector>

namespace noveltea::authoring {
struct Diagnostic {
    std::string path;
    std::string code;
    std::string message;
    std::string severity = "error";
    std::string source_path; // physical source provenance for compiler diagnostics
    std::optional<std::size_t> line;
    std::optional<std::size_t> column;
};
struct ValidationResult {
    bool accepted = false;
    std::string effective_json;
    std::vector<Diagnostic> diagnostics;
};
// Shared ECMAScript String.prototype.trim whitespace semantics for native
// schema normalization and domain validation (UTF-8 input/output).
std::string trim_ecmascript(std::string value);
// Certification boundary, not Project Workspace admission or cross-record validation.
ValidationResult validate_record(std::string_view contract, std::string_view source_json);
// Room-only sparse YAML source adapter for the parallel #477 session. Performs
// source-to-effective projection before the generated structural/semantic validator.
ValidationResult validate_room_source(std::string_view source_json);
ValidationResult validate_map_source(std::string_view source_json);
ValidationResult validate_character_source(std::string_view source_json);
ValidationResult validate_archetype_source(std::string_view source_json);
ValidationResult validate_animation_source(std::string_view source_json);
ValidationResult validate_asset_source(std::string_view source_json);
ValidationResult validate_material_source(std::string_view source_json);
ValidationResult validate_interactable_sparse_source(std::string_view source_json);
ValidationResult validate_dialogue_source(std::string_view source_json);
ValidationResult validate_scene_source(std::string_view source_json);
ValidationResult validate_verb_source(std::string_view source_json);
ValidationResult validate_interaction_source(std::string_view source_json);
ValidationResult validate_test_source(std::string_view source_json);
// Layout YAML keeps file/asset/none selectors. Companion bytes are separate
// physical owners; only the effective record contains inline source text.
ValidationResult validate_layout_source(std::string_view source_json,
                                        const std::map<std::string, std::string>& companions);
// Local domain invariants that do not require the rest of the Project.
// Input is an already-normalized Room or Map record; paths are record-relative.
ValidationResult validate_room_map_local(std::string_view family, std::string_view record_json);
struct MaterialPresetContract {
    std::string role;
    std::string hotspot_image;
    std::string hotspot_mask;
};
std::optional<MaterialPresetContract> material_preset_contract(std::string_view preset_id);
// Generated from the same defaults used by TypeScript Archetype inheritance.
std::optional<std::string> archetype_template_json(std::string_view instance_kind);
// Committed build-time Zod omission defaults for an authoring record family.
// This metadata may guide source compaction, but never authorizes semantic change.
std::optional<std::string> source_omission_defaults_json(std::string_view family);
// Deterministically generated from the authoritative TypeScript CLI record
// defaults and YAML writer. ID/label placeholders are replaced by the native
// authoring command before schema admission.
std::optional<std::string> default_entity_source_json(std::string_view family);
// Cross-record Room, Map, and Hotspot checks against a complete effective Project.
// Diagnostics use Project-absolute JSON Pointers; warnings and info do not reject.
ValidationResult validate_room_map_project(std::string_view effective_project_json);
std::string validation_result_json(const ValidationResult& result);
} // namespace noveltea::authoring
