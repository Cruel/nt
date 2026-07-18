#include "ui/rmlui/rmlui_document_registry.hpp"

#include "noveltea/runtime_layout_manager.hpp"
#include "ui/rmlui/rmlui_file_interface.hpp"
#include "ui/rmlui/rmlui_host.hpp"

#include <algorithm>
#include <cstdio>
#include <utility>

#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/EventListener.h>

namespace noveltea::ui::rmlui {
namespace {

constexpr char kRuntimeTitleDocumentAsset[] = "system:/ui/title/default-title.rml";
constexpr char kRuntimePauseMenuDocumentAsset[] = "system:/ui/menu/pause-menu.rml";
constexpr char kRuntimeSaveMenuDocumentAsset[] = "system:/ui/menu/save-menu.rml";
constexpr char kRuntimeLoadMenuDocumentAsset[] = "system:/ui/menu/load-menu.rml";
constexpr char kRuntimeSettingsMenuDocumentAsset[] = "system:/ui/menu/settings-menu.rml";
constexpr char kRuntimeTextLogDocumentAsset[] = "system:/ui/menu/text-log.rml";
constexpr char kRuntimeModalDocumentAsset[] = "system:/ui/menu/modal.rml";

struct BuiltinDescriptor {
    const char* id = nullptr;
    const char* path = nullptr;
};

BuiltinDescriptor builtin_descriptor(RuntimeLayoutBuiltinDocument document) noexcept
{
    switch (document) {
    case RuntimeLayoutBuiltinDocument::Title:
        return {kRuntimeTitleDocumentId, kRuntimeTitleDocumentAsset};
    case RuntimeLayoutBuiltinDocument::GameHud:
        return {kRuntimeGameDocumentId, nullptr};
    case RuntimeLayoutBuiltinDocument::PauseMenu:
        return {kRuntimePauseMenuDocumentId, kRuntimePauseMenuDocumentAsset};
    case RuntimeLayoutBuiltinDocument::SaveMenu:
        return {kRuntimeSaveMenuDocumentId, kRuntimeSaveMenuDocumentAsset};
    case RuntimeLayoutBuiltinDocument::LoadMenu:
        return {kRuntimeLoadMenuDocumentId, kRuntimeLoadMenuDocumentAsset};
    case RuntimeLayoutBuiltinDocument::SettingsMenu:
        return {kRuntimeSettingsMenuDocumentId, kRuntimeSettingsMenuDocumentAsset};
    case RuntimeLayoutBuiltinDocument::TextLog:
        return {kRuntimeTextLogDocumentId, kRuntimeTextLogDocumentAsset};
    case RuntimeLayoutBuiltinDocument::Modal:
        return {kRuntimeModalDocumentId, kRuntimeModalDocumentAsset};
    case RuntimeLayoutBuiltinDocument::None:
        return {};
    }
    return {};
}

} // namespace

class RmlUiDocumentRegistry::CallbackListener final : public Rml::EventListener {
public:
    explicit CallbackListener(std::function<void()> callback) : m_callback(std::move(callback)) {}

