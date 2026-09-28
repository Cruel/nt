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

void apply_debugger_reset_rect()
{
    const ImGuiViewport* viewport = ImGui::GetMainViewport();
    const auto rect = host::debug_ui_reset_rect({viewport->WorkPos.x, viewport->WorkPos.y},
                                                {viewport->WorkSize.x, viewport->WorkSize.y});
    ImGui::SetNextWindowPos(ImVec2(rect.position.x, rect.position.y), ImGuiCond_Always);
    ImGui::SetNextWindowSize(ImVec2(rect.size.x, rect.size.y), ImGuiCond_Always);
}

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
    m_visible = false;
    m_reset_window_rect = false;
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
        if (m_reset_window_rect) {
            apply_debugger_reset_rect();
            m_reset_window_rect = false;
        } else {
            ImGui::SetNextWindowPos(debug_overlay_default_pos(), ImGuiCond_FirstUseEver);
        }
        ImGui::Begin("NovelTea Debugger");

        if (ImGui::CollapsingHeader("Render", ImGuiTreeNodeFlags_DefaultOpen)) {
            const ImGuiIO& io = ImGui::GetIO();
            ImGui::Text("%s | %s | %.1f FPS", snapshot.host.platform.c_str(),
                        snapshot.host.renderer.c_str(), io.Framerate);
            ImGui::Text("Host: %d x %d", snapshot.host.surface.logical_size.width,
                        snapshot.host.surface.logical_size.height);
            bool render_perf_logging = snapshot.tooling.render_perf_logging;
            if (ImGui::Checkbox("Render Perf Logging", &render_perf_logging)) {
                output.commands.emplace_back(
                    host::SetRenderPerfLoggingDebugCommand{render_perf_logging});
            }
        }

        if (ImGui::CollapsingHeader("Runtime", ImGuiTreeNodeFlags_DefaultOpen)) {
            if (snapshot.runtime) {
                if (snapshot.host.host_generation) {
                    ImGui::Text("Loaded | host generation %llu",
                                static_cast<unsigned long long>(*snapshot.host.host_generation));
                } else {
                    ImGui::TextUnformatted("Loaded");
                }
                bool gameplay_paused = snapshot.runtime->publication.gameplay_ui.gameplay_paused;
                if (ImGui::Checkbox("Gameplay Paused", &gameplay_paused)) {
                    output.commands.emplace_back(
                        host::SetGameplayPausedDebugCommand{gameplay_paused});
                }
                ImGui::Text("Observations: %llu | diagnostics: %zu",
                            static_cast<unsigned long long>(
                                snapshot.runtime->publication.observations.values.size()),
                            snapshot.runtime->diagnostics.size());
            } else {
                ImGui::TextUnformatted("Not loaded");
            }
        }

        if (ImGui::CollapsingHeader("Input", ImGuiTreeNodeFlags_DefaultOpen)) {
            ImGui::Text("%s | gameplay %s (%s)", snapshot.input.last_event.c_str(),
                        snapshot.input.gameplay_admitted ? "admitted" : "blocked",
                        snapshot.input.gameplay_block_reason.c_str());
            ImGui::Text("Debug %s%s | RmlUi %s%s",
                        snapshot.input.debug_processed ? "processed" : "skipped",
                        snapshot.input.debug_consumed ? "/consumed" : "",
                        snapshot.input.runtime_ui_processed ? "processed" : "skipped",
                        snapshot.input.runtime_ui_consumed ? "/consumed" : "");
            if (snapshot.input.pointer_valid) {
                ImGui::Text("Pointer: %.1f, %.1f", snapshot.input.reference_pointer.x,
                            snapshot.input.reference_pointer.y);
            }
            if (snapshot.world.hovered || snapshot.world.pressed || snapshot.world.under_pointer) {
                ImGui::Text("World: hover=%s pressed=%s under=%s",
                            snapshot.world.hovered ? snapshot.world.hovered->c_str() : "none",
                            snapshot.world.pressed ? snapshot.world.pressed->c_str() : "none",
                            snapshot.world.under_pointer ? snapshot.world.under_pointer->c_str()
                                                         : "none");
            }
        }

        if (ImGui::CollapsingHeader("RmlUi", ImGuiTreeNodeFlags_DefaultOpen)) {
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
            for (const auto& context : snapshot.rmlui) {
                ImGui::BulletText("%s %dx%d%s", context.name.c_str(), context.width, context.height,
                                  context.mouse_interacting ? " interacting" : "");
            }
        }

        if (ImGui::CollapsingHeader("Console")) {
            if (ImGui::Checkbox("Freeze##console", &m_console_frozen)) {
                if (m_console_frozen)
                    m_frozen_console.assign(console.begin(), console.end());
                else
                    m_frozen_console.clear();
            }
            ImGui::SameLine();
            if (ImGui::Button("Clear##console")) {
                output.clear_console = true;
                if (m_console_frozen)
                    m_frozen_console.clear();
            }
            ImGui::SetNextItemWidth(140.0f);
            ImGui::Combo("Severity##console", &m_console_severity_filter,
                         "All\0Info\0Warning\0Error\0");
            ImGui::InputText("Category##console", m_console_category_filter.data(),
                             m_console_category_filter.size());
            ImGui::InputText("Filter##console", m_console_text_filter.data(),
                             m_console_text_filter.size());
            const std::span<const devtools::ConsoleRecord> visible_console =
                m_console_frozen ? std::span<const devtools::ConsoleRecord>{m_frozen_console}
                                 : console;
            if (visible_console.empty()) {
                ImGui::TextUnformatted("No retained records");
            } else {
                ImGui::BeginChild("Console", ImVec2(0.0f, 180.0f), true);
                for (const auto& record : visible_console) {
                    if (m_console_severity_filter != 0 &&
                        static_cast<int>(record.severity) + 1 != m_console_severity_filter)
                        continue;
                    if (m_console_category_filter[0] != '\0' &&
                        record.category.find(m_console_category_filter.data()) == std::string::npos)
                        continue;
                    if (m_console_text_filter[0] != '\0' &&
                        record.message.find(m_console_text_filter.data()) == std::string::npos)
                        continue;
                    ImGui::TextWrapped(
                        "[%llu] [%.*s] [%s] %s", static_cast<unsigned long long>(record.sequence),
                        static_cast<int>(devtools::console_severity_name(record.severity).size()),
                        devtools::console_severity_name(record.severity).data(),
                        record.category.c_str(), record.message.c_str());
                }
                ImGui::EndChild();
            }
        }

        if (ImGui::CollapsingHeader("Trace")) {
            if (ImGui::Checkbox("Freeze##trace", &m_trace_frozen)) {
                if (m_trace_frozen)
                    m_frozen_trace.assign(trace.begin(), trace.end());
                else
                    m_frozen_trace.clear();
            }
            ImGui::SameLine();
            if (ImGui::Button("Clear##trace")) {
                output.clear_trace = true;
                if (m_trace_frozen)
                    m_frozen_trace.clear();
            }
            ImGui::SetNextItemWidth(160.0f);
            ImGui::Combo("Kind##trace", &m_trace_kind_filter,
                         "All\0Input routing\0Debugger mutation\0Generation\0");
            ImGui::InputText("Category##trace", m_trace_category_filter.data(),
                             m_trace_category_filter.size());
            ImGui::InputText("Filter##trace", m_trace_text_filter.data(),
                             m_trace_text_filter.size());
            if (trace_evicted_record_count > 0) {
                ImGui::Text("History gap: %llu record(s) were evicted from retention",
                            static_cast<unsigned long long>(trace_evicted_record_count));
            }
            const std::span<const devtools::TraceRecord> visible_trace =
                m_trace_frozen ? std::span<const devtools::TraceRecord>{m_frozen_trace} : trace;
            if (visible_trace.empty()) {
                ImGui::TextUnformatted("No retained records");
            } else {
                ImGui::BeginChild("Trace", ImVec2(0.0f, 180.0f), true);
                for (const auto& record : visible_trace) {
                    if (m_trace_kind_filter != 0 &&
                        static_cast<int>(record.kind) + 1 != m_trace_kind_filter)
                        continue;
                    if (m_trace_category_filter[0] != '\0' &&
                        record.category.find(m_trace_category_filter.data()) == std::string::npos)
                        continue;
                    if (m_trace_text_filter[0] != '\0' &&
                        record.detail.find(m_trace_text_filter.data()) == std::string::npos &&
                        (!record.input ||
                         record.input->event.find(m_trace_text_filter.data()) == std::string::npos))
                        continue;
                    if (record.input) {
                        const auto& input = *record.input;
                        ImGui::TextWrapped("[%llu] [%s] %s admitted=%s block=%s world=%s repeat=%u",
                                           static_cast<unsigned long long>(record.sequence),
                                           devtools::trace_record_kind_name(record.kind),
                                           input.event.c_str(),
                                           input.gameplay_admitted ? "yes" : "no",
                                           input.gameplay_block_reason.c_str(),
                                           input.world_evaluated ? "evaluated" : "not-evaluated",
                                           record.repeat_count);
                        if (input.host_x || input.reference_x) {
                            ImGui::TextWrapped(
                                "  coords host=(%.1f, %.1f) reference=(%.1f, %.1f)",
                                input.host_x.value_or(0.0f), input.host_y.value_or(0.0f),
                                input.reference_x.value_or(0.0f), input.reference_y.value_or(0.0f));
                        }
                        if (input.rmlui_hover) {
                            const auto& hover = *input.rmlui_hover;
                            ImGui::TextWrapped("  RmlUi %s %s#%s pointer-events=%s",
                                               hover.context.c_str(), hover.tag.c_str(),
                                               hover.id.c_str(), hover.pointer_events.c_str());
                        }
                        ImGui::TextWrapped(
                            "  layout=%s (%s) hit=%s hovered=%s pressed=%s target=%s",
                            input.governing_layout ? input.governing_layout->c_str() : "none",
                            input.governing_layout_mode.c_str(),
                            input.world_hit ? input.world_hit->c_str() : "none",
                            input.world_hovered ? input.world_hovered->c_str() : "none",
                            input.world_pressed ? input.world_pressed->c_str() : "none",
                            input.world_target ? input.world_target->c_str() : "none");
                    } else {
                        ImGui::TextWrapped(
                            "[%llu] [%s] %s", static_cast<unsigned long long>(record.sequence),
                            devtools::trace_record_kind_name(record.kind), record.detail.c_str());
                    }
                }
                ImGui::EndChild();
            }
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
