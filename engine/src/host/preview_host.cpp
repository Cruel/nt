#include "host/preview_host.hpp"

#include "noveltea/runtime/runtime_capabilities.hpp"
#include "ui/rmlui/runtime_ui_facade_access.hpp"

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

constexpr const char* kPreviewBaseStyle = R"rcss(body, div,
h1, h2, h3, h4,
h5, h6, p,
hr, pre,
tabset tabs {
  display: block;
}

body {
  width: 100%;
  height: 100%;
  color: #f8fafc;
  font-family: Liberation Sans;
}

h1 { font-size: 2em; margin: .67em 0; }
h2 { font-size: 1.5em; margin: .75em 0; }
h3 { font-size: 1.17em; margin: .83em 0; }
h4, p { margin: 1.12em 0; }
h5 { font-size: .83em; margin: 1.5em 0; }
h6 { font-size: .75em; margin: 1.67em 0; }
h1, h2, h3, h4, h5, h6, strong { font-weight: bold; }
em { font-style: italic; }
pre { white-space: pre; }
hr { border-width: 1px; }

button {
  display: inline-block;
  margin: 4px 0;
  padding: 8px 12px;
  min-width: 96px;
  color: #f8fafc;
  background-color: #334155;
  border-width: 1px;
  border-color: #64748b;
  border-radius: 4px;
  font-family: Liberation Sans;
  font-size: 14px;
  text-align: center;
}

button:hover { background-color: #475569; border-color: #94a3b8; }
button:active { background-color: #1e293b; }
table { box-sizing: border-box; display: table; }
tr { box-sizing: border-box; display: table-row; }
td { box-sizing: border-box; display: table-cell; }
col { box-sizing: border-box; display: table-column; }
colgroup { display: table-column-group; }
thead, tbody, tfoot { display: table-row-group; }
)rcss";

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

} // namespace

PreviewHost::PreviewHost(Dependencies dependencies) noexcept
    : m_dependencies(std::move(dependencies)), m_audio_preview(m_dependencies.audio_backend)
{
}

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
    m_dependencies.preview_running = true;
    const bool accepted = dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
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
    return result.accepted();
}

bool PreviewHost::dispatch(core::RuntimeInputMessage input)
{
    return dispatch(runtime_handle(), std::move(input));
}

bool PreviewHost::continue_dialogue()
{
    return running_game_available() && dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
}

bool PreviewHost::select_dialogue_option(int option_index)
{
    const auto& current = publication();
    const auto* view = current ? &current->gameplay_ui : nullptr;
    if (!view || !view->dialogue || !view->dialogue->choice || option_index < 0 ||
        static_cast<std::size_t>(option_index) >= view->dialogue->choice->options.size())
        return false;
    return dispatch(core::RuntimeInputMessage{core::SelectDialogueChoiceInput{
        view->dialogue->choice->options[static_cast<std::size_t>(option_index)].edge}});
}

bool PreviewHost::navigate(int direction)
{
    const auto& current = publication();
    const auto* view = current ? &current->gameplay_ui : nullptr;
    if (!view || !view->room)
        return false;
    const auto exit = std::find_if(
        view->room->exits.begin(), view->room->exits.end(), [&](const auto& candidate) {
            return candidate.enabled && static_cast<int>(candidate.direction) == direction;
        });
    return exit != view->room->exits.end() &&
           dispatch(core::RuntimeInputMessage{core::NavigateRoomInput{exit->exit}});
}

bool PreviewHost::select_subjects(std::vector<core::compiled::InteractionSubject> subjects)
{
    return running_game_available() &&
           dispatch(core::RuntimeInputMessage{
               core::SelectInteractionSubjectsInput{std::move(subjects)}});
}

bool PreviewHost::clear_subject_selection()
{
    return running_game_available() &&
           dispatch(core::RuntimeInputMessage{core::ClearInteractionSubjectSelectionInput{}});
}

bool PreviewHost::run_interaction(const std::string& verb_id,
                                  std::vector<core::compiled::InteractionSubject> operands)
{
    auto verb = core::VerbId::create(verb_id);
    if (!verb)
        return false;
    return dispatch(core::RuntimeInputMessage{
        core::InvokeInteractionInput{std::move(*verb.value_if()), std::move(operands)}});
}

PreviewMutationResult PreviewHost::set_variable(const std::string& variable_id,
                                                core::RuntimeValue value)
{
    auto id = core::VariableId::create(variable_id);
    if (!id)
        return mutation_result(false, "set-variable", variable_id, "invalid variable id");
    const bool accepted = dispatch(core::RuntimeInputMessage{
        core::SetVariableDebugInput{std::move(*id.value_if()), std::move(value)}});
    return mutation_result(accepted, "set-variable", variable_id);
}

