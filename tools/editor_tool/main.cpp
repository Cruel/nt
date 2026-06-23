#include <noveltea/core/editor_api.hpp>
#include <noveltea/core/project_ids.hpp>
#include <noveltea/render/shader_compiler.hpp>

#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>

namespace {

using namespace noveltea::core;
using namespace noveltea::core::editor;

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

const char* severity_to_string(DiagnosticSeverity severity)
{
    switch (severity) {
    case DiagnosticSeverity::Info:
        return "info";
    case DiagnosticSeverity::Warning:
        return "warning";
    case DiagnosticSeverity::Error:
        return "error";
    }
    return "error";
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

nlohmann::json diagnostic_to_json(const ToolDiagnostic& diagnostic)
{
    return {{"severity", severity_to_string(diagnostic.severity)},
            {"path", diagnostic.path},
            {"message", diagnostic.message}};
}

nlohmann::json diagnostics_to_json(const std::vector<ToolDiagnostic>& diagnostics)
{
    auto result = nlohmann::json::array();
    for (const auto& diagnostic : diagnostics)
        result.push_back(diagnostic_to_json(diagnostic));
    return result;
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

nlohmann::json material_diagnostics_to_json(const std::vector<noveltea::MaterialDiagnostic>& diagnostics)
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
                          {"shader", diagnostic.shader.value()},
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

nlohmann::json shader_compile_outputs_to_json(
    const std::vector<noveltea::ShaderCompileOutput>& outputs)
{
    auto result = nlohmann::json::array();
    for (const auto& output : outputs) {
        result.push_back({{"shader", output.shader.value()},
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

std::optional<ProjectDocument> project_from_request(const nlohmann::json& request,
                                                    nlohmann::json& error_response)
{
    std::string source;
    if (request.contains("project")) {
        if (request["project"].is_string()) {
            source = request["project"].get<std::string>();
        } else {
            source = request["project"].dump();
        }
    } else if (request.contains("projectPath") && request["projectPath"].is_string()) {
        auto content = read_file(request["projectPath"].get<std::string>());
        if (!content) {
            error_response = fail("Could not read projectPath.");
            return std::nullopt;
        }
        source = std::move(*content);
    } else {
        error_response = fail("Request requires project or projectPath.");
        return std::nullopt;
    }

    auto loaded = ProjectTooling::load_project_json(source);
    if (!loaded.project) {
        error_response = fail("Project load failed.", diagnostics_to_json(loaded.diagnostics));
        return std::nullopt;
    }
    return std::move(*loaded.project);
}

nlohmann::json project_payload(ProjectLoadResult& loaded)
{
    nlohmann::json response = ok({{"success", loaded.success()},
                                  {"importedLegacy", loaded.imported_legacy},
                                  {"diagnostics", diagnostics_to_json(loaded.diagnostics)}});
    if (loaded.project)
        response["project"] = loaded.project->root();
    return response;
}

noveltea::ShaderCompileOptions shader_compile_options_from_json(const nlohmann::json& json,
                                                                  nlohmann::json& diagnostics)
{
    noveltea::ShaderCompileOptions options;
    if (!json.is_object())
        return options;

    options.shaderc = json.value("shaderc", std::string{});
    options.bgfx_shader_include_dir = json.value("bgfxShaderIncludeDir", std::string{});
    options.project_root = json.value("projectRoot", std::string{});
    options.output_root = json.value("outputRoot", std::string{});
    options.cache_root = json.value("cacheRoot", std::string{});
    options.force_rebuild = json.value("forceRebuild", false);

    std::vector<std::string> variant_names;
    if (auto variants = json.find("shaderVariants");
        variants != json.end() && variants->is_array()) {
        for (const auto& variant : *variants) {
            if (variant.is_string())
                variant_names.push_back(variant.get<std::string>());
        }
    }

    std::vector<noveltea::ShaderCompileDiagnostic> variant_diagnostics;
    options.variants =
        noveltea::shader_compile_variants_from_names(variant_names, &variant_diagnostics);
    diagnostics = shader_compile_diagnostics_to_json(variant_diagnostics);
    return options;
}

std::optional<noveltea::ShaderMaterialProject> shader_project_from_request(
    const nlohmann::json& request, nlohmann::json& error_response)
{
    auto shader_project_json = request.find("shaderProject");
    if (shader_project_json == request.end()) {
        error_response = fail("Request requires shaderProject.");
        return std::nullopt;
    }

    noveltea::ShaderMaterialProjectParseResult parsed;
    if (shader_project_json->is_string()) {
        parsed = noveltea::parse_shader_material_project_json(shader_project_json->get<std::string>());
    } else {
        parsed = noveltea::parse_shader_material_project_json_value(*shader_project_json);
    }

    if (!parsed.project) {
        error_response = fail("Shader project parse failed.",
                              material_diagnostics_to_json(parsed.diagnostics));
        return std::nullopt;
    }
    return std::move(*parsed.project);
}

PackageExportOptions export_options_from_json(const nlohmann::json& json)
{
    PackageExportOptions options;
    if (!json.is_object())
        return options;
    const auto kind = json.value("kind", std::string("runtime"));
    options.kind = kind == "editable" ? PackageExportKind::Editable : PackageExportKind::Runtime;
    options.project_name = json.value("projectName", std::string{});
    options.project_version = json.value("projectVersion", std::string{});
    options.created_by = json.value("createdBy", std::string("noveltea-editor"));
    options.include_checksums = json.value("includeChecksums", true);
    options.shader_asset_root = json.value("shaderAssetRoot", std::string{});
    if (auto variants = json.find("shaderVariants");
        variants != json.end() && variants->is_array()) {
        for (const auto& variant : *variants) {
            if (variant.is_string())
                options.shader_variants.push_back(variant.get<std::string>());
        }
    }
    if (auto roots = json.find("assetRoots"); roots != json.end() && roots->is_array()) {
        for (const auto& root : *roots) {
            if (!root.is_object())
                continue;
            PackageExportAssetRoot asset_root;
            asset_root.root = root.value("root", std::string{});
            asset_root.package_prefix = root.value("packagePrefix", std::string{});
            options.asset_roots.push_back(std::move(asset_root));
        }
    }
    return options;
}

nlohmann::json run_command(std::string_view command, const nlohmann::json& request)
{
    if (command == "load-project") {
        const auto source = request.value("source", std::string{});
        auto loaded = ProjectTooling::load_project_json(source);
        return project_payload(loaded);
    }

    if (command == "import-legacy-game") {
        const auto source = request.value("source", std::string{});
        auto loaded = ProjectTooling::import_legacy_game_json(source);
        return project_payload(loaded);
    }

    if (command == "validate") {
        nlohmann::json error_response;
        auto project = project_from_request(request, error_response);
        if (!project)
            return error_response;
        auto diagnostics = ProjectTooling::validate_project(*project);
        return ok(
            {{"success", diagnostics.empty()}, {"diagnostics", diagnostics_to_json(diagnostics)}});
    }

    if (command == "list-tests") {
        nlohmann::json error_response;
        auto project = project_from_request(request, error_response);
        if (!project)
            return error_response;
        std::vector<ToolDiagnostic> diagnostics;
        auto specs = RuntimePlaybackSession::specs_from_project(*project, diagnostics);
        auto tests = nlohmann::json::array();
        for (const auto& spec : specs)
            tests.push_back({{"id", spec.id}, {"steps", spec.steps.size()}});
        return ok({{"tests", std::move(tests)}, {"diagnostics", diagnostics_to_json(diagnostics)}});
    }

    if (command == "run-test") {
        nlohmann::json error_response;
        auto project = project_from_request(request, error_response);
        if (!project)
            return error_response;

        std::vector<ToolDiagnostic> diagnostics;
        std::optional<RuntimePlaybackSpec> spec;
        if (auto spec_json = request.find("spec"); spec_json != request.end()) {
            spec = RuntimePlaybackSession::parse_spec(*spec_json, diagnostics, "/spec");
        } else {
            const auto test_id = request.value("testId", std::string{});
            auto specs = RuntimePlaybackSession::specs_from_project(*project, diagnostics);
            for (auto& candidate : specs) {
                if (candidate.id == test_id) {
                    spec = std::move(candidate);
                    break;
                }
            }
            if (!spec && diagnostics.empty())
                diagnostics.push_back(
                    ToolDiagnostic{DiagnosticSeverity::Error, "/testId", "Unknown test id."});
        }
        if (!spec)
            return fail("Playback spec parse failed.", diagnostics_to_json(diagnostics));

        RuntimePlaybackSession playback;
        auto report = playback.run(std::move(*project), *spec);
        return ok(
            {{"report", report.to_json()}, {"diagnostics", diagnostics_to_json(diagnostics)}});
    }

    if (command == "compile-shaders") {
        nlohmann::json error_response;
        auto shader_project = shader_project_from_request(request, error_response);
        if (!shader_project)
            return error_response;

        nlohmann::json variant_diagnostics = nlohmann::json::array();
        auto options = shader_compile_options_from_json(
            request.value("options", nlohmann::json::object()), variant_diagnostics);
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
        auto project = project_from_request(request, error_response);
        if (!project)
            return error_response;
        const auto output = request.value("outputPath", std::string{});
        if (output.empty())
            return fail("Request requires outputPath.");
        const auto options =
            export_options_from_json(request.value("options", nlohmann::json::object()));
        auto result = ProjectTooling::export_project_package(*project, output, options);
        return ok({{"success", result.success},
                   {"diagnostics", export_diagnostics_to_json(result.diagnostics)},
                   {"manifest", result.manifest},
                   {"byteCount", result.byte_count},
                   {"checksums", result.checksums}});
    }

    if (command == "set-entity") {
        nlohmann::json error_response;
        auto project = project_from_request(request, error_response);
        if (!project)
            return error_response;
        auto result =
            ProjectTooling::set_entity_record(*project, request.value("collection", std::string{}),
                                              request.value("entityId", std::string{}),
                                              request.value("record", nlohmann::json::array()));
        return ok({{"success", result.success()},
                   {"diagnostics", diagnostics_to_json(result.diagnostics)},
                   {"project", project->root()}});
    }

    if (command == "erase-entity") {
        nlohmann::json error_response;
        auto project = project_from_request(request, error_response);
        if (!project)
            return error_response;
        auto result = ProjectTooling::erase_entity_record(
            *project, request.value("collection", std::string{}),
            request.value("entityId", std::string{}));
        return ok({{"success", result.success()},
                   {"diagnostics", diagnostics_to_json(result.diagnostics)},
                   {"project", project->root()}});
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

    try {
        const auto input = read_all(std::cin);
        const auto request =
            input.empty() ? nlohmann::json::object() : nlohmann::json::parse(input);
        auto response = run_command(argv[1], request);
        std::cout << response.dump(2) << '\n';
        return response.value("ok", false) ? 0 : 1;
    } catch (const nlohmann::json::parse_error& error) {
        std::cout << fail(std::string("Malformed request JSON: ") + error.what()).dump(2) << '\n';
        return 1;
    } catch (const std::exception& error) {
        std::cout << fail(error.what()).dump(2) << '\n';
        return 1;
    }
}
