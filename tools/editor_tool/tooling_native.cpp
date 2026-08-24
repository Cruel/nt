#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/core/compiled_package_codec.hpp>
#include <noveltea/core/package_export.hpp>
#include <noveltea/core/player_bootstrap.hpp>
#include <noveltea/core/editor_runtime_protocol.hpp>
#include <noveltea/core/save_state_codec.hpp>
#include <noveltea/core/typed_save_slot_store.hpp>
#include <noveltea/presentation/runtime_presentation_model.hpp>
#include <noveltea/runtime/running_game.hpp>
#include <noveltea/runtime/runtime_ports.hpp>
#include <noveltea/script/script_runtime.hpp>
#include <noveltea/core/json_access.hpp>
#include <noveltea/render/shader_compiler.hpp>
#include <noveltea/render/material_codec.hpp>

#include "tooling_native.hpp"
#include "tooling_native_c.h"

#include <algorithm>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <cstdio>
#include <optional>
#include <unordered_map>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

namespace bgfx {
int compileShader(int argc, const char* argv[]);
}

namespace {

using namespace noveltea::core;
using namespace noveltea::core::editor;

std::string filesystem_path_to_utf8(const std::filesystem::path& path)
{
    const auto encoded = path.generic_u8string();
    return std::string(reinterpret_cast<const char*>(encoded.data()), encoded.size());
}

std::filesystem::path filesystem_path_from_utf8(std::string_view value)
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

class HeadlessPresentationRuntime final : public noveltea::runtime::PresentationRuntimePort {
public:
    [[nodiscard]] Result<void, Diagnostics>
    reconcile_snapshot(const RuntimePresentationSnapshot&) override
    {
        return Result<void, Diagnostics>::success();
    }

    [[nodiscard]] Result<noveltea::runtime::PresentationAcceptance, Diagnostics>
    accept(const PresentationOperation&) override
    {
        return Result<noveltea::runtime::PresentationAcceptance, Diagnostics>::success({true});
    }

    [[nodiscard]] Result<noveltea::runtime::PresentationAcceptance, Diagnostics>
    accept(const AudioOperation&) override
    {
        return Result<noveltea::runtime::PresentationAcceptance, Diagnostics>::success({true});
    }

    [[nodiscard]] const PresentationCheckpointStatus& checkpoint_status() const noexcept override
    {
        return status;
    }

