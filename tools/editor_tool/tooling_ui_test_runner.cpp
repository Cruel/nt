#include <noveltea/assets/asset_manager.hpp>
#include <noveltea/assets/asset_residency.hpp>
#include <noveltea/assets/asset_source.hpp>
#include <noveltea/assets/mandatory_asset_gate.hpp>
#include <noveltea/core/compiled_package_codec.hpp>
#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/core/data_asset_codec.hpp>
#include <noveltea/core/editor_playback_expectations.hpp>
#include <noveltea/core/editor_runtime_protocol.hpp>
#include <noveltea/core/json_access.hpp>
#include <noveltea/core/player_bootstrap.hpp>
#include <noveltea/core/save_state_codec.hpp>
#include <noveltea/core/typed_save_slot_store.hpp>
#include <noveltea/jobs/inline_job_executor.hpp>
#include <noveltea/presentation/runtime_presentation_model.hpp>
#include <noveltea/presentation/runtime_system_layouts.hpp>
#include <noveltea/render/material_codec.hpp>
#include <noveltea/runtime/running_game.hpp>
#include <noveltea/runtime/runtime_capabilities.hpp>
#include <noveltea/runtime/runtime_ports.hpp>
#include <noveltea/script/script_runtime.hpp>
#include <noveltea/text/text_asset_loader.hpp>

#include "host/host_lifecycle_contracts.hpp"
#include "host/layout_realizer.hpp"
#include "host/presentation_layout_reconciler.hpp"
#include "text/text_engine.hpp"
#include "ui/rmlui/runtime_ui.hpp"
#include "ui/rmlui/runtime_ui_playback_driver.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <limits>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

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

class ToolingScriptSource final : public noveltea::runtime::ScriptSourcePort {
public:
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

class ExecutorShutdownGuard final {
public:
    explicit ExecutorShutdownGuard(noveltea::jobs::InlineJobExecutor& executor) noexcept
        : m_executor(executor)
    {
    }

    ~ExecutorShutdownGuard()
    {
        m_executor.begin_shutdown();
        (void)m_executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    }

    ExecutorShutdownGuard(const ExecutorShutdownGuard&) = delete;
    ExecutorShutdownGuard& operator=(const ExecutorShutdownGuard&) = delete;

private:
    noveltea::jobs::InlineJobExecutor& m_executor;
};

class ToolingUiInputSink final : public noveltea::RuntimeUiInputSink {
public:
    using PresentationPreparation = std::function<
        Result<void, Diagnostics>(const RuntimePresentationSnapshot&)>;

    ToolingUiInputSink(std::unique_ptr<noveltea::runtime::RunningGame>& running_game,
                       std::unique_ptr<noveltea::script::ScriptRuntime>& gameplay_scripts,
                       noveltea::runtime::ScriptSourcePort& gameplay_sources,
                       HeadlessPresentationRuntime& presentation,
                       noveltea::script::ScriptRuntime& frontend_scripts,
                       noveltea::RuntimeUI& runtime_ui,
                       noveltea::host::PresentationLayoutReconciler& layouts,
                       PresentationPreparation prepare_presentation) noexcept
        : m_running_game(running_game), m_gameplay_scripts(gameplay_scripts),
          m_gameplay_sources(gameplay_sources), m_presentation(presentation),
          m_frontend_scripts(frontend_scripts), m_runtime_ui(runtime_ui), m_layouts(layouts),
          m_prepare_presentation(std::move(prepare_presentation))
    {
    }

