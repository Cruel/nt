#pragma once

#include "noveltea/render/material.hpp"

#include <filesystem>
#include <optional>
#include <string>
#include <vector>

namespace noveltea {

enum class ShaderCompileSeverity {
    Info,
    Warning,
    Error,
};

enum class ShaderCompileDiagnosticCode {
    InvalidVariant,
    MissingShaderc,
    MissingBgfxInclude,
    MissingSource,
    SourceReadFailed,
    SourceWriteFailed,
    CompilerFailed,
    CacheReadFailed,
    CacheWriteFailed,
};

struct ShaderCompileVariant {
    std::string name;
    std::string platform;
    std::string profile;
};

struct ShaderCompileDiagnostic {
    ShaderCompileSeverity severity = ShaderCompileSeverity::Error;
    ShaderCompileDiagnosticCode code = ShaderCompileDiagnosticCode::CompilerFailed;
    ShaderId shader;
    ShaderStage stage = ShaderStage::Fragment;
    std::string variant;
    std::filesystem::path source_path;
    std::filesystem::path output_path;
    std::string command_line;
    int exit_code = 0;
    std::string message;
};

struct ShaderCompileOptions {
    std::filesystem::path shaderc;
    std::filesystem::path bgfx_shader_include_dir;
    std::filesystem::path project_root;
    std::filesystem::path output_root;
    std::filesystem::path cache_root;
    std::vector<ShaderCompileVariant> variants;
    bool force_rebuild = false;
};

struct ShaderCompileOutput {
    ShaderId shader;
    ShaderStage stage = ShaderStage::Fragment;
    std::string variant;
    std::filesystem::path source_path;
    std::filesystem::path output_path;
    std::string runtime_path;
    std::string cache_key;
    bool cache_hit = false;
};

struct ShaderCompileResult {
    ShaderMaterialProject project;
    std::vector<ShaderCompileOutput> outputs;
    std::vector<ShaderCompileDiagnostic> diagnostics;

    [[nodiscard]] bool has_errors() const noexcept;
    [[nodiscard]] bool success() const noexcept { return !has_errors(); }
};

[[nodiscard]] std::optional<ShaderCompileVariant>
shader_compile_variant_from_name(std::string_view name);

[[nodiscard]] std::vector<ShaderCompileVariant>
shader_compile_variants_from_names(const std::vector<std::string>& names,
                                   std::vector<ShaderCompileDiagnostic>* diagnostics = nullptr);

class ShaderCompilerService {
public:
    [[nodiscard]] ShaderCompileResult
    compile_shader_project(const ShaderMaterialProject& project,
                           const ShaderCompileOptions& options) const;
};

[[nodiscard]] std::string_view to_string(ShaderCompileSeverity severity) noexcept;
[[nodiscard]] std::string_view to_string(ShaderCompileDiagnosticCode code) noexcept;

} // namespace noveltea
