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

host::DebugUiFrameOutput DebugUI::end_frame(const devtools::DevtoolsSnapshot& snapshot,
                                            std::span<const devtools::ConsoleRecord> console,
                                            std::span<const devtools::TraceRecord> trace,
                                            std::uint64_t trace_evicted_record_count,
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
        bool render_perf_logging = snapshot.tooling.render_perf_logging;
        if (ImGui::Checkbox("Render Perf Logging", &render_perf_logging)) {
            output.commands.emplace_back(
                host::SetRenderPerfLoggingDebugCommand{render_perf_logging});
        }
        ImGui::Separator();

        ImGui::Text("Renderer: %s", snapshot.host.renderer.c_str());
        ImGui::Text("Host logical: %d x %d", snapshot.host.surface.logical_size.width,
                    snapshot.host.surface.logical_size.height);
        ImGui::Text("Backend: %s", snapshot.host.platform.c_str());
        ImGui::Text("Triangle smoke test: running on view 0");
        ImGui::Separator();

        if (snapshot.runtime) {
            if (snapshot.host.host_generation) {
                ImGui::Text("Runtime: loaded (host generation %llu)",
                            static_cast<unsigned long long>(*snapshot.host.host_generation));
            } else {
                ImGui::TextUnformatted("Runtime: loaded");
            }
            bool gameplay_paused = snapshot.runtime->publication.gameplay_ui.gameplay_paused;
            if (ImGui::Checkbox("Gameplay Paused", &gameplay_paused)) {
                output.commands.emplace_back(host::SetGameplayPausedDebugCommand{gameplay_paused});
            }
            ImGui::Text("Observations: %llu",
                        static_cast<unsigned long long>(
                            snapshot.runtime->publication.observations.values.size()));
            ImGui::Text("Diagnostics: %zu", snapshot.runtime->diagnostics.size());
        } else {
            ImGui::TextUnformatted("Runtime: not loaded");
        }
        ImGui::Separator();

        if (snapshot.rmlui_debugger.available) {
            bool visible = snapshot.rmlui_debugger.visible;
            if (ImGui::Checkbox("RmlUi Debugger", &visible))
                output.rmlui_debugger = {visible, snapshot.rmlui_debugger.context};
            if (ImGui::BeginCombo("Inspect context", snapshot.rmlui_debugger.context.c_str())) {
                for (const auto& context : snapshot.rmlui) {
                    if (ImGui::Selectable(context.name.c_str(),
                                          context.name == snapshot.rmlui_debugger.context))
                        output.rmlui_debugger = {visible, context.name};
                }
                ImGui::EndCombo();
            }
        }

        if (!console.empty()) {
            ImGui::TextUnformatted("Console");
            ImGui::BeginChild("Console", ImVec2(0.0f, 180.0f), true);
            const auto first = console.size() > 100 ? console.size() - 100 : 0;
            for (std::size_t index = first; index < console.size(); ++index) {
                const auto& record = console[index];
                ImGui::TextWrapped(
                    "[%llu] [%.*s] [%s] %s", static_cast<unsigned long long>(record.sequence),
                    static_cast<int>(devtools::console_severity_name(record.severity).size()),
                    devtools::console_severity_name(record.severity).data(),
                    record.category.c_str(), record.message.c_str());
            }
            ImGui::EndChild();
        }

        if (!trace.empty()) {
            ImGui::Separator();
            ImGui::TextUnformatted("Trace");
            if (trace_evicted_record_count > 0) {
                ImGui::Text("History gap: %llu record(s) were evicted from retention",
                            static_cast<unsigned long long>(trace_evicted_record_count));
            }
            ImGui::BeginChild("Trace", ImVec2(0.0f, 180.0f), true);
            const auto first = trace.size() > 100 ? trace.size() - 100 : 0;
            for (std::size_t index = first; index < trace.size(); ++index) {
                const auto& record = trace[index];
                if (record.input) {
                    const auto& input = *record.input;
                    ImGui::TextWrapped(
                        "[%llu] [%s] %s admitted=%s block=%s world=%s repeat=%u",
                        static_cast<unsigned long long>(record.sequence),
                        devtools::trace_record_kind_name(record.kind), input.event.c_str(),
                        input.gameplay_admitted ? "yes" : "no", input.gameplay_block_reason.c_str(),
                        input.world_evaluated ? "evaluated" : "not-evaluated", record.repeat_count);
                } else {
                    ImGui::TextWrapped(
                        "[%llu] [%s] %s", static_cast<unsigned long long>(record.sequence),
                        devtools::trace_record_kind_name(record.kind), record.detail.c_str());
                }
            }
            ImGui::EndChild();
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

} // namespace noveltea
