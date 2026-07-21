#include "devtools/debug_ui.hpp"

#include <imgui.h>
#include <imgui_impl_sdl3.h>

#include <SDL3/SDL.h>

#include <cstdarg>
#include <cstdio>
#include <cstring>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#endif

#include "devtools/imgui_bgfx.hpp"
#if defined(__EMSCRIPTEN__)
extern "C" {
extern void noveltea_web_sync_persistent_fs();
}
#endif

namespace noveltea {
namespace {

ImVec2 debug_overlay_default_pos() { return ImGui::GetMainViewport()->WorkPos; }

#if defined(SDL_PLATFORM_ANDROID)
void add_logical_mouse_position(float x, float y, const HostSurfaceMetrics& surface)
{
    const HostSurfaceMetrics s = sanitize_host_surface_metrics(surface);
    ImGui::GetIO().AddMousePosEvent(x / s.logical_to_framebuffer_scale.x,
                                    y / s.logical_to_framebuffer_scale.y);
}
#endif

} // namespace

DebugUI::DebugUI() = default;
DebugUI::~DebugUI() { shutdown(); }

bool DebugUI::initialize(SDL_Window* window, const assets::AssetManager* assets)
{
    if (m_initialized)
        return true;
    m_assets = assets;

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;

#if defined(SDL_PLATFORM_ANDROID)
    char* pref_path = SDL_GetPrefPath("Cruel", "NovelTea");
    if (pref_path) {
        m_ini_path = pref_path;
        SDL_free(pref_path);
        m_ini_path += "imgui.ini";
        io.IniFilename = m_ini_path.c_str();
        SDL_Log("[debug_ui] ImGui ini path: %s", io.IniFilename);
    } else {
        SDL_Log("[debug_ui] SDL_GetPrefPath failed: %s", SDL_GetError());
    }
#elif defined(__EMSCRIPTEN__)
    m_ini_path = "/persist/imgui.ini";
    io.IniFilename = m_ini_path.c_str();
    SDL_Log("[debug_ui] ImGui ini path: %s", io.IniFilename);
#endif

    ImGui::StyleColorsDark();
#if defined(SDL_PLATFORM_ANDROID)
    constexpr float android_ui_scale = 1.f;
    ImGuiStyle& style = ImGui::GetStyle();
    style.ScaleAllSizes(android_ui_scale);
    style.FontScaleDpi = android_ui_scale;
#endif

    if (!ImGui_ImplSDL3_InitForOther(window)) {
        SDL_Log("[debug_ui] ImGui_ImplSDL3_InitForOther failed");
        ImGui::DestroyContext();
        return false;
    }

    {
        auto* backend = new ImGuiBgfxRenderer();
        if (m_assets && backend->initialize(*m_assets)) {
            m_bgfx_backend = backend;
            SDL_Log("[debug_ui] ImGui bgfx renderer initialized");
        } else {
            SDL_Log("[debug_ui] ImGui bgfx renderer init failed; running without "
                    "rendering");
            delete backend;
        }
    }

    m_initialized = true;
    return true;
}

DebugUiEventResult DebugUI::process_event(const SDL_Event& event, const HostSurfaceMetrics& surface)
{
    if (!m_initialized)
        return {};

#if defined(SDL_PLATFORM_ANDROID)
    SDL_Event logical_event = event;
    const HostSurfaceMetrics s = sanitize_host_surface_metrics(surface);
    switch (logical_event.type) {
    case SDL_EVENT_MOUSE_MOTION:
        logical_event.motion.x /= s.logical_to_framebuffer_scale.x;
        logical_event.motion.y /= s.logical_to_framebuffer_scale.y;
        break;
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
    case SDL_EVENT_MOUSE_BUTTON_UP:
        add_logical_mouse_position(logical_event.button.x, logical_event.button.y, s);
        logical_event.button.x /= s.logical_to_framebuffer_scale.x;
        logical_event.button.y /= s.logical_to_framebuffer_scale.y;
        break;
    default:
        break;
    }
    ImGui_ImplSDL3_ProcessEvent(&logical_event);
#else
    ImGui_ImplSDL3_ProcessEvent(&event);
#endif

    if (!m_visible)
        return {};

    const ImGuiIO& io = ImGui::GetIO();
    switch (event.type) {
    case SDL_EVENT_MOUSE_MOTION:
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
    case SDL_EVENT_MOUSE_BUTTON_UP:
    case SDL_EVENT_MOUSE_WHEEL:
    case SDL_EVENT_FINGER_DOWN:
    case SDL_EVENT_FINGER_UP:
    case SDL_EVENT_FINGER_MOTION:
    case SDL_EVENT_FINGER_CANCELED:
        return {.consumed = io.WantCaptureMouse};
    case SDL_EVENT_KEY_DOWN:
    case SDL_EVENT_KEY_UP:
    case SDL_EVENT_TEXT_INPUT:
        return {.consumed = io.WantCaptureKeyboard};
    default:
        return {};
    }
}

void DebugUI::begin_frame(const HostSurfaceMetrics& surface)
{
    if (!m_initialized)
        return;
    ImGui_ImplSDL3_NewFrame();
    ImGuiIO& io = ImGui::GetIO();
    const HostSurfaceMetrics s = sanitize_host_surface_metrics(surface);
    if (s.logical_size.width > 0 && s.logical_size.height > 0) {
        io.DisplaySize = ImVec2(static_cast<float>(s.logical_size.width),
                                static_cast<float>(s.logical_size.height));
        io.DisplayFramebufferScale =
            ImVec2(s.logical_to_framebuffer_scale.x, s.logical_to_framebuffer_scale.y);
    }
    ImGui::NewFrame();
}

host::DebugUiFrameOutput DebugUI::end_frame(const host::DebugUiObservationSnapshot& observations,
                                            bool submit_draw_data)
{
    host::DebugUiFrameOutput output;
    if (!m_initialized)
        return output;

    if (m_visible) {
        ImGui::SetNextWindowPos(debug_overlay_default_pos(), ImGuiCond_FirstUseEver);
        ImGui::Begin("Debug Overlay");

        const ImGuiIO& io = ImGui::GetIO();
        ImGui::Text("FPS: %.1f", io.Framerate);
        ImGui::Text("Frame time: %.3f ms", 1000.0f / io.Framerate);
        bool render_perf_logging = observations.render_perf_logging;
        if (ImGui::Checkbox("Render Perf Logging", &render_perf_logging)) {
            output.commands.emplace_back(
                host::SetRenderPerfLoggingDebugCommand{render_perf_logging});
        }
        ImGui::Separator();

        ImGui::Text("Renderer: %.*s", static_cast<int>(observations.renderer_name.size()),
                    observations.renderer_name.data());
        ImGui::Text("Host logical: %d x %d", observations.surface.logical_size.width,
                    observations.surface.logical_size.height);
        ImGui::Text("Backend: %.*s", static_cast<int>(observations.platform_name.size()),
                    observations.platform_name.data());
        ImGui::Text("Triangle smoke test: running on view 0");
        ImGui::Separator();

        if (observations.runtime_loaded) {
            if (observations.host_generation) {
                ImGui::Text(
                    "Runtime: loaded (host generation %llu)",
                    static_cast<unsigned long long>(observations.host_generation->number()));
            } else {
                ImGui::TextUnformatted("Runtime: loaded");
            }
            bool gameplay_paused = observations.gameplay_paused;
            if (ImGui::Checkbox("Gameplay Paused", &gameplay_paused)) {
                output.commands.emplace_back(host::SetGameplayPausedDebugCommand{gameplay_paused});
            }
            ImGui::Text("Observations: %zu", observations.runtime_observations.size());
            ImGui::Text("Events: %zu", observations.runtime_events.size());
            ImGui::Text("Diagnostics: %zu", observations.runtime_diagnostics.size());
        } else {
            ImGui::TextUnformatted("Runtime: not loaded");
        }
        ImGui::Separator();

        if (m_log_len > 0) {
            m_log_buffer[m_log_len] = '\0';
            ImGui::TextUnformatted(m_log_buffer);
        }

        ImGui::End();
    }

    ImGui::Render();

#if defined(__EMSCRIPTEN__)
    ImGuiIO& web_io = ImGui::GetIO();
    m_web_ini_sync_timer += web_io.DeltaTime;
    if (m_web_ini_sync_timer >= 2.0f && web_io.IniFilename) {
        m_web_ini_sync_timer = 0.0f;
        ImGui::SaveIniSettingsToDisk(web_io.IniFilename);
        web_io.WantSaveIniSettings = false;
        noveltea_web_sync_persistent_fs();
    }
#endif

    if (m_bgfx_backend && submit_draw_data) {
        const ImGuiIO& io = ImGui::GetIO();
        auto* backend = static_cast<ImGuiBgfxRenderer*>(m_bgfx_backend);
        backend->render(ImGui::GetDrawData(), static_cast<int>(io.DisplaySize.x),
                        static_cast<int>(io.DisplaySize.y));
    }
    return output;
}

void DebugUI::shutdown()
{
    if (!m_initialized)
        return;

    if (m_bgfx_backend) {
        auto* backend = static_cast<ImGuiBgfxRenderer*>(m_bgfx_backend);
        backend->shutdown();
        delete backend;
        m_bgfx_backend = nullptr;
    }

    ImGui_ImplSDL3_Shutdown();
    ImGui::DestroyContext();
    m_ini_path.clear();
    m_web_ini_sync_timer = 0.0f;
    m_initialized = false;
    SDL_Log("[debug_ui] ImGui shutdown");
}

void DebugUI::log_printf(const char* fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    int n =
        std::vsnprintf(m_log_buffer + m_log_len, sizeof(m_log_buffer) - m_log_len - 1, fmt, args);
    if (n > 0)
        m_log_len += n;
    if (m_log_len > static_cast<int>(sizeof(m_log_buffer)) - 2) {
        m_log_len = static_cast<int>(sizeof(m_log_buffer)) - 2;
    }
    va_end(args);
}

} // namespace noveltea
