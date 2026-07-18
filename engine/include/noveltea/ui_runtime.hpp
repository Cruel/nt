#pragma once

#include <cstdint>
#include <functional>
#include <limits>
#include <optional>
#include <string>
#include <vector>

#include "noveltea/active_text_layout.hpp"
#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/presentation_coordinator.hpp"
#include "noveltea/core/runtime_clock.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/core/runtime_shell_contracts.hpp"
#include "noveltea/runtime_ui_contracts.hpp"
#include "noveltea/surface.hpp"

union SDL_Event;
struct SDL_Window;

namespace noveltea {

inline constexpr std::uint32_t kWorldTransitionSourceCompositionGroup =
    std::numeric_limits<std::uint32_t>::max();

namespace assets {
class AssetManager;
}
namespace script {
class ScriptRuntime;
} // namespace script
namespace ui::rmlui {
class RmlUiTestAccess;
}
struct ShaderMaterialProject;
enum class RuntimeLayoutBuiltinDocument : std::uint8_t;

enum class RuntimeUiPlaybackClickStatus {
    Dispatched,
    UiNotInitialized,
    DocumentNotFound,
    DocumentHidden,
    TargetNotFound,
    TargetHidden,
    TargetEmptyBounds,
    TargetDisabled,
    TargetBlocked,
    TargetNotInteractive,
};

struct RuntimeUiPlaybackClickRequest {
    std::string document_id;
    std::string selector;
};

struct RuntimeUiPlaybackClickResult {
    RuntimeUiPlaybackClickStatus status = RuntimeUiPlaybackClickStatus::UiNotInitialized;
    std::string message;
    std::string document_id;
    std::string selector;
    std::string target_id;
    std::string target_tag;
    float x = 0.0f;
    float y = 0.0f;
    float width = 0.0f;
    float height = 0.0f;
    bool dispatched = false;
};

[[nodiscard]] const char* to_string(RuntimeUiPlaybackClickStatus status) noexcept;

class RuntimeUI {
public:
    RuntimeUI();
    ~RuntimeUI();

    RuntimeUI(const RuntimeUI&) = delete;
    RuntimeUI& operator=(const RuntimeUI&) = delete;

    bool initialize(const assets::AssetManager* assets = nullptr, SDL_Window* window = nullptr,
                    bool load_demo_document = true, script::ScriptRuntime* scripts = nullptr,
                    const ShaderMaterialProject* shader_materials = nullptr,
                    bool headless_render = false);
    bool process_event(const SDL_Event& event, const PresentationMetrics& presentation);
    void resize(const PresentationMetrics& presentation);
    void begin_frame(const core::RuntimeClockUpdate& clocks);
    void set_world_overlay_framebuffers(std::uint16_t source, std::uint16_t target,
                                        bool transition_active);
    void render_world_overlay_source();
    void render_world_overlay_target();
    void end_frame();
    void shutdown();
    void set_rmlui_base_direct_compatibility(bool enabled);

    bool load_document(const std::string& id, const std::string& path, bool show = true);
    bool load_document_from_memory(const std::string& id, const std::string& rml,
                                   const std::string& source_url = "preview://document.rml",
                                   bool show = true);
    void set_preview_virtual_file(std::string path, std::string contents);
    void clear_preview_virtual_files();
    bool unload_document(const std::string& id);
    bool show_document(const std::string& id);
    bool hide_document(const std::string& id);
    bool set_document_opacity(const std::string& id, float opacity);
    bool load_title_document();
    void bind_title_document(const std::string& project_title, const std::string& subtitle = "",
                             const std::string& start_label = "Start");
    bool load_runtime_document();
    bool load_pause_menu_document();
    bool load_builtin_system_document(const std::string& id, const std::string& path);
    bool
    load_document_for_layout(const std::string& id, const std::string& path, bool show,
                             const core::MountedLayoutPolicy& policy,
                             std::uint32_t composition_group = 0,
                             core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay);
    bool load_document_from_memory_for_layout(
        const std::string& id, const std::string& rml, const std::string& source_url, bool show,
        const core::MountedLayoutPolicy& policy, std::uint32_t composition_group = 0,
        core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay);
    bool
    load_builtin_for_layout(RuntimeLayoutBuiltinDocument builtin_document,
                            const core::MountedLayoutPolicy& policy,
                            std::uint32_t composition_group = 0,
                            core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay);
    bool apply_layout_order(const std::vector<std::string>& ordered_document_ids);
    bool apply_layout_policy(const std::string& document_id,
                             const core::MountedLayoutPolicy& policy,
                             std::uint32_t composition_group = 0,
                             core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay);
    [[nodiscard]] bool has_document(const std::string& id) const;
    bool reload_documents_and_styles();
    void set_density(float density);
    ActiveTextLayout active_text_render_snapshot() const;
    bool active_text_direct_render_enabled() const;
    void bind_input_sink(RuntimeUiInputSink* sink) noexcept;
    [[nodiscard]] bool apply_gameplay_ui_values(const RuntimeUiGameplayValues& values);
    void clear_gameplay_ui_values();
    void apply_runtime_shell_view(core::RuntimeShellViewState view);
    void clear_runtime_shell_view();
    void set_runtime_notification(std::string notification);
    void append_typed_runtime_diagnostics(core::Diagnostics diagnostics);
    void clear_typed_runtime_diagnostics();
    [[nodiscard]] core::ActiveTextPresentationPhase active_text_presentation_phase() const noexcept;
    void bind_asset_service(const RuntimeUiAssetService* service) noexcept;
    void bind_layout_gameplay_admission(std::function<bool()> admission);
    void bind_game_started_handler(std::function<void()> handler);
    [[nodiscard]] bool dispatch_typed_runtime_input(const core::RuntimeInputMessage& input);
    std::uintptr_t add_event_listener(const std::string& document_id, const std::string& element_id,
                                      const std::string& event, std::function<void()> callback);
    bool remove_event_listener(std::uintptr_t listener_id);
    [[nodiscard]] RuntimeUiPlaybackClickResult
    playback_click(const RuntimeUiPlaybackClickRequest& request);

    void enable_render_perf_logging(bool enabled = true);

    const char* backend_name() const;
    const char* status_text() const;
    bool is_initialized() const { return m_initialized; }
    bool wants_input() const;
    bool wants_pointer_input() const;
    bool wants_keyboard_input() const;
    bool last_event_consumed() const { return m_last_event_consumed; }

private:
    friend class ui::rmlui::RmlUiTestAccess;
    struct State;
    void cleanup_state();
    State* m_state = nullptr;

    bool m_initialized = false;
    bool m_last_event_consumed = false;
};

} // namespace noveltea
