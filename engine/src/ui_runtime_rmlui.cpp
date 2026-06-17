#include "noveltea/ui_runtime.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "script/lua/script_runtime_internal.hpp"

#include <cstdio>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>

#include <SDL3/SDL.h>

#if defined(NOVELTEA_HAS_RMLUI)
#include <RmlUi/Core.h>
#include <RmlUi/Core/DataModelHandle.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/EventListener.h>
#if defined(NOVELTEA_HAS_RMLUI_LUA)
#include <RmlUi/Lua.h>
#endif
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
    struct CallbackListener final : Rml::EventListener {
        explicit CallbackListener(std::function<void()> cb) : callback(std::move(cb)) {}
        void ProcessEvent(Rml::Event&) override { if (callback) callback(); }
        std::function<void()> callback;
    };
    struct ListenerRecord {
        Rml::Element* element = nullptr;
        std::string event;
        std::unique_ptr<CallbackListener> listener;
    };
    Rml::Context* context = nullptr;
    Rml::ElementDocument* demo_document = nullptr;
    SDL_Window* window = nullptr;
    ui::rmlui::AssetRmlFileInterface* file_interface = nullptr;
    ui::rmlui::SdlSystemInterface* system_interface = nullptr;
#if defined(NOVELTEA_HAS_BGFX)
    ui::rmlui::BgfxRenderInterface* render_interface = nullptr;
#endif
    std::unordered_map<std::string, Rml::ElementDocument*> documents;
    std::unordered_map<std::uintptr_t, ListenerRecord> listeners;
    std::unordered_map<std::string, std::unique_ptr<Rml::DataModelConstructor>> data_models;
    std::uintptr_t next_listener_id = 1;
    bool rml_initialized = false;
#endif
};

RuntimeUI::RuntimeUI() = default;
RuntimeUI::~RuntimeUI() { shutdown(); }

void RuntimeUI::cleanup_state()
{
    if (!m_state) return;
    if (m_state->context) {
        m_state->context->UnloadAllDocuments();
        Rml::RemoveContext("main");
        m_state->context = nullptr;
    }
    m_state->documents.clear();
    m_state->listeners.clear();
    m_state->data_models.clear();
    if (m_state->rml_initialized) {
        Rml::Shutdown();
        m_state->rml_initialized = false;
    }
#if defined(NOVELTEA_HAS_BGFX)
    delete m_state->render_interface;
    m_state->render_interface = nullptr;
#endif
    Rml::SetSystemInterface(nullptr);
    Rml::SetFileInterface(nullptr);
    delete m_state->system_interface;
    m_state->system_interface = nullptr;
    delete m_state->file_interface;
    m_state->file_interface = nullptr;
    delete m_state;
    m_state = nullptr;
}

