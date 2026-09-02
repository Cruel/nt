#include "host/preview_host.hpp"

#include "host/layout_realizer.hpp"
#include "host/screenshot_capture.hpp"

#include "noveltea/core/editor_runtime_protocol.hpp"
#include "noveltea/preview_bridge.hpp"
#include "noveltea/runtime/runtime_capabilities.hpp"
#include "ui/rmlui/runtime_ui_facade_access.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <string_view>
#include <type_traits>
#include <utility>

namespace noveltea::host {
namespace {

constexpr const char* kEditorPreviewDocumentId = "editor_preview";
constexpr const char* kPreviewLayoutCurrentRml = "preview://layout/current.rml";
constexpr const char* kPreviewLayoutCurrentRcss = "preview://layout/current.rcss";
constexpr const char* kPreviewLayoutCurrentLua = "preview://layout/current.lua";
constexpr const char* kPreviewLayoutFragmentHostRcss =
    "preview://templates/layout-fragment-host.rcss";
constexpr const char* kPreviewShaderSquareRml = "preview://templates/shader-square-preview.rml";
constexpr const char* kPreviewShaderSquareRcss = "preview://templates/shader-square-preview.rcss";

constexpr const char* kLayoutFragmentHostRml = R"rml(<rml>
<head>
    <title>NovelTea Layout Fragment Preview</title>
    <link type="text/rcss" href="layout-fragment-host.rcss" />
</head>
<body>
    <div id="nt-layout-preview-root">
        <div id="nt-layout-preview-mount"></div>
    </div>
</body>
</rml>
)rml";

constexpr const char* kLayoutFragmentHostRcss = R"rcss(body {
    margin: 0;
    width: 100%;
    height: 100%;
    background-color: transparent;
    font-family: Liberation Sans;
}

#nt-layout-preview-root {
    position: absolute;
    left: 0;
    top: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
}

#nt-layout-preview-mount {
    position: absolute;
    left: 0;
    top: 0;
    right: 0;
    bottom: 0;
}
)rcss";

constexpr const char* kShaderSquareRml = R"rml(<rml>
<head>
    <title>NovelTea Shader Preview</title>
    <link type="text/rcss" href="preview://templates/shader-square-preview.rcss" />
</head>
<body>
    <div id="nt-shader-preview-stage">
        <div id="nt-shader-preview-square" data-preview-material="__NT_PREVIEW_MATERIAL_ID__"></div>
    </div>
</body>
</rml>
)rml";

constexpr const char* kShaderSquareRcss = R"rcss(body {
    margin: 0;
    width: 100%;
    height: 100%;
    background-color: #0f172a;
    font-family: Liberation Sans;
}

#nt-shader-preview-stage {
    position: absolute;
    left: 0;
    top: 0;
    right: 0;
    bottom: 0;
    background-color: #0f172a;
}

#nt-shader-preview-square {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 256px;
    height: 256px;
    margin-left: -128px;
    margin-top: -128px;
    background-color: #1e293b;
    border: 1px #94a3b8;
    decorator: shader("__NT_PREVIEW_MATERIAL_ID__");
}
)rcss";

core::Diagnostic preview_error(std::string code, std::string message, std::string path = {},
                               std::string source = {})
{
    return {.code = std::move(code),
            .message = std::move(message),
            .severity = core::ErrorSeverity::Error,
            .source_path = std::move(source),
            .json_pointer = std::move(path)};
}

core::Result<std::string, core::Diagnostics>
resolve_layout_source(const core::editor::TypedEditorLayoutSourceComponent& source,
                      const assets::AssetManager& assets, std::string_view path)
{
    if (source.kind == core::editor::TypedEditorLayoutSourceComponent::Kind::Inline)
        return core::Result<std::string, core::Diagnostics>::success(source.value);
    auto text = assets.read_text(source.value);
    if (!text) {
        return core::Result<std::string, core::Diagnostics>::failure(
            {preview_error("preview.layout.source_unreadable", text.error.message,
                           std::string(path), source.value)});
    }
    return core::Result<std::string, core::Diagnostics>::success(std::move(*text.value));
}

std::string_view shader_variant_name(core::editor::EditorPreviewShaderVariant variant) noexcept
{
    switch (variant) {
    case core::editor::EditorPreviewShaderVariant::Glsl120:
        return "glsl-120";
    case core::editor::EditorPreviewShaderVariant::Essl100:
        return "essl-100";
    case core::editor::EditorPreviewShaderVariant::Essl300:
        return "essl-300";
    case core::editor::EditorPreviewShaderVariant::Metal:
        return "metal";
    }
    return {};
}

std::string lower_ascii(std::string value)
{
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    return value;
}

void replace_all(std::string& value, std::string_view needle, std::string_view replacement)
{
    if (needle.empty())
        return;
    std::size_t pos = 0;
    while ((pos = value.find(needle, pos)) != std::string::npos) {
        value.replace(pos, needle.size(), replacement);
        pos += replacement.size();
    }
}

std::string inject_head_content(std::string rml, std::string_view content)
{
    if (content.empty())
        return rml;
    const std::string lowered = lower_ascii(rml);
    if (const std::size_t head_end = lowered.find("</head>"); head_end != std::string::npos) {
        rml.insert(head_end, std::string(content) + "\n");
        return rml;
    }
    if (const std::size_t rml_start = lowered.find("<rml"); rml_start != std::string::npos) {
        if (const std::size_t tag_end = lowered.find('>', rml_start);
            tag_end != std::string::npos) {
            rml.insert(tag_end + 1, "\n<head>\n" + std::string(content) + "\n</head>");
            return rml;
        }
    }
    return "<rml>\n<head>\n" + std::string(content) + "\n</head>\n<body>\n" + rml +
           "\n</body>\n</rml>\n";
}