    void terminate(PresentationCancellationReason) override {}

private:
    PresentationCheckpointStatus status{CheckpointStatusRevision::from_number(1), {}, std::nullopt};
};

std::string read_all(std::istream& stream)
{
    std::ostringstream buffer;
    buffer << stream.rdbuf();
    return buffer.str();
}

std::optional<std::string> read_file(const std::filesystem::path& path)
{
    std::ifstream file(path, std::ios::binary);
    if (!file)
        return std::nullopt;
    return read_all(file);
}

std::string runtime_package_entry_path(std::string_view path)
{
    constexpr std::string_view project_prefix = "project:/";
    return path.starts_with(project_prefix) ? std::string(path.substr(project_prefix.size()))
                                            : std::string(path);
}

struct HeadlessRuntimeInput {
    LoadedCompiledPackage package;
    std::string runtime_locale;
};

Result<HeadlessRuntimeInput, Diagnostics>
make_headless_running_game_input(nlohmann::json gameplay,
                                 std::optional<nlohmann::json> shader_materials,
                                 std::string runtime_locale)
{
    auto decoded_project = decode_compiled_project(gameplay, "game");
    if (!decoded_project) {
        return Result<HeadlessRuntimeInput, Diagnostics>::failure(
            std::move(decoded_project).error());
    }

    nlohmann::json entries = nlohmann::json::array({{{"path", "game"}, {"size", 0}}});
    std::vector<RuntimePackageFile> files{{"game", 0, std::nullopt}};
    for (const auto& asset : decoded_project.value_if()->assets()) {
        const auto package_path = runtime_package_entry_path(asset.path);
        entries.push_back({{"path", package_path}, {"size", 0}});
        files.push_back({package_path, 0, std::nullopt});
    }

    nlohmann::json manifest = {
        {"format", "noveltea.runtime-package"},
        {"runtime_api_version", player_runtime_api_version},
        {"kind", "runtime"},
        {"created_by", "noveltea"},
        {"project",
         {{"name", decoded_project.value_if()->identity().name},
          {"version", decoded_project.value_if()->identity().version}}},
        {"display",
         {{"reference_resolution",
           {{"width", decoded_project.value_if()->settings().display.reference_resolution.width},
            {"height",
             decoded_project.value_if()->settings().display.reference_resolution.height}}},
          {"world_raster_policy",
           decoded_project.value_if()->settings().display.world_raster_policy ==
                   compiled::WorldRasterPolicy::Native
               ? "native"
               : "capped"},
          {"bar_color", decoded_project.value_if()->settings().display.bar_color}}},
        {"accessibility",
         {{"ui_scale",
           {{"enabled", decoded_project.value_if()->settings().accessibility.ui_scale.enabled},
            {"minimum", decoded_project.value_if()->settings().accessibility.ui_scale.minimum},
            {"maximum", decoded_project.value_if()->settings().accessibility.ui_scale.maximum}}},
          {"text_scale",
           {{"enabled", decoded_project.value_if()->settings().accessibility.text_scale.enabled},
            {"minimum", decoded_project.value_if()->settings().accessibility.text_scale.minimum},
            {"maximum",
             decoded_project.value_if()->settings().accessibility.text_scale.maximum}}}}},
        {"shader_variants", nlohmann::json::array()},
        {"entries", entries},
    };

    if (shader_materials) {
        auto decoded_materials =
            decode_shader_material_manifest(*shader_materials, "shader-materials.json");
        if (!decoded_materials) {
            return Result<HeadlessRuntimeInput, Diagnostics>::failure(
                std::move(decoded_materials).error());
        }
        std::vector<std::string> variants;
        for (const auto& shader : decoded_materials.value_if()->shaders) {
            for (const auto& stage : shader.stages) {
                for (const auto& binary : stage.compiled) {
                    if (std::find(variants.begin(), variants.end(), binary.variant) ==
                        variants.end()) {
                        variants.push_back(binary.variant);
                    }
                    const auto package_path = runtime_package_entry_path(binary.path);
                    entries.push_back({{"path", package_path}, {"size", 0}});
                    files.push_back({package_path, 0, std::nullopt});
                }
            }
        }
        entries.push_back({{"path", "shader-materials.json"}, {"size", 0}});
        files.push_back({"shader-materials.json", 0, std::nullopt});
        manifest["entries"] = std::move(entries);
        manifest["shader_variants"] = std::move(variants);
        manifest["shader_materials"] = {{"entry", "shader-materials.json"},
                                        {"schema", "noveltea.shader-materials.v2"},
                                        {"sources_stripped", true}};
    }

    auto typed_manifest = decode_runtime_package_manifest(manifest, "manifest.json");
    if (!typed_manifest)
        return Result<HeadlessRuntimeInput, Diagnostics>::failure(std::move(typed_manifest).error());
    std::optional<noveltea::ShaderMaterialProject> typed_shader_materials;
    if (shader_materials) {
        auto decoded = decode_shader_material_manifest(*shader_materials, "shader-materials.json");
        if (!decoded)
            return Result<HeadlessRuntimeInput, Diagnostics>::failure(std::move(decoded).error());
        typed_shader_materials = std::move(*decoded.value_if());
    }
    auto package = assemble_compiled_package(std::move(*decoded_project.value_if()),
                                             std::move(*typed_manifest.value_if()),
                                             std::move(typed_shader_materials), std::move(files));
    if (!package)
        return Result<HeadlessRuntimeInput, Diagnostics>::failure(std::move(package).error());
    return Result<HeadlessRuntimeInput, Diagnostics>::success(
        HeadlessRuntimeInput{.package = std::move(*package.value_if()),
                             .runtime_locale = std::move(runtime_locale)});
}

class ToolingScriptSource final : public noveltea::runtime::ScriptSourcePort {
public:
    void add(std::string logical_path, std::string source)
    {
        m_sources.insert_or_assign(std::move(logical_path), std::move(source));
    }

