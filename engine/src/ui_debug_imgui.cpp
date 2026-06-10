// Dear ImGui debug overlay.
// Uses ImGui_ImplSDL3 for input; rendering requires a bgfx backend.
//
// TODO: Implement bgfx-based ImGui rendering (see "Next steps" in README).
//       Currently the overlay processes input and maintains state but relies
//       on bgfx debug text for visual feedback. Full ImGui rendering needs
//       custom bgfx shaders (see shaders/README.md when created).

#include "noveltea/ui_debug.hpp"

#include <imgui.h>
#include <imgui_impl_sdl3.h>

#include <SDL3/SDL.h>

#include <cstdio>
#include <cstdarg>
#include <cstring>

namespace noveltea {

DebugUI::DebugUI() = default;
DebugUI::~DebugUI() { shutdown(); }

bool DebugUI::initialize(SDL_Window* window)
{
    if (m_initialized) return true;

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;

    ImGui::StyleColorsDark();

    if (!ImGui_ImplSDL3_InitForOther(window)) {
        std::fprintf(stderr, "[debug_ui] ImGui_ImplSDL3_InitForOther failed\n");
        ImGui::DestroyContext();
        return false;
    }

    // Build font atlas manually since there is no renderer backend yet.
    // TODO: Once a bgfx imgui renderer backend is added, this will be
    //       handled by the renderer's initialization instead.
    io.Fonts->Build();

    m_initialized = true;
    std::printf("[debug_ui] ImGui initialized (input only — no bgfx renderer yet)\n");
    return true;
}

void DebugUI::process_event(const SDL_Event& event)
{
    if (!m_initialized) return;
    ImGui_ImplSDL3_ProcessEvent(&event);
}

void DebugUI::begin_frame()
{
    if (!m_initialized) return;
    ImGui_ImplSDL3_NewFrame();
    ImGui::NewFrame();
}

void DebugUI::end_frame()
{
    if (!m_initialized) return;

    if (m_visible) {
        ImGui::Begin("Debug Overlay");

        ImGui::Text("FPS: %.1f", ImGui::GetIO().Framerate);
        ImGui::Text("Frame time: %.3f ms", 1000.0f / ImGui::GetIO().Framerate);
        ImGui::Separator();

        // Log display
        if (m_log_len > 0) {
            m_log_buffer[m_log_len] = '\0';
            ImGui::TextUnformatted(m_log_buffer);
        }

        ImGui::Text("[TODO] Full ImGui rendering needs bgfx shader integration");
        ImGui::End();
    }

    ImGui::Render();

    // TODO: Render ImDrawData using bgfx.
    //       See engine/shaders/README.md for shader compilation instructions.
    //       In brief: compile vs_imgui.sc/fs_imgui.sc with shaderc, then
    //       create bgfx shader programs, vertex/index buffers, and textures
    //       from the ImDrawData structures.
}

void DebugUI::shutdown()
{
    if (m_initialized) {
        ImGui_ImplSDL3_Shutdown();
        ImGui::DestroyContext();
        m_initialized = false;
        std::printf("[debug_ui] ImGui shutdown\n");
    }
}

void DebugUI::log_printf(const char* fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    int n = std::vsnprintf(m_log_buffer + m_log_len,
        sizeof(m_log_buffer) - m_log_len - 1, fmt, args);
    if (n > 0) m_log_len += n;
    if (m_log_len > static_cast<int>(sizeof(m_log_buffer)) - 2) {
        m_log_len = static_cast<int>(sizeof(m_log_buffer)) - 2;
    }
    va_end(args);
}

} // namespace noveltea
