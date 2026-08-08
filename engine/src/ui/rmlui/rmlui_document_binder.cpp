#include "ui/rmlui/rmlui_document_binder.hpp"

#include "ui/rmlui/rmlui_custom_components.hpp"

#include <RmlUi/Core/ElementDocument.h>

namespace noveltea::ui::rmlui {

namespace {
Rml::Element* find_component(Rml::ElementDocument& doc, const std::string& tag)
{
    Rml::ElementList elements;
    doc.GetElementsByTagName(elements, tag);
    return elements.empty() ? nullptr : elements.front();
}

template<class T> T* find_component_as(Rml::ElementDocument& doc, const std::string& tag)
{
    auto* component = find_component(doc, tag);
    return component ? rmlui_dynamic_cast<T*>(component) : nullptr;
}

} // namespace

RuntimeUiDocumentBinder::RuntimeUiDocumentBinder() = default;

void RuntimeUiDocumentBinder::bind(Rml::ElementDocument& doc,
                                   const core::TypedRuntimeUIViewState& state, std::string_view)
{
    const auto active_text_snapshot = make_active_text_snapshot(state);
    if (auto* active_text = find_component_as<NtActiveTextElement>(doc, "nt-active-text"))
        active_text->set_snapshot(active_text_snapshot);
    if (auto* map_view = find_component_as<NtMapViewElement>(doc, "nt-map-view"))
        map_view->set_snapshot(make_map_view_snapshot(state));
}

} // namespace noveltea::ui::rmlui
