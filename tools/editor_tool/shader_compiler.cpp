#include "noveltea/render/shader_compiler.hpp"
#include "noveltea/core/player_bootstrap.hpp"

#include <nlohmann/json.hpp>

#if NOVELTEA_HAS_EMBEDDED_SHADERC
#include "embedded_bgfx_resources.hpp"
#include <bx/error.h>
#include <bx/readerwriter.h>
#include <shaderc.h>

namespace bgfx {
bool compileShader(const char* varying, const char* comment, char* shader, std::uint32_t shader_len,
                   const Options& options, bx::WriterI* shader_writer,
                   bx::WriterI* message_writer);
}
#endif

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <memory>
#include <optional>
#include <span>
#include <sstream>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

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

[[nodiscard]] std::string path_utf8(const std::filesystem::path& path)
{
    const auto encoded = path.generic_u8string();
    return std::string(reinterpret_cast<const char*>(encoded.data()), encoded.size());
}

[[nodiscard]] std::filesystem::path path_from_utf8(std::string_view value)
{
#if defined(_WIN32)
    if (value.empty())
        return {};
    const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                             static_cast<int>(value.size()), nullptr, 0);
    if (required <= 0)
        return {};
    std::wstring wide(static_cast<std::size_t>(required), L'\0');
    const int written = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                            static_cast<int>(value.size()), wide.data(), required);
    if (written != required)
        return {};
    return std::filesystem::path(std::move(wide));
#else
    return std::filesystem::path(value);
#endif
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

