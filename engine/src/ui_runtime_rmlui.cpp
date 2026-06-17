#include "noveltea/ui_runtime.hpp"

#include "noveltea/assets/asset_manager.hpp"

#include <cstdio>

#include <SDL3/SDL.h>

#if defined(NOVELTEA_HAS_RMLUI)
#include <RmlUi/Core.h>
#include "ui/rmlui/rmlui_file_interface.hpp"
#include "ui/rmlui/rmlui_input_sdl3.hpp"
#include "ui/rmlui/rmlui_system_interface_sdl3.hpp"
#endif

#if defined(NOVELTEA_HAS_RMLUI) && defined(NOVELTEA_HAS_BGFX)
#include "ui/rmlui/rmlui_render_interface_bgfx.hpp"
#endif

namespace noveltea {

namespace {
constexpr const char* kRuntimeUiFontAsset = "project:/rmlui/LiberationSans.ttf";
constexpr const char* kRuntimeUiDocumentAsset = "project:/rmlui/demo.rml";
}

struct RuntimeUI::State {
#if defined(NOVELTEA_HAS_RMLUI)
    Rml::Context* context = nullptr;
    Rml::ElementDocument* demo_document = nullptr;
    ui::rmlui::AssetRmlFileInterface* file_interface = nullptr;
    ui::rmlui::SdlSystemInterface* system_interface = nullptr;
#if defined(NOVELTEA_HAS_BGFX)
    ui::rmlui::BgfxRenderInterface* render_interface = nullptr;
#endif
#endif
};

RuntimeUI::RuntimeUI() = default;
RuntimeUI::~RuntimeUI() { shutdown(); }

bool RuntimeUI::initialize(const assets::AssetManager* assets)
{
    if (m_initialized) return true;

#if defined(NOVELTEA_HAS_RMLUI) && defined(NOVELTEA_HAS_BGFX)
    if (!assets) {
        std::fprintf(stderr, "[runtime_ui] no AssetManager for RmlUi\n");
        return false;
    }

    m_state = new State;
    m_state->file_interface = new ui::rmlui::AssetRmlFileInterface(*assets);
    m_state->system_interface = new ui::rmlui::SdlSystemInterface;
    Rml::SetFileInterface(m_state->file_interface);
    Rml::SetSystemInterface(m_state->system_interface);

    if (!Rml::Initialise()) {
        std::fprintf(stderr, "[runtime_ui] RmlUi::Initialise() failed\n");
        delete m_state->system_interface;
        delete m_state->file_interface;
        delete m_state;
        m_state = nullptr;
        return false;
    }

    m_state->render_interface = new ui::rmlui::BgfxRenderInterface(m_width, m_height, *assets);
    if (!*m_state->render_interface) {
        std::fprintf(stderr, "[runtime_ui] bgfx RmlUi renderer failed to initialize\n");
    }

    m_state->context = Rml::CreateContext("main", Rml::Vector2i(m_width, m_height), m_state->render_interface);
    if (!m_state->context) {
        std::fprintf(stderr, "[runtime_ui] RmlUi::CreateContext failed\n");
        Rml::Shutdown();
        delete m_state->render_interface;
        delete m_state->system_interface;
        delete m_state->file_interface;
        delete m_state;
        m_state = nullptr;
        return false;
    }

    if (!Rml::LoadFontFace(kRuntimeUiFontAsset, true)) {
        std::fprintf(stderr, "[runtime_ui] failed to load font: %s\n", kRuntimeUiFontAsset);
    }

    m_state->demo_document = m_state->context->LoadDocument(kRuntimeUiDocumentAsset);
    if (m_state->demo_document) {
        m_state->demo_document->Show();
        std::printf("[runtime_ui] demo document loaded\n");
    } else {
        std::fprintf(stderr, "[runtime_ui] failed to load demo document\n");
    }

    std::printf("[runtime_ui] RmlUi initialized (%dx%d)\n", m_width, m_height);
#elif defined(NOVELTEA_HAS_RMLUI)
    std::fprintf(stderr, "[runtime_ui] RmlUi enabled but bgfx backend unavailable\n");
    return false;
#else
    std::printf("[runtime_ui] RmlUi disabled for this target\n");
#endif

    m_initialized = true;
    return true;
}

bool RuntimeUI::process_event(const SDL_Event& event)
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (m_state && m_state->context) {
        return ui::rmlui::process_sdl_event(*m_state->context, event);
    }
#else
    (void)event;
#endif
    return false;
}

void RuntimeUI::resize(int width, int height)
{
    m_width = width;
    m_height = height;
#if defined(NOVELTEA_HAS_RMLUI)
    if (m_state && m_state->context) {
        m_state->context->SetDimensions(Rml::Vector2i(width, height));
#if defined(NOVELTEA_HAS_BGFX)
        if (m_state->render_interface) {
            m_state->render_interface->resize(width, height);
        }
#endif
    }
#endif
}

void RuntimeUI::begin_frame(float delta_time)
{
    (void)delta_time;
#if defined(NOVELTEA_HAS_RMLUI)
    if (m_state && m_state->context) {
#if defined(NOVELTEA_HAS_BGFX)
        if (m_state->render_interface) m_state->render_interface->begin_frame();
#endif
        m_state->context->Update();
    }
#endif
}

void RuntimeUI::end_frame()
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (m_state && m_state->context) {
        m_state->context->Render();
#if defined(NOVELTEA_HAS_BGFX)
        if (m_state->render_interface) m_state->render_interface->end_frame();
#endif
    }
#endif
}

void RuntimeUI::shutdown()
{
    if (!m_initialized) return;
#if defined(NOVELTEA_HAS_RMLUI)
    if (m_state) {
        if (m_state->context) {
            m_state->context->UnloadAllDocuments();
            Rml::RemoveContext("main");
            m_state->context = nullptr;
        }
        Rml::Shutdown();
#if defined(NOVELTEA_HAS_BGFX)
        delete m_state->render_interface;
#endif
        delete m_state->system_interface;
        delete m_state->file_interface;
        delete m_state;
        m_state = nullptr;
    }
#endif
    m_initialized = false;
}

const char* RuntimeUI::backend_name() const
{
#if defined(NOVELTEA_HAS_RMLUI) && defined(NOVELTEA_HAS_BGFX)
    return "RmlUi (bgfx)";
#elif defined(NOVELTEA_HAS_RMLUI)
    return "RmlUi (no renderer)";
#else
    return "RmlUi disabled";
#endif
}

const char* RuntimeUI::status_text() const
{
#if defined(NOVELTEA_HAS_RMLUI)
    return (m_state && m_state->context) ? "rendering" : "no context";
#else
    return "disabled";
#endif
}

bool RuntimeUI::wants_input() const
{
#if defined(NOVELTEA_HAS_RMLUI)
    return m_state && m_state->context && (m_state->context->GetHoverElement() || m_state->context->GetFocusElement());
#else
    return false;
#endif
}

} // namespace noveltea
