#include "noveltea/render/shader_compiler.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>

namespace noveltea {
namespace {

constexpr std::string_view kDefaultVaryingDefinition = R"sc(vec2 a_position  : POSITION;
vec4 a_color0     : COLOR0;
vec2 a_texcoord0  : TEXCOORD0;

vec2 v_texcoord0  : TEXCOORD0;
vec4 v_color0     : COLOR0;
)sc";

constexpr std::uint64_t fnv_offset = 14695981039346656037ull;
constexpr std::uint64_t fnv_prime = 1099511628211ull;

[[nodiscard]] bool starts_with(std::string_view value, std::string_view prefix) noexcept
{
    return value.size() >= prefix.size() && value.substr(0, prefix.size()) == prefix;
}

[[nodiscard]] std::string stage_suffix(ShaderStage stage)
{
    return stage == ShaderStage::Vertex ? "vs" : "fs";
}

[[nodiscard]] std::string shaderc_stage_type(ShaderStage stage)
{
    return stage == ShaderStage::Vertex ? "vertex" : "fragment";
}

[[nodiscard]] std::string hash_hex(std::string_view value)
{
    std::uint64_t hash = fnv_offset;
    for (const unsigned char ch : value) {
        hash ^= ch;
        hash *= fnv_prime;
    }
    std::ostringstream out;
    out << std::hex << std::setfill('0') << std::setw(16) << hash;
    return out.str();
}

[[nodiscard]] std::optional<std::string> read_text_file(const std::filesystem::path& path)
{
    std::ifstream file(path, std::ios::binary);
    if (!file)
        return std::nullopt;
    std::ostringstream buffer;
    buffer << file.rdbuf();
    if (file.bad())
        return std::nullopt;
    return buffer.str();
}

[[nodiscard]] bool write_text_file_if_changed(const std::filesystem::path& path,
                                              std::string_view value)
{
    if (const auto existing = read_text_file(path); existing && *existing == value)
        return true;
    std::filesystem::create_directories(path.parent_path());
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    if (!file)
        return false;
    file.write(value.data(), static_cast<std::streamsize>(value.size()));
    return static_cast<bool>(file);
}

[[nodiscard]] std::filesystem::path resolve_source_path(const ShaderStageDefinition& stage,
                                                        const ShaderCompileOptions& options)
{
    const std::string& source = stage.source.path;
    if (starts_with(source, "project:/"))
        return options.project_root / source.substr(std::string_view("project:/").size());
    if (starts_with(source, "system:/"))
        return options.project_root / source.substr(std::string_view("system:/").size());
    return std::filesystem::path(source);
}

[[nodiscard]] std::string shell_quote(const std::string& value)
{
    std::string quoted = "'";
    for (const char ch : value) {
        if (ch == '\'')
            quoted += "'\\''";
        else
            quoted.push_back(ch);
    }
    quoted += "'";
    return quoted;
}

[[nodiscard]] std::string command_line_from_args(const std::vector<std::string>& args)
{
    std::string command;
    for (const auto& arg : args) {
        if (!command.empty())
            command.push_back(' ');
        command += shell_quote(arg);
    }
    return command;
}

[[nodiscard]] std::string output_capture_path_key(const std::string& command_line)
{
    return hash_hex(command_line);
}

[[nodiscard]] std::string read_or_empty(const std::filesystem::path& path)
{
    if (const auto text = read_text_file(path))
        return *text;
    return {};
}

struct ProcessResult {
    int exit_code = 0;
    std::string output;
};

[[nodiscard]] ProcessResult run_command_capture(const std::vector<std::string>& args,
                                                const std::filesystem::path& cache_root)
{
    const std::string command_line = command_line_from_args(args);
    const auto capture_dir = cache_root.empty() ? std::filesystem::temp_directory_path()
                                                : cache_root / "shader-cache" / "logs";
    std::filesystem::create_directories(capture_dir);
    const auto capture_path =
        capture_dir / ("shaderc-" + output_capture_path_key(command_line) + ".txt");
    const std::string shell_command =
        command_line + " > " + shell_quote(capture_path.string()) + " 2>&1";
    const int exit_code = std::system(shell_command.c_str());
    ProcessResult result;
    result.exit_code = exit_code;
    result.output = read_or_empty(capture_path);
    std::error_code ignored;
    std::filesystem::remove(capture_path, ignored);
    return result;
}

void add_diagnostic(std::vector<ShaderCompileDiagnostic>& diagnostics,
                    ShaderCompileSeverity severity, ShaderCompileDiagnosticCode code,
                    const ShaderId& shader, ShaderStage stage, std::string variant,
                    std::filesystem::path source_path, std::filesystem::path output_path,
                    std::string command_line, int exit_code, std::string message)
{
    diagnostics.push_back(ShaderCompileDiagnostic{
        .severity = severity,
        .code = code,
        .shader = shader,
        .stage = stage,
        .variant = std::move(variant),
        .source_path = std::move(source_path),
        .output_path = std::move(output_path),
        .command_line = std::move(command_line),
        .exit_code = exit_code,
        .message = std::move(message),
    });
}

[[nodiscard]] std::string runtime_binary_path(const ShaderId& shader, ShaderStage stage,
                                              std::string_view variant)
{
    return "shaders/bgfx/" + std::string(variant) + "/" + shader.value() + "." +
           stage_suffix(stage) + ".bin";
}

[[nodiscard]] std::string interface_fingerprint(const ShaderDefinition& shader)
{
    std::ostringstream out;
    out << "shader=" << shader.id.value() << '\n';
    for (const auto& uniform : shader.uniforms) {
        out << "uniform=" << uniform.name << ':' << to_string(uniform.type) << ':'
            << uniform.editor_label << ':';
        if (uniform.binding)
            out << to_string(*uniform.binding);
        out << '\n';
    }
    for (const auto& sampler : shader.samplers)
        out << "sampler=" << sampler.name << ':' << to_string(sampler.type) << '\n';
    for (const auto role : shader.roles)
        out << "role=" << to_string(role) << '\n';
    for (const auto& binding : shader.role_bindings) {
        out << "binding=" << to_string(binding.role) << ':';
        if (binding.vertex_shader)
            out << binding.vertex_shader->value();
        out << ':';
        if (binding.fragment_shader)
            out << binding.fragment_shader->value();
        out << '\n';
    }
    return out.str();
}

[[nodiscard]] std::string compile_cache_key(const ShaderDefinition& shader,
                                            const ShaderStageDefinition& stage,
                                            const ShaderCompileVariant& variant,
                                            const ShaderCompileOptions& options,
                                            std::string_view source_text)
{
    std::ostringstream out;
    out << "shaderc=" << options.shaderc.string() << '\n';
    out << "bgfx_include=" << options.bgfx_shader_include_dir.string() << '\n';
    out << "variant=" << variant.name << ':' << variant.platform << ':' << variant.profile << '\n';
    out << "stage=" << to_string(stage.stage) << '\n';
    out << interface_fingerprint(shader);
    out << "source_path=" << stage.source.path << '\n';
    out << "source_text=" << source_text << '\n';
    return hash_hex(out.str());
}

[[nodiscard]] nlohmann::json read_cache_manifest(const std::filesystem::path& path,
                                                 std::vector<ShaderCompileDiagnostic>& diagnostics)
{
    if (path.empty() || !std::filesystem::exists(path))
        return nlohmann::json::object();
    const auto text = read_text_file(path);
    if (!text) {
        add_diagnostic(diagnostics, ShaderCompileSeverity::Warning,
                       ShaderCompileDiagnosticCode::CacheReadFailed, ShaderId{},
                       ShaderStage::Fragment, {}, {}, path, {}, 0,
                       "Failed to read shader compiler cache manifest.");
        return nlohmann::json::object();
    }
    try {
        auto manifest = nlohmann::json::parse(*text);
        return manifest.is_object() ? manifest : nlohmann::json::object();
    } catch (const nlohmann::json::parse_error&) {
        add_diagnostic(diagnostics, ShaderCompileSeverity::Warning,
                       ShaderCompileDiagnosticCode::CacheReadFailed, ShaderId{},
                       ShaderStage::Fragment, {}, {}, path, {}, 0,
                       "Failed to parse shader compiler cache manifest.");
        return nlohmann::json::object();
    }
}

void write_cache_manifest(const std::filesystem::path& path, const nlohmann::json& manifest,
                          std::vector<ShaderCompileDiagnostic>& diagnostics)
{
    if (path.empty())
        return;
    if (!write_text_file_if_changed(path, manifest.dump(2))) {
        add_diagnostic(diagnostics, ShaderCompileSeverity::Warning,
                       ShaderCompileDiagnosticCode::CacheWriteFailed, ShaderId{},
                       ShaderStage::Fragment, {}, {}, path, {}, 0,
                       "Failed to write shader compiler cache manifest.");
    }
}

[[nodiscard]] bool cache_entry_matches(const nlohmann::json& manifest,
                                       const std::string& runtime_path,
                                       const std::string& cache_key,
                                       const std::filesystem::path& output_path)
{
    const auto entry = manifest.find(runtime_path);
    return entry != manifest.end() && entry->is_object() &&
           entry->value("cacheKey", std::string{}) == cache_key &&
           std::filesystem::exists(output_path) && std::filesystem::is_regular_file(output_path);
}

void upsert_compiled_ref(ShaderStageDefinition& stage, std::string variant, std::string path)
{
    for (auto& compiled : stage.compiled) {
        if (compiled.variant == variant) {
            compiled.path = std::move(path);
            return;
        }
    }
    stage.compiled.push_back(
        ShaderCompiledBinaryRef{.variant = std::move(variant), .path = std::move(path)});
}

[[nodiscard]] std::optional<std::filesystem::path>
source_path_for_stage(const ShaderDefinition& shader, const ShaderStageDefinition& stage,
                      const ShaderCompileOptions& options,
                      std::vector<ShaderCompileDiagnostic>& diagnostics)
{
    if (!stage.source_text.empty()) {
        const auto source_key =
            hash_hex(shader.id.value() + std::string(":") + std::string(to_string(stage.stage)) +
                     ":" + stage.source_text);
        const auto source_path =
            options.cache_root / "shader-cache" / "source-text" /
            (shader.id.value() + "." + stage_suffix(stage.stage) + "." + source_key + ".sc");
        if (!write_text_file_if_changed(source_path, stage.source_text)) {
            add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                           ShaderCompileDiagnosticCode::SourceWriteFailed, shader.id, stage.stage,
                           {}, source_path, {}, {}, 0,
                           "Failed to write shader source_text to a temporary source file.");
            return std::nullopt;
        }
        return source_path;
    }