[[nodiscard]] std::string content_hash(std::string_view value)
{
    return "sha256:" +
           core::sha256_hex(std::as_bytes(std::span(value.data(), value.size())));
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
    std::error_code directory_error;
    std::filesystem::create_directories(path.parent_path(), directory_error);
    if (directory_error)
        return false;
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
    return path_from_utf8(source);
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

struct ProcessResult {
    int exit_code = 0;
    std::string output;
};

#if NOVELTEA_HAS_EMBEDDED_SHADERC
class VectorWriter final : public bx::WriterI {
public:
    int32_t write(const void* data, int32_t size, bx::Error*) override
    {
        if (size <= 0)
            return 0;
        const auto* bytes = static_cast<const char*>(data);
        value.append(bytes, static_cast<std::size_t>(size));
        return size;
    }

    std::string value;
};

[[nodiscard]] std::string embedded_toolchain_hash()
{
    static const std::string value = core::sha256_hex(std::as_bytes(std::span(
        embedded_bgfx::shader_sha256.data(), embedded_bgfx::shader_sha256.size()))) +
                                     core::sha256_hex(std::as_bytes(std::span(
                                         embedded_bgfx::compute_sha256.data(),
                                         embedded_bgfx::compute_sha256.size())));
    return core::sha256_hex(std::as_bytes(std::span(value.data(), value.size())));
}

[[nodiscard]] std::string embedded_engine_shader_hash()
{
    std::string identity;
    for (const auto& resource : embedded_bgfx::engine_shader_resources) {
        identity += resource.name;
        identity.push_back('=');
        identity += resource.sha256;
        identity.push_back('\n');
    }
    return core::sha256_hex(std::as_bytes(std::span(identity.data(), identity.size())));
}

[[nodiscard]] std::optional<std::filesystem::path>
materialize_embedded_engine_shader_resources(const std::filesystem::path& cache_root)
{
    const auto root = cache_root / "toolchain" / "noveltea-shaders" / embedded_engine_shader_hash();
    for (const auto& resource : embedded_bgfx::engine_shader_resources) {
        const auto text = std::string_view(reinterpret_cast<const char*>(resource.bytes.data()),
                                           resource.bytes.size());
        const auto path = root / resource.name;
        if (!write_text_file_if_changed(path, text))
            return std::nullopt;
        const auto check = read_text_file(path);
        if (!check)
            return std::nullopt;
        const auto hash = core::sha256_hex(std::as_bytes(std::span(check->data(), check->size())));
        if (hash != resource.sha256)
            return std::nullopt;
    }
    return root;
}

[[nodiscard]] std::optional<std::filesystem::path>
materialize_embedded_bgfx_resources(const std::filesystem::path& cache_root)
{
    const auto root = cache_root / "toolchain" / "bgfx" / embedded_toolchain_hash();
    const auto shader = std::string_view(
        reinterpret_cast<const char*>(embedded_bgfx::shader_bytes), sizeof(embedded_bgfx::shader_bytes));
    const auto compute = std::string_view(reinterpret_cast<const char*>(embedded_bgfx::compute_bytes),
                                          sizeof(embedded_bgfx::compute_bytes));
    if (!write_text_file_if_changed(root / "bgfx_shader.sh", shader) ||
        !write_text_file_if_changed(root / "bgfx_compute.sh", compute)) {
        return std::nullopt;
    }
    const auto shader_check = read_text_file(root / "bgfx_shader.sh");
    const auto compute_check = read_text_file(root / "bgfx_compute.sh");
    if (!shader_check || !compute_check)
        return std::nullopt;
    const auto shader_hash = core::sha256_hex(
        std::as_bytes(std::span(shader_check->data(), shader_check->size())));
    const auto compute_hash = core::sha256_hex(
        std::as_bytes(std::span(compute_check->data(), compute_check->size())));
    if (shader_hash != embedded_bgfx::shader_sha256 || compute_hash != embedded_bgfx::compute_sha256)
        return std::nullopt;
    return root;
}

#if defined(_WIN32)
[[nodiscard]] bool shader_include_candidate(const std::filesystem::path& path)
{
    const auto extension = path.extension().generic_string();
    return extension == ".sc" || extension == ".glsl" || extension == ".vert" ||
           extension == ".frag" || extension == ".vs" || extension == ".fs" ||
           extension == ".sh" || extension == ".inc";
}

[[nodiscard]] bool copy_shader_include_tree(const std::filesystem::path& source_root,
                                            const std::filesystem::path& destination_root)
{
    std::error_code root_error;
    if (!std::filesystem::is_directory(source_root, root_error) || root_error)
        return true;

    std::error_code iteration_error;
    std::filesystem::recursive_directory_iterator iterator(
        source_root, std::filesystem::directory_options::skip_permission_denied, iteration_error);
    const std::filesystem::recursive_directory_iterator end;
    while (!iteration_error && iterator != end) {
        const auto entry = *iterator;
        std::error_code type_error;
        if (entry.is_regular_file(type_error) && !type_error && shader_include_candidate(entry.path())) {
            std::error_code relative_error;
            const auto relative = std::filesystem::relative(entry.path(), source_root, relative_error);
            if (relative_error)
                return false;
            const auto destination = destination_root / relative;
            std::error_code directory_error;
            std::filesystem::create_directories(destination.parent_path(), directory_error);
            if (directory_error)
                return false;
            std::error_code copy_error;
            std::filesystem::copy_file(entry.path(), destination,
                                       std::filesystem::copy_options::overwrite_existing, copy_error);
            if (copy_error)
                return false;
        }
        iterator.increment(iteration_error);
    }
    return !iteration_error;
}

struct ScopedDirectoryCleanup {
    std::filesystem::path path;
    ~ScopedDirectoryCleanup()
    {
        std::error_code error;
        std::filesystem::remove_all(path, error);
    }
};

[[nodiscard]] std::optional<std::filesystem::path>
narrow_shaderc_stage_path(const std::filesystem::path& native_path)
{
    const auto utf8 = path_utf8(native_path);
    if (std::all_of(utf8.begin(), utf8.end(), [](unsigned char ch) { return ch < 0x80; }))
        return native_path;

    const DWORD required = GetShortPathNameW(native_path.c_str(), nullptr, 0);
    if (required == 0)
        return std::nullopt;
    std::wstring short_path(static_cast<std::size_t>(required), L'\0');
    const DWORD written = GetShortPathNameW(native_path.c_str(), short_path.data(), required);
    if (written == 0 || written >= required)
        return std::nullopt;
    short_path.resize(static_cast<std::size_t>(written));
    const std::filesystem::path alias(std::move(short_path));
    const auto alias_utf8 = path_utf8(alias);
    if (!std::all_of(alias_utf8.begin(), alias_utf8.end(), [](unsigned char ch) { return ch < 0x80; }))
        return std::nullopt;
    return alias;
}
#endif

[[nodiscard]] ProcessResult run_embedded_shaderc(
    const std::vector<std::string>& args, ShaderStage stage, const ShaderCompileVariant& variant,
    const std::filesystem::path& source_path, const std::filesystem::path& output_path,
    const std::filesystem::path& varying_path,
    const std::vector<std::filesystem::path>& include_roots)
{
    const auto source = read_text_file(source_path);
    const auto varying = read_text_file(varying_path);
    if (!source || !varying)
        return {.exit_code = -1, .output = "failed to read shader source or varying definition"};

    std::string normalized_source = *source;
    if (normalized_source.size() >= 3 &&
        static_cast<unsigned char>(normalized_source[0]) == 0xef &&
        static_cast<unsigned char>(normalized_source[1]) == 0xbb &&
        static_cast<unsigned char>(normalized_source[2]) == 0xbf) {
        normalized_source.erase(0, 3);
    }
    const auto source_size = static_cast<std::uint32_t>(normalized_source.size());
    constexpr std::size_t shaderc_padding = 16384;
    auto mutable_source = std::make_unique<char[]>(normalized_source.size() + shaderc_padding + 1);
    std::memcpy(mutable_source.get(), normalized_source.data(), normalized_source.size());
    std::memset(mutable_source.get() + normalized_source.size(), 0, shaderc_padding + 1);

    bgfx::Options native_options;
    native_options.shaderType = stage == ShaderStage::Vertex ? 'v' : 'f';
    native_options.platform = variant.platform;
    native_options.profile = variant.profile;
#if defined(_WIN32)
    const auto stage_key = hash_hex(path_utf8(source_path) + ":" + variant.name + ":" +
                                    std::string(to_string(stage)));
    const auto stage_root =
        std::filesystem::temp_directory_path() / "noveltea-shaderc" / stage_key;
    ScopedDirectoryCleanup stage_cleanup{stage_root};
    std::error_code reset_error;
    std::filesystem::remove_all(stage_root, reset_error);
    std::error_code stage_error;
    std::filesystem::create_directories(stage_root, stage_error);
    if (stage_error)
        return {.exit_code = -1, .output = "failed to create narrow shaderc staging directory"};

    const auto staged_source_root = stage_root / "source";
    if (!copy_shader_include_tree(source_path.parent_path(), staged_source_root))
        return {.exit_code = -1, .output = "failed to stage shader include inputs"};
    std::vector<std::filesystem::path> staged_include_roots;
    staged_include_roots.reserve(include_roots.size());
    for (std::size_t index = 0; index < include_roots.size(); ++index) {
        const auto staged_root = stage_root / ("include-" + std::to_string(index));
        if (!copy_shader_include_tree(include_roots[index], staged_root))
            return {.exit_code = -1, .output = "failed to stage shader include inputs"};
        staged_include_roots.push_back(staged_root);
    }
    const auto staged_input = staged_source_root / "input.sc";
    if (!write_text_file_if_changed(staged_input, normalized_source))
        return {.exit_code = -1, .output = "failed to stage shader source"};

    const auto narrow_root = narrow_shaderc_stage_path(stage_root);
    if (!narrow_root)
        return {.exit_code = -1,
                .output = "Windows temporary path cannot be represented safely for embedded shaderc"};
    native_options.inputFilePath = path_utf8(*narrow_root / "source" / "input.sc");
    native_options.outputFilePath = path_utf8(*narrow_root / "output.bin");
    native_options.includeDirs = {path_utf8(*narrow_root / "source")};
    for (const auto& root : staged_include_roots)
        native_options.includeDirs.push_back(path_utf8(*narrow_root / root.lexically_relative(stage_root)));
#else
    native_options.inputFilePath = path_utf8(source_path);
    native_options.outputFilePath = path_utf8(output_path);
    native_options.includeDirs = {path_utf8(source_path.parent_path())};
    for (const auto& root : include_roots)
        native_options.includeDirs.push_back(path_utf8(root));
#endif

    std::string comment = "// shaderc command line:\n//";
    for (const auto& arg : args) {
        comment += " ";
        comment += arg;
    }
    comment += "\n\n";

    VectorWriter binary_writer;
    VectorWriter message_writer;
    // The pinned bgfx structured compiler takes ownership of the input buffer and
    // deletes it after preprocessing, matching its argc/argv frontend.
    const bool compiled = bgfx::compileShader(varying->c_str(), comment.c_str(),
                                              mutable_source.release(), source_size, native_options,
                                              &binary_writer, &message_writer);
    if (!compiled)
        return {.exit_code = 1, .output = std::move(message_writer.value)};
    if (!write_text_file_if_changed(output_path, binary_writer.value))
        return {.exit_code = -1, .output = "failed to write embedded shaderc output"};
    return {.exit_code = 0, .output = std::move(message_writer.value)};
}
#endif

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
    return "project:/shaders/bgfx/" + std::string(variant) + "/" + shader.string() + "." +
           stage_suffix(stage) + ".bin";
}

