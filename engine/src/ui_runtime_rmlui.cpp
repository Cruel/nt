#include "noveltea/ui_runtime.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "script/lua/script_runtime_internal.hpp"

#include <algorithm>
#include <cstdio>
#include <functional>
#include <memory>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <SDL3/SDL.h>

#if defined(NOVELTEA_HAS_RMLUI)
#include <RmlUi/Core.h>
#include <RmlUi/Core/DataModelHandle.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/EventListener.h>
#include <RmlUi/Core/Variant.h>
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
constexpr const char* kRuntimeGameUiDocumentAsset = "project:/rmlui/runtime_game.rml";

std::string escape_rml(std::string_view value)
{
    std::string escaped;
    escaped.reserve(value.size());
    for (const char ch : value) {
        switch (ch) {
        case '&': escaped += "&amp;"; break;
        case '<': escaped += "&lt;"; break;
        case '>': escaped += "&gt;"; break;
        case '"': escaped += "&quot;"; break;
        case '\'': escaped += "&#39;"; break;
        default: escaped.push_back(ch); break;
        }
    }
    return escaped;
}

std::string paragraph_rml(const std::string& text)
{
    std::ostringstream out;
    std::size_t start = 0;
    while (start <= text.size()) {
        const std::size_t end = text.find('\n', start);
        const auto line = text.substr(start, end == std::string::npos ? std::string::npos : end - start);
        if (!line.empty()) {
            out << "<p>" << escape_rml(line) << "</p>";
        }
        if (end == std::string::npos) break;
        start = end + 1;
    }
    return out.str();
}
}

struct RuntimeUI::State {
#if defined(NOVELTEA_HAS_RMLUI)
    struct CallbackListener final : Rml::EventListener {
        explicit CallbackListener(std::function<void()> cb) : callback(std::move(cb)) {}
        void ProcessEvent(Rml::Event&) override { if (callback) callback(); }
        std::function<void()> callback;
    };
    struct RuntimeControllerListener final : Rml::EventListener {
        explicit RuntimeControllerListener(State& owner_state) : owner(owner_state) {}
        void ProcessEvent(Rml::Event& event) override;
        State& owner;
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
    std::unique_ptr<RuntimeControllerListener> runtime_controller_listener;
    core::RuntimeController* runtime_controller = nullptr;
    std::uintptr_t next_listener_id = 1;
    bool rml_initialized = false;
    std::vector<std::string> selected_action_objects;
#endif
    core::RuntimeUIViewAdapter runtime_view;
};

#if defined(NOVELTEA_HAS_RMLUI)
void RuntimeUI::State::RuntimeControllerListener::ProcessEvent(Rml::Event& event)
{
    if (!owner.runtime_controller) return;
    Rml::Element* target = event.GetTargetElement();
    if (!target) return;

    if (target->HasAttribute("nt-option")) {
        const int index = target->GetAttribute<int>("nt-option", -1);
        if (index >= 0) {
            owner.runtime_controller->dialogue_select_option(index);
        }
    } else if (target->HasAttribute("nt-nav")) {
        const int direction = target->GetAttribute<int>("nt-nav", -1);
        if (direction >= 0) {
            owner.runtime_controller->navigate_path(direction);
        }
    } else if (target->HasAttribute("nt-continue")) {
        const auto mode = owner.runtime_controller->current_mode_name();
        if (mode == std::string_view("dialogue")) {
            owner.runtime_controller->dialogue_continue();
        } else if (mode == std::string_view("cutscene")) {
            owner.runtime_controller->cutscene_click();
        }
    } else if (target->HasAttribute("nt-object")) {
        const auto object_id = target->GetAttribute<Rml::String>("nt-object", "");
        if (!object_id.empty()) {
            auto it = std::find(owner.selected_action_objects.begin(), owner.selected_action_objects.end(), object_id);
            if (it == owner.selected_action_objects.end()) {
                owner.selected_action_objects.push_back(object_id);
            } else {
                owner.selected_action_objects.erase(it);
            }
        }
    } else if (target->HasAttribute("nt-action")) {
        const auto verb_id = target->GetAttribute<Rml::String>("nt-action", "");
        if (!verb_id.empty()) {
            owner.runtime_controller->process_action(verb_id, owner.selected_action_objects);
            owner.selected_action_objects.clear();
        }
    }
}
#endif

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

    m_surface = sanitize_surface_metrics(m_surface);
    m_state->render_interface = new ui::rmlui::BgfxRenderInterface(m_surface, *assets);
    if (!*m_state->render_interface) {
        std::fprintf(stderr, "[runtime_ui] bgfx RmlUi renderer failed to initialize\n");
        cleanup_state();
        return false;
    }

    m_state->context = Rml::CreateContext("main", Rml::Vector2i(m_surface.logical_width, m_surface.logical_height), m_state->render_interface);
    if (!m_state->context) {
        std::fprintf(stderr, "[runtime_ui] RmlUi::CreateContext failed\n");
        cleanup_state();
        return false;
    }
    m_state->context->SetDensityIndependentPixelRatio(m_surface.scale_x);

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

