#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/core/data_asset_codec.hpp>
#include <noveltea/core/compiled_package_codec.hpp>
#include <noveltea/core/package_export.hpp>
#include <noveltea/core/player_bootstrap.hpp>
#include <noveltea/core/editor_playback_expectations.hpp>
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
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <system_error>
#include <cstdio>
#include <optional>
#include <unordered_map>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

extern int noveltea_bimg_texturec_main(int argc, const char** argv);

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif
extern char** environ;
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
    accept(const PresentationOperation& operation) override
    {
        std::visit(
            [this](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, RoomNavigationTransitionOperation>) {
                    m_completions.push_back(CompletePresentationInput{
                        value.common.id, value.completion.owner, value.completion.blocker});
                } else if (value.completion) {
                    m_completions.push_back(CompletePresentationInput{
                        value.common.id, value.completion->owner, value.completion->blocker});
                }
            },
            operation);
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

    void terminate(PresentationCancellationReason) override { m_completions.clear(); }

    [[nodiscard]] std::optional<CompletePresentationInput> take_completion()
    {
        if (m_completions.empty())
            return std::nullopt;
        auto completion = m_completions.front();
        m_completions.erase(m_completions.begin());
        return completion;
    }

private:
    PresentationCheckpointStatus status{CheckpointStatusRevision::from_number(1), {}, std::nullopt};
    std::vector<CompletePresentationInput> m_completions;
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
                                        {"schema", "noveltea.shader-materials"},
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

    [[nodiscard]] Result<PersistableValue, std::string>
    read_data_asset(std::string_view logical_path) const override
    {
        auto source = read_script_source(logical_path);
        if (!source)
            return Result<PersistableValue, std::string>::failure(source.error().message);
        return decode_data_asset(source.value());
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

nlohmann::json reflected_inputs_to_json(
    const std::vector<noveltea::ShaderReflectedInput>& inputs)
{
    auto result = nlohmann::json::array();
    for (const auto& input : inputs) {
        result.push_back({
            {"name", input.name},
            {"kind", input.kind == noveltea::ShaderReflectedInputKind::SampledImage
                         ? "sampled-image"
                         : "uniform"},
            {"type", input.type},
            {"arraySize", input.array_size},
        });
    }
    return result;
}

nlohmann::json source_program_outputs_to_json(
    std::string_view program,
    const noveltea::ShaderSourceProgramCompileResult& compile_result)
{
    auto result = nlohmann::json::array();
    for (const auto& output : compile_result.outputs) {
        auto dependency_revisions = nlohmann::json::array();
        for (const auto& dependency : output.dependency_revisions)
            dependency_revisions.push_back(nlohmann::json::object(
                {{"identity", dependency.identity}, {"contentHash", dependency.content_hash}}));
        nlohmann::json item = {
            {"program", program},
            {"programIdentity", compile_result.program_identity},
            {"stage", std::string(noveltea::to_string(output.stage))},
            {"variant", output.variant},
            {"sourceIdentity", output.source_identity},
            {"dependencies", output.dependencies},
            {"dependencyRevisions", std::move(dependency_revisions)},
            {"outputPath", filesystem_path_to_utf8(output.output_path)},
            {"runtimePath", output.runtime_path},
            {"cacheKey", output.cache_key},
            {"byteHash", output.byte_hash},
            {"byteSize", output.byte_size},
            {"reflectedInputs", reflected_inputs_to_json(output.reflected_inputs)},
            {"cacheHit", output.cache_hit},
        };
        if (output.browser_payload)
            item["browserPayload"] = *output.browser_payload;
        result.push_back(std::move(item));
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

nlohmann::json
compiled_project_admission_failure(std::string message,
                                   nlohmann::json diagnostics = nlohmann::json::array())
{
    auto result = fail(std::move(message), std::move(diagnostics));
    result["compiledProjectAdmissionRejected"] = true;
    return result;
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
        error_response = compiled_project_admission_failure("Request requires compiled project.");
        return std::nullopt;
    }
    nlohmann::json project = *project_it;
    if (project.is_string())
        project =
            nlohmann::json::parse(json_access::get_or<std::string>(project, {}), nullptr, false);
    if (project.is_discarded()) {
        error_response = compiled_project_admission_failure("Compiled project JSON is malformed.");
        return std::nullopt;
    }
    auto decoded = decode_compiled_project(project, "game");
    if (!decoded) {
        error_response = compiled_project_admission_failure(
            "Compiled project validation failed.", compiled_diagnostics_to_json(decoded.error()));
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
        return compiled_project_admission_failure("Compiled runtime load failed.",
                                                  compiled_diagnostics_to_json(input.error()));
    auto runtime =
        load_headless_running_game(std::move(*input.value_if()), scripts, presentation, saves);
    if (!runtime)
        return compiled_project_admission_failure("Compiled runtime load failed.",
                                                  compiled_diagnostics_to_json(runtime.error()));

    auto decoded_spec = editor::decode_editor_playback_text(spec_it->dump());
    if (!decoded_spec)
        return fail("Playback spec parse failed.",
                    compiled_diagnostics_to_json(decoded_spec.error()));

    std::vector<editor::TypedPlaybackStepReport> steps;
    std::vector<editor::TypedPlaybackExpectationReport> final_expectations;
    std::vector<noveltea::runtime::RuntimeEvent> all_events;
    Diagnostics all_diagnostics;
    bool passed = true;
    const auto* typed_spec = decoded_spec.value_if();
    if (!typed_spec)
        return fail("Playback spec parse failed.");
    auto& session = runtime.value_if()->get()->session();
    const auto settle_headless_presentation = [&](noveltea::runtime::RuntimeDispatchResult& result) {
        while (auto completion = presentation.take_completion()) {
            auto completed = session.dispatch(RuntimeInputMessage{std::move(*completion)});
            result.events.insert(result.events.end(),
                                 std::make_move_iterator(completed.events.begin()),
                                 std::make_move_iterator(completed.events.end()));
            result.diagnostics.insert(result.diagnostics.end(),
                                      std::make_move_iterator(completed.diagnostics.begin()),
                                      std::make_move_iterator(completed.diagnostics.end()));
            if (completed.publication)
                result.publication = std::move(completed.publication);
            if (completed.disposition == noveltea::runtime::RuntimeInputDisposition::Failed)
                result.disposition = noveltea::runtime::RuntimeInputDisposition::Failed;
        }
    };
    auto startup = session.dispatch(RuntimeInputMessage{StartRuntimeInput{}});
    settle_headless_presentation(startup);
    std::optional<noveltea::runtime::RuntimePublication> final_publication;
    if (startup.publication)
        final_publication = std::move(startup.publication);
    all_events.insert(all_events.end(), startup.events.begin(), startup.events.end());
    all_diagnostics.insert(all_diagnostics.end(), startup.diagnostics.begin(),
                           startup.diagnostics.end());
    if (startup.disposition == noveltea::runtime::RuntimeInputDisposition::Failed ||
        diagnostics_have_errors(startup.diagnostics))
        passed = false;

    for (const auto& step : typed_spec->steps) {
        if (!std::holds_alternative<RuntimeInputMessage>(step.input))
            return fail("UI click playback input requires run-ui-test.");
        auto result = session.dispatch(std::get<RuntimeInputMessage>(step.input));
        settle_headless_presentation(result);
        editor::TypedPlaybackStepReport report;
        report.index = step.index;
        report.handled = result.disposition == noveltea::runtime::RuntimeInputDisposition::Handled;
        if (result.publication)
            final_publication = std::move(result.publication);
        report.events = std::move(result.events);
        report.diagnostics = std::move(result.diagnostics);

        // Expectations observe a settled semantic boundary. A zero-duration engine-time advance
        // drains deterministic runtime work without introducing wall-clock sleeps or elapsed time.
        if (!step.expectations.empty()) {
            auto settled = session.dispatch(RuntimeInputMessage{AdvanceTimeInput{}});
            settle_headless_presentation(settled);
            if (settled.publication)
                final_publication = std::move(settled.publication);
            report.events.insert(report.events.end(),
                                 std::make_move_iterator(settled.events.begin()),
                                 std::make_move_iterator(settled.events.end()));
            report.diagnostics.insert(report.diagnostics.end(),
                                      std::make_move_iterator(settled.diagnostics.begin()),
                                      std::make_move_iterator(settled.diagnostics.end()));
            if (settled.disposition == noveltea::runtime::RuntimeInputDisposition::Failed)
                passed = false;
        }
        if (!final_publication)
            return fail("Playback step completed without a runtime publication.");

        if (result.disposition == noveltea::runtime::RuntimeInputDisposition::Failed ||
            diagnostics_have_errors(report.diagnostics))
            passed = false;
        for (const auto& expectation : step.expectations) {
            auto expectation_report = noveltea::core::editor::evaluate_playback_expectation(
                expectation, session, *final_publication, report.events, report.diagnostics);
            if (!expectation_report.passed)
                passed = false;
            report.expectations.push_back(std::move(expectation_report));
        }
        all_events.insert(all_events.end(), report.events.begin(), report.events.end());
        all_diagnostics.insert(all_diagnostics.end(), report.diagnostics.begin(),
                               report.diagnostics.end());
        steps.push_back(std::move(report));
    }

    auto settled = session.dispatch(RuntimeInputMessage{AdvanceTimeInput{}});
    settle_headless_presentation(settled);
    if (settled.publication)
        final_publication = std::move(settled.publication);
    all_events.insert(all_events.end(), settled.events.begin(), settled.events.end());
    all_diagnostics.insert(all_diagnostics.end(), settled.diagnostics.begin(),
                           settled.diagnostics.end());
    if (settled.disposition == noveltea::runtime::RuntimeInputDisposition::Failed ||
        diagnostics_have_errors(settled.diagnostics))
        passed = false;
    if (!final_publication)
        return fail("Playback completed without a final runtime publication.");
    for (const auto& expectation : typed_spec->final_expectations) {
        auto expectation_report = noveltea::core::editor::evaluate_playback_expectation(
            expectation, session, *final_publication, all_events, all_diagnostics);
        if (!expectation_report.passed)
            passed = false;
        final_expectations.push_back(std::move(expectation_report));
    }
    const auto report_text = editor::encode_editor_playback_report_text(
        typed_spec->id, steps, final_expectations, *final_publication, passed);
    auto report = nlohmann::json::parse(report_text, nullptr, false);
    if (report.is_discarded())
        return fail("Playback report encoding failed.");
    return ok({{"report", std::move(report)}});
}

noveltea::ShaderCompileOptions
shader_compile_options_from_json(const nlohmann::json& json,
                                 std::vector<noveltea::ShaderCompileDiagnostic>& diagnostics)
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
    options.engine_shader_root = filesystem_path_from_utf8(
        json_access::value_or(json, "engineShaderRoot", std::string{}));
    options.force_rebuild = json_access::value_or(json, "forceRebuild", false);

    std::vector<std::string> variant_names;
    if (auto variants = json.find("shaderVariants");
        variants != json.end() && variants->is_array()) {
        for (const auto& variant : *variants) {
            if (variant.is_string())
                variant_names.push_back(json_access::get_or<std::string>(variant, {}));
        }
    }

    options.variants = noveltea::shader_compile_variants_from_names(variant_names, &diagnostics);
    return options;
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
    if (auto entries = json.find("textEntries"); entries != json.end() && entries->is_array()) {
        for (const auto& entry : *entries) {
            if (!entry.is_object())
                continue;
            PackageExportTextEntry text_entry;
            text_entry.text = json_access::value_or(entry, "text", std::string{});
            text_entry.package_path = json_access::value_or(entry, "packagePath", std::string{});
            const auto storage = json_access::value_or(entry, "storage", std::string("auto"));
            if (storage == "stored")
                text_entry.storage = PackageExportStorage::Stored;
            else if (storage == "compressed")
                text_entry.storage = PackageExportStorage::Compressed;
            options.text_entries.push_back(std::move(text_entry));
        }
    }
    return options;
}

std::optional<std::filesystem::path> current_executable_directory()
{
#if defined(_WIN32)
    std::wstring buffer(32768, L'\0');
    const auto size = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (size == 0 || size >= buffer.size())
        return std::nullopt;
    buffer.resize(size);
    return std::filesystem::path(std::move(buffer)).parent_path();
#elif defined(__APPLE__)
    std::uint32_t size = 0;
    (void)_NSGetExecutablePath(nullptr, &size);
    if (size == 0)
        return std::nullopt;
    std::string buffer(size, '\0');
    if (_NSGetExecutablePath(buffer.data(), &size) != 0)
        return std::nullopt;
    buffer.resize(std::strlen(buffer.c_str()));
    std::error_code error;
    const auto executable = std::filesystem::weakly_canonical(std::filesystem::path(buffer), error);
    if (error)
        return std::nullopt;
    return executable.parent_path();
#else
    std::error_code error;
    const auto executable = std::filesystem::read_symlink("/proc/self/exe", error);
    if (error)
        return std::nullopt;
    return executable.parent_path();
#endif
}

std::optional<std::filesystem::path> ui_test_runner_path()
{
    if (const char* override_path = std::getenv("NOVELTEA_UI_TEST_RUNNER");
        override_path != nullptr && *override_path != '\0') {
        const std::filesystem::path candidate(override_path);
        if (std::filesystem::exists(candidate))
            return candidate;
    }
    if (const auto directory = current_executable_directory()) {
#if defined(_WIN32)
        const auto candidate = *directory / "noveltea-ui-test-runner.exe";
#else
        const auto candidate = *directory / "noveltea-ui-test-runner";
#endif
        if (std::filesystem::exists(candidate))
            return candidate;
    }
#ifdef NOVELTEA_UI_TEST_RUNNER_PATH
    const std::filesystem::path configured(NOVELTEA_UI_TEST_RUNNER_PATH);
    if (std::filesystem::exists(configured))
        return configured;
#endif
    return std::nullopt;
}

int run_ui_test_runner_process(const std::filesystem::path& runner,
                               const std::filesystem::path& input_path,
                               const std::filesystem::path& response_path)
{
#if defined(_WIN32)
    const auto quote = [](const std::wstring& value) { return L"\"" + value + L"\""; };
    std::wstring command = quote(runner.native()) + L" " + quote(input_path.native()) + L" " +
                           quote(response_path.native());
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(runner.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                        nullptr, nullptr, &startup, &process))
        return -1;
    const auto wait = WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exit_code = 0;
    const bool exited = wait == WAIT_OBJECT_0 && GetExitCodeProcess(process.hProcess, &exit_code);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return exited ? static_cast<int>(exit_code) : -1;
#else
    auto runner_text = filesystem_path_to_utf8(runner);
    auto input_text = filesystem_path_to_utf8(input_path);
    auto response_text = filesystem_path_to_utf8(response_path);
    char* arguments[] = {runner_text.data(), input_text.data(), response_text.data(), nullptr};
    posix_spawn_file_actions_t actions;
    if (posix_spawn_file_actions_init(&actions) != 0)
        return -1;
    const int redirected = posix_spawn_file_actions_adddup2(&actions, STDERR_FILENO, STDOUT_FILENO);
    if (redirected != 0) {
        posix_spawn_file_actions_destroy(&actions);
        return -1;
    }
    pid_t process = 0;
    const int spawned =
        posix_spawn(&process, runner_text.c_str(), &actions, nullptr, arguments, environ);
    posix_spawn_file_actions_destroy(&actions);
    if (spawned != 0)
        return -1;
    int status = 0;
    while (waitpid(process, &status, 0) < 0) {
        if (errno != EINTR)
            return -1;
    }
    if (WIFEXITED(status))
        return WEXITSTATUS(status);
    if (WIFSIGNALED(status))
        return 128 + WTERMSIG(status);
    return -1;
#endif
}

nlohmann::json run_external_ui_playback(const nlohmann::json& request)
{
    const auto runner = ui_test_runner_path();
    if (!runner)
        return fail("Runtime UI Test runner is unavailable.");

    static std::atomic_uint64_t sequence{0};
    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto root = std::filesystem::temp_directory_path() /
                      ("noveltea-ui-test-" + std::to_string(nonce) + "-" +
                       std::to_string(sequence.fetch_add(1, std::memory_order_relaxed)));
    std::error_code error;
    if (!std::filesystem::create_directories(root, error) || error)
        return fail("Could not create Runtime UI Test request directory.");
    const auto input_path = root / "request.json";
    const auto response_path = root / "response.json";
    {
        std::ofstream input(input_path, std::ios::binary | std::ios::trunc);
        if (!input) {
            std::filesystem::remove_all(root, error);
            return fail("Could not write Runtime UI Test request.");
        }
        input << request.dump();
    }
#if !defined(_WIN32)
    std::filesystem::permissions(
        root, std::filesystem::perms::owner_all, std::filesystem::perm_options::replace, error);
    error.clear();
    std::filesystem::permissions(input_path,
                                 std::filesystem::perms::owner_read |
                                     std::filesystem::perms::owner_write,
                                 std::filesystem::perm_options::replace, error);
    error.clear();
#endif
    const int status = run_ui_test_runner_process(*runner, input_path, response_path);
    const auto response_text = read_file(response_path);
    std::filesystem::remove_all(root, error);
    if (!response_text)
        return fail("Runtime UI Test runner did not produce a response (status " +
                    std::to_string(status) + ").");
    auto response = nlohmann::json::parse(*response_text, nullptr, false);
    if (response.is_discarded())
        return fail("Runtime UI Test runner returned malformed JSON.");
    return response;
}

bool playback_report_has_execution_error(const nlohmann::json& report)
{
    const auto steps = report.find("steps");
    if (steps == report.end() || !steps->is_array())
        return true;
    for (const auto& step : *steps) {
        if (!step.is_object())
            return true;
        const auto diagnostics = step.find("diagnostics");
        if (diagnostics == step.end() || !diagnostics->is_array())
            return true;
        for (const auto& diagnostic : *diagnostics) {
            const auto severity = json_access::value_or(diagnostic, "severity", std::string{});
            if (severity == "error" || severity == "fatal")
                return true;
        }
    }
    return false;
}

nlohmann::json playback_report_error_diagnostics(const nlohmann::json& report,
                                                 std::string_view test_id)
{
    auto result = nlohmann::json::array();
    const auto steps = report.find("steps");
    if (steps != report.end() && steps->is_array()) {
        for (const auto& step : *steps) {
            if (!step.is_object())
                continue;
            const auto diagnostics = step.find("diagnostics");
            if (diagnostics == step.end() || !diagnostics->is_array())
                continue;
            for (const auto& diagnostic : *diagnostics) {
                if (!diagnostic.is_object())
                    continue;
                const auto severity = json_access::value_or(diagnostic, "severity", std::string{});
                if (severity == "error" || severity == "fatal")
                    result.push_back(diagnostic);
            }
        }
    }
    if (result.empty()) {
        result.push_back({{"severity", "error"},
                          {"path", "/tests/" + std::string(test_id)},
                          {"message", "Native test execution did not complete successfully."}});
    }
    return result;
}

nlohmann::json suite_error_diagnostics(const nlohmann::json& response, std::string_view test_id)
{
    if (auto diagnostics = response.find("diagnostics");
        diagnostics != response.end() && diagnostics->is_array())
        return *diagnostics;
    return nlohmann::json::array(
        {{{"severity", "error"},
          {"path", "/tests/" + std::string(test_id)},
          {"message", json_access::value_or(response, "error",
                                            std::string("Native test execution failed."))}}});
}

nlohmann::json run_test_suite(const nlohmann::json& request)
{
    nlohmann::json error_response;
    auto project = compiled_project_from_request(request, error_response);
    if (!project)
        return error_response;

    const auto catalog_it = request.find("catalog");
    if (catalog_it == request.end() || !catalog_it->is_object() ||
        json_access::value_or(*catalog_it, "schema", std::string{}) !=
            "noveltea.runtime-test-catalog")
        return fail("Request requires current lowered test catalog.");
    const auto entries_it = catalog_it->find("entries");
    if (entries_it == catalog_it->end() || !entries_it->is_array())
        return fail("Lowered test catalog requires entries.");

    std::vector<nlohmann::json> entries(entries_it->begin(), entries_it->end());
    std::sort(entries.begin(), entries.end(), [](const auto& left, const auto& right) {
        return json_access::value_or(left, "id", std::string{}) <
               json_access::value_or(right, "id", std::string{});
    });

    const bool has_runnable = std::any_of(entries.begin(), entries.end(), [](const auto& entry) {
        return json_access::value_or(entry, "status", std::string{}) == "runnable";
    });
    if (has_runnable) {
        const nlohmann::json preflight_request = {
            {"project", *project},
            {"spec",
             {{"schema", "noveltea.editor.playback"},
              {"version", 1},
              {"id", "__suite_preflight__"},
              {"steps", nlohmann::json::array()},
              {"finalExpectations", nlohmann::json::array()}}},
        };
        const auto preflight = run_compiled_playback(preflight_request);
        if (!json_access::value_or(preflight, "ok", false))
            return preflight;
        const auto preflight_report = preflight.find("report");
        if (preflight_report == preflight.end() ||
            !json_access::value_or(*preflight_report, "passed", false))
            return compiled_project_admission_failure(
                "Compiled runtime startup failed during suite preflight.");
    }

    nlohmann::json report_entries = nlohmann::json::array();
    std::string previous_id;
    std::size_t passed = 0, failed = 0, blocked = 0, errors = 0;
    for (const auto& entry : entries) {
        const auto id = json_access::value_or(entry, "id", std::string{});
        if (id.empty() || id == previous_id)
            return fail("Lowered test catalog contains invalid or duplicate test IDs.");
        previous_id = id;
        const auto status = json_access::value_or(entry, "status", std::string{});
        if (status == "blocked") {
            auto diagnostics = json_access::value_or(entry, "diagnostics", nlohmann::json::array());
            if (!diagnostics.is_array() || diagnostics.empty())
                return fail("Blocked test catalog entry requires diagnostics.");
            report_entries.push_back({{"id", id},
                                      {"runner", nullptr},
                                      {"status", "blocked"},
                                      {"diagnostics", std::move(diagnostics)}});
            ++blocked;
            continue;
        }
        if (status != "runnable")
            return fail("Lowered test catalog entry has unknown status.");
        const auto runner = json_access::value_or(entry, "runner", std::string{});
        const auto spec = entry.find("spec");
        if ((runner != "runtime" && runner != "runtime-ui") || spec == entry.end())
            return fail("Runnable test catalog entry is incomplete.");

        nlohmann::json single_request = {{"project", *project}, {"spec", *spec}};
        if (auto root = request.find("projectRoot"); root != request.end())
            single_request["projectRoot"] = *root;
        if (auto shader_metadata = request.find("shaderMaterialMetadata");
            shader_metadata != request.end())
            single_request["shaderMaterialMetadata"] = *shader_metadata;
        const auto response = runner == "runtime-ui" ? run_external_ui_playback(single_request)
                                                     : run_compiled_playback(single_request);
        if (!json_access::value_or(response, "ok", false) || !response.contains("report")) {
            report_entries.push_back({{"id", id},
                                      {"runner", runner},
                                      {"status", "error"},
                                      {"diagnostics", suite_error_diagnostics(response, id)}});
            ++errors;
            continue;
        }
        const auto& playback_report = response["report"];
        const bool execution_error = playback_report_has_execution_error(playback_report);
        const bool test_passed = json_access::value_or(playback_report, "passed", false);
        const auto result_status = execution_error ? "error" : test_passed ? "passed" : "failed";
        nlohmann::json report_entry = {
            {"id", id}, {"runner", runner}, {"status", result_status}, {"report", playback_report}};
        if (execution_error)
            report_entry["diagnostics"] = playback_report_error_diagnostics(playback_report, id);
        report_entries.push_back(std::move(report_entry));
        if (execution_error)
            ++errors;
        else if (test_passed)
            ++passed;
        else
            ++failed;
    }

    const auto total = entries.size();
    return ok({{"success", failed == 0 && errors == 0},
               {"report",
                {{"schema", "noveltea.test-suite-report"},
                 {"counts",
                  {{"total", total},
                   {"passed", passed},
                   {"failed", failed},
                   {"blocked", blocked},
                   {"error", errors}}},
                 {"entries", std::move(report_entries)}}}});
}

nlohmann::json run_command(std::string_view command, const nlohmann::json& request)
{
    if (command == "run-test") {
        return run_compiled_playback(request);
    }

    if (command == "run-test-suite") {
        return run_test_suite(request);
    }

    if (command == "run-ui-test") {
        return run_external_ui_playback(request);
    }

    if (command == "compile-shaders") {
        const auto shader_project = request.find("shaderProject");
        if (shader_project == request.end() || !shader_project->is_object())
            return fail("Request requires shaderProject.");

        std::vector<noveltea::ShaderCompileDiagnostic> variant_diagnostics;
        auto options = shader_compile_options_from_json(
            json_access::value_or(request, "options", nlohmann::json::object()),
            variant_diagnostics);
        noveltea::ShaderCompilerService compiler;

        if (json_access::value_or(*shader_project, "schema", std::string{}) !=
            "noveltea.shader-source-programs")
            return fail("Shader compilation requires canonical source-program input.");

        const auto programs_it = shader_project->find("programs");
        if (programs_it == shader_project->end() || !programs_it->is_object())
            return fail("Shader source-program request requires programs.");

        auto outputs = nlohmann::json::array();
        std::vector<noveltea::ShaderCompileDiagnostic> diagnostics =
            std::move(variant_diagnostics);
        bool success = diagnostics.empty();
        for (const auto& [program, value] : programs_it->items()) {
            if (!value.is_object())
                return fail("Shader source-program entry must be an object.");
            noveltea::ShaderSourceProgramRequest source_request{
                .vertex_source = json_access::value_or(value, "vertexSource", std::string{}),
                .fragment_source = json_access::value_or(value, "fragmentSource", std::string{}),
                .varying_definition =
                    json_access::value_or(value, "varyingDefinition", std::string{}),
                .interface_contract =
                    json_access::value_or(value, "interfaceContract", std::string{}),
            };
            auto result = compiler.compile_source_program(source_request, options);
            success = success && result.success();
            auto serialized = source_program_outputs_to_json(program, result);
            for (auto& output : serialized)
                outputs.push_back(std::move(output));
            diagnostics.insert(diagnostics.end(), result.diagnostics.begin(),
                               result.diagnostics.end());
        }
        return ok({{"success", success},
                   {"outputs", std::move(outputs)},
                   {"diagnostics", shader_compile_diagnostics_to_json(diagnostics)}});
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

NativeOperationResult run_test_suite(std::string_view request_json)
{
    return invoke_json_operation("run-test-suite", request_json);
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

extern "C" std::uint64_t noveltea_tooling_run_test_suite_json(const std::uint8_t* request,
                                                              std::uint64_t request_size,
                                                              std::uint8_t* response,
                                                              std::uint64_t response_capacity)
{
    return noveltea::tooling::copy_result(
        noveltea::tooling::run_test_suite(noveltea::tooling::request_view(request, request_size)),
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

extern "C" std::uint64_t
noveltea_tooling_validate_font_coverage_json(const std::uint8_t* request,
                                             std::uint64_t request_size, std::uint8_t* response,
                                             std::uint64_t response_capacity)
{
    return noveltea::tooling::copy_result(
        noveltea::tooling::validate_font_coverage(
            noveltea::tooling::request_view(request, request_size)),
        response, response_capacity);
}

extern "C" std::int32_t noveltea_tooling_shaderc(std::int32_t argc, const char* const* argv)
{
    return bgfx::compileShader(argc, const_cast<const char**>(argv));
}

extern "C" std::int32_t noveltea_tooling_texturec(std::int32_t argc, const char* const* argv)
{
    return noveltea_bimg_texturec_main(argc, const_cast<const char**>(argv));
}

extern "C" std::uint64_t noveltea_tooling_texturec_json(const std::uint8_t* request,
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
    storage.emplace_back("texturec");
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
    const auto exit_code =
        noveltea_bimg_texturec_main(static_cast<int>(argv.size()), argv.data());
    std::fflush(stdout);
    std::fflush(stderr);
    return noveltea::tooling::copy_result(
        {.exit_code = exit_code,
         .response_json = nlohmann::json{{"exitCode", exit_code}}.dump()},
        response, response_capacity);
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
