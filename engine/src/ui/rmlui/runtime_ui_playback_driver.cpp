#include "ui/rmlui/runtime_ui_playback_driver.hpp"

#include "ui/rmlui/rmlui_document_registry.hpp"
#include "ui/rmlui/rmlui_host.hpp"

#include <cmath>
#include <string>
#include <utility>

#include <RmlUi/Core/Box.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementDocument.h>

namespace noveltea::ui::rmlui {
namespace {

Rml::Element* find_ancestor_tag(Rml::Element* element, const char* tag)
{
    for (auto* current = element; current; current = current->GetParentNode()) {
        if (current->GetTagName() == tag)
            return current;
    }
    return nullptr;
}

Rml::Element* resolve_target(Rml::ElementDocument& document, const std::string& selector)
{
    if (selector.empty())
        return nullptr;
    if (selector.front() == '#')
        return selector.size() > 1 ? document.GetElementById(selector.substr(1)) : nullptr;

    const auto attribute_start = selector.find('[');
    const auto attribute_end =
        selector.find(']', attribute_start == std::string::npos ? 0 : attribute_start);
    if (attribute_start != std::string::npos && attribute_end != std::string::npos &&
        attribute_end > attribute_start + 1) {
        const auto tag =
            attribute_start == 0 ? std::string("*") : selector.substr(0, attribute_start);
        auto attribute = selector.substr(attribute_start + 1, attribute_end - attribute_start - 1);
        std::string expected;
        if (const auto equals = attribute.find('='); equals != std::string::npos) {
            expected = attribute.substr(equals + 1);
            attribute = attribute.substr(0, equals);
            if (expected.size() >= 2 && ((expected.front() == '"' && expected.back() == '"') ||
                                         (expected.front() == '\'' && expected.back() == '\''))) {
                expected = expected.substr(1, expected.size() - 2);
            }
        }

        Rml::ElementList elements;
        if (tag == "*")
            document.GetElementsByTagName(elements, "button");
        else
            document.GetElementsByTagName(elements, tag);
        for (auto* element : elements) {
            if (!element || !element->HasAttribute(attribute))
                continue;
            if (expected.empty() || element->GetAttribute<Rml::String>(attribute, "") == expected) {
                return element;
            }
        }
        return nullptr;
    }

    Rml::ElementList elements;
    if (selector.front() == '.') {
        if (selector.size() <= 1)
            return nullptr;
        document.GetElementsByClassName(elements, selector.substr(1));
    } else {
        document.GetElementsByTagName(elements, selector);
    }
    return elements.empty() ? nullptr : elements.front();
}

bool has_disabled_ancestor(Rml::Element* element)
{
    for (auto* current = element; current; current = current->GetParentNode()) {
        if (current->HasAttribute("disabled"))
            return true;
    }
    return false;
}

bool is_descendant_or_self(Rml::Element* candidate, Rml::Element* ancestor)
{
    for (auto* current = candidate; current; current = current->GetParentNode()) {
        if (current == ancestor)
            return true;
    }
    return false;
}

bool has_runtime_activation_attribute(Rml::Element& element)
{
    return element.HasAttribute("nt-option") || element.HasAttribute("nt-nav") ||
           element.HasAttribute("nt-continue") || element.HasAttribute("nt-object") ||
           element.HasAttribute("nt-action") || element.HasAttribute("nt-clear-selection");
}

bool has_runtime_activation_behavior(Rml::Element& target)
{
    if (target.HasAttribute("onclick") || has_runtime_activation_attribute(target))
        return true;
    return target.GetTagName() == "nt-active-text" || find_ancestor_tag(&target, "nt-active-text");
}

void fill_target_metadata(RuntimeUiPlaybackClickResult& result, Rml::Element& target)
{
    result.target_id = target.GetId();
    result.target_tag = target.GetTagName();
    const Rml::Vector2f offset = target.GetAbsoluteOffset(Rml::BoxArea::Content);
    const Rml::Vector2f size = target.GetBox().GetSize(Rml::BoxArea::Content);
    result.x = offset.x + size.x * 0.5f;
    result.y = offset.y + size.y * 0.5f;
    result.width = size.x;
    result.height = size.y;
}

RuntimeUiPlaybackClickResult make_result(RuntimeUiPlaybackClickStatus status,
                                         const RuntimeUiPlaybackClickRequest& request,
                                         std::string message)
{
    RuntimeUiPlaybackClickResult result;
    result.status = status;
    result.message = std::move(message);
    result.document_id = request.document_id;
    result.selector = request.selector;
    return result;
}

} // namespace

RuntimeUiPlaybackDriver::RuntimeUiPlaybackDriver(RmlUiHost& host, RmlUiDocumentRegistry& documents,
                                                 LayoutEventDispatch dispatch_layout_event) noexcept
    : m_host(host), m_documents(documents),
      m_dispatch_layout_event(std::move(dispatch_layout_event))
{
}

RuntimeUiPlaybackClickResult
RuntimeUiPlaybackDriver::click(const RuntimeUiPlaybackClickRequest& request)
{
    if (m_host.contexts().empty()) {
        return make_result(RuntimeUiPlaybackClickStatus::UiNotInitialized, request,
                           "runtime UI is not initialized");
    }

    auto* document = m_documents.document(request.document_id);
    if (!document) {
        return make_result(RuntimeUiPlaybackClickStatus::DocumentNotFound, request,
                           "document is not loaded: " + request.document_id);
    }
    if (!document->IsVisible()) {
        return make_result(RuntimeUiPlaybackClickStatus::DocumentHidden, request,
                           "document is hidden: " + request.document_id);
    }
    auto* context = m_documents.document_context(request.document_id);
    if (!context) {
        return make_result(RuntimeUiPlaybackClickStatus::DocumentNotFound, request,
                           "document context is unavailable: " + request.document_id);
    }
    const auto* context_metrics = m_host.context_metrics(context);
    if (!context_metrics) {
        return make_result(RuntimeUiPlaybackClickStatus::DocumentNotFound, request,
                           "document context transform is unavailable: " + request.document_id);
    }

    auto* target = resolve_target(*document, request.selector);
    if (!target) {
        return make_result(RuntimeUiPlaybackClickStatus::TargetNotFound, request,
                           "target not found: " + request.selector);
    }

    auto result = make_result(RuntimeUiPlaybackClickStatus::Dispatched, request, {});
    fill_target_metadata(result, *target);

    if (!target->IsVisible(true)) {
        result.status = RuntimeUiPlaybackClickStatus::TargetHidden;
        result.message = "target or ancestor is hidden: " + request.selector;
        return result;
    }
    if (result.width <= 0.0f || result.height <= 0.0f || !std::isfinite(result.width) ||
        !std::isfinite(result.height)) {
        result.status = RuntimeUiPlaybackClickStatus::TargetEmptyBounds;
        result.message = "target has empty bounds: " + request.selector;
        return result;
    }
    if (has_disabled_ancestor(target)) {
        result.status = RuntimeUiPlaybackClickStatus::TargetDisabled;
        result.message = "target or ancestor is disabled: " + request.selector;
        return result;
    }

    const PresentationTransform transform{m_host.presentation()};
    const Vec2 native_click =
        transform.context_logical_to_native_ui_raster({result.x, result.y}, *context_metrics);
    const Vec2 context_click =
        transform.native_ui_raster_to_context_logical(native_click, *context_metrics);

    auto* hit = context->GetElementAtPoint({context_click.x, context_click.y});
    if (!has_runtime_activation_attribute(*target) && hit && !is_descendant_or_self(hit, target) &&
        !is_descendant_or_self(target, hit)) {
        result.status = RuntimeUiPlaybackClickStatus::TargetBlocked;
        result.message = "target is not hittable at click point: " + request.selector;
        result.message += " hit=";
        result.message += hit->GetTagName();
        if (!hit->GetId().empty()) {
            result.message += "#";
            result.message += hit->GetId();
        }
        return result;
    }

    const bool has_click_listener = has_runtime_activation_behavior(*target) ||
                                    m_documents.has_event_listener(*target, "click");
    if (!has_click_listener) {
        result.status = RuntimeUiPlaybackClickStatus::TargetNotInteractive;
        result.message = "target has no onclick or bound click listener: " + request.selector;
        return result;
    }

    const int x = static_cast<int>(std::lround(context_click.x));
    const int y = static_cast<int>(std::lround(context_click.y));
    const auto context_key = m_documents.context_key_or_default(request.document_id);
    bool dispatched = false;
    if (m_dispatch_layout_event) {
        (void)m_dispatch_layout_event(context_key.owner, [&]() {
            dispatched = true;
            m_host.set_context_clock(context_key);
            const bool moved = context->ProcessMouseMove(x, y, 0);
            const bool pressed = context->ProcessMouseButtonDown(0, 0);
            const bool released = context->ProcessMouseButtonUp(0, 0);
            return moved || pressed || released;
        });
    }
    if (!dispatched) {
        result.status = RuntimeUiPlaybackClickStatus::HostDispatchRejected;
        result.message = "host rejected playback layout-event dispatch: " + request.selector;
        return result;
    }
    result.dispatched = true;
    result.message = "dispatched ui-click";
    return result;
}

Rml::ElementDocument* RuntimeUiPlaybackDriver::document(const std::string& id) const noexcept
{
    return m_documents.document(id);
}

Rml::Element* RuntimeUiPlaybackDriver::element(const std::string& document_id,
                                               const std::string& element_id) const noexcept
{
    return m_documents.element(document_id, element_id);
}

const char* to_string(RuntimeUiPlaybackClickStatus status) noexcept
{
    switch (status) {
    case RuntimeUiPlaybackClickStatus::Dispatched:
        return "dispatched";
    case RuntimeUiPlaybackClickStatus::UiNotInitialized:
        return "ui-not-initialized";
    case RuntimeUiPlaybackClickStatus::DocumentNotFound:
        return "document-not-found";
    case RuntimeUiPlaybackClickStatus::DocumentHidden:
        return "document-hidden";
    case RuntimeUiPlaybackClickStatus::TargetNotFound:
        return "target-not-found";
    case RuntimeUiPlaybackClickStatus::TargetHidden:
        return "target-hidden";
    case RuntimeUiPlaybackClickStatus::TargetEmptyBounds:
        return "target-empty-bounds";
    case RuntimeUiPlaybackClickStatus::TargetDisabled:
        return "target-disabled";
    case RuntimeUiPlaybackClickStatus::TargetBlocked:
        return "target-blocked";
    case RuntimeUiPlaybackClickStatus::TargetNotInteractive:
        return "target-not-interactive";
    case RuntimeUiPlaybackClickStatus::HostDispatchRejected:
        return "host-dispatch-rejected";
    }
    return "unknown";
}

} // namespace noveltea::ui::rmlui
