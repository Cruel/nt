#pragma once

#if defined(NOVELTEA_HAS_RMLUI)

#include <RmlUi/Core/SystemInterface.h>

struct SDL_Cursor;
struct SDL_Window;

namespace noveltea::ui::rmlui {

class SdlSystemInterface final : public Rml::SystemInterface {
public:
    explicit SdlSystemInterface(SDL_Window* window);
    ~SdlSystemInterface() override;

    double GetElapsedTime() override;
    void SetMouseCursor(const Rml::String& cursor_name) override;
    void SetClipboardText(const Rml::String& text) override;
    void GetClipboardText(Rml::String& text) override;
    void ActivateKeyboard(Rml::Vector2f caret_position, float line_height) override;
    void DeactivateKeyboard() override;
    bool LogMessage(Rml::Log::Type type, const Rml::String& message) override;

private:
    SDL_Window* m_window = nullptr;
    SDL_Cursor* m_default_cursor = nullptr;
    SDL_Cursor* m_move_cursor = nullptr;
    SDL_Cursor* m_pointer_cursor = nullptr;
    SDL_Cursor* m_resize_cursor = nullptr;
    SDL_Cursor* m_cross_cursor = nullptr;
    SDL_Cursor* m_text_cursor = nullptr;
    SDL_Cursor* m_unavailable_cursor = nullptr;
    uint64_t m_start = 0;
    double m_frequency = 1.0;
};

} // namespace noveltea::ui::rmlui

#endif
