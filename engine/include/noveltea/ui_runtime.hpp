#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "noveltea/active_text_layout.hpp"
#include "noveltea/core/runtime_session_host.hpp"
#include "noveltea/core/runtime_ui_view.hpp"
#include "noveltea/surface.hpp"

union SDL_Event;
struct SDL_Window;

namespace noveltea {

namespace assets {
class AssetManager;
}
namespace script {
class ScriptRuntime;
}
struct ShaderMaterialProject;
class TweenService;

class RuntimeUI {
public:
    RuntimeUI();
    ~RuntimeUI();

    RuntimeUI(const RuntimeUI&) = delete;
    RuntimeUI& operator=(const RuntimeUI&) = delete;

    bool initialize(const assets::AssetManager* assets = nullptr, SDL_Window* window = nullptr,
                    bool load_demo_document = true, script::ScriptRuntime* scripts = nullptr,
                    const ShaderMaterialProject* shader_materials = nullptr);
    bool process_event(const SDL_Event& event);
    void resize(const SurfaceMetrics& surface);
    void begin_frame(float delta_time);
    void end_frame();
    void shutdown();
    void set_rmlui_base_direct_compatibility(bool enabled);

    // Returned pointers are borrowed from RmlUi. They remain valid until the
    // document is unloaded, all documents are reloaded, or RuntimeUI shuts down.
    bool load_document(const std::string& id, const std::string& path, bool show = true);
    bool unload_document(const std::string& id);
    bool show_document(const std::string& id);
    bool hide_document(const std::string& id);
    bool load_runtime_document();
    void* document(const std::string& id) const;
    void* element(const std::string& document_id, const std::string& element_id) const;
    bool reload_documents_and_styles();
    void set_density(float density);
    void apply_controller_commands(const std::vector<core::ControllerCommand>& commands);
    const core::RuntimeUIViewState& runtime_view_state() const;
    ActiveTextLayout active_text_render_snapshot() const;
    bool active_text_direct_render_enabled() const;
    void bind_runtime_host(core::RuntimeSessionHost* host);
    void bind_tween_service(TweenService* tweens);
    std::uintptr_t add_event_listener(const std::string& document_id, const std::string& element_id,
                                      const std::string& event, std::function<void()> callback);
    bool remove_event_listener(std::uintptr_t listener_id);
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
};

} // namespace noveltea