PreviewMutationResult PreviewHost::reset_variable(const std::string& variable_id)
{
    auto id = core::VariableId::create(variable_id);
    const auto* running_game = m_dependencies.game_host.running_game();
    if (!id || !running_game)
        return mutation_result(false, "reset-variable", variable_id, "invalid variable id");
    const auto* definition = running_game->package().project().find_variable(*id.value_if());
    if (!definition)
        return mutation_result(false, "reset-variable", variable_id, "unknown variable");
    const bool accepted = dispatch(core::RuntimeInputMessage{
        core::SetVariableDebugInput{*id.value_if(), definition->default_value}});
    return mutation_result(accepted, "reset-variable", variable_id);
}

PreviewMutationResult PreviewHost::give_object(const std::string& object_id)
{
    auto id = core::InteractableId::create(object_id);
    auto* running_game = m_dependencies.game_host.running_game();
    if (!id || !running_game)
        return mutation_result(false, "give-object", object_id, "invalid object id");
    auto result = running_game->session().gateway().request_interactable_location(
        *id.value_if(), core::compiled::InventoryLocation{});
    if (result)
        (void)dispatch(core::RuntimeInputMessage{core::AdvanceTimeInput{}});
    return mutation_result(static_cast<bool>(result), "give-object", object_id,
                           result ? "" : first_diagnostic_message(result.error()));
}

PreviewMutationResult PreviewHost::remove_inventory_object(const std::string& object_id)
{
    auto id = core::InteractableId::create(object_id);
    auto* running_game = m_dependencies.game_host.running_game();
    if (!id || !running_game)
        return mutation_result(false, "remove-object", object_id, "invalid object id");
    auto result = running_game->session().gateway().request_interactable_location(
        *id.value_if(), core::compiled::NowhereLocation{});
    if (result)
        (void)dispatch(core::RuntimeInputMessage{core::AdvanceTimeInput{}});
    return mutation_result(static_cast<bool>(result), "remove-object", object_id,
                           result ? "" : first_diagnostic_message(result.error()));
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
                ui::rmlui::RuntimeUiFacadeAccess::set_preview_virtual_file(
                    m_dependencies.runtime_ui, kPreviewLayoutCurrentRcss,
                    std::string(kPreviewBaseStyle) + "\n" + request.rcss);
                ui::rmlui::RuntimeUiFacadeAccess::set_preview_virtual_file(
                    m_dependencies.runtime_ui, kPreviewLayoutCurrentLua, request.lua);
                ui::rmlui::RuntimeUiFacadeAccess::set_preview_virtual_file(
                    m_dependencies.runtime_ui, kPreviewLayoutFragmentHostRcss,
                    request.fragment_host_rcss.value_or(kLayoutFragmentHostRcss));

                if (request.script_enabled &&
                    !execute_lua({.source = request.lua, .chunk_name = kPreviewLayoutCurrentLua}))
                    return false;

                std::string rml;
                if (request.layout_kind == core::editor::EditorPreviewLayoutKind::Fragment) {
                    rml = layout_fragment_host_rml(
                        request.fragment_host_rml.value_or(kLayoutFragmentHostRml), request.rml);
                } else {
                    const std::string source = request.rml.empty()
                                                   ? "<rml><head><title>Empty Layout "
                                                     "Preview</title></head><body></body></rml>"
                                                   : request.rml;
                    rml = inject_head_content(
                        source,
                        "<link type=\"text/rcss\" href=\"preview://layout/current.rcss\" />");
                }
                ui::rmlui::RuntimeUiFacadeAccess::set_preview_virtual_file(
                    m_dependencies.runtime_ui, kPreviewLayoutCurrentRml, rml);
                return load_document(
                    {.rml = std::move(rml), .source_url = kPreviewLayoutCurrentRml});
            } else if constexpr (std::is_same_v<T,
                                                core::editor::TypedEditorShaderPreviewDocument>) {
                if (request.shader_materials) {
                    m_dependencies.shader_materials = std::move(*request.shader_materials);
                    upsert_preview_material(m_dependencies.shader_materials,
                                            request.preview_material_id, request.shader_id);
                    m_dependencies.renderer.set_shader_material_project(
                        &m_dependencies.shader_materials);
                }

                std::string rml = request.template_rml.value_or(kShaderSquareRml);
                std::string rcss = request.template_rcss.value_or(kShaderSquareRcss);
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

bool PreviewHost::request_screenshot(std::string path)
{
    if (path.empty() || !m_dependencies.renderer.is_initialized()) {
        report_diagnostic(preview_error("preview.screenshot.unavailable",
                                        "Screenshot request requires a ready renderer and path."));
        return false;
    }
    m_dependencies.renderer.request_screenshot(path);
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
