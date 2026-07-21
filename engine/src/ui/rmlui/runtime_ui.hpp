#pragma once

#include "host/runtime_ui_host.hpp"

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "noveltea/active_text_layout.hpp"
#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/presentation/presentation_coordinator.hpp"
#include "noveltea/core/runtime_clock.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/core/runtime_shell_contracts.hpp"
#include "noveltea/surface.hpp"

union SDL_Event;
struct SDL_Window;

namespace noveltea {

namespace assets {
class AssetManager;
}
namespace script {
class ScriptRuntime;
} // namespace script
namespace ui::rmlui {
class RuntimeUiFacadeAccess;
class RuntimeUiPlaybackDriver;
} // namespace ui::rmlui
namespace presentation {
enum class RuntimeLayoutBuiltinDocument : std::uint8_t;
} // namespace presentation
struct ShaderMaterialProject;

class RuntimeUI final : public host::RuntimeUiHost {
public:
    RuntimeUI();
    ~RuntimeUI() override;

    RuntimeUI(const RuntimeUI&) = delete;
    RuntimeUI& operator=(const RuntimeUI&) = delete;

    bool initialize(const assets::AssetManager* assets = nullptr, SDL_Window* window = nullptr,
                    script::ScriptRuntime* scripts = nullptr,
                    const ShaderMaterialProject* shader_materials = nullptr,
                    bool headless_render = false);
    [[nodiscard]] RuntimeUiEventResult process_event(const SDL_Event& event,
                                                     const PresentationMetrics& presentation);
    void resize(const PresentationMetrics& presentation);
    void begin_frame(const core::RuntimeClockUpdate& clocks);
    void set_postprocess_framebuffers(std::uint16_t world, std::uint16_t full_game);
    void set_world_overlay_framebuffers(std::uint16_t source, std::uint16_t target,
                                        bool transition_active);
    void render_world_overlay_source();
    void render_world_overlay_target();
    void end_frame(bool include_debug_plane = true);
    void shutdown();

    bool unload_document(const std::string& id);
    bool show_document(const std::string& id);
    bool hide_document(const std::string& id);
    bool set_document_opacity(const std::string& id, float opacity);
    bool load_document_for_layout(
        const std::string& id, const std::string& path, bool show,
        const core::MountedLayoutPolicy& policy, std::uint32_t composition_group = 0,
        core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay,
        core::LayoutScalePolicy scale_policy = {}, std::uint32_t compatibility_group = 0);
    bool load_document_from_memory_for_layout(
        const std::string& id, const std::string& rml, const std::string& source_url, bool show,
        const core::MountedLayoutPolicy& policy, std::uint32_t composition_group = 0,
        core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay,
        core::LayoutScalePolicy scale_policy = {}, std::uint32_t compatibility_group = 0);
    bool load_builtin_for_layout(
        presentation::RuntimeLayoutBuiltinDocument builtin_document,
        const core::MountedLayoutPolicy& policy, std::uint32_t composition_group = 0,
        core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay,
        core::LayoutScalePolicy scale_policy = {}, std::uint32_t compatibility_group = 0);
    bool apply_layout_order(const std::vector<std::string>& ordered_document_ids);
    bool apply_layout_policy(const std::string& document_id,
                             const core::MountedLayoutPolicy& policy,
                             std::uint32_t composition_group = 0,
                             core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay,
                             core::LayoutScalePolicy scale_policy = {},
                             std::uint32_t compatibility_group = 0);
    [[nodiscard]] bool has_document(const std::string& id) const;
    bool reload_documents_and_styles();
    bool reset_backend();
    ActiveTextLayout active_text_render_snapshot() const;
    bool active_text_direct_render_enabled() const;
    void bind_input_sink(RuntimeUiInputSink* sink) noexcept override;
    [[nodiscard]] bool apply_gameplay_ui_values(const RuntimeUiGameplayValues& values) override;
    void clear_gameplay_ui_values() override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconfigure_user_settings(const core::RuntimeUserSettings& settings);
    void apply_runtime_shell_view(core::RuntimeShellViewState view);
    void clear_runtime_shell_view() override;
    void set_runtime_notification(std::string notification) override;
    void append_typed_runtime_diagnostics(core::Diagnostics diagnostics) override;
    void clear_typed_runtime_diagnostics() override;
    [[nodiscard]] core::ActiveTextPresentationPhase
    active_text_presentation_phase() const noexcept override;
    void bind_asset_service(const RuntimeUiAssetService* service) noexcept override;
    void bind_title_document(const std::string& project_title, const std::string& subtitle,
                             const std::string& start_label) override;
    void bind_layout_gameplay_admission(std::function<bool()> admission);

    void enable_render_perf_logging(bool enabled = true);

    const char* backend_name() const;
    const char* status_text() const;
    bool is_initialized() const { return m_initialized; }
    bool wants_input() const;
    bool wants_pointer_input() const;
    bool wants_keyboard_input() const;
    bool last_event_consumed() const { return m_last_event_consumed; }

private:
    friend class ui::rmlui::RuntimeUiFacadeAccess;
    friend class ui::rmlui::RuntimeUiPlaybackDriver;
    struct State;
    void cleanup_state();
    State* m_state = nullptr;

    bool m_initialized = false;
    bool m_last_event_consumed = false;
};

} // namespace noveltea