[[nodiscard]] std::string package_binary_path(const ShaderId& shader, ShaderStage stage,
                                              std::string_view variant)
{
    return "shaders/bgfx/" + std::string(variant) + "/" + shader.string() + "." +
           stage_suffix(stage) + ".bin";
}

[[nodiscard]] std::string interface_fingerprint(const ShaderDefinition& shader)
{
    std::ostringstream out;
    out << "shader=" << shader.id.string() << '\n';
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
#if NOVELTEA_HAS_EMBEDDED_SHADERC
    out << "shaderc=embedded-bgfx-" NOVELTEA_BGFX_VERSION_STRING "\n";
    out << "bgfx_resources=" << embedded_toolchain_hash() << '\n';
#else
    out << "shaderc=unavailable\n";
#endif
    out << "variant=" << variant.name << ':' << variant.platform << ':' << variant.profile << '\n';
    out << "stage=" << to_string(stage.stage) << '\n';
    out << interface_fingerprint(shader);
    out << "source_path=" << stage.source.path << '\n';
    out << "source_text=" << source_text << '\n';
    return hash_hex(out.str());
}

struct ResolvedSourceFile {
    std::filesystem::path path;
    std::string identity;
};

[[nodiscard]] bool path_within_root(const std::filesystem::path& path,
                                    const std::filesystem::path& root)
{
    std::error_code root_error;
    std::error_code path_error;
    const auto canonical_root = std::filesystem::weakly_canonical(root, root_error);
    const auto canonical_path = std::filesystem::weakly_canonical(path, path_error);
    if (root_error || path_error)
        return false;
    auto root_it = canonical_root.begin();
    auto path_it = canonical_path.begin();
    for (; root_it != canonical_root.end(); ++root_it, ++path_it) {
        if (path_it == canonical_path.end() || *path_it != *root_it)
            return false;
    }
    return true;
}

[[nodiscard]] std::optional<ResolvedSourceFile>
resolve_source_identity(std::string_view identity, const ShaderCompileOptions& options,
                        ShaderStage stage, std::vector<ShaderCompileDiagnostic>& diagnostics)
{
    std::filesystem::path root;
    std::string_view relative;
    if (starts_with(identity, "project:/")) {
        if (!starts_with(identity, "project:/shaders/")) {
            add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                           ShaderCompileDiagnosticCode::InvalidSourcePath, ShaderId{}, stage, {}, {},
                           {}, {}, 0, "Project shader sources must live below project:/shaders/.");
            return std::nullopt;
        }
        root = options.project_root / "shaders";
        relative = identity.substr(std::string_view("project:/shaders/").size());
    } else if (starts_with(identity, "engine:/")) {
        root = options.engine_shader_root;
        relative = identity.substr(std::string_view("engine:/").size());
        if (root.empty()) {
            add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                           ShaderCompileDiagnosticCode::InvalidSourcePath, ShaderId{}, stage, {}, {},
                           {}, {}, 0, "Engine shader source root is not configured.");
            return std::nullopt;
        }
    } else {
        add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                       ShaderCompileDiagnosticCode::InvalidSourcePath, ShaderId{}, stage, {}, {}, {},
                       {}, 0, "Shader source identity must use project:/shaders/ or engine:/.");
        return std::nullopt;
    }

    const auto candidate = root / path_from_utf8(relative);
    if (!path_within_root(candidate, root)) {
        add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                       ShaderCompileDiagnosticCode::InvalidSourcePath, ShaderId{}, stage, {},
                       candidate, {}, {}, 0, "Shader source path escapes its declared source root.");
        return std::nullopt;
    }
    std::error_code exists_error;
    if (!std::filesystem::is_regular_file(candidate, exists_error) || exists_error) {
        add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                       ShaderCompileDiagnosticCode::MissingSource, ShaderId{}, stage, {}, candidate,
                       {}, {}, 0, "Shader source file does not exist: '" + path_utf8(candidate) + "'.");
        return std::nullopt;
    }
    return ResolvedSourceFile{.path = candidate, .identity = std::string(identity)};
}

[[nodiscard]] std::optional<std::string> include_target(std::string_view line)
{
    const auto first = line.find_first_not_of(" \t");
    if (first == std::string_view::npos)
        return std::nullopt;
    line.remove_prefix(first);
    if (line.empty() || line.front() != '#')
        return std::nullopt;
    line.remove_prefix(1);
    const auto directive_start = line.find_first_not_of(" \t");
    if (directive_start == std::string_view::npos)
        return std::nullopt;
    line.remove_prefix(directive_start);
    constexpr std::string_view include_directive = "include";
    if (!starts_with(line, include_directive))
        return std::nullopt;
    auto rest = line.substr(include_directive.size());
    if (!rest.empty() && rest.front() != ' ' && rest.front() != '\t' && rest.front() != '"' &&
        rest.front() != '<') {
        return std::nullopt;
    }
    const auto begin = rest.find_first_of("\"<");
    if (begin == std::string_view::npos)
        return std::nullopt;
    const char close = rest[begin] == '"' ? '"' : '>';
    const auto end = rest.find(close, begin + 1);
    if (end == std::string_view::npos)
        return std::nullopt;
    return std::string(rest.substr(begin + 1, end - begin - 1));
}

[[nodiscard]] std::string source_identity_for_path(const std::filesystem::path& path,
                                                   const ShaderCompileOptions& options)
{
    const auto project_root = options.project_root / "shaders";
    if (path_within_root(path, project_root)) {
        std::error_code error;
        const auto relative = std::filesystem::relative(path, project_root, error);
        if (!error)
            return "project:/shaders/" + path_utf8(relative);
    }
    if (!options.engine_shader_root.empty() && path_within_root(path, options.engine_shader_root)) {
        std::error_code error;
        const auto relative = std::filesystem::relative(path, options.engine_shader_root, error);
        if (!error)
            return "engine:/" + path_utf8(relative);
    }
    return {};
}

