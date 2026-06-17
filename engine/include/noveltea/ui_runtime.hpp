#pragma once

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