    [[nodiscard]] Result<std::string, noveltea::runtime::ScriptSourceError>
    read_script_source(std::string_view logical_path) const override
    {
        const auto found = m_sources.find(std::string(logical_path));
        if (found == m_sources.end()) {
            return Result<std::string, noveltea::runtime::ScriptSourceError>::failure(
                {"Script source not found: " + std::string(logical_path)});
        }
        return Result<std::string, noveltea::runtime::ScriptSourceError>::success(found->second);
    }

private:
    std::unordered_map<std::string, std::string> m_sources;
};

Result<std::unique_ptr<noveltea::runtime::RunningGame>, Diagnostics>
load_headless_running_game(HeadlessRuntimeInput input, noveltea::script::ScriptRuntime& scripts,
                           HeadlessPresentationRuntime& presentation, TypedMemorySaveSlotStore& saves)
{
    static noveltea::presentation::RuntimePresentationModel presentation_model;
    static const JsonSaveStateCodec save_codec;
    return noveltea::runtime::RunningGame::create(
        std::move(input.package), scripts, scripts, presentation_model, presentation, saves, save_codec,
        std::move(input.runtime_locale));
}

const char* export_severity_to_string(PackageExportSeverity severity)
{
    switch (severity) {
    case PackageExportSeverity::Info:
        return "info";
    case PackageExportSeverity::Warning:
        return "warning";
    case PackageExportSeverity::Error:
        return "error";
    }
    return "error";
}

nlohmann::json export_diagnostics_to_json(const std::vector<PackageExportDiagnostic>& diagnostics)
{
    auto result = nlohmann::json::array();
    for (const auto& diagnostic : diagnostics) {
        result.push_back({{"severity", export_severity_to_string(diagnostic.severity)},
                          {"category", diagnostic.category},
                          {"path", diagnostic.path},
                          {"message", diagnostic.message}});
    }
    return result;
}

nlohmann::json
material_diagnostics_to_json(const std::vector<noveltea::MaterialDiagnostic>& diagnostics)
{
    auto result = nlohmann::json::array();
    for (const auto& diagnostic : diagnostics) {
        result.push_back({{"severity", std::string(noveltea::to_string(diagnostic.severity))},
                          {"code", std::string(noveltea::to_string(diagnostic.code))},
                          {"path", diagnostic.path},
                          {"message", diagnostic.message}});
    }
    return result;
}

nlohmann::json shader_compile_diagnostics_to_json(
    const std::vector<noveltea::ShaderCompileDiagnostic>& diagnostics)
{
    auto result = nlohmann::json::array();
    for (const auto& diagnostic : diagnostics) {
        result.push_back({{"severity", std::string(noveltea::to_string(diagnostic.severity))},
                          {"code", std::string(noveltea::to_string(diagnostic.code))},
                          {"shader", diagnostic.shader.string()},
                          {"stage", std::string(noveltea::to_string(diagnostic.stage))},
                          {"variant", diagnostic.variant},
                          {"sourcePath", filesystem_path_to_utf8(diagnostic.source_path)},
                          {"outputPath", filesystem_path_to_utf8(diagnostic.output_path)},
                          {"commandLine", diagnostic.command_line},
                          {"exitCode", diagnostic.exit_code},
                          {"message", diagnostic.message}});
    }
    return result;
}

nlohmann::json
shader_compile_outputs_to_json(const std::vector<noveltea::ShaderCompileOutput>& outputs)
{
    auto result = nlohmann::json::array();
    for (const auto& output : outputs) {
        result.push_back({{"shader", output.shader.string()},
                          {"stage", std::string(noveltea::to_string(output.stage))},
                          {"variant", output.variant},
                          {"sourcePath", filesystem_path_to_utf8(output.source_path)},
                          {"outputPath", filesystem_path_to_utf8(output.output_path)},
                          {"runtimePath", output.runtime_path},
                          {"cacheKey", output.cache_key},
                          {"byteHash", output.byte_hash},
                          {"byteSize", output.byte_size},
                          {"cacheHit", output.cache_hit}});
    }
    return result;
}

nlohmann::json ok(nlohmann::json payload = nlohmann::json::object())
{
    payload["ok"] = true;
    return payload;
}

nlohmann::json fail(std::string message, nlohmann::json diagnostics = nlohmann::json::array())
{
    return {{"ok", false}, {"error", std::move(message)}, {"diagnostics", std::move(diagnostics)}};
}

nlohmann::json compiled_diagnostics_to_json(const Diagnostics& diagnostics)
{
    auto result = nlohmann::json::array();
    for (const auto& diagnostic : diagnostics) {
        const char* severity = "error";
        switch (diagnostic.severity) {
        case ErrorSeverity::Info:
            severity = "info";
            break;
        case ErrorSeverity::Warning:
            severity = "warning";
            break;
        case ErrorSeverity::Error:
            severity = "error";
            break;
        case ErrorSeverity::Fatal:
            severity = "error";
            break;
        }
        result.push_back({{"severity", severity},
                          {"code", diagnostic.code},
                          {"category", diagnostic.code},
                          {"path", diagnostic.source_path},
                          {"message", diagnostic.message}});
    }
    return result;
}

Result<void, Diagnostics> certify_compiled_export(const nlohmann::json& project,
                                                  const PackageExportOptions& options)
{
    ToolingScriptSource source;
    Diagnostics diagnostics;
    for (const auto& entry : options.file_entries) {
        auto content = read_file(entry.source);
        if (!content) {
            diagnostics.push_back(
                {.code = "export.asset_read_failed",
                 .message =
                     "Could not read export asset '" + filesystem_path_to_utf8(entry.source) + "'.",
                 .severity = ErrorSeverity::Error,
                 .source_path = entry.package_path});
            continue;
        }
        source.add("project:/" + entry.package_path, *content);
    }
    if (!diagnostics.empty())
        return Result<void, Diagnostics>::failure(std::move(diagnostics));

    noveltea::script::ScriptRuntime scripts;
    auto initialized = scripts.initialize({&source});
    if (!initialized) {
        diagnostics.push_back({.code = "runtime.lua_initialization_failed",
                               .message = initialized.error().message,
                               .severity = ErrorSeverity::Error,
                               .source_path = initialized.error().chunk});
        return Result<void, Diagnostics>::failure(std::move(diagnostics));
    }
    TypedMemorySaveSlotStore saves;
    HeadlessPresentationRuntime presentation;
    auto shader_material_metadata = options.shader_material_metadata;
    if (shader_material_metadata && options.strip_shader_sources) {
        auto shaders = shader_material_metadata->find("shaders");
        if (shaders != shader_material_metadata->end() && shaders->is_object()) {
            for (auto& [_shader_id, shader] : shaders->items()) {
                if (!shader.is_object())
                    continue;
                auto stages = shader.find("stages");
                if (stages == shader.end() || !stages->is_object())
                    continue;
                for (auto& [_stage_name, stage] : stages->items()) {
                    if (!stage.is_object())
                        continue;
                    stage.erase("source");
                    stage.erase("source_text");
                    stage.erase("editor_preview");
                    stage.erase("compile_cache");
                }
            }
        }
    }
    auto input =
        make_headless_running_game_input(project, std::move(shader_material_metadata), "en");
    if (!input)
        return Result<void, Diagnostics>::failure(std::move(input).error());
    auto runtime = load_headless_running_game(std::move(*input.value_if()), scripts, presentation, saves);
    if (!runtime)
        return Result<void, Diagnostics>::failure(std::move(runtime).error());
    return Result<void, Diagnostics>::success();
}

std::optional<nlohmann::json> compiled_project_from_request(const nlohmann::json& request,
                                                            nlohmann::json& error_response)
{
    const auto project_it = request.find("project");
    if (project_it == request.end()) {
        error_response = fail("Request requires compiled project.");
        return std::nullopt;
    }
    nlohmann::json project = *project_it;
    if (project.is_string())
        project =
            nlohmann::json::parse(json_access::get_or<std::string>(project, {}), nullptr, false);
    if (project.is_discarded()) {
        error_response = fail("Compiled project JSON is malformed.");
        return std::nullopt;
    }
    auto decoded = decode_compiled_project(project, "game");
    if (!decoded) {
        error_response = fail("Compiled project validation failed.",
                              compiled_diagnostics_to_json(decoded.error()));
        return std::nullopt;
    }
    return project;
}

bool diagnostics_have_errors(const Diagnostics& diagnostics)
{
    return std::any_of(diagnostics.begin(), diagnostics.end(), [](const auto& diagnostic) {
        return diagnostic.severity == ErrorSeverity::Error ||
               diagnostic.severity == ErrorSeverity::Fatal;
    });
}

nlohmann::json run_compiled_playback(const nlohmann::json& request)
{
    nlohmann::json error_response;
    auto project = compiled_project_from_request(request, error_response);
    if (!project)
        return error_response;
    const auto spec_it = request.find("spec");
    if (spec_it == request.end())
        return fail("Request requires a playback spec.");

    ToolingScriptSource sources;
    noveltea::script::ScriptRuntime scripts;
    auto initialized = scripts.initialize({&sources});
    if (!initialized)
        return fail("Lua runtime initialization failed.");
    TypedMemorySaveSlotStore saves;
    HeadlessPresentationRuntime presentation;
    auto input = make_headless_running_game_input(*project, std::nullopt, "en");
    if (!input)
        return fail("Compiled runtime load failed.", compiled_diagnostics_to_json(input.error()));
    auto runtime = load_headless_running_game(std::move(*input.value_if()), scripts, presentation, saves);
    if (!runtime)
        return fail("Compiled runtime load failed.", compiled_diagnostics_to_json(runtime.error()));

    auto decoded_spec = editor::decode_editor_playback_text(spec_it->dump());
    if (!decoded_spec)
        return fail("Playback spec parse failed.",
                    compiled_diagnostics_to_json(decoded_spec.error()));

    std::vector<editor::TypedPlaybackStepReport> steps;
    bool passed = true;
    const auto* typed_spec = decoded_spec.value_if();
    if (!typed_spec)
        return fail("Playback spec parse failed.");
    auto& session = runtime.value_if()->get()->session();
    auto startup = session.dispatch(RuntimeInputMessage{StartRuntimeInput{}});
    std::optional<noveltea::runtime::RuntimePublication> final_publication;
    if (startup.publication)
        final_publication = std::move(startup.publication);
    for (const auto& step : typed_spec->steps) {
        auto result = session.dispatch(step.input);
        editor::TypedPlaybackStepReport report;
        report.index = step.index;
        report.handled = result.disposition == noveltea::runtime::RuntimeInputDisposition::Handled;
        if (result.publication)
            final_publication = std::move(result.publication);
        report.events = std::move(result.events);
        report.diagnostics = std::move(result.diagnostics);
        if (result.disposition == noveltea::runtime::RuntimeInputDisposition::Failed ||
            diagnostics_have_errors(report.diagnostics))
            passed = false;
        steps.push_back(std::move(report));
    }
    if (!steps.empty()) {
        auto observed = session.dispatch(RuntimeInputMessage{AdvanceTimeInput{}});
        if (observed.publication)
            final_publication = std::move(observed.publication);
    }
    if (!final_publication)
        return fail("Playback completed without a final runtime publication.");
    const auto report_text = editor::encode_editor_playback_report_text(typed_spec->id, steps,
                                                                        *final_publication, passed);
    auto report = nlohmann::json::parse(report_text, nullptr, false);
    if (report.is_discarded())
        return fail("Playback report encoding failed.");
    return ok({{"report", std::move(report)}});
}

noveltea::ShaderCompileOptions shader_compile_options_from_json(const nlohmann::json& json,
                                                                nlohmann::json& diagnostics)
{
    noveltea::ShaderCompileOptions options;
    if (!json.is_object())
        return options;

    options.project_root =
        filesystem_path_from_utf8(json_access::value_or(json, "projectRoot", std::string{}));
    options.output_root =
        filesystem_path_from_utf8(json_access::value_or(json, "outputRoot", std::string{}));
    options.cache_root =
        filesystem_path_from_utf8(json_access::value_or(json, "cacheRoot", std::string{}));
    options.force_rebuild = json_access::value_or(json, "forceRebuild", false);

    std::vector<std::string> variant_names;
    if (auto variants = json.find("shaderVariants");
        variants != json.end() && variants->is_array()) {
        for (const auto& variant : *variants) {
            if (variant.is_string())
                variant_names.push_back(json_access::get_or<std::string>(variant, {}));
        }
    }

    std::vector<noveltea::ShaderCompileDiagnostic> variant_diagnostics;
    options.variants =
        noveltea::shader_compile_variants_from_names(variant_names, &variant_diagnostics);
    diagnostics = shader_compile_diagnostics_to_json(variant_diagnostics);
    return options;
}

std::optional<noveltea::ShaderMaterialProject>
shader_project_from_request(const nlohmann::json& request, nlohmann::json& error_response)
{
    auto shader_project_json = request.find("shaderProject");
    if (shader_project_json == request.end()) {
        error_response = fail("Request requires shaderProject.");
        return std::nullopt;
    }

    noveltea::ShaderMaterialProjectParseResult parsed;
    if (shader_project_json->is_string()) {
        parsed =
            noveltea::parse_shader_material_project_json(shader_project_json->get<std::string>());
    } else {
        parsed = noveltea::parse_shader_material_project_json_value(*shader_project_json);
    }

    if (!parsed.project) {
        error_response =
            fail("Shader project parse failed.", material_diagnostics_to_json(parsed.diagnostics));
        return std::nullopt;
    }
    return std::move(*parsed.project);
}

PackageExportOptions export_options_from_json(const nlohmann::json& json)
{
    PackageExportOptions options;
    if (!json.is_object())
        return options;
    const auto kind = json_access::value_or(json, "kind", std::string("runtime"));
    options.kind = kind == "editable" ? PackageExportKind::Editable : PackageExportKind::Runtime;
    options.project_name = json_access::value_or(json, "projectName", std::string{});
    options.project_version = json_access::value_or(json, "projectVersion", std::string{});
    options.created_by = json_access::value_or(json, "createdBy", std::string("noveltea-editor"));
    options.include_checksums = json_access::value_or(json, "includeChecksums", true);
    options.strip_shader_sources = json_access::value_or(json, "stripShaderSources", true);
    if (auto display = json.find("display"); display != json.end() && display->is_object()) {
        options.display = *display;
    }
    if (auto accessibility = json.find("accessibility");
        accessibility != json.end() && accessibility->is_object()) {
        options.accessibility = *accessibility;
    }
    if (auto platform = json.find("platform"); platform != json.end() && platform->is_object()) {
        options.platform = *platform;
    }
    options.shader_asset_root =
        filesystem_path_from_utf8(json_access::value_or(json, "shaderAssetRoot", std::string{}));
    if (auto metadata = json.find("shaderMaterialMetadata"); metadata != json.end()) {
        options.shader_material_metadata = *metadata;
    }
    if (auto variants = json.find("shaderVariants");
        variants != json.end() && variants->is_array()) {
        for (const auto& variant : *variants) {
            if (variant.is_string())
                options.shader_variants.push_back(json_access::get_or<std::string>(variant, {}));
        }
    }
    if (auto required = json.find("requiredShaderBinaryPaths");
        required != json.end() && required->is_array()) {
        for (const auto& path : *required) {
            if (path.is_string())
                options.required_shader_binary_paths.insert(
                    json_access::get_or<std::string>(path, {}));
        }
    }
    if (auto required = json.find("requiredSeekablePaths");
        required != json.end() && required->is_array()) {
        for (const auto& path : *required) {
            if (path.is_string())
                options.required_seekable_paths.insert(
                    json_access::get_or<std::string>(path, {}));
        }
    }
    if (auto roots = json.find("assetRoots"); roots != json.end() && roots->is_array()) {
        for (const auto& root : *roots) {
            if (!root.is_object())
                continue;
            PackageExportAssetRoot asset_root;
            asset_root.root =
                filesystem_path_from_utf8(json_access::value_or(root, "root", std::string{}));
            asset_root.package_prefix = json_access::value_or(root, "packagePrefix", std::string{});
            options.asset_roots.push_back(std::move(asset_root));
        }
    }
    if (auto entries = json.find("fileEntries"); entries != json.end() && entries->is_array()) {
        for (const auto& entry : *entries) {
            if (!entry.is_object())
                continue;
            PackageExportFileEntry file_entry;
            file_entry.source =
                filesystem_path_from_utf8(json_access::value_or(entry, "source", std::string{}));
            file_entry.package_path = json_access::value_or(entry, "packagePath", std::string{});
            const auto storage = json_access::value_or(entry, "storage", std::string("auto"));
            if (storage == "stored")
                file_entry.storage = PackageExportStorage::Stored;
            else if (storage == "compressed")
                file_entry.storage = PackageExportStorage::Compressed;
            options.file_entries.push_back(std::move(file_entry));
        }
    }
    return options;
}

nlohmann::json run_command(std::string_view command, const nlohmann::json& request)
{
    if (command == "run-test") {
        return run_compiled_playback(request);
    }

    if (command == "run-ui-test") {
        return run_compiled_playback(request);
    }

    if (command == "compile-shaders") {
        nlohmann::json error_response;
        auto shader_project = shader_project_from_request(request, error_response);
        if (!shader_project)
            return error_response;

        nlohmann::json variant_diagnostics = nlohmann::json::array();
        auto options = shader_compile_options_from_json(
            json_access::value_or(request, "options", nlohmann::json::object()),
            variant_diagnostics);
        noveltea::ShaderCompilerService compiler;
        auto result = compiler.compile_shader_project(*shader_project, options);
        auto diagnostics = shader_compile_diagnostics_to_json(result.diagnostics);
        for (const auto& diagnostic : variant_diagnostics)
            diagnostics.push_back(diagnostic);
        return ok({{"success", result.success()},
                   {"outputs", shader_compile_outputs_to_json(result.outputs)},
                   {"diagnostics", std::move(diagnostics)}});
    }

    if (command == "export-package") {
        nlohmann::json error_response;
        auto project = compiled_project_from_request(request, error_response);
        if (!project)
            return error_response;
        const auto output = json_access::value_or(request, "outputPath", std::string{});
        if (output.empty())
            return fail("Request requires outputPath.");
        const auto options = export_options_from_json(
            json_access::value_or(request, "options", nlohmann::json::object()));
        auto certified = certify_compiled_export(*project, options);
        if (!certified)
            return fail("Compiled project export readiness failed.",
                        compiled_diagnostics_to_json(certified.error()));
        auto result =
            ProjectPackageWriter::write_to_file(*project, filesystem_path_from_utf8(output), options);
        return ok({{"success", result.success},
                   {"diagnostics", export_diagnostics_to_json(result.diagnostics)},
                   {"manifest", result.manifest},
                   {"byteCount", result.byte_count},
                   {"checksums", result.checksums}});
    }

    return fail("Unknown command.");
}

} // namespace

