#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/core/compiled_package_codec.hpp>
#include <noveltea/core/package_export.hpp>
#include <noveltea/assets/asset_manager.hpp>
#include <noveltea/core/editor_runtime_protocol.hpp>
#include <noveltea/core/typed_save_slot_store.hpp>
#include <noveltea/runtime/running_game.hpp>
#include <noveltea/boundary/running_game_loader.hpp>
#include <noveltea/script/script_runtime.hpp>
#include <noveltea/core/json_access.hpp>
#include <noveltea/render/shader_compiler.hpp>
#include <noveltea/render/material_codec.hpp>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace {

using namespace noveltea::core;
using namespace noveltea::core::editor;

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

Result<noveltea::runtime::RunningGameLoadInput, Diagnostics>
make_headless_running_game_input(nlohmann::json gameplay,
                                 std::optional<nlohmann::json> shader_materials,
                                 std::string runtime_locale)
{
    auto decoded_project = decode_compiled_project(gameplay, "game");
    if (!decoded_project) {
        return Result<noveltea::runtime::RunningGameLoadInput, Diagnostics>::failure(
            std::move(decoded_project).error());
    }

    nlohmann::json entries = nlohmann::json::array({{{"path", "game"}, {"size", 0}}});
    std::vector<RuntimePackageFile> files{{"game", 0, std::nullopt}};
    for (const auto& asset : decoded_project.value_if()->assets()) {
        entries.push_back({{"path", asset.path}, {"size", 0}});
        files.push_back({asset.path, 0, std::nullopt});
    }

    nlohmann::json manifest = {
        {"format", "noveltea.runtime-package"},
        {"format_version", 2},
        {"kind", "runtime"},
        {"created_by", "noveltea-editor-tool"},
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
            return Result<noveltea::runtime::RunningGameLoadInput, Diagnostics>::failure(
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
                    entries.push_back({{"path", binary.path}, {"size", 0}});
                    files.push_back({binary.path, 0, std::nullopt});
                }
            }
        }
        entries.push_back({{"path", "shader-materials.json"}, {"size", 0}});
        files.push_back({"shader-materials.json", 0, std::nullopt});
        manifest["entries"] = std::move(entries);
        manifest["shader_variants"] = std::move(variants);
        manifest["shader_materials"] = {{"entry", "shader-materials.json"},
                                        {"schema", "noveltea.shader-materials.v1"},
                                        {"sources_stripped", true}};
    }

    return Result<noveltea::runtime::RunningGameLoadInput, Diagnostics>::success(
        noveltea::runtime::RunningGameLoadInput{.gameplay = std::move(gameplay),
                                                .manifest = std::move(manifest),
                                                .shader_materials = std::move(shader_materials),
                                                .files = std::move(files),
                                                .runtime_locale = std::move(runtime_locale),
                                                .decoded_package = std::nullopt});
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
                          {"sourcePath", diagnostic.source_path.generic_string()},
                          {"outputPath", diagnostic.output_path.generic_string()},
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
                          {"sourcePath", output.source_path.generic_string()},
                          {"outputPath", output.output_path.generic_string()},
                          {"runtimePath", output.runtime_path},
                          {"cacheKey", output.cache_key},
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
    auto source = std::make_shared<noveltea::assets::MemoryAssetSource>();
    Diagnostics diagnostics;
    for (const auto& entry : options.file_entries) {
        auto content = read_file(entry.source);
        if (!content) {
            diagnostics.push_back(
                {.code = "export.asset_read_failed",
                 .message = "Could not read export asset '" + entry.source.string() + "'.",
                 .severity = ErrorSeverity::Error,
                 .source_path = entry.package_path});
            continue;
        }
        source->add("project:/" + entry.package_path,
                    noveltea::assets::AssetBytes(content->begin(), content->end()),
                    entry.source.string());
    }
    if (!diagnostics.empty())
        return Result<void, Diagnostics>::failure(std::move(diagnostics));

    noveltea::assets::AssetManager assets;
    assets.mount("project", std::move(source));
    noveltea::script::ScriptRuntime scripts;
    auto initialized = scripts.initialize({&assets});
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
    auto runtime = noveltea::runtime::load_running_game(std::move(*input.value_if()), scripts,
                                                        presentation, saves);
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

    noveltea::assets::AssetManager assets;
    noveltea::script::ScriptRuntime scripts;
    auto initialized = scripts.initialize({&assets});
    if (!initialized)
        return fail("Lua runtime initialization failed.");
    TypedMemorySaveSlotStore saves;
    HeadlessPresentationRuntime presentation;
    auto input = make_headless_running_game_input(*project, std::nullopt, "en");
    if (!input)
        return fail("Compiled runtime load failed.", compiled_diagnostics_to_json(input.error()));
    auto runtime = noveltea::runtime::load_running_game(std::move(*input.value_if()), scripts,
                                                        presentation, saves);
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

    options.shaderc = json_access::value_or(json, "shaderc", std::string{});
    options.bgfx_shader_include_dir =
        json_access::value_or(json, "bgfxShaderIncludeDir", std::string{});
    options.project_root = json_access::value_or(json, "projectRoot", std::string{});
    options.output_root = json_access::value_or(json, "outputRoot", std::string{});
    options.cache_root = json_access::value_or(json, "cacheRoot", std::string{});
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
    options.shader_asset_root = json_access::value_or(json, "shaderAssetRoot", std::string{});
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
            asset_root.root = json_access::value_or(root, "root", std::string{});
            asset_root.package_prefix = json_access::value_or(root, "packagePrefix", std::string{});
            options.asset_roots.push_back(std::move(asset_root));
        }
    }
    if (auto entries = json.find("fileEntries"); entries != json.end() && entries->is_array()) {
        for (const auto& entry : *entries) {
            if (!entry.is_object())
                continue;
            PackageExportFileEntry file_entry;
            file_entry.source = json_access::value_or(entry, "source", std::string{});
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
        auto result = ProjectPackageWriter::write_to_file(*project, output, options);
        return ok({{"success", result.success},
                   {"diagnostics", export_diagnostics_to_json(result.diagnostics)},
                   {"manifest", result.manifest},
                   {"byteCount", result.byte_count},
                   {"checksums", result.checksums}});
    }

    return fail("Unknown command.");
}

} // namespace

int main(int argc, char** argv)
{
    if (argc < 2) {
        std::cout << fail("Usage: noveltea-editor-tool <command>").dump(2) << '\n';
        return 2;
    }

    const auto input = read_all(std::cin);
    const auto request =
        input.empty() ? nlohmann::json::object() : nlohmann::json::parse(input, nullptr, false);
    if (request.is_discarded()) {
        std::cout << fail("Malformed request JSON").dump(2) << '\n';
        return 1;
    }

    auto response = run_command(argv[1], request);
    std::cout << response.dump(2) << '\n';
    return json_access::value_or(response, "ok", false) ? 0 : 1;
}