std::string layout_fragment_host_rml(std::string host_template, const std::string& fragment)
{
    replace_all(host_template, "href=\"layout-fragment-host.rcss\"",
                "href=\"preview://templates/layout-fragment-host.rcss\"");
    replace_all(host_template, "href='layout-fragment-host.rcss'",
                "href='preview://templates/layout-fragment-host.rcss'");
    host_template =
        inject_head_content(std::move(host_template),
                            "<link type=\"text/rcss\" href=\"preview://layout/current.rcss\" />");

    constexpr std::string_view empty_mount = "<div id=\"nt-layout-preview-mount\"></div>";
    if (const std::size_t pos = host_template.find(empty_mount); pos != std::string::npos) {
        host_template.replace(pos, empty_mount.size(),
                              "<div id=\"nt-layout-preview-mount\">\n" + fragment + "\n</div>");
        return host_template;
    }
    constexpr std::string_view indented_empty_mount =
        "<div id=\"nt-layout-preview-mount\">\n        </div>";
    if (const std::size_t pos = host_template.find(indented_empty_mount);
        pos != std::string::npos) {
        host_template.replace(pos, indented_empty_mount.size(),
                              "<div id=\"nt-layout-preview-mount\">\n" + fragment + "\n</div>");
        return host_template;
    }
    return inject_head_content(
        "<rml>\n<head><title>NovelTea Layout Fragment Preview</title></head>\n<body>\n"
        "<div id=\"nt-layout-preview-root\"><div id=\"nt-layout-preview-mount\">\n" +
            fragment + "\n</div></div>\n</body>\n</rml>\n",
        "<link type=\"text/rcss\" href=\"preview://templates/layout-fragment-host.rcss\" />\n"
        "<link type=\"text/rcss\" href=\"preview://layout/current.rcss\" />");
}

void upsert_preview_material(ShaderMaterialProject& project, std::string material_id,
                             std::string shader_id)
{
    project.materials.erase(std::remove_if(project.materials.begin(), project.materials.end(),
                                           [&](const MaterialDefinition& material) {
                                               return material.id.string() == material_id;
                                           }),
                            project.materials.end());
    MaterialDefinition material;
    material.id = MaterialId(std::move(material_id));
    material.role = ShaderRole::RmlUiDecorator;
    material.shader = ShaderId(std::move(shader_id));
    material.display_name = "Editor Preview Shader Material";
    project.materials.push_back(std::move(material));
}

PreviewMutationResult mutation_result(bool accepted, std::string kind, std::string id,
                                      std::string message = {})
{
    return {.accepted = accepted,
            .kind = std::move(kind),
            .id = std::move(id),
            .message = std::move(message)};
}

std::string first_diagnostic_message(const core::Diagnostics& diagnostics)
{
    return diagnostics.empty() ? std::string{} : diagnostics.front().message;
}

std::optional<core::GameplayInstanceRef> gameplay_instance_ref(std::string_view kind,
                                                               const std::string& id)
{
    if (kind == "room") {
        auto parsed = core::RoomId::create(id);
        return parsed ? std::optional<core::GameplayInstanceRef>{*parsed.value_if()} : std::nullopt;
    }
    if (kind == "character") {
        auto parsed = core::CharacterId::create(id);
        return parsed ? std::optional<core::GameplayInstanceRef>{*parsed.value_if()} : std::nullopt;
    }
    if (kind == "interactable") {
        auto parsed = core::InteractableInstanceId::create(id);
        return parsed ? std::optional<core::GameplayInstanceRef>{*parsed.value_if()} : std::nullopt;
    }
    return std::nullopt;
}

std::optional<runtime::RuntimeInstanceConfigurationRequest>
runtime_instance_source(std::string_view kind, std::string_view source_kind,
                        const std::string& source_id)
{
    if (source_kind == "archetype") {
        auto parsed = core::ArchetypeId::create(source_id);
        return parsed
                   ? std::optional<
                         runtime::
                             RuntimeInstanceConfigurationRequest>{runtime::
                                                                      ArchetypeInstanceConfiguration{
                                                                          *parsed.value_if()}}
                   : std::nullopt;
    }
    auto instance = gameplay_instance_ref(kind, source_id);
    if (!instance)
        return std::nullopt;
    if (source_kind == "compiled")
        return runtime::RuntimeInstanceConfigurationRequest{
            runtime::CompiledInstanceConfiguration{std::move(*instance)}};
    if (source_kind == "effective")
        return runtime::RuntimeInstanceConfigurationRequest{
            runtime::EffectiveInstanceConfiguration{std::move(*instance)}};
    return std::nullopt;
}

} // namespace