namespace noveltea::tooling {
namespace {

NativeOperationResult invoke_json_operation(std::string_view command, std::string_view request_json)
{
    const auto request = request_json.empty()
                             ? nlohmann::json::object()
                             : nlohmann::json::parse(request_json, nullptr, false);
    if (request.is_discarded()) {
        return {.exit_code = 1, .response_json = fail("Malformed request JSON").dump()};
    }
    auto response = run_command(command, request);
    return {.exit_code = json_access::value_or(response, "ok", false) ? 0 : 1,
            .response_json = response.dump()};
}

std::uint64_t copy_result(const NativeOperationResult& result, std::uint8_t* response,
                          std::uint64_t response_capacity)
{
    const auto required = static_cast<std::uint64_t>(result.response_json.size());
    if (response != nullptr && response_capacity >= required && required != 0) {
        std::memcpy(response, result.response_json.data(), static_cast<std::size_t>(required));
    }
    return required;
}

std::string_view request_view(const std::uint8_t* request, std::uint64_t request_size)
{
    if (request == nullptr || request_size == 0)
        return {};
    return {reinterpret_cast<const char*>(request), static_cast<std::size_t>(request_size)};
}

} // namespace

NativeOperationResult compile_shaders(std::string_view request_json)
{
    return invoke_json_operation("compile-shaders", request_json);
}

NativeOperationResult run_headless_test(std::string_view request_json)
{
    return invoke_json_operation("run-test", request_json);
}

NativeOperationResult run_ui_test(std::string_view request_json)
{
    return invoke_json_operation("run-ui-test", request_json);
}

NativeOperationResult export_package(std::string_view request_json)
{
    return invoke_json_operation("export-package", request_json);
}

NativeOperationResult invoke_legacy_command(std::string_view command, std::string_view request_json)
{
    return invoke_json_operation(command, request_json);
}

} // namespace noveltea::tooling