    void ProcessEvent(Rml::Event&) override
    {
        if (m_callback)
            m_callback();
    }

private:
    std::function<void()> m_callback;
};

RmlUiDocumentRegistry::RmlUiDocumentRegistry(RmlUiHost& host) : m_host(host) {}

RmlUiDocumentRegistry::~RmlUiDocumentRegistry() { clear(); }

RmlUiDocumentRegistry::ContextKey RmlUiDocumentRegistry::default_context_key() noexcept
{
    return {core::PresentationPlane::GameUi, 0, core::LayoutClockDomain::Gameplay,
            core::LayoutInputMode::Normal, core::MountedLayoutOwner::Gameplay};
}

std::string_view
RmlUiDocumentRegistry::builtin_document_id(RuntimeLayoutBuiltinDocument document) noexcept
{
    const auto descriptor = builtin_descriptor(document);
    return descriptor.id ? std::string_view(descriptor.id) : std::string_view{};
}

void RmlUiDocumentRegistry::set_runtime_input_listener(Rml::EventListener* listener) noexcept
{
    if (m_runtime_input_listener == listener)
        return;
    for (auto& [id, record] : m_documents) {
        (void)id;
        detach_runtime_input(record);
    }
    m_runtime_input_listener = listener;
    for (auto& [id, record] : m_documents) {
        (void)id;
        attach_runtime_input(record);
    }
}

bool RmlUiDocumentRegistry::load_path(const std::string& id, const std::string& path, bool show,
                                      ContextKey context, bool runtime_input)
{
    if (id.empty() || path.empty())
        return false;
    return replace(id, DocumentSource{path, std::nullopt}, show, context, runtime_input);
}

bool RmlUiDocumentRegistry::load_memory(const std::string& id, const std::string& rml,
                                        const std::string& source_url, bool show,
                                        ContextKey context, bool runtime_input)
{
    if (id.empty() || rml.empty() || source_url.empty())
        return false;
    return replace(id, DocumentSource{source_url, rml}, show, context, runtime_input);
}

bool RmlUiDocumentRegistry::load_builtin(RuntimeLayoutBuiltinDocument document,
                                         const std::string& runtime_document_path, bool show,
                                         ContextKey context)
{
    const auto descriptor = builtin_descriptor(document);
    if (!descriptor.id)
        return false;
    const std::string path = descriptor.path ? descriptor.path : runtime_document_path;
    const bool loaded = load_path(descriptor.id, path, show, context, true);
    const char* kind =
        document == RuntimeLayoutBuiltinDocument::Title
            ? "title document"
            : (document == RuntimeLayoutBuiltinDocument::GameHud ? "runtime document"
                                                                 : "system document");
    if (loaded)
        std::printf("[runtime_ui] loaded %s: %s\n", kind, path.c_str());
    else
        std::fprintf(stderr, "[runtime_ui] failed to load %s: %s\n", kind, path.c_str());
    return loaded;
}

Rml::ElementDocument* RmlUiDocumentRegistry::instantiate(const DocumentSource& source,
                                                         ContextKey context) const
{
    auto* target = m_host.context_for(context);
    if (!target)
        return nullptr;
    return source.memory_rml ? target->LoadDocumentFromMemory(*source.memory_rml, source.path)
                             : target->LoadDocument(source.path);
}

bool RmlUiDocumentRegistry::replace(const std::string& id, DocumentSource source, bool show,
                                    ContextKey context, bool runtime_input)
{
    auto* replacement = instantiate(source, context);
    if (!replacement)
        return false;
    replacement->Hide();

    if (auto found = m_documents.find(id); found != m_documents.end()) {
        detach_custom_listeners(id, true);
        retire(found->second);
    }

    auto& record = m_documents[id];
    record.document = replacement;
    record.source = std::move(source);
    record.context = context;
    record.runtime_input = runtime_input;
    remember_order(id);
    attach_runtime_input(record);
    if (show)
        replacement->Show();
    return true;
}

bool RmlUiDocumentRegistry::recreate_in_context(const std::string& id, ContextKey context)
{
    auto found = m_documents.find(id);
    if (found == m_documents.end() || !found->second.document)
        return false;
    if (found->second.context == context)
        return true;

    auto* replacement = instantiate(found->second.source, context);
    if (!replacement)
        return false;
    replacement->Hide();

    std::vector<std::pair<ListenerRecord*, Rml::Element*>> rebound;
    for (auto& [listener_id, listener] : m_listeners) {
        (void)listener_id;
        if (listener.document_id != id)
            continue;
        auto* target = listener.element_id.empty()
                           ? static_cast<Rml::Element*>(replacement)
                           : replacement->GetElementById(listener.element_id);
        if (!target) {
            replacement->Close();
            return false;
        }
        rebound.emplace_back(&listener, target);
    }

    const bool visible = found->second.document->IsVisible();
    std::string focused_element_id;
    if (auto* current_context = document_context(id)) {
        if (auto* focused = current_context->GetFocusElement();
            focused && focused->GetOwnerDocument() == found->second.document) {
            focused_element_id = focused->GetId();
        }
    }

    detach_custom_listeners(id, false);
    retire(found->second);
    found->second.document = replacement;
    found->second.context = context;
    attach_runtime_input(found->second);
    for (auto& [listener, target] : rebound) {
        target->AddEventListener(listener->event, listener->listener.get());
        listener->element = target;
    }
    if (visible)
        replacement->Show(Rml::ModalFlag::None, Rml::FocusFlag::Keep);
    if (!focused_element_id.empty()) {
        if (auto* focused = replacement->GetElementById(focused_element_id))
            focused->Focus();
    }
    restore_order();
    m_host.sort_contexts();
    return true;
}

bool RmlUiDocumentRegistry::reload_all()
{
    if (m_host.contexts().empty())
        return false;

    struct ReloadState {
        bool visible = false;
        std::string focused_element_id;
    };

    const auto order = recreation_order();
    std::unordered_map<std::string, ReloadState> state;
    state.reserve(m_documents.size());
    for (const auto& id : order) {
        auto found = m_documents.find(id);
        if (found == m_documents.end() || !found->second.document)
            continue;
        auto& reload = state[id];
        reload.visible = found->second.document->IsVisible();
        if (auto* context = document_context(id)) {
            if (auto* focused = context->GetFocusElement();
                focused && focused->GetOwnerDocument() == found->second.document) {
                reload.focused_element_id = focused->GetId();
            }
        }
    }

    for (auto& [listener_id, listener] : m_listeners) {
        (void)listener_id;
        if (listener.element)
            listener.element->RemoveEventListener(listener.event, listener.listener.get());
        listener.element = nullptr;
    }
    for (auto& [id, record] : m_documents) {
        (void)id;
        detach_runtime_input(record);
    }
    for (auto& context : m_host.contexts())
        context.context->UnloadAllDocuments();
    for (auto& [id, record] : m_documents) {
        (void)id;
        record.document = nullptr;
    }

    bool ok = true;
    for (const auto& id : order) {
        auto found = m_documents.find(id);
        if (found == m_documents.end())
            continue;
        found->second.document = instantiate(found->second.source, found->second.context);
        if (!found->second.document) {
            ok = false;
            continue;
        }
        found->second.document->Hide();
        attach_runtime_input(found->second);
        if (const auto saved = state.find(id); saved != state.end() && saved->second.visible)
            found->second.document->Show(Rml::ModalFlag::None, Rml::FocusFlag::Keep);
    }

    for (auto& [listener_id, listener] : m_listeners) {
        (void)listener_id;
        auto* target = listener.element_id.empty()
                           ? static_cast<Rml::Element*>(document(listener.document_id))
                           : element(listener.document_id, listener.element_id);
        if (!target) {
            ok = false;
            continue;
        }
        target->AddEventListener(listener.event, listener.listener.get());
        listener.element = target;
    }

    for (const auto& [id, saved] : state) {
        if (saved.focused_element_id.empty())
            continue;
        if (auto* focused = element(id, saved.focused_element_id))
            focused->Focus();
    }
    restore_order();
    m_host.sort_contexts();
    return ok;
}

bool RmlUiDocumentRegistry::unload(const std::string& id)
{
    auto found = m_documents.find(id);
    if (found == m_documents.end())
        return false;
    detach_custom_listeners(id, true);
    retire(found->second);
    m_documents.erase(found);
    std::erase(m_ordered_document_ids, id);
    return true;
}

void RmlUiDocumentRegistry::clear()
{
    for (auto& [listener_id, listener] : m_listeners) {
        (void)listener_id;
        if (listener.element)
            listener.element->RemoveEventListener(listener.event, listener.listener.get());
    }
    m_listeners.clear();
    for (auto& [id, record] : m_documents) {
        (void)id;
        retire(record);
    }
    m_documents.clear();
    m_ordered_document_ids.clear();
}

bool RmlUiDocumentRegistry::show(const std::string& id)
{
    auto* value = document(id);
    if (!value)
        return false;
    value->Show();
    return true;
}

bool RmlUiDocumentRegistry::hide(const std::string& id)
{
    auto* value = document(id);
    if (!value)
        return false;
    value->Hide();
    return true;
}

bool RmlUiDocumentRegistry::set_opacity(const std::string& id, float opacity)
{
    auto* value = document(id);
    if (!value)
        return false;
    opacity = std::clamp(opacity, 0.0f, 1.0f);
    return value->SetProperty("opacity", std::to_string(opacity));
}

bool RmlUiDocumentRegistry::apply_order(const std::vector<std::string>& ordered_document_ids)
{
    for (const auto& id : ordered_document_ids) {
        if (!document(id) || !document_context(id))
            return false;
    }
    m_ordered_document_ids = ordered_document_ids;
    restore_order();
    m_host.sort_contexts();
    return true;
}

Rml::ElementDocument* RmlUiDocumentRegistry::document(const std::string& id) const noexcept
{
    const auto found = m_documents.find(id);
    return found == m_documents.end() ? nullptr : found->second.document;
}

Rml::Element* RmlUiDocumentRegistry::element(const std::string& document_id,
                                             const std::string& element_id) const noexcept
{
    auto* owner = document(document_id);
    return owner ? owner->GetElementById(element_id) : nullptr;
}

Rml::Context* RmlUiDocumentRegistry::document_context(const std::string& id) const noexcept
{
    const auto found = m_documents.find(id);
    return found == m_documents.end() ? nullptr : m_host.find_context(found->second.context);
}

RmlUiDocumentRegistry::ContextKey
RmlUiDocumentRegistry::context_key_or_default(const std::string& id) const noexcept
{
    const auto found = m_documents.find(id);
    return found == m_documents.end() ? default_context_key() : found->second.context;
}

bool RmlUiDocumentRegistry::has_document(const std::string& id) const noexcept
{
    return document(id) != nullptr;
}

bool RmlUiDocumentRegistry::has_visible_document(Rml::Context* context) const noexcept
{
    if (!context)
        return false;
    return std::any_of(m_documents.begin(), m_documents.end(), [&](const auto& entry) {
        return entry.second.document && entry.second.document->IsVisible() &&
               m_host.find_context(entry.second.context) == context;
    });
}

std::uintptr_t RmlUiDocumentRegistry::add_event_listener(const std::string& document_id,
                                                         const std::string& element_id,
                                                         const std::string& event,
                                                         std::function<void()> callback)
{
    if (event.empty() || !callback)
        return 0;
    auto* target = element_id.empty() ? static_cast<Rml::Element*>(document(document_id))
                                      : element(document_id, element_id);
    if (!target)
        return 0;
    auto listener = std::make_unique<CallbackListener>(std::move(callback));
    const auto id = m_next_listener_id++;
    target->AddEventListener(event, listener.get());
    m_listeners.emplace(
        id, ListenerRecord{document_id, element_id, target, event, std::move(listener)});
    return id;
}

bool RmlUiDocumentRegistry::remove_event_listener(std::uintptr_t listener_id)
{
    auto found = m_listeners.find(listener_id);
    if (found == m_listeners.end())
        return false;
    if (found->second.element) {
        found->second.element->RemoveEventListener(found->second.event,
                                                   found->second.listener.get());
    }
    m_listeners.erase(found);
    return true;
}

bool RmlUiDocumentRegistry::has_event_listener(const Rml::Element& element,
                                               std::string_view event) const noexcept
{
    return std::any_of(m_listeners.begin(), m_listeners.end(), [&](const auto& entry) {
        return entry.second.element == &element && entry.second.event == event;
    });
}

void RmlUiDocumentRegistry::set_virtual_file(std::string path, std::string contents)
{
    if (auto* files = m_host.file_interface())
        files->set_virtual_file(std::move(path), std::move(contents));
}

void RmlUiDocumentRegistry::clear_virtual_files()
{
    if (auto* files = m_host.file_interface())
        files->clear_virtual_files();
}

void RmlUiDocumentRegistry::remember_order(const std::string& id)
{
    if (std::find(m_ordered_document_ids.begin(), m_ordered_document_ids.end(), id) ==
        m_ordered_document_ids.end()) {
        m_ordered_document_ids.push_back(id);
    }
}

std::vector<std::string> RmlUiDocumentRegistry::recreation_order() const
{
    std::vector<std::string> order;
    order.reserve(m_documents.size());
    for (const auto& id : m_ordered_document_ids) {
        if (m_documents.contains(id))
            order.push_back(id);
    }
    std::vector<std::string> remaining;
    for (const auto& [id, record] : m_documents) {
        (void)record;
        if (std::find(order.begin(), order.end(), id) == order.end())
            remaining.push_back(id);
    }
    std::sort(remaining.begin(), remaining.end());
    order.insert(order.end(), remaining.begin(), remaining.end());
    return order;
}

void RmlUiDocumentRegistry::restore_order()
{
    for (const auto& id : m_ordered_document_ids) {
        auto* owner = document(id);
        auto* context = document_context(id);
        if (owner && context)
            context->PullDocumentToFront(owner);
    }
}

void RmlUiDocumentRegistry::attach_runtime_input(DocumentRecord& record)
{
    if (record.document && record.runtime_input && m_runtime_input_listener)
        record.document->AddEventListener("click", m_runtime_input_listener);
}

void RmlUiDocumentRegistry::detach_runtime_input(DocumentRecord& record)
{
    if (record.document && record.runtime_input && m_runtime_input_listener)
        record.document->RemoveEventListener("click", m_runtime_input_listener);
}

void RmlUiDocumentRegistry::detach_custom_listeners(const std::string& document_id,
                                                    bool erase_records)
{
    for (auto listener = m_listeners.begin(); listener != m_listeners.end();) {
        if (listener->second.document_id != document_id) {
            ++listener;
            continue;
        }
        if (listener->second.element) {
            listener->second.element->RemoveEventListener(listener->second.event,
                                                          listener->second.listener.get());
        }
        listener->second.element = nullptr;
        if (erase_records)
            listener = m_listeners.erase(listener);
        else
            ++listener;
    }
}

void RmlUiDocumentRegistry::retire(DocumentRecord& record)
{
    if (!record.document)
        return;
    detach_runtime_input(record);
    record.document->Hide();
    record.document->Close();
    record.document = nullptr;
}

} // namespace noveltea::ui::rmlui
