#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <unordered_set>
#include <vector>

#include "noveltea/active_text_layout.hpp"
#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/presentation_coordinator.hpp"
#include "noveltea/core/runtime_clock.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"
#include "noveltea/surface.hpp"

union SDL_Event;
struct SDL_Window;

namespace noveltea {

namespace assets {
class AssetManager;
}
namespace core {
class CompiledProject;
}
namespace script {
class ScriptRuntime;
} // namespace script
namespace runtime {
class RunningGame;
}
struct ShaderMaterialProject;
enum class RuntimeLayoutBuiltinDocument : std::uint8_t;

enum class TypedRuntimeOperationDisposition : std::uint8_t {
    Completed,
    Pending
};

class RuntimeUiAssetResolver {
public:
    void bind(const runtime::RunningGame* runtime) noexcept;
    void bind(const core::CompiledProject& project) noexcept { m_project = &project; }
    void clear() noexcept { m_project = nullptr; }
    [[nodiscard]] std::optional<std::string> resolve(const core::AssetId& asset) const;

private:
    const core::CompiledProject* m_project = nullptr;
};

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
    void end_frame();
    void shutdown();
    void set_rmlui_base_direct_compatibility(bool enabled);

    // Returned pointers are borrowed from RmlUi. They remain valid until the
    // document is unloaded, all documents are reloaded, or RuntimeUI shuts down.
    bool load_document(const std::string& id, const std::string& path, bool show = true);
    bool load_document_from_memory(const std::string& id, const std::string& rml,
                                   const std::string& source_url = "preview://document.rml",
                                   bool show = true);
    void set_preview_virtual_file(std::string path, std::string contents);
    void clear_preview_virtual_files();
    bool unload_document(const std::string& id);
    bool show_document(const std::string& id);
    bool hide_document(const std::string& id);
    bool load_title_document();
    void bind_title_document(const std::string& project_title, const std::string& subtitle = "",
                             const std::string& start_label = "Start");
    bool load_runtime_document();
    bool load_pause_menu_document();
    bool load_document_for_layout(const std::string& id, const std::string& path, bool show,
                                  const core::MountedLayoutPolicy& policy);
    bool load_builtin_for_layout(RuntimeLayoutBuiltinDocument builtin_document,
                                 const core::MountedLayoutPolicy& policy);
    bool apply_layout_order(const std::vector<std::string>& ordered_document_ids);
    bool apply_layout_policy(const std::string& document_id,
                             const core::MountedLayoutPolicy& policy,
                             std::uint32_t composition_group = 0);
    void* document(const std::string& id) const;
    void* element(const std::string& document_id, const std::string& element_id) const;
    bool reload_documents_and_styles();
    void set_density(float density);
    ActiveTextLayout active_text_render_snapshot() const;
    bool active_text_direct_render_enabled() const;
    void bind_runtime_input_handler(std::function<bool(const core::RuntimeInputMessage&)> handler);
    void apply_runtime_publication(const runtime::RuntimePublication& publication);
    void deliver_runtime_events(const std::vector<runtime::RuntimeEvent>& events);
    void append_typed_runtime_diagnostics(core::Diagnostics diagnostics);
    [[nodiscard]] core::ActiveTextPresentationPhase active_text_presentation_phase() const noexcept;
    void bind_asset_resolver(const RuntimeUiAssetResolver* resolver);
    void bind_layout_gameplay_admission(std::function<bool()> admission);
    void bind_game_started_handler(std::function<void()> handler);
    [[nodiscard]] bool dispatch_typed_runtime_input(const core::RuntimeInputMessage& input);
    [[nodiscard]] const core::TypedRuntimeUIViewState* typed_runtime_view_state() const noexcept;
    [[nodiscard]] const core::Diagnostics& typed_runtime_diagnostics() const noexcept;
    std::uintptr_t add_event_listener(const std::string& document_id, const std::string& element_id,
                                      const std::string& event, std::function<void()> callback);
    bool remove_event_listener(std::uintptr_t listener_id);
    [[nodiscard]] RuntimeUiPlaybackClickResult
    playback_click(const RuntimeUiPlaybackClickRequest& request);
    void* create_data_model(const std::string& name);
    void* data_model(const std::string& name) const;
    bool remove_data_model(const std::string& name);

    void enable_render_perf_logging(bool enabled = true);

    const char* backend_name() const;
    const char* status_text() const;
    bool is_initialized() const { return m_initialized; }
    bool wants_input() const;
    bool wants_pointer_input() const;
    bool wants_keyboard_input() const;
    bool last_event_consumed() const { return m_last_event_consumed; }

private:
    struct State;
    void cleanup_state();
    State* m_state = nullptr;

    bool m_initialized = false;
    bool m_last_event_consumed = false;
    SurfaceMetrics m_surface{};
    PresentationMetrics m_presentation{};
    bool m_pointer_inside = false;
    std::unordered_set<std::uint64_t> m_active_touches;
};

} // namespace noveltea