bool RuntimeUI::initialize(
    const assets::AssetManager* assets,
    SDL_Window* window,
    bool load_demo_document,
    script::ScriptRuntime* scripts)
{
    if (m_initialized) return true;

#if defined(NOVELTEA_HAS_RMLUI) && defined(NOVELTEA_HAS_BGFX)
    if (!assets) {
        std::fprintf(stderr, "[runtime_ui] no AssetManager for RmlUi\n");
        return false;
    }

    m_state = new State;
    m_state->window = window;
    m_state->file_interface = new ui::rmlui::AssetRmlFileInterface(*assets);
    m_state->system_interface = new ui::rmlui::SdlSystemInterface(window);
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
    m_state->rml_initialized = true;

#if defined(NOVELTEA_HAS_RMLUI_LUA)
    if (!scripts || !scripts->is_initialized() || !script::detail::ScriptRuntimeAccess::state(*scripts)) {
        std::fprintf(stderr, "[runtime_ui] RmlUi Lua requested but ScriptRuntime is unavailable\n");
        cleanup_state();
        return false;
    }
    Rml::Lua::Initialise(script::detail::ScriptRuntimeAccess::state(*scripts));
    script::install_host_print(script::detail::ScriptRuntimeAccess::state(*scripts));
#else
    (void)scripts;
#endif

    m_state->render_interface = new ui::rmlui::BgfxRenderInterface(m_width, m_height, *assets);
    if (!*m_state->render_interface) {
        std::fprintf(stderr, "[runtime_ui] bgfx RmlUi renderer failed to initialize\n");
        cleanup_state();
        return false;
    }

    m_state->context = Rml::CreateContext("main", Rml::Vector2i(m_width, m_height), m_state->render_interface);
    if (!m_state->context) {
        std::fprintf(stderr, "[runtime_ui] RmlUi::CreateContext failed\n");
        cleanup_state();
        return false;
    }
    if (window) {
        int drawable_width = 0;
        int drawable_height = 0;
        if (SDL_GetWindowSizeInPixels(window, &drawable_width, &drawable_height) && drawable_width > 0 && drawable_height > 0) {
            m_width = drawable_width;
            m_height = drawable_height;
            m_state->context->SetDimensions({drawable_width, drawable_height});
            m_state->render_interface->resize(drawable_width, drawable_height);
        }
        m_state->context->SetDensityIndependentPixelRatio(SDL_GetWindowDisplayScale(window));
    }

    if (!Rml::LoadFontFace(kRuntimeUiFontAsset, true)) {
        std::fprintf(stderr, "[runtime_ui] failed to load font: %s\n", kRuntimeUiFontAsset);
    }

    if (load_demo_document) {
        m_state->demo_document = m_state->context->LoadDocument(kRuntimeUiDocumentAsset);
        if (m_state->demo_document) {
            m_state->documents["demo"] = m_state->demo_document;
            m_state->demo_document->Show();
            std::printf("[runtime_ui] demo document loaded\n");
        } else {
            std::fprintf(stderr, "[runtime_ui] failed to load demo document\n");
        }
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
    m_last_event_consumed = false;
#if defined(NOVELTEA_HAS_RMLUI)
    if (m_state && m_state->context) {
        m_last_event_consumed = ui::rmlui::process_sdl_event(*m_state->context, m_state->window, event);
        return m_last_event_consumed;
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
        cleanup_state();
    }
#endif
    m_initialized = false;
}

bool RuntimeUI::load_document(const std::string& id, const std::string& path, bool show)
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (!m_state || !m_state->context || id.empty()) return false;
    unload_document(id);
    Rml::ElementDocument* doc = m_state->context->LoadDocument(path);
    if (!doc) return false;
    m_state->documents[id] = doc;
    if (show) doc->Show();
    return true;
#else
    (void)id; (void)path; (void)show;
    return false;
#endif
}

bool RuntimeUI::unload_document(const std::string& id)
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (!m_state || id.empty()) return false;
    auto it = m_state->documents.find(id);
    if (it == m_state->documents.end()) return false;
    for (auto listener = m_state->listeners.begin(); listener != m_state->listeners.end();) {
        if (listener->second.element && listener->second.element->GetOwnerDocument() == it->second) {
            listener->second.element->RemoveEventListener(listener->second.event, listener->second.listener.get());
            listener = m_state->listeners.erase(listener);
        } else {
            ++listener;
        }
    }
    it->second->Close();
    if (it->second == m_state->demo_document) m_state->demo_document = nullptr;
    m_state->documents.erase(it);
    return true;
#else
    (void)id;
    return false;
#endif
}

bool RuntimeUI::show_document(const std::string& id)
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (auto* doc = static_cast<Rml::ElementDocument*>(document(id))) {
        doc->Show();
        return true;
    }
#else
    (void)id;
#endif
    return false;
}

bool RuntimeUI::hide_document(const std::string& id)
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (auto* doc = static_cast<Rml::ElementDocument*>(document(id))) {
        doc->Hide();
        return true;
    }
#else
    (void)id;
#endif
    return false;
}

