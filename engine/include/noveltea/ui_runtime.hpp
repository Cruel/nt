#pragma once

union SDL_Event;

namespace noveltea {

namespace assets { class AssetManager; }

class RuntimeUI {
public:
    RuntimeUI();
    ~RuntimeUI();

    RuntimeUI(const RuntimeUI&) = delete;
    RuntimeUI& operator=(const RuntimeUI&) = delete;

    bool initialize(const assets::AssetManager* assets = nullptr);
    void process_event(const SDL_Event& event);
    void resize(int width, int height);
    void begin_frame(float delta_time);
    void end_frame();
    void shutdown();

    const char* backend_name() const;
    const char* status_text() const;
    bool is_initialized() const { return m_initialized; }

private:
    struct State;
#if defined(NOVELTEA_HAS_RMLUI)
    State* m_state = nullptr;
#endif

    bool m_initialized = false;
    int m_width = 1280;
    int m_height = 720;
};

} // namespace noveltea