[[nodiscard]] bool collect_source_dependencies(
    const ResolvedSourceFile& source, const ShaderCompileOptions& options,
    std::vector<std::pair<std::string, std::string>>& dependencies,
    std::vector<ShaderCompileDiagnostic>& diagnostics, ShaderStage stage)
{
    if (std::any_of(dependencies.begin(), dependencies.end(), [&](const auto& dependency) {
            return dependency.first == source.identity;
        })) {
        return true;
    }
    const auto text = read_text_file(source.path);
    if (!text) {
        add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                       ShaderCompileDiagnosticCode::SourceReadFailed, ShaderId{}, stage, {},
                       source.path, {}, {}, 0, "Failed to read shader source dependency.");
        return false;
    }
    dependencies.emplace_back(source.identity, *text);

    std::istringstream lines(*text);
    std::string line;
    while (std::getline(lines, line)) {
        const auto target = include_target(line);
        if (!target || *target == "bgfx_shader.sh" || *target == "bgfx_compute.sh")
            continue;
        const auto include_path = path_from_utf8(*target);
        if (include_path.is_absolute()) {
            add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                           ShaderCompileDiagnosticCode::UnsafeIncludePath, ShaderId{}, stage, {},
                           source.path, {}, {}, 0, "Absolute shader include paths are not allowed.");
            return false;
        }

        std::vector<std::filesystem::path> candidates = {source.path.parent_path() / include_path,
                                                         options.project_root / "shaders" / include_path};
        if (!options.engine_shader_root.empty())
            candidates.push_back(options.engine_shader_root / include_path);

        std::optional<std::filesystem::path> resolved;
        for (const auto& candidate : candidates) {
            const bool allowed = path_within_root(candidate, options.project_root / "shaders") ||
                                 (!options.engine_shader_root.empty() &&
                                  path_within_root(candidate, options.engine_shader_root));
            if (!allowed)
                continue;
            std::error_code error;
            if (std::filesystem::is_regular_file(candidate, error) && !error) {
                resolved = candidate;
                break;
            }
        }
        if (!resolved) {
            const auto lexical_candidate = source.path.parent_path() / include_path;
            if (!path_within_root(lexical_candidate, options.project_root / "shaders") &&
                (options.engine_shader_root.empty() ||
                 !path_within_root(lexical_candidate, options.engine_shader_root))) {
                add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                               ShaderCompileDiagnosticCode::UnsafeIncludePath, ShaderId{}, stage, {},
                               source.path, {}, {}, 0,
                               "Shader include escapes the project and engine shader roots: '" +
                                   *target + "'.");
            } else {
                add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                               ShaderCompileDiagnosticCode::MissingSource, ShaderId{}, stage, {},
                               source.path, {}, {}, 0,
                               "Shader include could not be resolved: '" + *target + "'.");
            }
            return false;
        }
        const auto identity = source_identity_for_path(*resolved, options);
        if (identity.empty()) {
            add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                           ShaderCompileDiagnosticCode::UnsafeIncludePath, ShaderId{}, stage, {},
                           *resolved, {}, {}, 0, "Resolved shader include is outside allowed roots.");
            return false;
        }
        const ResolvedSourceFile dependency{.path = *resolved, .identity = identity};
        if (!collect_source_dependencies(dependency, options, dependencies, diagnostics, stage))
            return false;
    }
    return true;
}

[[nodiscard]] std::string source_dependency_fingerprint(
    const std::vector<std::pair<std::string, std::string>>& dependencies)
{
    std::ostringstream out;
    for (const auto& [identity, text] : dependencies)
        out << identity << '\n' << text << "\n--dependency--\n";
    return out.str();
}

struct ReflectedShaderBinary {
    std::vector<ShaderReflectedInput> inputs;
    std::optional<std::string> source_payload;
};

[[nodiscard]] std::optional<ReflectedShaderBinary>
reflect_shader_binary(const std::filesystem::path& path)
{
    const auto bytes = read_text_file(path);
    if (!bytes || bytes->size() < 18)
        return std::nullopt;
    const auto* data = reinterpret_cast<const unsigned char*>(bytes->data());
    // bgfx shader binaries begin with magic + input/output hashes, followed by
    // RawBindings (srv/uav) before the reflected uniform table.
    std::size_t offset = 20;
    const auto read_u8 = [&]() -> std::optional<std::uint8_t> {
        if (offset + 1 > bytes->size())
            return std::nullopt;
        return data[offset++];
    };
    const auto read_u16 = [&]() -> std::optional<std::uint16_t> {
        if (offset + 2 > bytes->size())
            return std::nullopt;
        const auto value = static_cast<std::uint16_t>(data[offset]) |
                           (static_cast<std::uint16_t>(data[offset + 1]) << 8);
        offset += 2;
        return value;
    };
    const auto read_u32 = [&]() -> std::optional<std::uint32_t> {
        if (offset + 4 > bytes->size())
            return std::nullopt;
        const auto value = static_cast<std::uint32_t>(data[offset]) |
                           (static_cast<std::uint32_t>(data[offset + 1]) << 8) |
                           (static_cast<std::uint32_t>(data[offset + 2]) << 16) |
                           (static_cast<std::uint32_t>(data[offset + 3]) << 24);
        offset += 4;
        return value;
    };

    const auto uniform_count = read_u16();
    if (!uniform_count)
        return std::nullopt;
    ReflectedShaderBinary reflected;
    for (std::uint16_t index = 0; index < *uniform_count; ++index) {
        const auto name_size = read_u8();
        if (!name_size || offset + *name_size > bytes->size())
            return std::nullopt;
        std::string name(bytes->data() + offset, *name_size);
        offset += *name_size;
        const auto type = read_u8();
        const auto array_size = read_u8();
        const auto register_index = read_u16();
        const auto register_count = read_u16();
        const auto texture_component = read_u8();
        const auto texture_dimension = read_u8();
        const auto texture_format = read_u16();
        (void)register_index;
        (void)register_count;
        (void)texture_component;
        (void)texture_dimension;
        (void)texture_format;
        if (!type || !array_size)
            return std::nullopt;
        constexpr std::uint8_t uniform_flag_mask = 0xf0u;
        constexpr std::uint8_t sampler_bit = 0x20u;
        const auto base_type = static_cast<std::uint8_t>(*type & ~uniform_flag_mask);
        const bool sampler = ((*type) & sampler_bit) != 0u || base_type == 0u;
        std::string type_name;
        switch (base_type) {
        case 0:
            type_name = "sampler";
            break;
        case 2:
            type_name = "vec4";
            break;
        case 3:
            type_name = "mat3";
            break;
        case 4:
            type_name = "mat4";
            break;
        default:
            type_name = "unknown";
            break;
        }
        reflected.inputs.push_back(ShaderReflectedInput{
            .name = std::move(name),
            .kind = sampler ? ShaderReflectedInputKind::SampledImage
                            : ShaderReflectedInputKind::Uniform,
            .type = std::move(type_name),
            .array_size = *array_size,
        });
    }

    // Metal shaderc binaries expose a combined sampler as three reflected records:
    // `<name>Sampler`, `<name>Texture`, and the original sampled-image name. The two
    // companions are backend implementation details, while the original record uses
    // an array count of zero for a non-array sampler. Normalize that backend encoding
    // to the logical shader interface shared by the other renderer variants.
    std::vector<std::string> sampled_images;
    for (auto& input : reflected.inputs) {
        if (input.kind != ShaderReflectedInputKind::SampledImage)
            continue;
        if (input.array_size == 0)
            input.array_size = 1;
        sampled_images.push_back(input.name);
    }
    reflected.inputs.erase(
        std::remove_if(reflected.inputs.begin(), reflected.inputs.end(),
                       [&sampled_images](const ShaderReflectedInput& input) {
                           if (input.kind != ShaderReflectedInputKind::Uniform ||
                               input.type != "unknown")
                               return false;
                           const std::string_view name = input.name;
                           std::string_view logical_name;
                           if (name.ends_with("Sampler"))
                               logical_name = name.substr(0, name.size() - std::string_view("Sampler").size());
                           else if (name.ends_with("Texture"))
                               logical_name = name.substr(0, name.size() - std::string_view("Texture").size());
                           else
                               return false;
                           return std::find(sampled_images.begin(), sampled_images.end(), logical_name) !=
                                  sampled_images.end();
                       }),
        reflected.inputs.end());

    const auto payload_size = read_u32();
    if (!payload_size || offset + *payload_size > bytes->size())
        return std::nullopt;
    reflected.source_payload = std::string(bytes->data() + offset, *payload_size);
    while (reflected.source_payload && !reflected.source_payload->empty() &&
           reflected.source_payload->back() == '\0') {
        reflected.source_payload->pop_back();
    }
    return reflected;
}