PreviewHost::PreviewHost(Dependencies dependencies) noexcept
    : m_dependencies(std::move(dependencies)),
      m_audio_preview(m_dependencies.audio_backend, m_dependencies.assets),
      m_fallback_world_resources(m_dependencies.assets),
      m_fallback_world(m_fallback_world_resources),
      m_focused_presenter(std::make_unique<
                          FocusedPreviewPresenter>(FocusedPreviewPresenter::Dependencies{
          .assets = m_dependencies.assets,
          .world_resources = m_dependencies.world_resources != nullptr
                                 ? *m_dependencies.world_resources
                                 : m_fallback_world_resources,
          .world = m_dependencies.world != nullptr ? *m_dependencies.world : m_fallback_world,
          .layouts = m_dependencies.layout_realizer,
          .scripts = m_dependencies.scripts,
          .prepare_environment = m_dependencies.prepare_focused_environment,
          .prepare_layout_environment = m_dependencies.prepare_authored_environment,
          .prepare_clear_environment = m_dependencies.prepare_clear_authored_environment,
          .prepare_ui_values =
              [this](RuntimeUiGameplayValues values) {
                  return m_dependencies.runtime_ui.prepare_gameplay_ui_values(std::move(values));
              },
          .commit_ui_values =
              [this](RuntimeUiGameplayValues values) {
                  m_dependencies.runtime_ui.commit_gameplay_ui_values(std::move(values));
              },
          .apply_materials =
              [this](const ShaderMaterialProject& materials) {
                  m_dependencies.shader_materials = materials;
                  m_dependencies.renderer.set_asset_lease_lookup_scope(
                      assets::AssetLeaseLookupScope::FocusedPreview);
                  m_dependencies.renderer.set_shader_material_project(
                      &m_dependencies.shader_materials);
              },
          .bind_candidate_materials =
              [this](const ShaderMaterialProject* materials) {
                  const auto scope =
                      materials != nullptr ||
                              m_dependencies.assets.has_focused_published_leases_on_owner()
                          ? assets::AssetLeaseLookupScope::FocusedPreview
                          : assets::AssetLeaseLookupScope::Runtime;
                  m_dependencies.renderer.set_asset_lease_lookup_scope(scope);
                  m_dependencies.renderer.set_shader_material_project(
                      materials != nullptr ? materials : &m_dependencies.shader_materials);
              },
          .bind_input_sink =
              [this](RuntimeUiInputSink* sink) { m_dependencies.runtime_ui.bind_input_sink(sink); },
          .retire_legacy_preview =
              [this]() {
                  m_dependencies.layout_realizer.clear_authored_preview();
                  (void)ui::rmlui::RuntimeUiFacadeAccess::hide_document(m_dependencies.runtime_ui,
                                                                        kEditorPreviewDocumentId);
              },
          .active_shader_variant = [this]() -> std::string_view {
              return m_dependencies.renderer.active_shader_variant();
          },
          .standalone_layout_style_prefix =
              [](bool fragment) {
                  return fragment ? std::string(kLayoutFragmentHostRcss) : std::string{};
              },
          .complete =
              [this](const core::editor::FocusedEditorDocumentRequest& request,
                     std::string_view status, const core::Diagnostics& diagnostics) {
                  complete_focused_request(request, status, diagnostics);
              },
          .report =
              [this](core::Diagnostics diagnostics) { report_diagnostics(std::move(diagnostics)); },
      }))
{
}

PreviewHost::~PreviewHost() = default;

bool PreviewHost::load_project(const std::string& logical_path)
{
    if (logical_path.empty()) {
        report_diagnostic(preview_error("preview.load.empty_path",
                                        "Cannot load an empty compiled-project path."));
        return false;
    }
    if (!m_dependencies.load_game) {
        report_diagnostic(preview_error("preview.load.unavailable",
                                        "Preview project loading is not configured."));
        return false;
    }
    return m_dependencies.load_game(
        {.logical_path = logical_path, .load_title_screen = true, .stop_runtime_after_load = true});
}

bool PreviewHost::reset() { return reload(); }

bool PreviewHost::reload()
{
    const std::string logical_path = m_dependencies.game_host.compiled_project_path();
    if (logical_path.empty()) {
        report_diagnostic(preview_error("preview.reload.unloaded",
                                        "Cannot reload without a loaded compiled project."));
        return false;
    }
    if (!m_dependencies.load_game) {
        report_diagnostic(preview_error("preview.reload.unavailable",
                                        "Preview project reloading is not configured."));
        return false;
    }
    return m_dependencies.load_game(
        {.logical_path = logical_path, .load_title_screen = true, .stop_runtime_after_load = true});
}

bool PreviewHost::start()
{
    if (!running_game_available()) {
        report_diagnostic(
            preview_error("preview.runtime.unloaded", "Cannot start an unloaded preview runtime."));
        return false;
    }
    const bool accepted = m_dependencies.game_host.submit_runtime_ui_shell_command(
        core::RuntimeShellCommand{core::StartGameShellCommand{}});
    if (accepted)
        m_dependencies.preview_running = true;
    return accepted;
}

bool PreviewHost::stop()
{
    if (!running_game_available()) {
        report_diagnostic(
            preview_error("preview.runtime.unloaded", "Cannot stop an unloaded preview runtime."));
        return false;
    }
    m_dependencies.preview_running = false;
    const bool accepted = dispatch(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    return accepted;
}

bool PreviewHost::step(double delta_seconds)
{
    if (!running_game_available())
        return false;
    return dispatch(core::RuntimeInputMessage{
        core::AdvanceTimeInput{std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::duration<double>(std::max(0.0, delta_seconds)))}});
}

PreviewRuntimeHandle PreviewHost::runtime_handle() const noexcept
{
    return {.session_generation = m_dependencies.game_host.session_generation(),
            .backend_generation = m_dependencies.game_host.backend_generation()};
}

bool PreviewHost::accepts(PreviewRuntimeHandle handle) const noexcept
{
    return m_dependencies.game_host.accepts(handle.session_generation, handle.backend_generation);
}