extern "C" std::uint64_t
noveltea_tooling_compile_shaders_json(const std::uint8_t* request, std::uint64_t request_size,
                                      std::uint8_t* response, std::uint64_t response_capacity)
{
    return noveltea::tooling::copy_result(
        noveltea::tooling::compile_shaders(noveltea::tooling::request_view(request, request_size)),
        response, response_capacity);
}

extern "C" std::uint64_t
noveltea_tooling_run_headless_test_json(const std::uint8_t* request, std::uint64_t request_size,
                                        std::uint8_t* response, std::uint64_t response_capacity)
{
    return noveltea::tooling::copy_result(
        noveltea::tooling::run_headless_test(noveltea::tooling::request_view(request, request_size)),
        response, response_capacity);
}

extern "C" std::uint64_t
noveltea_tooling_run_ui_test_json(const std::uint8_t* request, std::uint64_t request_size,
                                  std::uint8_t* response, std::uint64_t response_capacity)
{
    return noveltea::tooling::copy_result(
        noveltea::tooling::run_ui_test(noveltea::tooling::request_view(request, request_size)),
        response, response_capacity);
}

extern "C" std::uint64_t
noveltea_tooling_export_package_json(const std::uint8_t* request, std::uint64_t request_size,
                                     std::uint8_t* response, std::uint64_t response_capacity)
{
    return noveltea::tooling::copy_result(
        noveltea::tooling::export_package(noveltea::tooling::request_view(request, request_size)),
        response, response_capacity);
}

