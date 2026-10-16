#pragma once

#include "character_archetype_semantics.hpp"

#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <string_view>

namespace noveltea::authoring {

// Normalized effective Material with its resolved terminal Preset and sparse
// inherited authoring values. This does not replace compiler reflection.
ValidationResult resolve_material(std::string_view material_id, std::string_view normalized_record,
                                  const AuthoringRecordResolver& resolve,
                                  const std::filesystem::path& project_root,
                                  const std::map<std::string, std::string>& shader_overlays = {});

// Compiler output is owned by the existing native ShaderCompilerService. This
// adapter consumes its diagnostics without guessing GLSL correctness or interfaces.
ValidationResult
validate_material_shader_compiler_result(std::string_view result_json, std::string_view material_id,
                                         std::string_view effective_material_json = {});
std::string material_shader_program_request(std::string_view material_id,
                                            std::string_view effective_material_json);

} // namespace noveltea::authoring
