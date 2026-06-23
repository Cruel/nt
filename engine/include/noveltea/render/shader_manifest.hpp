#pragma once

#include "noveltea/render/material.hpp"

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea {

enum class ShaderProgramRequestKind {
    Material,
    DirectShaderPair,
};

enum class ShaderProgramDiagnosticCode {
    UnknownMaterial,
    UnknownShader,
    IncompatibleShaderRole,
    MissingRoleBinding,
    IncompleteRoleBinding,
    MissingShaderStage,
    MissingCompiledVariant,
    UnsupportedActiveVariant,
};

struct ShaderProgramDiagnostic {
    ShaderProgramDiagnosticCode code = ShaderProgramDiagnosticCode::UnknownShader;
    std::string context;
    std::string message;
};

struct ShaderStageBinaryRef {
    ShaderId shader;
    ShaderStage stage = ShaderStage::Vertex;
    std::string variant;
    std::string path;
};

struct ShaderProgramKey {
    ShaderProgramRequestKind kind = ShaderProgramRequestKind::Material;
    std::string material_id;
    ShaderRole role = ShaderRole::Engine2D;
    ShaderId material_shader;
    ShaderId vertex_shader;
    ShaderId fragment_shader;
    std::string variant;
    std::string vertex_path;
    std::string fragment_path;

    friend bool operator==(const ShaderProgramKey&, const ShaderProgramKey&) = default;
};

struct ShaderProgramResolution {
    ShaderProgramKey key;
    ShaderStageBinaryRef vertex;
    ShaderStageBinaryRef fragment;
    std::vector<ShaderUniformDeclaration> uniforms;
    std::vector<ShaderSamplerDeclaration> samplers;
};

struct ShaderProgramResolutionResult {
    std::optional<ShaderProgramResolution> program;
    std::vector<ShaderProgramDiagnostic> diagnostics;

    [[nodiscard]] bool ok() const noexcept { return program.has_value() && diagnostics.empty(); }
};

[[nodiscard]] ShaderProgramResolutionResult
resolve_material_shader_program(const ShaderMaterialProject& project, const MaterialId& material_id,
                                std::string_view active_variant);

[[nodiscard]] ShaderProgramResolutionResult resolve_direct_shader_pair_program(
    const ShaderMaterialProject& project, const ShaderId& vertex_shader_id,
    const ShaderId& fragment_shader_id, std::string_view active_variant);

[[nodiscard]] std::string shader_program_cache_key(const ShaderProgramKey& key);
[[nodiscard]] std::string expected_shader_binary_path(const ShaderId& shader_id, ShaderStage stage,
                                                      std::string_view variant);

[[nodiscard]] std::string_view to_string(ShaderProgramRequestKind kind) noexcept;
[[nodiscard]] std::string_view to_string(ShaderProgramDiagnosticCode code) noexcept;

} // namespace noveltea