void* RuntimeUI::document(const std::string& id) const
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (!m_state) return nullptr;
    auto it = m_state->documents.find(id);
    return it == m_state->documents.end() ? nullptr : it->second;
#else
    (void)id;
    return nullptr;
#endif
}

void* RuntimeUI::element(const std::string& document_id, const std::string& element_id) const
{
#if defined(NOVELTEA_HAS_RMLUI)
    auto* doc = static_cast<Rml::ElementDocument*>(document(document_id));
    return doc ? doc->GetElementById(element_id) : nullptr;
#else
    (void)document_id; (void)element_id;
    return nullptr;
#endif
}

bool RuntimeUI::reload_documents_and_styles()
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (!m_state || !m_state->context) return false;
    m_state->listeners.clear();
    m_state->context->UnloadAllDocuments();
    m_state->documents.clear();
    m_state->demo_document = nullptr;
    return load_document("demo", kRuntimeUiDocumentAsset, true);
#else
    return false;
#endif
}

void RuntimeUI::set_density(float density)
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (m_state && m_state->context) {
        m_state->context->SetDensityIndependentPixelRatio(density);
    }
#else
    (void)density;
#endif
}

std::uintptr_t RuntimeUI::add_event_listener(
    const std::string& document_id,
    const std::string& element_id,
    const std::string& event,
    std::function<void()> callback)
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (!m_state || event.empty() || !callback) return 0;
    Rml::Element* target = nullptr;
    if (element_id.empty()) {
        target = static_cast<Rml::ElementDocument*>(document(document_id));
    } else {
        target = static_cast<Rml::Element*>(element(document_id, element_id));
    }
    if (!target) return 0;
    auto listener = std::make_unique<State::CallbackListener>(std::move(callback));
    const std::uintptr_t id = m_state->next_listener_id++;
    target->AddEventListener(event, listener.get());
    m_state->listeners.emplace(id, State::ListenerRecord{target, event, std::move(listener)});
    return id;
#else
    (void)document_id; (void)element_id; (void)event; (void)callback;
    return 0;
#endif
}

bool RuntimeUI::remove_event_listener(std::uintptr_t listener_id)
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (!m_state) return false;
    auto it = m_state->listeners.find(listener_id);
    if (it == m_state->listeners.end()) return false;
    if (it->second.element) {
        it->second.element->RemoveEventListener(it->second.event, it->second.listener.get());
    }
    m_state->listeners.erase(it);
    return true;
#else
    (void)listener_id;
    return false;
#endif
}

void* RuntimeUI::create_data_model(const std::string& name)
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (!m_state || !m_state->context || name.empty()) return nullptr;
    auto model = std::make_unique<Rml::DataModelConstructor>(m_state->context->CreateDataModel(name));
    void* result = model.get();
    m_state->data_models[name] = std::move(model);
    return result;
#else
    (void)name;
    return nullptr;
#endif
}

void* RuntimeUI::data_model(const std::string& name) const
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (!m_state) return nullptr;
    auto it = m_state->data_models.find(name);
    return it == m_state->data_models.end() ? nullptr : it->second.get();
#else
    (void)name;
    return nullptr;
#endif
}

bool RuntimeUI::remove_data_model(const std::string& name)
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (!m_state || !m_state->context) return false;
    const bool removed = m_state->context->RemoveDataModel(name);
    m_state->data_models.erase(name);
    return removed;
#else
    (void)name;
    return false;
#endif
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
    return wants_pointer_input() || wants_keyboard_input();
}

bool RuntimeUI::wants_pointer_input() const
{
#if defined(NOVELTEA_HAS_RMLUI)
    return m_state && m_state->context && m_state->context->IsMouseInteracting();
#else
    return false;
#endif
}

bool RuntimeUI::wants_keyboard_input() const
{
#if defined(NOVELTEA_HAS_RMLUI)
    return m_state && m_state->context && m_state->context->GetFocusElement();
#else
    return false;
#endif
}

} // namespace noveltea