struct CompiledBinaryMetadata {
    std::string byte_hash;
    std::uint64_t byte_size = 0;
};

[[nodiscard]] std::optional<CompiledBinaryMetadata>
compiled_binary_metadata(const std::filesystem::path& path)
{
    const auto bytes = read_text_file(path);
    if (!bytes)
        return std::nullopt;
    return CompiledBinaryMetadata{
        .byte_hash =
            "sha256:" + core::sha256_hex(std::as_bytes(std::span(bytes->data(), bytes->size()))),
        .byte_size = static_cast<std::uint64_t>(bytes->size()),
    };
}

[[nodiscard]] nlohmann::json read_cache_manifest(const std::filesystem::path& path,
                                                 std::vector<ShaderCompileDiagnostic>& diagnostics)
{
    std::error_code exists_error;
    if (path.empty() || !std::filesystem::exists(path, exists_error) || exists_error)
        return nlohmann::json::object();
    const auto text = read_text_file(path);
    if (!text) {
        add_diagnostic(diagnostics, ShaderCompileSeverity::Warning,
                       ShaderCompileDiagnosticCode::CacheReadFailed, ShaderId{},
                       ShaderStage::Fragment, {}, {}, path, {}, 0,
                       "Failed to read shader compiler cache manifest.");
        return nlohmann::json::object();
    }
    auto manifest = nlohmann::json::parse(*text, nullptr, false);
    if (manifest.is_discarded() || !manifest.is_object()) {
        add_diagnostic(diagnostics, ShaderCompileSeverity::Warning,
                       ShaderCompileDiagnosticCode::CacheReadFailed, ShaderId{},
                       ShaderStage::Fragment, {}, {}, path, {}, 0,
                       "Failed to parse shader compiler cache manifest.");
        return nlohmann::json::object();
    }
    return manifest;
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
    std::error_code exists_error;
    const bool exists = std::filesystem::exists(output_path, exists_error);
    std::error_code regular_error;
    const bool regular = std::filesystem::is_regular_file(output_path, regular_error);
    return entry != manifest.end() && entry->is_object() &&
           entry->value("cacheKey", std::string{}) == cache_key && exists && !exists_error &&
           regular && !regular_error;
}

void upsert_compiled_ref(ShaderStageDefinition& stage, std::string variant, std::string path,
                         const CompiledBinaryMetadata& metadata)
{
    for (auto& compiled : stage.compiled) {
        if (compiled.variant == variant) {
            compiled.path = std::move(path);
            compiled.byte_hash = metadata.byte_hash;
            compiled.byte_size = metadata.byte_size;
            return;
        }
    }
    stage.compiled.emplace_back(std::move(variant), std::move(path), metadata.byte_hash,
                                metadata.byte_size);
}

[[nodiscard]] std::optional<std::filesystem::path>
source_path_for_stage(const ShaderDefinition& shader, const ShaderStageDefinition& stage,
                      const ShaderCompileOptions& options,
                      std::vector<ShaderCompileDiagnostic>& diagnostics)
{
    if (!stage.source_text.empty()) {
        const auto source_key =
            hash_hex(shader.id.string() + std::string(":") + std::string(to_string(stage.stage)) +
                     ":" + stage.source_text);
        const auto source_path =
            options.cache_root / "shader-cache" / "source-text" /
            (shader.id.string() + "." + stage_suffix(stage.stage) + "." + source_key + ".sc");
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
    std::error_code exists_error;
    const bool exists = std::filesystem::exists(source_path, exists_error);
    std::error_code regular_error;
    const bool regular = std::filesystem::is_regular_file(source_path, regular_error);
    if (!exists || exists_error || !regular || regular_error) {
        add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                       ShaderCompileDiagnosticCode::MissingSource, shader.id, stage.stage, {},
                       source_path, {}, {}, 0,
                       "Shader source file does not exist: '" + path_utf8(source_path) + "'.");
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
#if NOVELTEA_HAS_EMBEDDED_SHADERC
    if (!materialize_embedded_bgfx_resources(options.cache_root)) {
        add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                       ShaderCompileDiagnosticCode::MissingBgfxInclude, ShaderId{},
                       ShaderStage::Fragment, {}, options.cache_root, {}, {}, 0,
                       "Embedded bgfx shader resources could not be materialized and verified.");
        ok = false;
    }
#else
    add_diagnostic(diagnostics, ShaderCompileSeverity::Error,
                   ShaderCompileDiagnosticCode::MissingShaderc, ShaderId{}, ShaderStage::Fragment,
                   {}, {}, {}, {}, 0,
                   "This build does not contain the embedded bgfx shader compiler.");
    ok = false;
#endif
    return ok;
}

} // namespace