bool PreviewHost::dispatch(PreviewRuntimeHandle handle, core::RuntimeInputMessage input)
{
    if (!accepts(handle)) {
        report_diagnostic(preview_error(
            "preview.runtime.stale_handle",
            "Preview command was rejected because its runtime or backend generation is stale."));
        return false;
    }
    auto result =
        m_dependencies.game_host.submit_runtime_input(handle.session_generation, std::move(input));
    return result.disposition == runtime::RuntimeInputDisposition::Handled;
}

bool PreviewHost::dispatch(core::RuntimeInputMessage input)
{
    return dispatch(runtime_handle(), std::move(input));
}

bool PreviewHost::continue_dialogue()
{
    return running_game_available() && dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
}

bool PreviewHost::select_dialogue_choice(const core::DialogueEdgeId& edge)
{
    const auto& current = publication();
    const auto* view = current ? &current->gameplay_ui : nullptr;
    if (!view || !view->dialogue || !view->dialogue->choice)
        return false;
    const auto selected = std::find_if(
        view->dialogue->choice->options.begin(), view->dialogue->choice->options.end(),
        [&](const auto& candidate) { return candidate.enabled && candidate.edge == edge; });
    return selected != view->dialogue->choice->options.end() &&
           dispatch(core::RuntimeInputMessage{core::SelectDialogueChoiceInput{selected->edge}});
}

bool PreviewHost::select_scene_choice(const core::SceneChoiceOptionId& option)
{
    const auto& current = publication();
    const auto* view = current ? &current->gameplay_ui : nullptr;
    if (!view || !view->scene || !view->scene->choice)
        return false;
    const auto selected = std::find_if(
        view->scene->choice->options.begin(), view->scene->choice->options.end(),
        [&](const auto& candidate) { return candidate.enabled && candidate.option == option; });
    return selected != view->scene->choice->options.end() &&
           dispatch(core::RuntimeInputMessage{core::SelectSceneChoiceInput{selected->option}});
}

bool PreviewHost::navigate(const core::RoomExitId& exit)
{
    const auto& current = publication();
    const auto* view = current ? &current->gameplay_ui : nullptr;
    if (!view || !view->room)
        return false;
    const auto selected = std::find_if(
        view->room->exits.begin(), view->room->exits.end(),
        [&](const auto& candidate) { return candidate.enabled && candidate.exit == exit; });
    return selected != view->room->exits.end() &&
           dispatch(core::RuntimeInputMessage{core::NavigateRoomInput{selected->exit}});
}

bool PreviewHost::select_subjects(std::vector<core::compiled::InteractionSubject> subjects)
{
    return running_game_available() &&
           dispatch(core::RuntimeInputMessage{
               core::SelectInteractionSubjectsInput{std::move(subjects)}});
}

bool PreviewHost::primary_activate(core::compiled::InteractionSubject subject)
{
    return running_game_available() &&
           dispatch(core::RuntimeInputMessage{core::PrimaryActivateInput{std::move(subject)}});
}

bool PreviewHost::open_verb_menu(core::compiled::InteractionSubject subject)
{
    return running_game_available() &&
           dispatch(core::RuntimeInputMessage{core::OpenVerbMenuInput{std::move(subject)}});
}

bool PreviewHost::clear_subject_selection()
{
    return running_game_available() &&
           dispatch(core::RuntimeInputMessage{core::ClearInteractionSubjectSelectionInput{}});
}

bool PreviewHost::run_interaction(const std::string& verb_id,
                                  std::vector<core::InteractionSubjectBinding> bindings)
{
    auto verb = core::VerbId::create(verb_id);
    if (!verb)
        return false;
    return dispatch(core::RuntimeInputMessage{
        core::InvokeInteractionInput{std::move(*verb.value_if()), std::move(bindings)}});
}

PreviewMutationResult PreviewHost::set_variable(const std::string& variable_id,
                                                core::RuntimeValue value)
{
    auto id = core::PropertyId::create(variable_id);
    if (!id)
        return mutation_result(false, "set-variable", variable_id, "invalid variable id");
    const bool accepted = dispatch(core::RuntimeInputMessage{
        core::SetVariableDebugInput{std::move(*id.value_if()), std::move(value)}});
    return mutation_result(accepted, "set-variable", variable_id);
}

PreviewMutationResult PreviewHost::reset_variable(const std::string& variable_id)
{
    auto id = core::PropertyId::create(variable_id);
    const auto* running_game = m_dependencies.game_host.running_game();
    if (!id || !running_game)
        return mutation_result(false, "reset-variable", variable_id, "invalid variable id");
    const auto* definition = running_game->package().project().find_property(*id.value_if());
    if (!definition || !definition->is_global())
        return mutation_result(false, "reset-variable", variable_id, "unknown variable");
    const bool accepted = dispatch(
        core::RuntimeInputMessage{core::SetVariableDebugInput{*id.value_if(), std::nullopt}});
    return mutation_result(accepted, "reset-variable", variable_id);
}

PreviewMutationResult PreviewHost::teleport_room(const std::string& room_id)
{
    auto id = core::RoomId::create(room_id);
    auto* running_game = m_dependencies.game_host.running_game();
    if (!id || !running_game)
        return mutation_result(false, "teleport-room", room_id, "invalid room id");
    auto result = running_game->session().gateway().request_tail_replacement(
        core::FlowTarget{*id.value_if()});
    if (result)
        (void)dispatch(core::RuntimeInputMessage{core::AdvanceTimeInput{}});
    return mutation_result(static_cast<bool>(result), "teleport-room", room_id,
                           result ? "" : first_diagnostic_message(result.error()));
}

