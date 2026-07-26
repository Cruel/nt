#pragma once

#include "host/audio_preview_adapter.hpp"
#include "host/focused_preview_presenter.hpp"
#include "host/game_host.hpp"

#include "noveltea/core/editor_preview_contracts.hpp"
#include "noveltea/preview_bridge.hpp"
#include "noveltea/render/material.hpp"
#include "noveltea/renderer.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/surface.hpp"
#include "ui/rmlui/runtime_ui.hpp"

#include <cstdint>
#include <compare>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::host {

class LayoutRealizer;

struct PreviewRuntimeHandle {
    GameSessionGeneration session_generation;
    BackendGeneration backend_generation;
    auto operator<=>(const PreviewRuntimeHandle&) const = default;
};

struct PreviewDocumentRequest {
    std::string rml;
    std::string source_url = "preview://layout/current.rml";
};

struct PreviewLuaRequest {
    std::string source;
    std::string chunk_name = "editor_preview.lua";
};

struct PreviewMutationResult {
    bool accepted = false;
    std::string kind;
    std::string id;
    std::string message;
};

struct PreviewPresentationFastForwardResult {
    core::PresentationFastForwardDisposition disposition =
        core::PresentationFastForwardDisposition::Idle;
    std::vector<core::RuntimeInputMessage> inputs;
    core::Diagnostics diagnostics;
};

class PreviewHost final {
public:
    struct Dependencies {
        GameHost& game_host;
        RuntimeUI& runtime_ui;
        script::ScriptRuntime& scripts;
        Renderer& renderer;
        ShaderMaterialProject& shader_materials;
        assets::AssetManager& assets;
        AssetWorldPresentationResourceResolver* world_resources = nullptr;
        AudioSystem& audio_backend;
        LayoutRealizer& layout_realizer;
        std::function<bool(GameHostLoadRequest)> load_game;
        std::function<core::Result<void, core::Diagnostics>(
            const core::editor::TypedEditorAuthoredPreviewEnvironment&)>
            apply_authored_environment;
        std::function<core::Result<void, core::Diagnostics>()> clear_authored_environment;
        bool& preview_running;
    };

    explicit PreviewHost(Dependencies dependencies) noexcept;
    ~PreviewHost();

    [[nodiscard]] bool load_project(const std::string& logical_path);
    [[nodiscard]] bool reset();
    [[nodiscard]] bool reload();
    [[nodiscard]] bool start();
    [[nodiscard]] bool stop();
    [[nodiscard]] bool step(double delta_seconds);

    [[nodiscard]] PreviewRuntimeHandle runtime_handle() const noexcept;
    [[nodiscard]] bool accepts(PreviewRuntimeHandle handle) const noexcept;
    [[nodiscard]] bool dispatch(PreviewRuntimeHandle handle, core::RuntimeInputMessage input);
    [[nodiscard]] bool dispatch(core::RuntimeInputMessage input);

    [[nodiscard]] bool continue_dialogue();
    [[nodiscard]] bool select_dialogue_option(int option_index);
    [[nodiscard]] bool navigate(int direction);
    [[nodiscard]] bool select_subjects(std::vector<core::compiled::InteractionSubject> subjects);
    [[nodiscard]] bool clear_subject_selection();
    [[nodiscard]] bool run_interaction(const std::string& verb_id,
                                       std::vector<core::compiled::InteractionSubject> operands);

    [[nodiscard]] PreviewMutationResult set_variable(const std::string& variable_id,
                                                     core::RuntimeValue value);
    [[nodiscard]] PreviewMutationResult reset_variable(const std::string& variable_id);
    [[nodiscard]] PreviewMutationResult give_object(const std::string& object_id);
    [[nodiscard]] PreviewMutationResult remove_inventory_object(const std::string& object_id);
    [[nodiscard]] PreviewMutationResult teleport_room(const std::string& room_id);

    [[nodiscard]] bool begin_recording();
    [[nodiscard]] bool end_recording();
    [[nodiscard]] bool clear_recording();
    [[nodiscard]] bool undo_recording_step();
    [[nodiscard]] bool replay_recording();

    [[nodiscard]] PreviewPresentationFastForwardResult fast_forward_presentation_once();

    [[nodiscard]] bool load_document(PreviewDocumentRequest request);
    [[nodiscard]] bool execute_lua(PreviewLuaRequest request);
    [[nodiscard]] bool apply_editor_document(core::editor::TypedEditorPreviewDocument document);
    [[nodiscard]] bool
    apply_focused_editor_document(core::editor::FocusedEditorDocumentRequest request);
    void update_focused_preview();
    [[nodiscard]] const FocusedContentOwnerState& focused_content_owner() const noexcept
    {
        return m_focused_presenter->committed_owner();
    }
    void enable_fixture_room_commit(bool enabled) noexcept
    {
        m_focused_presenter->enable_fixture_room_commit(enabled);
    }
    [[nodiscard]] bool request_screenshot(std::string path);
    [[nodiscard]] AudioVoiceHandle play_audio_sfx(const std::string& path, float volume = 1.0f,
                                                  float pitch = 1.0f);
    [[nodiscard]] AudioTrackHandle play_audio_track(const AudioTrackId& track_id,
                                                    const std::string& path, float volume = 1.0f,
                                                    bool loop = true);
    void stop_audio_track(const AudioTrackId& track_id, float fade_seconds = 0.0f);
    void stop_all_preview_audio(float fade_seconds = 0.0f);
    void update_audio_requests();

    [[nodiscard]] const std::optional<runtime::RuntimePublication>& publication() const noexcept;
    [[nodiscard]] const runtime::RuntimeObservationSnapshot& observations() const noexcept;
    [[nodiscard]] const std::vector<runtime::RuntimeEvent>& events() const noexcept;
    [[nodiscard]] const core::Diagnostics& runtime_diagnostics() const noexcept;
    [[nodiscard]] bool preview_running() const noexcept { return m_dependencies.preview_running; }
    [[nodiscard]] std::uint64_t host_generation() const noexcept { return m_host_generation; }
    [[nodiscard]] const char* active_shader_variant() const noexcept
    {
        return m_dependencies.renderer.active_shader_variant();
    }
    [[nodiscard]] const core::Diagnostics& preview_diagnostics() const noexcept
    {
        return m_preview_diagnostics;
    }
    [[nodiscard]] core::Diagnostics take_preview_diagnostics();
    void report_diagnostics(core::Diagnostics diagnostics);

private:
    void complete_focused_request(const core::editor::FocusedEditorDocumentRequest& request,
                                  std::string_view status,
                                  const core::Diagnostics& diagnostics = {}) const;
    [[nodiscard]] bool running_game_available() const noexcept;
    void report_diagnostic(core::Diagnostic diagnostic);
    void emit_diagnostic(const core::Diagnostic& diagnostic) const;

    Dependencies m_dependencies;
    AudioPreviewAdapter m_audio_preview;
    AssetWorldPresentationResourceResolver m_fallback_world_resources;
    core::Diagnostics m_preview_diagnostics;
    std::uint64_t m_host_generation = 1;
    std::unique_ptr<FocusedPreviewPresenter> m_focused_presenter;
};

} // namespace noveltea::host