    if (stage.source.empty()) {
        add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                       ShaderCompileDiagnosticCode::MissingSource, shader.id, stage.stage, {}, {},
                       {}, {}, 0, "Shader stage has no source or source_text to compile.");
        return std::nullopt;
    }

    const auto source_path = resolve_source_path(stage, options);
    if (!std::filesystem::exists(source_path) || !std::filesystem::is_regular_file(source_path)) {
        add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                       ShaderCompileDiagnosticCode::MissingSource, shader.id, stage.stage, {},
                       source_path, {}, {}, 0,
                       "Shader source file does not exist: '" + source_path.string() + "'.");
        return std::nullopt;
    }
    return source_path;
}

[[nodiscard]] bool validate_tools(const ShaderCompileOptions& options,
                                  std::vector<ShaderCompileDiagnostic>& diagnostics)
{
    bool ok = true;
    if (options.variants.empty()) {
        add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                       ShaderCompileDiagnosticCode::InvalidVariant, ShaderId{},
                       ShaderStage::Fragment, {}, {}, {}, {}, 0,
                       "No shader compile variants were requested.");
        ok = false;
    }
    if (options.shaderc.empty() || !std::filesystem::exists(options.shaderc)) {
        add_diagnostic(
            diagnostics, ShaderCompileSeverity::Error, ShaderCompileDiagnosticCode::MissingShaderc,
            ShaderId{}, ShaderStage::Fragment, {}, options.shaderc, {}, {}, 0,
            "shaderc host executable was not found: '" + options.shaderc.string() + "'.");
        ok = false;
    }
    if (options.bgfx_shader_include_dir.empty() ||
        !std::filesystem::exists(options.bgfx_shader_include_dir / "bgfx_shader.sh")) {
        add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                       ShaderCompileDiagnosticCode::MissingBgfxInclude, ShaderId{},
                       ShaderStage::Fragment, {}, options.bgfx_shader_include_dir, {}, {}, 0,
                       "bgfx shader include directory must contain bgfx_shader.sh: '" +
                           options.bgfx_shader_include_dir.string() + "'.");
        ok = false;
    }
    return ok;
}

} // namespace