PreviewMutationResult PreviewHost::create_runtime_instance(const std::string& kind,
                                                           const std::string& source_kind,
                                                           const std::string& source_id)
{
    auto* running_game = m_dependencies.game_host.running_game();
    if (!running_game)
        return mutation_result(false, "instance-create", source_id,
                               "invalid Gameplay Instance creation request");

    auto& gateway = running_game->session().gateway();
    if (kind == "interactable") {
        if (source_kind != "definition")
            return mutation_result(false, "instance-create", source_id,
                                   "Interactable creation requires an Interactable definition");
        auto definition = core::InteractableDefinitionId::create(source_id);
        if (!definition)
            return mutation_result(false, "instance-create", source_id,
                                   first_diagnostic_message(definition.error()));
        auto created = gateway.create_interactable_quantity(*definition.value_if(), 1,
                                                            core::compiled::UnplacedLocation{});
        if (!created)
            return mutation_result(false, "instance-create", source_id,
                                   first_diagnostic_message(created.error()));
        if (created.value_if()->created.size() != 1)
            return mutation_result(false, "instance-create", source_id,
                                   "Interactable creation produced an invalid exact identity set");
        const auto id = created.value_if()->created.front().text();
        (void)dispatch(core::RuntimeInputMessage{core::AdvanceTimeInput{}});
        return mutation_result(true, "instance-create", id);
    }
    auto source = runtime_instance_source(kind, source_kind, source_id);
    if (!source)
        return mutation_result(false, "instance-create", source_id,
                               "invalid Gameplay Instance creation source");
    if (kind == "room") {
        auto created = gateway.create_room(std::move(*source));
        if (!created)
            return mutation_result(false, "instance-create", source_id,
                                   first_diagnostic_message(created.error()));
        const auto id = created.value_if()->text();
        (void)dispatch(core::RuntimeInputMessage{core::AdvanceTimeInput{}});
        return mutation_result(true, "instance-create", id);
    }
    if (kind == "character") {
        auto created = gateway.create_character(std::move(*source));
        if (!created)
            return mutation_result(false, "instance-create", source_id,
                                   first_diagnostic_message(created.error()));
        const auto id = created.value_if()->text();
        (void)dispatch(core::RuntimeInputMessage{core::AdvanceTimeInput{}});
        return mutation_result(true, "instance-create", id);
    }
    return mutation_result(false, "instance-create", source_id,
                           "Gameplay Instance kind must be room, character, or interactable");
}

PreviewMutationResult PreviewHost::replace_runtime_instance_configuration(
    const std::string& kind, const std::string& instance_id, const std::string& source_kind,
    const std::string& source_id)
{
    auto* running_game = m_dependencies.game_host.running_game();
    auto instance = gameplay_instance_ref(kind, instance_id);
    auto source = runtime_instance_source(kind, source_kind, source_id);
    if (!running_game || !instance || !source)
        return mutation_result(false, "instance-replace-configuration", instance_id,
                               "invalid Gameplay Instance configuration replacement request");
    auto result = running_game->session().gateway().replace_instance_configuration(
        std::move(*instance), std::move(*source));
    if (result)
        (void)dispatch(core::RuntimeInputMessage{core::AdvanceTimeInput{}});
    return mutation_result(static_cast<bool>(result), "instance-replace-configuration", instance_id,
                           result ? "" : first_diagnostic_message(result.error()));
}

PreviewMutationResult
PreviewHost::clear_runtime_instance_configuration(const std::string& kind,
                                                  const std::string& instance_id)
{
    auto* running_game = m_dependencies.game_host.running_game();
    auto instance = gameplay_instance_ref(kind, instance_id);
    if (!running_game || !instance)
        return mutation_result(false, "instance-clear-configuration", instance_id,
                               "invalid Gameplay Instance configuration clear request");
    auto result =
        running_game->session().gateway().clear_instance_configuration(std::move(*instance));
    if (result)
        (void)dispatch(core::RuntimeInputMessage{core::AdvanceTimeInput{}});
    return mutation_result(static_cast<bool>(result), "instance-clear-configuration", instance_id,
                           result ? "" : first_diagnostic_message(result.error()));
}

PreviewMutationResult PreviewHost::destroy_runtime_instance(const std::string& kind,
                                                            const std::string& instance_id)
{
    auto* running_game = m_dependencies.game_host.running_game();
    auto instance = gameplay_instance_ref(kind, instance_id);
    if (!running_game || !instance)
        return mutation_result(false, "instance-destroy", instance_id,
                               "invalid Gameplay Instance destruction request");
    auto result = running_game->session().gateway().destroy_instance(std::move(*instance));
    if (result)
        (void)dispatch(core::RuntimeInputMessage{core::AdvanceTimeInput{}});
    return mutation_result(static_cast<bool>(result), "instance-destroy", instance_id,
                           result ? "" : first_diagnostic_message(result.error()));
}

