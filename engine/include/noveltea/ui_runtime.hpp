#pragma once

#include <cstdint>
#include <functional>
#include <string>

union SDL_Event;
struct SDL_Window;

namespace noveltea {

namespace assets { class AssetManager; }

class RuntimeUI {
public:
    RuntimeUI();
    ~RuntimeUI();

    RuntimeUI(const RuntimeUI&) = delete;
    RuntimeUI& operator=(const RuntimeUI&) = delete;

    bool initialize(const assets::AssetManager* assets = nullptr, SDL_Window* window = nullptr);
    bool process_event(const SDL_Event& event);
    void resize(int width, int height);
    void begin_frame(float delta_time);
    void end_frame();
    void shutdown();

    // Returned pointers are borrowed from RmlUi. They remain valid until the
    // document is unloaded, all documents are reloaded, or RuntimeUI shuts down.
    bool load_document(const std::string& id, const std::string& path, bool show = true);
    bool unload_document(const std::string& id);
    bool show_document(const std::string& id);
    bool hide_document(const std::string& id);
    void* document(const std::string& id) const;
    void* element(const std::string& document_id, const std::string& element_id) const;
    bool reload_documents_and_styles();
    void set_density(float density);
    std::uintptr_t add_event_listener(
        const std::string& document_id,
        const std::string& element_id,
        const std::string& event,
        std::function<void()> callback);
    bool remove_event_listener(std::uintptr_t listener_id);
    void* create_data_model(const std::string& name);
    void* data_model(const std::string& name) const;
    bool remove_data_model(const std::string& name);

    const char* backend_name() const;
    const char* status_text() const;
    bool is_initialized() const { return m_initialized; }
    bool wants_input() const;
    bool wants_pointer_input() const;
    bool wants_keyboard_input() const;
    bool last_event_consumed() const { return m_last_event_consumed; }

private:
    struct State;
#if defined(NOVELTEA_HAS_RMLUI)
    State* m_state = nullptr;
#endif

    bool m_initialized = false;
    bool m_last_event_consumed = false;
    int m_width = 1280;
    int m_height = 720;
};

} // namespace noveltea
