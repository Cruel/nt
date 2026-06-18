#include "noveltea/ui_debug.hpp"

#include <imgui.h>
#include <imgui_impl_sdl3.h>

#include <SDL3/SDL.h>

#include <cstdarg>
#include <cstdio>
#include <cstring>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#endif

#ifdef NOVELTEA_HAS_BGFX
#include "devtools/imgui_bgfx.hpp"
#include <bgfx/bgfx.h>
#endif

#if defined(__EMSCRIPTEN__)
extern "C" {
extern void noveltea_web_sync_persistent_fs();
}
#endif

namespace noveltea {
namespace {

ImVec2 debug_overlay_default_pos() {
  return ImGui::GetMainViewport()->WorkPos;
}

} // namespace

DebugUI::DebugUI() = default;
DebugUI::~DebugUI() { shutdown(); }

bool DebugUI::initialize(SDL_Window *window, const assets::AssetManager* assets) {
  if (m_initialized)
    return true;
  m_assets = assets;

  IMGUI_CHECKVERSION();
  ImGui::CreateContext();
  ImGuiIO &io = ImGui::GetIO();
  io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;

#if defined(SDL_PLATFORM_ANDROID)
  char *pref_path = SDL_GetPrefPath("Cruel", "NovelTea");
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
  ImGuiStyle &style = ImGui::GetStyle();
  style.ScaleAllSizes(android_ui_scale);
  style.FontScaleDpi = android_ui_scale;
#endif

  if (!ImGui_ImplSDL3_InitForOther(window)) {
    SDL_Log("[debug_ui] ImGui_ImplSDL3_InitForOther failed");
    ImGui::DestroyContext();
    return false;
  }

#ifdef NOVELTEA_HAS_BGFX
  {
    auto *backend = new ImGuiBgfxRenderer();
    if (m_assets && backend->initialize(*m_assets)) {
      m_bgfx_backend = backend;
      SDL_Log("[debug_ui] ImGui bgfx renderer initialized");
    } else {
      SDL_Log("[debug_ui] ImGui bgfx renderer init failed; running without "
              "rendering");
      delete backend;
    }
  }
#else
  io.Fonts->Build();
  SDL_Log("[debug_ui] ImGui initialized (input only - no bgfx renderer)");
#endif

  m_initialized = true;
  return true;
}

void DebugUI::process_event(const SDL_Event &event) {
  if (!m_initialized)
    return;
  ImGui_ImplSDL3_ProcessEvent(&event);
}

void DebugUI::begin_frame(const SurfaceMetrics& surface) {
  if (!m_initialized)
    return;
  ImGui_ImplSDL3_NewFrame();
  ImGuiIO &io = ImGui::GetIO();
  const SurfaceMetrics s = sanitize_surface_metrics(surface);
  if (s.logical_width > 0 && s.logical_height > 0) {
    io.DisplaySize =
        ImVec2(static_cast<float>(s.logical_width), static_cast<float>(s.logical_height));
    io.DisplayFramebufferScale = ImVec2(s.scale_x, s.scale_y);
  }
  ImGui::NewFrame();
}

void DebugUI::end_frame() {
  if (!m_initialized)
    return;

  if (m_visible) {
    ImGui::SetNextWindowPos(debug_overlay_default_pos(), ImGuiCond_FirstUseEver);
    ImGui::Begin("Debug Overlay");

    const ImGuiIO &io = ImGui::GetIO();
    ImGui::Text("FPS: %.1f", io.Framerate);
    ImGui::Text("Frame time: %.3f ms", 1000.0f / io.Framerate);
    ImGui::Separator();

    ImGui::Text("Renderer: %s",
#ifdef NOVELTEA_HAS_BGFX
                bgfx::getRendererName(bgfx::getRendererType())
#else
                "(stub)"
#endif
    );
    ImGui::Text("Viewport: %.0f x %.0f", io.DisplaySize.x, io.DisplaySize.y);
    ImGui::Text("Backend: %s", "SDL3");
    ImGui::Text("Triangle smoke test: running on view 0");
    ImGui::Separator();

    if (m_log_len > 0) {
      m_log_buffer[m_log_len] = '\0';
      ImGui::TextUnformatted(m_log_buffer);
    }

    ImGui::End();
  }

  ImGui::Render();

#if defined(__EMSCRIPTEN__)
  ImGuiIO &web_io = ImGui::GetIO();
  m_web_ini_sync_timer += web_io.DeltaTime;
  if (m_web_ini_sync_timer >= 2.0f && web_io.IniFilename) {
    m_web_ini_sync_timer = 0.0f;
    ImGui::SaveIniSettingsToDisk(web_io.IniFilename);
    web_io.WantSaveIniSettings = false;
    noveltea_web_sync_persistent_fs();
  }
#endif

#ifdef NOVELTEA_HAS_BGFX
  if (m_bgfx_backend) {
    const ImGuiIO &io = ImGui::GetIO();
    auto *backend = static_cast<ImGuiBgfxRenderer *>(m_bgfx_backend);
    backend->render(ImGui::GetDrawData(), static_cast<int>(io.DisplaySize.x),
                    static_cast<int>(io.DisplaySize.y));
  }
#else
  // Without bgfx, ImGui draw data is not rendered.
#endif
}

void DebugUI::shutdown() {
  if (!m_initialized)
    return;

#ifdef NOVELTEA_HAS_BGFX
  if (m_bgfx_backend) {
    auto *backend = static_cast<ImGuiBgfxRenderer *>(m_bgfx_backend);
    backend->shutdown();
    delete backend;
    m_bgfx_backend = nullptr;
  }
#endif

  ImGui_ImplSDL3_Shutdown();
  ImGui::DestroyContext();
  m_ini_path.clear();
  m_web_ini_sync_timer = 0.0f;
  m_initialized = false;
  SDL_Log("[debug_ui] ImGui shutdown");
}

void DebugUI::log_printf(const char *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  int n = std::vsnprintf(m_log_buffer + m_log_len,
                         sizeof(m_log_buffer) - m_log_len - 1, fmt, args);
  if (n > 0)
    m_log_len += n;
  if (m_log_len > static_cast<int>(sizeof(m_log_buffer)) - 2) {
    m_log_len = static_cast<int>(sizeof(m_log_buffer)) - 2;
  }
  va_end(args);
}

} // namespace noveltea