bool ShaderCompileResult::has_errors() const noexcept
{
    return std::any_of(diagnostics.begin(), diagnostics.end(), [](const auto& diagnostic) {
        return diagnostic.severity == ShaderCompileSeverity::Error;
    });
}

std::optional<ShaderCompileVariant> shader_compile_variant_from_name(std::string_view name)
{
    if (name == "glsl-120")
        return ShaderCompileVariant{.name = "glsl-120", .platform = "linux", .profile = "120"};
    if (name == "essl-100")
        return ShaderCompileVariant{.name = "essl-100", .platform = "asm.js", .profile = "100_es"};
    if (name == "essl-300")
        return ShaderCompileVariant{.name = "essl-300", .platform = "android", .profile = "300_es"};
    return std::nullopt;
}

std::vector<ShaderCompileVariant>
shader_compile_variants_from_names(const std::vector<std::string>& names,
                                   std::vector<ShaderCompileDiagnostic>* diagnostics)
{
    std::vector<ShaderCompileVariant> variants;
    for (const auto& name : names) {
        if (auto variant = shader_compile_variant_from_name(name)) {
            variants.push_back(std::move(*variant));
        } else if (diagnostics != nullptr) {
            add_diagnostic(*diagnostics, ShaderCompileSeverity::Error,
                           ShaderCompileDiagnosticCode::InvalidVariant, ShaderId{},
                           ShaderStage::Fragment, name, {}, {}, {}, 0,
                           "Unknown shader compile variant '" + name + "'.");
        }
    }
    return variants;
}

