#pragma once

#include "noveltea/surface.hpp"

#include <RmlUi/Core/SystemInterface.h>

#include <chrono>

struct SDL_Cursor;
struct SDL_Window;

namespace noveltea::ui::rmlui {

struct TextInputAreaProjection {
    int x = 0;
    int y = 0;
    int width = 1;
    int height = 1;
};

[[nodiscard]] TextInputAreaProjection
project_text_input_area_to_host_logical(const PresentationMetrics& presentation,
                                        const ResolvedContextMetrics& context, Vec2 context_caret,
                                        float context_line_height) noexcept;

class SdlSystemInterface final : public Rml::SystemInterface {
public:
    explicit SdlSystemInterface(SDL_Window* window);
    ~SdlSystemInterface() override;

    double GetElapsedTime() override;
    void set_elapsed_time(std::chrono::microseconds elapsed) noexcept;
    void SetMouseCursor(const Rml::String& cursor_name) override;
    void SetClipboardText(const Rml::String& text) override;
    void GetClipboardText(Rml::String& text) override;
    void set_context_projection(const PresentationMetrics& presentation,
                                const ResolvedContextMetrics& context) noexcept;
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
    std::chrono::microseconds m_elapsed{0};
    PresentationMetrics m_presentation{};
    ResolvedContextMetrics m_context_metrics{};
    bool m_has_context_projection = false;
};

} // namespace noveltea::ui::rmlui