PreviewMutationResult PreviewHost::retarget_runtime_room_exit(const std::string& room_id,
                                                              const std::string& exit_id,
                                                              const std::string& target_room_id)
{
    auto* running_game = m_dependencies.game_host.running_game();
    auto room = core::RoomId::create(room_id);
    auto exit = core::RoomExitId::create(exit_id);
    auto target = core::RoomId::create(target_room_id);
    if (!running_game || !room || !exit || !target)
        return mutation_result(false, "room-exit-retarget", room_id,
                               "invalid Room Exit retarget request");
    auto result = running_game->session().gateway().retarget_room_exit(
        *room.value_if(), *exit.value_if(), *target.value_if());
    if (result)
        (void)dispatch(core::RuntimeInputMessage{core::AdvanceTimeInput{}});
    return mutation_result(static_cast<bool>(result), "room-exit-retarget", room_id,
                           result ? "" : first_diagnostic_message(result.error()));
}

bool PreviewHost::begin_recording()
{
    return dispatch(core::RuntimeInputMessage{core::BeginPlaybackInput{}});
}

bool PreviewHost::end_recording()
{
    return dispatch(core::RuntimeInputMessage{core::EndPlaybackInput{}});
}

bool PreviewHost::clear_recording()
{
    return dispatch(core::RuntimeInputMessage{core::ClearPlaybackInput{}});
}

bool PreviewHost::undo_recording_step()
{
    return dispatch(core::RuntimeInputMessage{core::UndoPlaybackStepInput{}});
}

bool PreviewHost::replay_recording()
{
    return dispatch(core::RuntimeInputMessage{core::ReplayPlaybackInput{}});
}

PreviewPresentationFastForwardResult PreviewHost::fast_forward_presentation_once()
{
    auto result = m_dependencies.game_host.runtime_presentation().fast_forward_one();
    if (!result.diagnostics.empty())
        report_diagnostics(result.diagnostics);
    return {.disposition = result.disposition,
            .inputs = std::move(result.inputs),
            .diagnostics = std::move(result.diagnostics)};
}

bool PreviewHost::load_document(PreviewDocumentRequest request)
{
    if (request.rml.empty() || !m_dependencies.runtime_ui.is_initialized()) {
        report_diagnostic(
            preview_error("preview.document.unavailable",
                          "Preview document cannot be loaded before RuntimeUI is ready.", "/rml",
                          request.source_url));
        return false;
    }
    if (m_dependencies.clear_authored_environment) {
        auto cleared = m_dependencies.clear_authored_environment();
        if (!cleared) {
            report_diagnostics(std::move(cleared).error());
            return false;
        }
    }
    m_dependencies.layout_realizer.clear_authored_preview();
    (void)ui::rmlui::RuntimeUiFacadeAccess::hide_document(m_dependencies.runtime_ui, "demo");
    (void)ui::rmlui::RuntimeUiFacadeAccess::hide_document(m_dependencies.runtime_ui,
                                                          "runtime_game");
    (void)ui::rmlui::RuntimeUiFacadeAccess::hide_document(m_dependencies.runtime_ui,
                                                          "runtime-acceptance");
    if (ui::rmlui::RuntimeUiFacadeAccess::load_document_from_memory(
            m_dependencies.runtime_ui, kEditorPreviewDocumentId, request.rml,
            request.source_url.empty() ? kPreviewLayoutCurrentRml : request.source_url, true)) {
        return true;
    }
    report_diagnostic(preview_error("preview.document.load_failed",
                                    "RmlUi failed to load the preview document.", "/rml",
                                    request.source_url));
    return false;
}

bool PreviewHost::execute_lua(PreviewLuaRequest request)
{
    if (request.source.empty())
        return true;
    if (!m_dependencies.scripts.is_initialized()) {
        report_diagnostic(preview_error("preview.lua.unavailable",
                                        "Preview Lua cannot run before ScriptRuntime is ready.",
                                        "/lua", request.chunk_name));
        return false;
    }

    std::optional<runtime::RuntimeCapabilitySet> tooling_capabilities;
    if (auto* running_game = m_dependencies.game_host.running_game()) {
        auto& gateway = running_game->session().gateway();
        runtime::RuntimeCapabilityIssuer issuer(gateway, gateway.generation());
        tooling_capabilities = issuer.issue(runtime::RuntimeCapabilityProfile::Tooling);
        if (!tooling_capabilities) {
            report_diagnostic(
                preview_error("preview.lua.capability_unavailable",
                              "Tooling capabilities could not be issued for preview Lua.", "/lua",
                              request.chunk_name));
            return false;
        }
        m_dependencies.scripts.replace_runtime_capabilities(*tooling_capabilities);
    } else {
        m_dependencies.scripts.clear_runtime_capabilities();
    }

    auto result = [&] {
        struct CapabilityScope final {
            script::ScriptRuntime& scripts;
            ~CapabilityScope() { scripts.clear_runtime_capabilities(); }
        } scope{m_dependencies.scripts};
        return m_dependencies.scripts.execute(request.source, request.chunk_name);
    }();
    if (running_game_available())
        (void)dispatch(core::RuntimeInputMessage{core::AdvanceTimeInput{}});
    if (result)
        return true;

    const auto& error = result.error();
    const std::string message =
        error.traceback.empty() ? error.message : error.message + "\n" + error.traceback;
    report_diagnostic(preview_error("preview.lua.failed", message, "/lua", request.chunk_name));
    return false;
}