ShaderCompileResult
ShaderCompilerService::compile_shader_project(const ShaderMaterialProject& project,
                                              const ShaderCompileOptions& options) const
{
    ShaderCompileResult result;
    result.project = project;
    if (!validate_tools(options, result.diagnostics))
        return result;

    const auto manifest_path = options.cache_root / "shader-cache" / "manifest.json";
    auto cache_manifest = read_cache_manifest(manifest_path, result.diagnostics);

    for (auto& shader : result.project.shaders) {
        for (auto& stage : shader.stages) {
            auto source_path = source_path_for_stage(shader, stage, options, result.diagnostics);
            if (!source_path)
                continue;
            const auto source_text = read_text_file(*source_path);
            if (!source_text) {
                add_diagnostic(result.diagnostics, ShaderCompileSeverity::Error,
                               ShaderCompileDiagnosticCode::SourceReadFailed, shader.id,
                               stage.stage, {}, *source_path, {}, {}, 0,
                               "Failed to read shader source file: '" + source_path->string() +
                                   "'.");
                continue;
            }

            for (const auto& variant : options.variants) {
                const auto varying_path = source_path->parent_path() / "varying.def.sc";
                if (!std::filesystem::exists(varying_path) &&
                    !write_text_file_if_changed(varying_path, kDefaultVaryingDefinition)) {
                    add_diagnostic(result.diagnostics, ShaderCompileSeverity::Error,
                                   ShaderCompileDiagnosticCode::SourceWriteFailed, shader.id,
                                   stage.stage, variant.name, varying_path, {}, {}, 0,
                                   "Failed to write the default shader varying definition.");
                    continue;
                }
                const auto runtime_path = runtime_binary_path(shader.id, stage.stage, variant.name);
                const auto output_path = options.output_root / runtime_path;
                const auto cache_key =
                    compile_cache_key(shader, stage, variant, options, *source_text);

                if (!options.force_rebuild &&
                    cache_entry_matches(cache_manifest, runtime_path, cache_key, output_path)) {
                    upsert_compiled_ref(stage, variant.name, runtime_path);
                    result.outputs.push_back(ShaderCompileOutput{
                        .shader = shader.id,
                        .stage = stage.stage,
                        .variant = variant.name,
                        .source_path = *source_path,
                        .output_path = output_path,
                        .runtime_path = runtime_path,
                        .cache_key = cache_key,
                        .cache_hit = true,
                    });
                    continue;
                }

                std::filesystem::create_directories(output_path.parent_path());
                const std::vector<std::string> args = {
                    options.shaderc.string(),
                    "-f",
                    source_path->string(),
                    "-o",
                    output_path.string(),
                    "--type",
                    shaderc_stage_type(stage.stage),
                    "--platform",
                    variant.platform,
                    "--profile",
                    variant.profile,
                    "--varyingdef",
                    varying_path.string(),
                    "-i",
                    source_path->parent_path().string(),
                    "-i",
                    options.project_root.string(),
                    "-i",
                    options.bgfx_shader_include_dir.string(),
                };
                const auto command_line = command_line_from_args(args);
                const auto process = run_command_capture(args, options.cache_root);
                if (process.exit_code != 0 || !std::filesystem::exists(output_path)) {
                    add_diagnostic(result.diagnostics, ShaderCompileSeverity::Error,
                                   ShaderCompileDiagnosticCode::CompilerFailed, shader.id,
                                   stage.stage, variant.name, *source_path, output_path,
                                   command_line, process.exit_code,
                                   "shaderc failed for shader '" + shader.id.value() + "' " +
                                       std::string(to_string(stage.stage)) + " variant '" +
                                       variant.name + "'.\n" + process.output);
                    continue;
                }

                cache_manifest[runtime_path] = nlohmann::json::object({
                    {"cacheKey", cache_key},
                    {"shader", shader.id.value()},
                    {"stage", to_string(stage.stage)},
                    {"variant", variant.name},
                    {"source", source_path->generic_string()},
                });
                upsert_compiled_ref(stage, variant.name, runtime_path);
                result.outputs.push_back(ShaderCompileOutput{
                    .shader = shader.id,
                    .stage = stage.stage,
                    .variant = variant.name,
                    .source_path = *source_path,
                    .output_path = output_path,
                    .runtime_path = runtime_path,
                    .cache_key = cache_key,
                    .cache_hit = false,
                });
            }
        }
    }

    write_cache_manifest(manifest_path, cache_manifest, result.diagnostics);
    return result;
}