    [[nodiscard]] bool submit_gameplay_input(RuntimeInputMessage input) override
    {
        auto result = m_running_game->session().dispatch(std::move(input));
        if (result.session_replacement_request && result.diagnostics.empty()) {
            const auto* reset =
                std::get_if<noveltea::core::ResetRuntimeInput>(&*result.session_replacement_request);
            if (reset == nullptr) {
                m_diagnostics.push_back(
                    {.code = "tooling.ui_test_session_replacement_unsupported",
                     .message = "Runtime UI Test only supports reset session replacement requests."});
                return false;
            }

            auto candidate_scripts = std::make_unique<noveltea::script::ScriptRuntime>();
            auto initialized = candidate_scripts->initialize({&m_gameplay_sources});
            if (!initialized) {
                m_diagnostics.push_back(
                    {.code = "tooling.ui_test_reset_script_initialization_failed",
                     .message = "Runtime UI Test reset Lua initialization failed."});
                return false;
            }
            candidate_scripts->synchronize_project_data_assets(m_running_game->package().project());
            candidate_scripts->set_startup_context(reset->startup_context);
            auto prepared = candidate_scripts->prepare_project_modules(m_running_game->package().project());
            if (!prepared) {
                m_diagnostics.push_back({.code = "tooling.ui_test_reset_script_modules_failed",
                                         .message = prepared.error().message,
                                         .source_path = prepared.error().chunk});
                return false;
            }
            auto bootstrapped = candidate_scripts->run_project_bootstrap();
            if (!bootstrapped) {
                m_diagnostics.push_back({.code = "tooling.ui_test_reset_bootstrap_failed",
                                         .message = bootstrapped.error().message,
                                         .source_path = bootstrapped.error().chunk});
                return false;
            }
            auto frozen = candidate_scripts->freeze_project_hooks();
            if (!frozen) {
                m_diagnostics.push_back({.code = "tooling.ui_test_reset_hooks_failed",
                                         .message = frozen.error().message,
                                         .source_path = frozen.error().chunk});
                return false;
            }
            auto candidate =
                m_running_game->prepare_reset_candidate(*reset, *candidate_scripts, m_presentation);
            if (!candidate) {
                const auto& diagnostics = candidate.error();
                m_diagnostics.insert(m_diagnostics.end(), diagnostics.begin(), diagnostics.end());
                return false;
            }
            auto prepared_candidate = std::move(*candidate.value_if());
            result = prepared_candidate->take_initial_result();
            auto previous = m_running_game->commit_candidate(std::move(prepared_candidate));
            previous.reset();
            m_gameplay_scripts = std::move(candidate_scripts);
            m_layouts.replace_runtime_session();
            m_runtime_ui.clear_gameplay_ui_values();
            m_runtime_ui.set_startup_context(m_running_game->startup_context());
        }
        while (auto completion = m_presentation.take_completion()) {
            auto completed = m_running_game->session().dispatch(
                RuntimeInputMessage{std::move(*completion)});
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
        m_events.insert(m_events.end(), result.events.begin(), result.events.end());
        m_diagnostics.insert(m_diagnostics.end(), result.diagnostics.begin(), result.diagnostics.end());
        if (result.publication) {
            m_publication = *result.publication;
            if (m_prepare_presentation) {
                auto prepared = m_prepare_presentation(result.publication->presentation);
                if (!prepared) {
                    auto diagnostics = std::move(prepared).error();
                    m_diagnostics.insert(m_diagnostics.end(),
                                         std::make_move_iterator(diagnostics.begin()),
                                         std::make_move_iterator(diagnostics.end()));
                    return false;
                }
            }
            auto reconciled = m_layouts.reconcile(result.publication->presentation);
            if (!reconciled) {
                const auto& diagnostics = reconciled.error();
                m_diagnostics.insert(m_diagnostics.end(), diagnostics.begin(), diagnostics.end());
                return false;
            }
            if (!m_runtime_ui.apply_gameplay_ui_values(
                    noveltea::RuntimeUiGameplayValues{result.publication->revision.number(),
                                                      result.publication->gameplay_ui, {}})) {
                m_diagnostics.push_back(
                    {.code = "tooling.ui_test_runtime_ui_rejected",
                     .message = "RuntimeUI rejected gameplay values after UI input."});
                return false;
            }
            m_runtime_ui.begin_frame({});
        }
        return result.disposition != noveltea::runtime::RuntimeInputDisposition::Failed &&
               !has_errors(result.diagnostics);
    }

    [[nodiscard]] bool submit_shell_command(noveltea::core::RuntimeShellCommand) override
    {
        return false;
    }

    [[nodiscard]] bool
    dispatch_layout_event(noveltea::core::MountedLayoutOwner owner,
                          const std::function<bool()>& dispatch) override
    {
        auto& gateway = m_running_game->session().gateway();
        noveltea::runtime::RuntimeCapabilityIssuer issuer(gateway, gateway.generation());
        const auto profile = owner == noveltea::core::MountedLayoutOwner::Shell
                                 ? noveltea::runtime::RuntimeCapabilityProfile::ShellLayoutEvent
                                 : noveltea::runtime::RuntimeCapabilityProfile::GameplayLayoutEvent;
        auto capabilities = issuer.issue(profile);
        if (!capabilities)
            return false;
        m_frontend_scripts.replace_runtime_capabilities(std::move(*capabilities));
        const bool consumed = dispatch();
        m_frontend_scripts.clear_runtime_capabilities();
        return consumed;
    }

    void clear_step_outputs()
    {
        m_events.clear();
        m_diagnostics.clear();
        m_publication.reset();
    }

    [[nodiscard]] const std::vector<noveltea::runtime::RuntimeEvent>& events() const noexcept
    {
        return m_events;
    }
    [[nodiscard]] const Diagnostics& diagnostics() const noexcept { return m_diagnostics; }
    [[nodiscard]] const std::optional<noveltea::runtime::RuntimePublication>& publication() const noexcept
    {
        return m_publication;
    }

    [[nodiscard]] static bool has_errors(const Diagnostics& diagnostics)
    {
        return std::any_of(diagnostics.begin(), diagnostics.end(), [](const auto& diagnostic) {
            return diagnostic.severity == ErrorSeverity::Error ||
                   diagnostic.severity == ErrorSeverity::Fatal;
        });
    }

private:
    std::unique_ptr<noveltea::runtime::RunningGame>& m_running_game;
    std::unique_ptr<noveltea::script::ScriptRuntime>& m_gameplay_scripts;
    noveltea::runtime::ScriptSourcePort& m_gameplay_sources;
    HeadlessPresentationRuntime& m_presentation;
    noveltea::script::ScriptRuntime& m_frontend_scripts;
    noveltea::RuntimeUI& m_runtime_ui;
    noveltea::host::PresentationLayoutReconciler& m_layouts;
    PresentationPreparation m_prepare_presentation;
    std::vector<noveltea::runtime::RuntimeEvent> m_events;
    Diagnostics m_diagnostics;
    std::optional<noveltea::runtime::RuntimePublication> m_publication;
};

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
make_running_game_input(nlohmann::json gameplay, std::optional<nlohmann::json> shader_materials,
                        std::string runtime_locale)
{
    auto decoded_project = decode_compiled_project(gameplay, "game");
    if (!decoded_project)
        return Result<HeadlessRuntimeInput, Diagnostics>::failure(
            std::move(decoded_project).error());

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
            {"height", decoded_project.value_if()->settings().display.reference_resolution.height}}},
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
            {"maximum", decoded_project.value_if()->settings().accessibility.text_scale.maximum}}}}},
        {"shader_variants", nlohmann::json::array()},
        {"entries", entries},
    };

    if (shader_materials) {
        auto decoded_materials =
            decode_shader_material_manifest(*shader_materials, "shader-materials.json");
        if (!decoded_materials)
            return Result<HeadlessRuntimeInput, Diagnostics>::failure(
                std::move(decoded_materials).error());
        std::vector<std::string> variants;
        for (const auto& shader : decoded_materials.value_if()->shaders) {
            for (const auto& stage : shader.stages) {
                for (const auto& binary : stage.compiled) {
                    if (std::find(variants.begin(), variants.end(), binary.variant) == variants.end())
                        variants.push_back(binary.variant);
                    const auto package_path = runtime_package_entry_path(binary.path);
                    entries.push_back({{"path", package_path}, {"size", 0}});
                    files.push_back({package_path, 0, std::nullopt});
                }
            }
        }
        entries.push_back({{"path", "shader-materials.json"}, {"size", 0}});
        files.push_back({"shader-materials.json", 0, std::nullopt});
        manifest["entries"] = entries;
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

Result<std::unique_ptr<noveltea::runtime::RunningGame>, Diagnostics>
load_running_game(HeadlessRuntimeInput input, noveltea::script::ScriptRuntime& scripts,
                  HeadlessPresentationRuntime& presentation, TypedMemorySaveSlotStore& saves)
{
    static noveltea::presentation::RuntimePresentationModel presentation_model;
    static const JsonSaveStateCodec save_codec;
    return noveltea::runtime::RunningGame::create(
        std::move(input.package), scripts, scripts, presentation_model, presentation, saves, save_codec,
        std::move(input.runtime_locale));
}

nlohmann::json diagnostics_json(const Diagnostics& diagnostics)
{
    auto result = nlohmann::json::array();
    for (const auto& diagnostic : diagnostics) {
        result.push_back({{"code", diagnostic.code},
                          {"message", diagnostic.message},
                          {"path", diagnostic.source_path}});
    }
    return result;
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

bool has_errors(const Diagnostics& diagnostics)
{
    return ToolingUiInputSink::has_errors(diagnostics);
}

noveltea::assets::FontAssetConfig
project_font_config(const noveltea::core::CompiledProject& project, std::string_view runtime_locale)
{
    noveltea::assets::FontAssetConfig config;
    for (const auto& asset : project.assets()) {
        if (asset.kind != noveltea::core::compiled::AssetKind::Font)
            continue;
        config.families.push_back(noveltea::assets::FontFamilyAssetDesc{
            .alias = asset.id.text(),
            .regular = noveltea::FontDesc{.asset_path = "project:/" + asset.path},
            .bold = std::nullopt,
            .italic = std::nullopt,
            .bold_italic = std::nullopt,
            .synthetic_styles = true});
    }
    if (project.settings().text.default_font) {
        if (const auto* font = project.find_asset(*project.settings().text.default_font))
            config.default_alias = font->id.text();
    }
    for (const auto& font : project.settings().text.font_stack)
        config.fallback_aliases.push_back(font.text());
    config.active_locale = std::string(runtime_locale);
    for (const auto& locale : project.localization().locales) {
        noveltea::assets::LocaleFontStackAssetConfig stack;
        stack.locale = locale.locale;
        for (const auto& font : locale.font_stack)
            stack.aliases.push_back(font.text());
        config.locale_fallbacks.push_back(std::move(stack));
    }
    return config;
}

Result<void, Diagnostics> prepare_layout_font_leases(
    const RuntimePresentationSnapshot& snapshot, const noveltea::core::CompiledProject& project,
    noveltea::assets::AssetManager& assets, noveltea::jobs::InlineJobExecutor& executor)
{
    std::unordered_set<std::string> aliases;
    for (const auto& mounted : snapshot.layouts) {
        const auto* layout = project.find_layout(mounted.layout);
        if (layout == nullptr)
            continue;
        for (const auto& font : layout->dependencies.fonts)
            aliases.insert(font.text());
    }

    if (aliases.empty()) {
        assets.clear_supplemental_leases_on_owner();
        return Result<void, Diagnostics>::success();
    }

    struct PendingFont {
        noveltea::assets::FontAssetRequest request;
        noveltea::assets::AssetRequestHandle<noveltea::assets::FontAsset> handle;
    };
    std::vector<PendingFont> pending;
    pending.reserve(aliases.size());
    Diagnostics diagnostics;
    for (const auto& alias : aliases) {
        noveltea::assets::FontAssetRequest request{
            .alias = alias, .source_path = std::nullopt, .style = noveltea::TextFontRegular};
        auto requested = assets.request_font(request, noveltea::assets::AssetRequestReason::Demand);
        if (!requested) {
            diagnostics.push_back(std::move(requested).error());
            continue;
        }
        pending.push_back({std::move(request), std::move(*requested.value_if())});
    }
    if (!diagnostics.empty())
        return Result<void, Diagnostics>::failure(std::move(diagnostics));

    if (!executor.run_until_idle(1024)) {
        return Result<void, Diagnostics>::failure(
            {{.code = "tooling.ui_test_font_preparation_timeout",
              .message = "Runtime UI Test font preparation did not settle."}});
    }

    std::vector<noveltea::assets::StructuredAssetLeaseRecord> records;
    records.reserve(pending.size());
    for (auto& font : pending) {
        if (font.handle.state() != noveltea::assets::AssetRequestState::Ready) {
            auto request_diagnostics = font.handle.diagnostics();
            if (request_diagnostics.empty()) {
                request_diagnostics.push_back(
                    {.code = "tooling.ui_test_font_preparation_failed",
                     .message = "Runtime UI Test font dependency did not become ready: " +
                                font.request.alias});
            }
            diagnostics.insert(diagnostics.end(),
                               std::make_move_iterator(request_diagnostics.begin()),
                               std::make_move_iterator(request_diagnostics.end()));
            continue;
        }
        auto lease = std::move(font.handle).take_ready();
        if (!lease) {
            diagnostics.push_back(
                {.code = "tooling.ui_test_font_lease_missing",
                 .message = "Runtime UI Test font dependency produced no ready lease: " +
                            font.request.alias});
            continue;
        }
        const auto cache_key = lease->cache_key();
        records.push_back(
            {.descriptor = {.request = font.request, .cache_key = cache_key},
             .lease = noveltea::assets::StructuredAssetLease{std::move(*lease)}});
    }
    if (!diagnostics.empty())
        return Result<void, Diagnostics>::failure(std::move(diagnostics));

    assets.set_supplemental_leases_on_owner(
        noveltea::assets::StructuredAssetLeaseSet(std::move(records)));
    return Result<void, Diagnostics>::success();
}

std::optional<std::filesystem::path>
resolve_system_asset_root(const std::filesystem::path& executable_path)
{
    if (const char* configured = std::getenv("NOVELTEA_UI_TEST_SYSTEM_ASSET_ROOT");
        configured != nullptr && *configured != '\0') {
        std::filesystem::path candidate(configured);
        if (std::filesystem::is_directory(candidate))
            return candidate;
    }
    const auto sibling = executable_path.parent_path() / "assets" / "system";
    if (std::filesystem::is_directory(sibling))
        return sibling;
#ifdef NOVELTEA_UI_TEST_SYSTEM_ASSET_ROOT
    std::filesystem::path configured(NOVELTEA_UI_TEST_SYSTEM_ASSET_ROOT);
    if (std::filesystem::is_directory(configured))
        return configured;
#endif
    return std::nullopt;
}

nlohmann::json run_ui_test(const nlohmann::json& request,
                           const std::filesystem::path& system_asset_root)
{
    const auto project_it = request.find("project");
    if (project_it == request.end())
        return compiled_project_admission_failure("Request requires compiled project.");
    nlohmann::json project_json = *project_it;
    if (project_json.is_string())
        project_json = nlohmann::json::parse(
            json_access::get_or<std::string>(project_json, {}), nullptr, false);
    if (project_json.is_discarded())
        return compiled_project_admission_failure("Compiled project JSON is malformed.");
    auto decoded_project = decode_compiled_project(project_json, "game");
    if (!decoded_project)
        return compiled_project_admission_failure("Compiled project validation failed.",
                                                  diagnostics_json(decoded_project.error()));

    const auto spec_it = request.find("spec");
    if (spec_it == request.end())
        return fail("Request requires a playback spec.");
    auto decoded_spec = decode_editor_playback_text(spec_it->dump());
    if (!decoded_spec)
        return fail("Playback spec parse failed.", diagnostics_json(decoded_spec.error()));

    std::optional<nlohmann::json> shader_materials;
    if (const auto materials = request.find("shaderMaterialMetadata");
        materials != request.end() && !materials->is_null()) {
        if (!materials->is_object())
            return fail("Runtime UI Test shaderMaterialMetadata must be an object or null.");
        shader_materials = *materials;
    }

    std::optional<std::filesystem::path> project_root;
    if (const auto root = request.find("projectRoot"); root != request.end() && !root->is_null()) {
        if (!root->is_string())
            return fail("Runtime UI Test projectRoot must be a string or null.");
        const auto candidate = std::filesystem::path(json_access::get_or<std::string>(*root, {}));
        if (candidate.empty() || !std::filesystem::is_directory(candidate))
            return fail("Runtime UI Test project root is unavailable.");
        project_root = candidate;
    }

    ToolingScriptSource fallback_gameplay_sources;
    noveltea::assets::AssetManager gameplay_assets;
    noveltea::runtime::ScriptSourcePort* gameplay_sources = &fallback_gameplay_sources;
    if (project_root) {
        gameplay_assets.mount_directory("project", *project_root, false);
        gameplay_sources = &gameplay_assets;
    }
    auto gameplay_scripts = std::make_unique<noveltea::script::ScriptRuntime>();
    auto gameplay_initialized = gameplay_scripts->initialize({gameplay_sources});
    if (!gameplay_initialized)
        return fail("Lua runtime initialization failed.");
    TypedMemorySaveSlotStore saves;
    HeadlessPresentationRuntime presentation;
    auto input = make_running_game_input(project_json, shader_materials, "en");
    if (!input)
        return compiled_project_admission_failure("Compiled runtime load failed.",
                                                  diagnostics_json(input.error()));
    auto running_game =
        load_running_game(std::move(*input.value_if()), *gameplay_scripts, presentation, saves);
    if (!running_game)
        return compiled_project_admission_failure("Compiled runtime load failed.",
                                                  diagnostics_json(running_game.error()));

    auto project_assets = std::make_shared<noveltea::assets::MemoryAssetSource>();
    noveltea::jobs::InlineJobExecutor executor;
    ExecutorShutdownGuard executor_shutdown(executor);
    auto residency = std::make_shared<noveltea::assets::AssetResidencyManager>(
        noveltea::assets::ResidencyBudget{.source_bytes = 64 * 1024 * 1024,
                                         .prepared_cpu_bytes = 64 * 1024 * 1024,
                                         .gpu_bytes = 64 * 1024 * 1024,
                                         .audio_bytes = 64 * 1024 * 1024,
                                         .temporary_bytes = 64 * 1024 * 1024});
    noveltea::assets::AssetManager frontend_assets;
    if (project_root)
        frontend_assets.mount_directory("project", *project_root, false);
    else
        frontend_assets.mount("project", project_assets);
    frontend_assets.mount_directory("system", system_asset_root, false);
    if (!frontend_assets.configure_async_requests(executor, residency))
        return fail("RuntimeUI asset initialization failed.");
    noveltea::text::TextEngine text_engine(frontend_assets);
    noveltea::text::TextFontAssetLoader font_loader(frontend_assets, text_engine);
    frontend_assets.bind_font_loader(&font_loader);
    const auto& runtime_project = running_game.value_if()->get()->package().project();
    frontend_assets.configure_fonts(
        project_font_config(runtime_project, running_game.value_if()->get()->runtime_locale()));
    noveltea::script::ScriptRuntime frontend_scripts;
    auto frontend_initialized = frontend_scripts.initialize({&frontend_assets});
    if (!frontend_initialized)
        return fail("RuntimeUI Lua initialization failed.");
    frontend_scripts.synchronize_project_data_assets(runtime_project);

    noveltea::RuntimeUI runtime_ui;
    const auto& loaded_shader_materials = running_game.value_if()->get()->package().shader_materials();
    const auto* runtime_shader_materials =
        loaded_shader_materials ? &*loaded_shader_materials : nullptr;
    if (!runtime_ui.initialize(
            &frontend_assets, nullptr, &frontend_scripts, runtime_shader_materials,
            [&](const noveltea::StyledText& text, float raster_scale) {
                return text_engine.layout_text(text, raster_scale);
            },
            true))
        return fail("RuntimeUI initialization failed.");
    if (!runtime_ui.configure_fonts(frontend_assets.font_config()))
        return fail("RuntimeUI font configuration failed.");
    if (!executor.run_until_idle(64))
        return fail("RuntimeUI asset initialization did not settle.");

    noveltea::host::LayoutRealizer realizer(frontend_assets, runtime_ui);
    auto generation = noveltea::host::HostGeneration::from_number(1);
    if (!generation)
        return fail("Could not allocate UI-test host generation.");
    auto bound = realizer.bind_session(*decoded_project.value_if(), *generation);
    if (!bound)
        return fail("RuntimeUI Layout binding failed.", diagnostics_json(bound.error()));
    noveltea::presentation::RuntimeLayoutManager layout_manager;
    layout_manager.bind_document_host(&realizer);
    noveltea::host::PresentationLayoutReconciler layouts(layout_manager, realizer);
    layouts.bind_project(*decoded_project.value_if());
    const auto game_hud_setting = std::find_if(
        runtime_project.settings().system_layouts.begin(), runtime_project.settings().system_layouts.end(),
        [](const auto& item) { return item.role == noveltea::core::compiled::SystemLayoutRole::GameHud; });
    auto game_hud = [&]() -> noveltea::presentation::RuntimeLayoutManager::MountResult {
        if (game_hud_setting == runtime_project.settings().system_layouts.end() ||
            !game_hud_setting->layout)
            return layout_manager.mount_builtin_game_hud(true);
        noveltea::presentation::RuntimeLayoutMountRequest request;
        request.layout_id = game_hud_setting->layout->text();
        request.source = noveltea::presentation::RuntimeLayoutProjectSource{};
        request.system_role = noveltea::core::compiled::SystemLayoutRole::GameHud;
        request.policy = noveltea::presentation::runtime_system_layout_policy(
            noveltea::core::compiled::SystemLayoutRole::GameHud, true);
        request.composition_group = noveltea::core::PresentationCompositionGroup::Interface;
        return layout_manager.mount(std::move(request));
    }();
    if (!game_hud)
        return fail("RuntimeUI Game HUD initialization failed.", diagnostics_json(game_hud.error()));
    const auto game_hud_instance = *game_hud.value_if();

    auto prepare_presentation = [&](const RuntimePresentationSnapshot& snapshot) {
        return prepare_layout_font_leases(snapshot, runtime_project, frontend_assets, executor);
    };

    auto running_game_instance = std::move(*running_game.value_if());
    ToolingUiInputSink ui_sink(running_game_instance, gameplay_scripts, *gameplay_sources,
                               presentation, frontend_scripts, runtime_ui, layouts,
                               prepare_presentation);
    runtime_ui.bind_input_sink(&ui_sink);
    const auto settle_headless_presentation =
        [&](noveltea::runtime::RuntimeDispatchResult& result) {
            while (auto completion = presentation.take_completion()) {
                auto completed = running_game_instance->session().dispatch(
                    RuntimeInputMessage{std::move(*completion)});
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

    std::vector<TypedPlaybackStepReport> steps;
    std::vector<TypedPlaybackExpectationReport> final_expectations;
    std::vector<noveltea::runtime::RuntimeEvent> all_events;
    Diagnostics all_diagnostics;
    bool passed = true;
    std::optional<noveltea::runtime::RuntimePublication> final_publication;

    auto apply_result = [&](noveltea::runtime::RuntimeDispatchResult& result) {
        if (!result.publication)
            return;
        final_publication = *result.publication;
        auto prepared = prepare_presentation(result.publication->presentation);
        if (!prepared) {
            auto diagnostics = std::move(prepared).error();
            result.diagnostics.insert(result.diagnostics.end(),
                                      std::make_move_iterator(diagnostics.begin()),
                                      std::make_move_iterator(diagnostics.end()));
            passed = false;
            return;
        }
        auto reconciled = layouts.reconcile(result.publication->presentation);
        if (!reconciled) {
            auto diagnostics = std::move(reconciled).error();
            result.diagnostics.insert(result.diagnostics.end(),
                                      std::make_move_iterator(diagnostics.begin()),
                                      std::make_move_iterator(diagnostics.end()));
            passed = false;
        }
        if (!runtime_ui.apply_gameplay_ui_values(
                noveltea::RuntimeUiGameplayValues{result.publication->revision.number(),
                                                  result.publication->gameplay_ui, {}})) {
            result.diagnostics.push_back(
                {.code = "tooling.ui_test_runtime_ui_rejected",
                 .message = "RuntimeUI rejected gameplay values after semantic input."});
            passed = false;
        }
        runtime_ui.begin_frame({});
    };

    auto startup = running_game_instance->session().dispatch(RuntimeInputMessage{StartRuntimeInput{}});
    settle_headless_presentation(startup);
    apply_result(startup);
    all_events.insert(all_events.end(), startup.events.begin(), startup.events.end());
    all_diagnostics.insert(all_diagnostics.end(), startup.diagnostics.begin(), startup.diagnostics.end());
    if (startup.disposition == noveltea::runtime::RuntimeInputDisposition::Failed ||
        has_errors(startup.diagnostics))
        passed = false;
    if (!passed)
        return fail("Runtime UI Test startup failed.", diagnostics_json(all_diagnostics));

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(runtime_ui);
    if (!driver)
        return fail("RuntimeUI playback driver is unavailable.");

    for (const auto& step : decoded_spec.value().steps) {
        TypedPlaybackStepReport report;
        report.index = step.index;
        ui_sink.clear_step_outputs();
        if (std::holds_alternative<RuntimeInputMessage>(step.input)) {
            auto result = running_game_instance->session().dispatch(std::get<RuntimeInputMessage>(step.input));
            settle_headless_presentation(result);
            report.handled = result.disposition == noveltea::runtime::RuntimeInputDisposition::Handled;
            apply_result(result);
            report.events = std::move(result.events);
            report.diagnostics = std::move(result.diagnostics);
            if (result.disposition == noveltea::runtime::RuntimeInputDisposition::Failed)
                passed = false;
        } else {
            const auto& click = std::get<TypedPlaybackUiClickInput>(step.input);
            std::string document_id = click.document_id;
            if (document_id == "runtime_game")
                document_id = realizer.document_id(game_hud_instance).value_or(document_id);
            const auto clicked = driver->click({.document_id = document_id,
                                                .selector = click.selector});
            runtime_ui.begin_frame({});
            report.handled =
                clicked.status == noveltea::ui::rmlui::RuntimeUiPlaybackClickStatus::Dispatched;
            report.events.assign(ui_sink.events().begin(), ui_sink.events().end());
            report.diagnostics.assign(ui_sink.diagnostics().begin(), ui_sink.diagnostics().end());
            if (ui_sink.publication())
                final_publication = *ui_sink.publication();
            if (!report.handled) {
                report.diagnostics.push_back(
                    {.code = "tooling.ui_test_click_failed",
                     .message = clicked.message,
                     .source_path = click.document_id + " " + click.selector});
                passed = false;
            }
        }

        if (!step.expectations.empty()) {
            auto settled = running_game_instance->session().dispatch(RuntimeInputMessage{AdvanceTimeInput{}});
            settle_headless_presentation(settled);
            apply_result(settled);
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
        if (has_errors(report.diagnostics))
            passed = false;
        for (const auto& expectation : step.expectations) {
            auto expectation_report = evaluate_playback_expectation(
                expectation, running_game_instance->session(), *final_publication, report.events,
                report.diagnostics);
            if (!expectation_report.passed)
                passed = false;
            report.expectations.push_back(std::move(expectation_report));
        }
        all_events.insert(all_events.end(), report.events.begin(), report.events.end());
        all_diagnostics.insert(all_diagnostics.end(), report.diagnostics.begin(),
                               report.diagnostics.end());
        steps.push_back(std::move(report));
    }

    auto settled = running_game_instance->session().dispatch(RuntimeInputMessage{AdvanceTimeInput{}});
    settle_headless_presentation(settled);
    apply_result(settled);
    all_events.insert(all_events.end(), settled.events.begin(), settled.events.end());
    all_diagnostics.insert(all_diagnostics.end(), settled.diagnostics.begin(), settled.diagnostics.end());
    if (settled.disposition == noveltea::runtime::RuntimeInputDisposition::Failed ||
        has_errors(settled.diagnostics))
        passed = false;
    if (!final_publication)
        return fail("Playback completed without a final runtime publication.");
    for (const auto& expectation : decoded_spec.value().final_expectations) {
        auto expectation_report = evaluate_playback_expectation(
            expectation, running_game_instance->session(), *final_publication, all_events,
            all_diagnostics);
        if (!expectation_report.passed)
            passed = false;
        final_expectations.push_back(std::move(expectation_report));
    }

    const auto report_text = encode_editor_playback_report_text(
        decoded_spec.value().id, steps, final_expectations, *final_publication, passed);
    auto report = nlohmann::json::parse(report_text, nullptr, false);
    if (report.is_discarded())
        return fail("Playback report encoding failed.");

    runtime_ui.bind_input_sink(nullptr);
    runtime_ui.shutdown();
    frontend_scripts.shutdown();
    return {{"ok", true}, {"report", std::move(report)}};
}

std::string read_all(std::istream& stream)
{
    std::ostringstream buffer;
    buffer << stream.rdbuf();
    return buffer.str();
}

} // namespace

int main(int argc, char** argv)
{
    if (argc != 3) {
        return 2;
    }
    std::ifstream input(argv[1], std::ios::binary);
    if (!input)
        return 2;
    const auto request_text = read_all(input);
    const auto request = nlohmann::json::parse(request_text, nullptr, false);
    const auto system_asset_root = resolve_system_asset_root(std::filesystem::absolute(argv[0]));
    const auto response = request.is_discarded()
                              ? fail("Request JSON is malformed.")
                              : !system_asset_root
                                    ? fail("Runtime UI Test system assets are unavailable.")
                                    : run_ui_test(request, *system_asset_root);
    std::ofstream output(argv[2], std::ios::binary | std::ios::trunc);
    if (!output)
        return 2;
    output << response.dump();
    return response.value("ok", false) ? 0 : 1;
}