bool PreviewHost::apply_editor_document(core::editor::TypedEditorPreviewDocument document)
{
    return std::visit(
        [this](auto&& request) {
            using T = std::decay_t<decltype(request)>;
            if constexpr (std::is_same_v<T, core::editor::TypedEditorLayoutPreviewDocument>) {
                if (!m_dependencies.apply_authored_environment) {
                    report_diagnostic(preview_error(
                        "preview.authored_environment.unavailable",
                        "Authored Layout preview environment application is not configured.",
                        "/environment"));
                    return false;
                }
                auto rml_source = resolve_layout_source(request.rml, m_dependencies.assets, "/rml");
                auto rcss_source =
                    resolve_layout_source(request.rcss, m_dependencies.assets, "/rcss");
                auto lua_source = resolve_layout_source(request.lua, m_dependencies.assets, "/lua");
                if (!rml_source || !rcss_source || !lua_source) {
                    if (!rml_source)
                        report_diagnostics(std::move(rml_source).error());
                    if (!rcss_source)
                        report_diagnostics(std::move(rcss_source).error());
                    if (!lua_source)
                        report_diagnostics(std::move(lua_source).error());
                    return false;
                }
                std::string rml_text = std::move(*rml_source.value_if());
                std::string rcss_text = std::move(*rcss_source.value_if());
                std::string lua_text = std::move(*lua_source.value_if());
                ui::rmlui::RuntimeUiFacadeAccess::set_preview_virtual_file(
                    m_dependencies.runtime_ui, kPreviewLayoutCurrentRcss, rcss_text);
                ui::rmlui::RuntimeUiFacadeAccess::set_preview_virtual_file(
                    m_dependencies.runtime_ui, kPreviewLayoutCurrentLua, lua_text);
                ui::rmlui::RuntimeUiFacadeAccess::set_preview_virtual_file(
                    m_dependencies.runtime_ui, kPreviewLayoutFragmentHostRcss,
                    kLayoutFragmentHostRcss);

                if (request.script_enabled &&
                    !execute_lua(
                        {.source = lua_text,
                         .chunk_name = request.lua.kind ==
                                               core::editor::TypedEditorLayoutSourceComponent::
                                                   Kind::LogicalAsset
                                           ? request.lua.value
                                           : kPreviewLayoutCurrentLua}))
                    return false;

                std::string rml;
                if (request.layout_kind == core::editor::EditorPreviewLayoutKind::Fragment) {
                    rml = layout_fragment_host_rml(kLayoutFragmentHostRml, rml_text);
                } else {
                    const std::string source = rml_text.empty()
                                                   ? "<rml><head><title>Empty Layout "
                                                     "Preview</title></head><body></body></rml>"
                                                   : rml_text;
                    rml = inject_head_content(
                        source,
                        "<link type=\"text/rcss\" href=\"preview://layout/current.rcss\" />");
                }
                ui::rmlui::RuntimeUiFacadeAccess::set_preview_virtual_file(
                    m_dependencies.runtime_ui, kPreviewLayoutCurrentRml, rml);
                auto environment = m_dependencies.apply_authored_environment(request.environment);
                if (!environment) {
                    report_diagnostics(std::move(environment).error());
                    return false;
                }
                if (request.shader_materials) {
                    m_dependencies.shader_materials = std::move(*request.shader_materials);
                    m_dependencies.renderer.set_shader_material_project(
                        &m_dependencies.shader_materials);
                }
                (void)ui::rmlui::RuntimeUiFacadeAccess::hide_document(m_dependencies.runtime_ui,
                                                                      kEditorPreviewDocumentId);
                auto realized = m_dependencies.layout_realizer.realize_authored_preview(
                    {.rml = std::move(rml),
                     .source_url = request.source_url,
                     .scale_policy = request.environment.scale_policy});
                if (!realized) {
                    report_diagnostics(std::move(realized).error());
                    if (m_dependencies.clear_authored_environment) {
                        auto restored = m_dependencies.clear_authored_environment();
                        if (!restored)
                            report_diagnostics(std::move(restored).error());
                    }
                    return false;
                }
                return true;
            } else if constexpr (std::is_same_v<T,
                                                core::editor::TypedEditorShaderPreviewDocument>) {
                if (shader_variant_name(request.active_shader_variant) !=
                    m_dependencies.renderer.active_shader_variant()) {
                    report_diagnostic(preview_error(
                        "preview.shader.variant_mismatch",
                        "Focused Shader document variant does not match the active renderer.",
                        "/activeShaderVariant"));
                    return false;
                }
                m_dependencies.shader_materials = std::move(request.shader_materials);
                upsert_preview_material(m_dependencies.shader_materials,
                                        request.preview_material_id, request.shader_id);
                m_dependencies.renderer.set_shader_material_project(
                    &m_dependencies.shader_materials);

                std::string rml = kShaderSquareRml;
                std::string rcss = kShaderSquareRcss;
                replace_all(rml, "href=\"shader-square-preview.rcss\"",
                            "href=\"preview://templates/shader-square-preview.rcss\"");
                replace_all(rml, "href='shader-square-preview.rcss'",
                            "href='preview://templates/shader-square-preview.rcss'");
                replace_all(rml, "__NT_PREVIEW_MATERIAL_ID__", request.preview_material_id);
                replace_all(rcss, "__NT_PREVIEW_MATERIAL_ID__", request.preview_material_id);
                ui::rmlui::RuntimeUiFacadeAccess::set_preview_virtual_file(
                    m_dependencies.runtime_ui, kPreviewShaderSquareRml, rml);
                ui::rmlui::RuntimeUiFacadeAccess::set_preview_virtual_file(
                    m_dependencies.runtime_ui, kPreviewShaderSquareRcss, rcss);
                return load_document(
                    {.rml = std::move(rml), .source_url = kPreviewShaderSquareRml});
            } else {
                static_assert(!sizeof(T), "Unhandled editor preview document");
            }
        },
        std::move(document));
}