std::string_view to_string(ShaderCompileSeverity severity) noexcept
{
    switch (severity) {
    case ShaderCompileSeverity::Info:
        return "info";
    case ShaderCompileSeverity::Warning:
        return "warning";
    case ShaderCompileSeverity::Error:
        return "error";
    }
    return "error";
}

std::string_view to_string(ShaderCompileDiagnosticCode code) noexcept
{
    switch (code) {
    case ShaderCompileDiagnosticCode::InvalidVariant:
        return "invalid_variant";
    case ShaderCompileDiagnosticCode::MissingShaderc:
        return "missing_shaderc";
    case ShaderCompileDiagnosticCode::MissingBgfxInclude:
        return "missing_bgfx_include";
    case ShaderCompileDiagnosticCode::MissingSource:
        return "missing_source";
    case ShaderCompileDiagnosticCode::SourceReadFailed:
        return "source_read_failed";
    case ShaderCompileDiagnosticCode::SourceWriteFailed:
        return "source_write_failed";
    case ShaderCompileDiagnosticCode::CompilerFailed:
        return "compiler_failed";
    case ShaderCompileDiagnosticCode::CacheReadFailed:
        return "cache_read_failed";
    case ShaderCompileDiagnosticCode::CacheWriteFailed:
        return "cache_write_failed";
    }
    return "compiler_failed";
}

} // namespace noveltea