extern "C" std::int32_t noveltea_tooling_shaderc(std::int32_t argc, const char* const* argv)
{
    return bgfx::compileShader(argc, const_cast<const char**>(argv));
}

extern "C" std::uint64_t noveltea_tooling_shaderc_json(const std::uint8_t* request,
                                                       std::uint64_t request_size,
                                                       std::uint8_t* response,
                                                       std::uint64_t response_capacity)
{
    const auto input = noveltea::tooling::request_view(request, request_size);
    const auto parsed = nlohmann::json::parse(input, nullptr, false);
    if (parsed.is_discarded() || !parsed.is_array()) {
        return noveltea::tooling::copy_result(
            {.exit_code = 2, .response_json = R"({"exitCode":2})"}, response, response_capacity);
    }
    std::vector<std::string> storage;
    storage.reserve(parsed.size() + 1);
    storage.emplace_back("shaderc");
    for (const auto& value : parsed) {
        if (!value.is_string()) {
            return noveltea::tooling::copy_result(
                {.exit_code = 2, .response_json = R"({"exitCode":2})"}, response,
                response_capacity);
        }
        storage.push_back(value.get<std::string>());
    }
    std::vector<const char*> argv;
    argv.reserve(storage.size());
    for (const auto& value : storage)
        argv.push_back(value.c_str());
    const auto exit_code = bgfx::compileShader(static_cast<int>(argv.size()), argv.data());
    std::fflush(stdout);
    std::fflush(stderr);
    return noveltea::tooling::copy_result(
        {.exit_code = exit_code,
         .response_json = nlohmann::json{{"exitCode", exit_code}}.dump()},
        response, response_capacity);
}