void PreviewHost::complete_focused_request(
    const core::editor::FocusedEditorDocumentRequest& request, std::string_view status,
    const core::Diagnostics& diagnostics) const
{
    nlohmann::json encoded = nlohmann::json::array();
    for (const auto& diagnostic : diagnostics) {
        const auto severity = diagnostic.severity == core::ErrorSeverity::Info      ? "info"
                              : diagnostic.severity == core::ErrorSeverity::Warning ? "warning"
                                                                                    : "error";
        encoded.push_back(nlohmann::json{{"severity", severity},
                                         {"code", diagnostic.code},
                                         {"message", diagnostic.message},
                                         {"path", diagnostic.json_pointer},
                                         {"sourcePath", diagnostic.source_path}});
    }
    const auto kind =
        request.kind == core::editor::FocusedEditorDocumentKind::Layout   ? "layout-preview"
        : request.kind == core::editor::FocusedEditorDocumentKind::Shader ? "shader-preview"
                                                                          : "room-preview";
    const auto encoded_text = encoded.dump();
    const auto status_text = std::string(status);
    preview_bridge::emit_focused_document_applied(
        request.request_id.c_str(), host_generation(), request.apply_sequence,
        request.project_instance_id.c_str(), request.resource_stage_generation, kind,
        request.record_id.c_str(), request.revision.c_str(), status_text.c_str(),
        encoded_text.c_str());
}

bool PreviewHost::apply_focused_editor_document(core::editor::FocusedEditorDocumentRequest request)
{
    return m_focused_presenter->apply(std::move(request));
}

void PreviewHost::update_focused_preview() { m_focused_presenter->update(); }

void PreviewHost::clear_focused_preview() noexcept
{
    m_focused_presenter->clear();
    m_dependencies.renderer.set_asset_lease_lookup_scope(assets::AssetLeaseLookupScope::Runtime);
}

bool PreviewHost::request_screenshot(std::string path)
{
    if (path.empty() || !m_dependencies.renderer.is_initialized() ||
        m_dependencies.screenshots == nullptr) {
        report_diagnostic(preview_error("preview.screenshot.unavailable",
                                        "Screenshot request requires a ready renderer and path."));
        return false;
    }
    if (!m_dependencies.screenshots->request_file(std::move(path))) {
        report_diagnostic(preview_error("preview.screenshot.rejected",
                                        "Screenshot service rejected the request."));
        return false;
    }
    return true;
}

AudioVoiceHandle PreviewHost::play_audio_sfx(const std::string& path, float volume, float pitch)
{
    return m_audio_preview.play_sfx(path, volume, pitch);
}

AudioTrackHandle PreviewHost::play_audio_track(const AudioTrackId& track_id,
                                               const std::string& path, float volume, bool loop)
{
    return m_audio_preview.play_track(track_id, path, volume, loop);
}

void PreviewHost::stop_audio_track(const AudioTrackId& track_id, float fade_seconds)
{
    m_audio_preview.stop_track(track_id, fade_seconds);
}

void PreviewHost::stop_all_preview_audio(float fade_seconds)
{
    m_audio_preview.stop_all(fade_seconds);
}

void PreviewHost::update_audio_requests()
{
    update_focused_preview();
    m_audio_preview.update();
    report_diagnostics(m_audio_preview.take_diagnostics());
}

const std::optional<runtime::RuntimePublication>& PreviewHost::publication() const noexcept
{
    return m_dependencies.game_host.runtime_publication();
}

const runtime::RuntimeObservationSnapshot& PreviewHost::observations() const noexcept
{
    return m_dependencies.game_host.runtime_observations();
}

const std::vector<runtime::RuntimeEvent>& PreviewHost::events() const noexcept
{
    return m_dependencies.game_host.runtime_events();
}

const core::Diagnostics& PreviewHost::runtime_diagnostics() const noexcept
{
    return m_dependencies.game_host.runtime_diagnostics();
}

core::Diagnostics PreviewHost::take_preview_diagnostics()
{
    core::Diagnostics diagnostics = std::move(m_preview_diagnostics);
    m_preview_diagnostics.clear();
    return diagnostics;
}

void PreviewHost::report_diagnostics(core::Diagnostics diagnostics)
{
    if (diagnostics.empty())
        return;
    for (const auto& diagnostic : diagnostics)
        emit_diagnostic(diagnostic);
    core::append_diagnostics(m_preview_diagnostics, std::move(diagnostics));
}

bool PreviewHost::running_game_available() const noexcept
{
    return m_dependencies.game_host.running_game() != nullptr;
}

void PreviewHost::report_diagnostic(core::Diagnostic diagnostic)
{
    core::Diagnostics diagnostics;
    diagnostics.push_back(std::move(diagnostic));
    report_diagnostics(std::move(diagnostics));
}

void PreviewHost::emit_diagnostic(const core::Diagnostic& diagnostic) const
{
    const char* severity = "error";
    switch (diagnostic.severity) {
    case core::ErrorSeverity::Info:
        severity = "info";
        break;
    case core::ErrorSeverity::Warning:
        severity = "warning";
        break;
    case core::ErrorSeverity::Error:
    case core::ErrorSeverity::Fatal:
        break;
    }
    preview_bridge::emit_diagnostic(severity, diagnostic.code.c_str(),
                                    diagnostic.json_pointer.c_str(), diagnostic.message.c_str(),
                                    diagnostic.source_path.c_str());
}

} // namespace noveltea::host