bool ShaderCompileResult::has_errors() const noexcept
{
    return std::any_of(diagnostics.begin(), diagnostics.end(), [](const auto& diagnostic) {
        return diagnostic.severity == ShaderCompileSeverity::Error;
    });
}

bool ShaderSourceProgramCompileResult::has_errors() const noexcept
{
    return std::any_of(diagnostics.begin(), diagnostics.end(), [](const auto& diagnostic) {
        return diagnostic.severity == ShaderCompileSeverity::Error;
    });
}

std::optional<ShaderCompileVariant> shader_compile_variant_from_name(std::string_view name)
{
    if (name == "glsl-330")
        return ShaderCompileVariant{.name = "glsl-330", .platform = "linux", .profile = "330"};
    if (name == "essl-300")
        return ShaderCompileVariant{.name = "essl-300", .platform = "android", .profile = "300_es"};
    if (name == "metal")
        return ShaderCompileVariant{.name = "metal", .platform = "osx", .profile = "metal"};
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

ShaderSourceProgramCompileResult ShaderCompilerService::compile_source_program(
    const ShaderSourceProgramRequest& request, const ShaderCompileOptions& options) const
{
    ShaderSourceProgramCompileResult result;
    if (!validate_tools(options, result.diagnostics))
        return result;

    ShaderCompileOptions effective_options = options;
#if NOVELTEA_HAS_EMBEDDED_SHADERC
    const auto embedded_include_root = materialize_embedded_bgfx_resources(options.cache_root);
    if (!embedded_include_root)
        return result;
    if (effective_options.engine_shader_root.empty()) {
        const auto embedded_engine_root =
            materialize_embedded_engine_shader_resources(options.cache_root);
        if (!embedded_engine_root) {
            add_diagnostic(result.diagnostics, ShaderCompileSeverity::Error,
                           ShaderCompileDiagnosticCode::SourceWriteFailed, ShaderId{},
                           ShaderStage::Fragment, {}, {}, {}, {}, 0,
                           "Failed to materialize embedded NovelTea engine shader sources.");
            return result;
        }
        effective_options.engine_shader_root = *embedded_engine_root;
    }
#else
    const std::filesystem::path embedded_include_root;
#endif

    if (request.vertex_source.empty() && request.fragment_source.empty()) {
        add_diagnostic(result.diagnostics, ShaderCompileSeverity::Error,
                       ShaderCompileDiagnosticCode::MissingSource, ShaderId{}, ShaderStage::Fragment,
                       {}, {}, {}, {}, 0, "Source program requires at least one shader stage.");
        return result;
    }
    if (request.varying_definition.empty()) {
        add_diagnostic(result.diagnostics, ShaderCompileSeverity::Error,
                       ShaderCompileDiagnosticCode::MissingVaryingDefinition, ShaderId{},
                       ShaderStage::Fragment, {}, {}, {}, {}, 0,
                       "Source program requires an explicit varying/interface definition.");
        return result;
    }

    auto varying = resolve_source_identity(request.varying_definition, effective_options,
                                           ShaderStage::Fragment, result.diagnostics);
    if (!varying)
        return result;
    const auto varying_text = read_text_file(varying->path);
    if (!varying_text) {
        add_diagnostic(result.diagnostics, ShaderCompileSeverity::Error,
                       ShaderCompileDiagnosticCode::SourceReadFailed, ShaderId{},
                       ShaderStage::Fragment, {}, varying->path, {}, {}, 0,
                       "Failed to read explicit varying/interface definition.");
        return result;
    }

    struct StageWork {
        ShaderStage stage = ShaderStage::Fragment;
        ResolvedSourceFile source;
        std::vector<std::pair<std::string, std::string>> dependencies;
    };
    std::vector<StageWork> stages;
    const auto prepare_stage = [&](ShaderStage stage, const std::string& identity) {
        if (identity.empty())
            return true;
        auto source = resolve_source_identity(identity, effective_options, stage, result.diagnostics);
        if (!source)
            return false;
        StageWork work{.stage = stage, .source = std::move(*source)};
        if (!collect_source_dependencies(work.source, effective_options, work.dependencies,
                                         result.diagnostics, stage)) {
            return false;
        }
        stages.push_back(std::move(work));
        return true;
    };
    if (!prepare_stage(ShaderStage::Vertex, request.vertex_source) ||
        !prepare_stage(ShaderStage::Fragment, request.fragment_source)) {
        return result;
    }

    std::ostringstream identity_input;
#if NOVELTEA_HAS_EMBEDDED_SHADERC
    identity_input << "shaderc=embedded-bgfx-" NOVELTEA_BGFX_VERSION_STRING "\n";
    identity_input << "bgfx_resources=" << embedded_toolchain_hash() << '\n';
#else
    identity_input << "shaderc=unavailable\n";
#endif
    identity_input << "interface=" << request.interface_contract << '\n';
    identity_input << "interface_fingerprint=" << request.interface_fingerprint << '\n';
    identity_input << "varying=" << varying->identity << '\n' << *varying_text << '\n';
    for (const auto& stage : stages) {
        identity_input << "stage=" << to_string(stage.stage) << '\n';
        identity_input << source_dependency_fingerprint(stage.dependencies);
    }
    result.program_identity = hash_hex(identity_input.str());

    const auto manifest_path = effective_options.cache_root / "shader-cache" / "manifest.json";
    auto cache_manifest = read_cache_manifest(manifest_path, result.diagnostics);
    for (const auto& stage : stages) {
        for (const auto& variant : effective_options.variants) {
            std::ostringstream key_input;
            key_input << result.program_identity << '\n' << variant.name << ':' << variant.platform
                      << ':' << variant.profile << '\n' << to_string(stage.stage) << '\n';
            const auto cache_key = hash_hex(key_input.str());
            const auto package_path = "shaders/derived/" + variant.name + "/" +
                                      result.program_identity + "." + stage_suffix(stage.stage) +
                                      ".bin";
            const auto runtime_path = "project:/" + package_path;
            const auto output_path = effective_options.output_root / package_path;

            auto append_output = [&](bool cache_hit) -> bool {
                const auto metadata = compiled_binary_metadata(output_path);
                const auto reflected = reflect_shader_binary(output_path);
                if (!metadata || !reflected) {
                    if (!cache_hit) {
                        add_diagnostic(result.diagnostics, ShaderCompileSeverity::Error,
                                       ShaderCompileDiagnosticCode::ReflectionFailed, ShaderId{},
                                       stage.stage, variant.name, stage.source.path, output_path, {}, 0,
                                       "Compiled shader output could not be reflected.");
                    }
                    return false;
                }
                std::vector<std::string> dependencies;
                std::vector<ShaderSourceDependencyRevision> dependency_revisions;
                dependencies.reserve(stage.dependencies.size() + 1);
                dependency_revisions.reserve(stage.dependencies.size() + 1);
                for (const auto& dependency : stage.dependencies) {
                    dependencies.push_back(dependency.first);
                    dependency_revisions.push_back(
                        {.identity = dependency.first, .content_hash = content_hash(dependency.second)});
                }
                dependencies.push_back(varying->identity);
                dependency_revisions.push_back(
                    {.identity = varying->identity, .content_hash = content_hash(*varying_text)});
                result.outputs.push_back(ShaderSourceCompileOutput{
                    .stage = stage.stage,
                    .variant = variant.name,
                    .source_identity = stage.source.identity,
                    .dependencies = std::move(dependencies),
                    .dependency_revisions = std::move(dependency_revisions),
                    .output_path = output_path,
                    .runtime_path = runtime_path,
                    .cache_key = cache_key,
                    .byte_hash = metadata->byte_hash,
                    .byte_size = metadata->byte_size,
                    .reflected_inputs = reflected->inputs,
                    .browser_payload = variant.name == "essl-300" ? reflected->source_payload
                                                                  : std::nullopt,
                    .cache_hit = cache_hit,
                });
                cache_manifest[package_path] = nlohmann::json::object({
                    {"cacheKey", cache_key},
                    {"programIdentity", result.program_identity},
                    {"stage", to_string(stage.stage)},
                    {"variant", variant.name},
                    {"source", stage.source.identity},
                    {"byteHash", metadata->byte_hash},
                    {"byteSize", metadata->byte_size},
                });
                return true;
            };

            if (!effective_options.force_rebuild &&
                cache_entry_matches(cache_manifest, package_path, cache_key, output_path)) {
                if (append_output(true))
                    continue;
                add_diagnostic(result.diagnostics, ShaderCompileSeverity::Warning,
                               ShaderCompileDiagnosticCode::CacheReadFailed, ShaderId{}, stage.stage,
                               variant.name, stage.source.path, output_path, {}, 0,
                               "Cached shader output could not be reflected; recompiling.");
            }

            std::error_code directory_error;
            std::filesystem::create_directories(output_path.parent_path(), directory_error);
            if (directory_error) {
                add_diagnostic(result.diagnostics, ShaderCompileSeverity::Error,
                               ShaderCompileDiagnosticCode::SourceWriteFailed, ShaderId{},
                               stage.stage, variant.name, stage.source.path, output_path, {}, 0,
                               "Failed to create derived shader output directory: " +
                                   directory_error.message());
                continue;
            }

            std::vector<std::string> args = {
                "shaderc", "-f", path_utf8(stage.source.path), "-o", path_utf8(output_path),
                "--type", shaderc_stage_type(stage.stage), "--platform", variant.platform,
                "--profile", variant.profile, "--varyingdef", path_utf8(varying->path),
                "-i", path_utf8(effective_options.project_root / "shaders"),
            };
            if (!effective_options.engine_shader_root.empty()) {
                args.push_back("-i");
                args.push_back(path_utf8(effective_options.engine_shader_root));
            }
#if NOVELTEA_HAS_EMBEDDED_SHADERC
            args.push_back("-i");
            args.push_back(path_utf8(*embedded_include_root));
#endif
            const auto command_line = command_line_from_args(args);
#if NOVELTEA_HAS_EMBEDDED_SHADERC
            std::vector<std::filesystem::path> include_roots = {
                effective_options.project_root / "shaders"};
            if (!effective_options.engine_shader_root.empty())
                include_roots.push_back(effective_options.engine_shader_root);
            include_roots.push_back(*embedded_include_root);
            const auto process = run_embedded_shaderc(args, stage.stage, variant, stage.source.path,
                                                      output_path, varying->path, include_roots);
#else
            const ProcessResult process{.exit_code = -1, .output = "embedded shaderc is unavailable"};
#endif
            std::error_code output_error;
            if (process.exit_code != 0 || !std::filesystem::is_regular_file(output_path, output_error) ||
                output_error) {
                add_diagnostic(result.diagnostics, ShaderCompileSeverity::Error,
                               ShaderCompileDiagnosticCode::CompilerFailed, ShaderId{}, stage.stage,
                               variant.name, stage.source.path, output_path, command_line,
                               process.exit_code,
                               "shaderc failed for source program stage '" +
                                   std::string(to_string(stage.stage)) + "' variant '" + variant.name +
                                   "'.\n" + process.output);
                continue;
            }
            append_output(false);
        }
    }

    write_cache_manifest(manifest_path, cache_manifest, result.diagnostics);
    return result;
}

ShaderCompileResult
ShaderCompilerService::compile_shader_project(const ShaderMaterialProject& project,
                                              const ShaderCompileOptions& options) const
{
    ShaderCompileResult result;
    result.project = project;
    if (!validate_tools(options, result.diagnostics))
        return result;

#if NOVELTEA_HAS_EMBEDDED_SHADERC
    const auto embedded_include_root = materialize_embedded_bgfx_resources(options.cache_root);
    if (!embedded_include_root)
        return result;
#endif

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
                               "Failed to read shader source file: '" + path_utf8(*source_path) +
                                   "'.");
                continue;
            }

            for (const auto& variant : options.variants) {
                const auto varying_path = source_path->parent_path() / "varying.def.sc";
                std::error_code varying_error;
                const bool varying_exists = std::filesystem::exists(varying_path, varying_error);
                if ((!varying_exists || varying_error) &&
                    !write_text_file_if_changed(varying_path, kDefaultVaryingDefinition)) {
                    add_diagnostic(result.diagnostics, ShaderCompileSeverity::Error,
                                   ShaderCompileDiagnosticCode::SourceWriteFailed, shader.id,
                                   stage.stage, variant.name, varying_path, {}, {}, 0,
                                   "Failed to write the default shader varying definition.");
                    continue;
                }
                const auto runtime_path = runtime_binary_path(shader.id, stage.stage, variant.name);
                const auto package_path = package_binary_path(shader.id, stage.stage, variant.name);
                const auto output_path = options.output_root / package_path;
                const auto cache_key =
                    compile_cache_key(shader, stage, variant, options, *source_text);

                if (!options.force_rebuild &&
                    cache_entry_matches(cache_manifest, package_path, cache_key, output_path)) {
                    const auto metadata = compiled_binary_metadata(output_path);
                    if (!metadata) {
                        add_diagnostic(
                            result.diagnostics, ShaderCompileSeverity::Warning,
                            ShaderCompileDiagnosticCode::CacheReadFailed, shader.id, stage.stage,
                            variant.name, *source_path, output_path, {}, 0,
                            "Cached shader output metadata could not be verified; recompiling.");
                    } else {
                        cache_manifest[package_path] = nlohmann::json::object({
                            {"cacheKey", cache_key},
                            {"shader", shader.id.string()},
                            {"stage", to_string(stage.stage)},
                            {"variant", variant.name},
                            {"source", path_utf8(*source_path)},
                            {"byteHash", metadata->byte_hash},
                            {"byteSize", metadata->byte_size},
                        });
                        upsert_compiled_ref(stage, variant.name, runtime_path, *metadata);
                        result.outputs.push_back(ShaderCompileOutput{
                            .shader = shader.id,
                            .stage = stage.stage,
                            .variant = variant.name,
                            .source_path = *source_path,
                            .output_path = output_path,
                            .runtime_path = runtime_path,
                            .cache_key = cache_key,
                            .byte_hash = metadata->byte_hash,
                            .byte_size = metadata->byte_size,
                            .cache_hit = true,
                        });
                        continue;
                    }
                }

                std::error_code output_directory_error;
                std::filesystem::create_directories( // filesystem-error-code
                    output_path.parent_path(), output_directory_error);
                if (output_directory_error) {
                    add_diagnostic(result.diagnostics, ShaderCompileSeverity::Error,
                                   ShaderCompileDiagnosticCode::SourceWriteFailed, shader.id,
                                   stage.stage, variant.name, *source_path, output_path, {}, 0,
                                   "Failed to create shader output directory: " +
                                       output_directory_error.message());
                    continue;
                }
                const std::vector<std::string> args = {
                    "shaderc",
                    "-f",
                    path_utf8(*source_path),
                    "-o",
                    path_utf8(output_path),
                    "--type",
                    shaderc_stage_type(stage.stage),
                    "--platform",
                    variant.platform,
                    "--profile",
                    variant.profile,
                    "--varyingdef",
                    path_utf8(varying_path),
                    "-i",
                    path_utf8(source_path->parent_path()),
                    "-i",
                    path_utf8(options.project_root),
                    "-i",
#if NOVELTEA_HAS_EMBEDDED_SHADERC
                    path_utf8(*embedded_include_root),
#else
                    std::string{},
#endif
                };
                const auto command_line = command_line_from_args(args);
#if NOVELTEA_HAS_EMBEDDED_SHADERC
                const auto process = run_embedded_shaderc(
                    args, stage.stage, variant, *source_path, output_path, varying_path,
                    {options.project_root, *embedded_include_root});
#else
                const ProcessResult process{.exit_code = -1,
                                            .output = "embedded shaderc is unavailable"};
#endif
                std::error_code output_exists_error;
                const bool output_exists =
                    std::filesystem::exists(output_path, output_exists_error);
                if (process.exit_code != 0 || !output_exists || output_exists_error) {
                    add_diagnostic(result.diagnostics, ShaderCompileSeverity::Error,
                                   ShaderCompileDiagnosticCode::CompilerFailed, shader.id,
                                   stage.stage, variant.name, *source_path, output_path,
                                   command_line, process.exit_code,
                                   "shaderc failed for shader '" + shader.id.string() + "' " +
                                       std::string(to_string(stage.stage)) + " variant '" +
                                       variant.name + "'.\n" + process.output);
                    continue;
                }

                const auto metadata = compiled_binary_metadata(output_path);
                if (!metadata) {
                    add_diagnostic(
                        result.diagnostics, ShaderCompileSeverity::Error,
                        ShaderCompileDiagnosticCode::SourceReadFailed, shader.id, stage.stage,
                        variant.name, *source_path, output_path, command_line, process.exit_code,
                        "Compiled shader output could not be read for digest verification.");
                    continue;
                }

                cache_manifest[package_path] = nlohmann::json::object({
                    {"cacheKey", cache_key},
                    {"shader", shader.id.string()},
                    {"stage", to_string(stage.stage)},
                    {"variant", variant.name},
                    {"source", path_utf8(*source_path)},
                    {"byteHash", metadata->byte_hash},
                    {"byteSize", metadata->byte_size},
                });
                upsert_compiled_ref(stage, variant.name, runtime_path, *metadata);
                result.outputs.push_back(ShaderCompileOutput{
                    .shader = shader.id,
                    .stage = stage.stage,
                    .variant = variant.name,
                    .source_path = *source_path,
                    .output_path = output_path,
                    .runtime_path = runtime_path,
                    .cache_key = cache_key,
                    .byte_hash = metadata->byte_hash,
                    .byte_size = metadata->byte_size,
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
    case ShaderCompileDiagnosticCode::InvalidSourcePath:
        return "invalid_source_path";
    case ShaderCompileDiagnosticCode::UnsafeIncludePath:
        return "unsafe_include_path";
    case ShaderCompileDiagnosticCode::MissingShaderc:
        return "missing_shaderc";
    case ShaderCompileDiagnosticCode::MissingBgfxInclude:
        return "missing_bgfx_include";
    case ShaderCompileDiagnosticCode::MissingSource:
        return "missing_source";
    case ShaderCompileDiagnosticCode::MissingVaryingDefinition:
        return "missing_varying_definition";
    case ShaderCompileDiagnosticCode::SourceReadFailed:
        return "source_read_failed";
    case ShaderCompileDiagnosticCode::SourceWriteFailed:
        return "source_write_failed";
    case ShaderCompileDiagnosticCode::CompilerFailed:
        return "compiler_failed";
    case ShaderCompileDiagnosticCode::ReflectionFailed:
        return "reflection_failed";
    case ShaderCompileDiagnosticCode::CacheReadFailed:
        return "cache_read_failed";
    case ShaderCompileDiagnosticCode::CacheWriteFailed:
        return "cache_write_failed";
    }
    return "compiler_failed";
}

} // namespace noveltea