    load_document("runtime_game", kRuntimeGameUiDocumentAsset, false);

    std::printf("[runtime_ui] RmlUi initialized logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f\n",
        m_surface.logical_width,
        m_surface.logical_height,
        m_surface.framebuffer_width,
        m_surface.framebuffer_height,
        m_surface.scale_x,
        m_surface.scale_y);
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

void RuntimeUI::resize(const SurfaceMetrics& surface)
{
    m_surface = sanitize_surface_metrics(surface);
#if defined(NOVELTEA_HAS_RMLUI)
    if (m_state && m_state->context) {
        m_state->context->SetDimensions(Rml::Vector2i(m_surface.logical_width, m_surface.logical_height));
        m_state->context->SetDensityIndependentPixelRatio(m_surface.scale_x);
#if defined(NOVELTEA_HAS_BGFX)
        if (m_state->render_interface) {
            m_state->render_interface->resize(m_surface);
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

void RuntimeUI::apply_controller_commands(const std::vector<core::ControllerCommand>& commands)
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (!m_state) return;
    m_state->runtime_view.apply(commands);
    auto* doc = static_cast<Rml::ElementDocument*>(document("runtime_game"));
    if (!doc) return;
    const auto& view = m_state->runtime_view.state();

    if (auto* mode = doc->GetElementById("rt_mode")) {
        mode->SetInnerRML(escape_rml(view.mode));
    }
    if (auto* title = doc->GetElementById("rt_title")) {
        title->SetInnerRML(escape_rml(view.title));
    }
    if (auto* body = doc->GetElementById("rt_body")) {
        const auto body_rml = paragraph_rml(view.body);
        body->SetInnerRML(body_rml.empty() ? "&nbsp;" : body_rml);
    }
    if (auto* note = doc->GetElementById("rt_notification")) {
        note->SetInnerRML(escape_rml(view.notification));
    }
    if (auto* prompt = doc->GetElementById("rt_prompt")) {
        if (view.page_break) {
            prompt->SetInnerRML("<button class=\"continue\" nt-continue=\"1\">Page break</button>");
        } else if (view.awaiting_continue) {
            prompt->SetInnerRML("<button class=\"continue\" nt-continue=\"1\">Continue</button>");
        } else {
            prompt->SetInnerRML("");
        }
    }
    if (auto* options = doc->GetElementById("rt_options")) {
        std::ostringstream out;
        for (std::size_t i = 0; i < view.dialogue_options.size(); ++i) {
            const auto& option = view.dialogue_options[i];
            out << "<button class=\"option";
            if (!option.enabled) out << " disabled";
            out << "\" nt-option=\"" << i << "\"";
            if (!option.enabled) out << " disabled";
            out << ">" << escape_rml(option.text) << "</button>";
        }
        options->SetInnerRML(out.str());
    }
    if (auto* nav = doc->GetElementById("rt_navigation")) {
        std::ostringstream out;
        for (std::size_t i = 0; i < view.navigation.size(); ++i) {
            out << "<button class=\"nav\" nt-nav=\"" << i << "\">" << escape_rml(view.navigation[i]) << "</button>";
        }
        nav->SetInnerRML(out.str());
    }
    if (auto* objects = doc->GetElementById("rt_objects")) {
        std::ostringstream out;
        for (const auto& object : view.objects) {
            out << "<button class=\"object\" nt-object=\"" << escape_rml(object.id) << "\">"
                << escape_rml(object.name);
            if (object.in_inventory && !object.in_room) out << " (inventory)";
            out << "</button>";
        }
        objects->SetInnerRML(out.str());
    }
    if (auto* actions = doc->GetElementById("rt_actions")) {
        std::ostringstream out;
        for (const auto& action : view.actions) {
            out << "<button class=\"action\" nt-action=\"" << escape_rml(action.verb_id) << "\">"
                << escape_rml(action.label);
            if (action.object_count > 0) out << " (" << action.object_count << ")";
            out << "</button>";
        }
        actions->SetInnerRML(out.str());
    }
    if (auto* log = doc->GetElementById("rt_log")) {
        std::ostringstream out;
        for (const auto& line : view.text_log) {
            out << "<p>" << escape_rml(line) << "</p>";
        }
        log->SetInnerRML(out.str());
    }

    doc->Show();
#else
    (void)commands;
#endif
}

const core::RuntimeUIViewState& RuntimeUI::runtime_view_state() const
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (m_state) return m_state->runtime_view.state();
#endif
    static const core::RuntimeUIViewState empty;
    return empty;
}

void RuntimeUI::bind_runtime_controller(core::RuntimeController* controller)
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (!m_state) return;
    m_state->runtime_controller = controller;
    auto* doc = static_cast<Rml::ElementDocument*>(document("runtime_game"));
    if (!doc) return;
    if (!m_state->runtime_controller_listener) {
        m_state->runtime_controller_listener = std::make_unique<State::RuntimeControllerListener>(*m_state);
        doc->AddEventListener("click", m_state->runtime_controller_listener.get());
    }
#else
    (void)controller;
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
