#include "ui/rmlui/rmlui_host.hpp"

#include "ui/rmlui/rmlui_input_sdl3.hpp"

#include <algorithm>
#include <optional>

#include <SDL3/SDL.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Element.h>

namespace noveltea::ui::rmlui {

bool RmlUiHost::dispatch_transformed_event(const SDL_Event& event,
                                           const VisibleDocumentPredicate& has_visible_document,
                                           const LayoutEventDispatch& dispatch_layout_event)
{
    bool consumed = false;
    for (auto it = m_contexts.rbegin(); it != m_contexts.rend(); ++it) {
        if (!it->context || it->key.input == core::LayoutInputMode::None ||
            (has_visible_document && !has_visible_document(it->context)))
            continue;
        const auto process_context = [&]() {
            set_context_clock(it->key);
            return process_sdl_event(*it->context, m_window, event);
        };
        const bool context_consumed = dispatch_layout_event
                                          ? dispatch_layout_event(it->key.owner, process_context)
                                          : process_context();
        consumed = context_consumed || consumed;
        if (stops_lower_presentation_input(it->key.input, consumed))
            break;
    }
    return consumed;
}

bool RmlUiHost::process_event(const SDL_Event& event, const PresentationMetrics& presentation,
                              const VisibleDocumentPredicate& has_visible_document,
                              const LayoutEventDispatch& dispatch_layout_event)
{
    if (m_contexts.empty())
        return false;

    SDL_Event transformed = event;
    const auto dispatch = [&](const SDL_Event& routed) {
        return dispatch_transformed_event(routed, has_visible_document, dispatch_layout_event);
    };
    const auto transform_pointer = [&](float x, float y) -> std::optional<Vec2> {
        return host_to_viewport_logical({x, y}, presentation);
    };

    switch (event.type) {
    case SDL_EVENT_MOUSE_MOTION: {
        const auto point = transform_pointer(event.motion.x, event.motion.y);
        if (!point) {
            if (m_pointer_inside) {
                m_pointer_inside = false;
                SDL_Event leave{};
                leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
                return dispatch(leave);
            }
            return false;
        }
        m_pointer_inside = true;
        transformed.motion.x = point->x;
        transformed.motion.y = point->y;
        break;
    }
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
    case SDL_EVENT_MOUSE_BUTTON_UP: {
        const auto point = transform_pointer(event.button.x, event.button.y);
        if (!point) {
            if (event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
                const bool release_consumed = dispatch(transformed);
                m_pointer_inside = false;
                SDL_Event leave{};
                leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
                return release_consumed || dispatch(leave);
            }
            return false;
        }
        m_pointer_inside = true;
        transformed.button.x = point->x;
        transformed.button.y = point->y;
        break;
    }
    case SDL_EVENT_MOUSE_WHEEL: {
        const auto point = transform_pointer(event.wheel.mouse_x, event.wheel.mouse_y);
        if (!point) {
            if (m_pointer_inside) {
                m_pointer_inside = false;
                SDL_Event leave{};
                leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
                return dispatch(leave);
            }
            return false;
        }
        m_pointer_inside = true;
        break;
    }
    case SDL_EVENT_FINGER_DOWN:
    case SDL_EVENT_FINGER_UP:
    case SDL_EVENT_FINGER_MOTION:
    case SDL_EVENT_FINGER_CANCELED: {
        const std::uint64_t touch_id = static_cast<std::uint64_t>(event.tfinger.fingerID);
        const HostSurfaceMetrics& host = presentation.host;
        const auto point = transform_pointer(event.tfinger.x * host.logical_size.width,
                                             event.tfinger.y * host.logical_size.height);
        if (!point) {
            if (event.type != SDL_EVENT_FINGER_DOWN && m_active_touches.erase(touch_id) > 0) {
                transformed.type = SDL_EVENT_FINGER_CANCELED;
                transformed.tfinger.x = 0.0f;
                transformed.tfinger.y = 0.0f;
                break;
            }
            return false;
        }
        if (event.type == SDL_EVENT_FINGER_DOWN) {
            m_active_touches.insert(touch_id);
        } else if (!m_active_touches.contains(touch_id)) {
            return false;
        } else if (event.type == SDL_EVENT_FINGER_UP || event.type == SDL_EVENT_FINGER_CANCELED) {
            m_active_touches.erase(touch_id);
        }
        transformed.tfinger.x = point->x / presentation.viewport.host_logical_rect.width;
        transformed.tfinger.y = point->y / presentation.viewport.host_logical_rect.height;
        break;
    }
    case SDL_EVENT_WINDOW_MOUSE_LEAVE:
        m_pointer_inside = false;
        break;
    default:
        break;
    }

    return dispatch(transformed);
}

void RmlUiHost::reset_pointer_state()
{
    m_pointer_inside = false;
    m_active_touches.clear();
}

bool RmlUiHost::wants_pointer_input() const
{
    return std::any_of(m_contexts.begin(), m_contexts.end(), [](const auto& record) {
        return record.context && record.context->IsMouseInteracting();
    });
}

bool RmlUiHost::wants_keyboard_input() const
{
    return std::any_of(m_contexts.begin(), m_contexts.end(), [](const auto& record) {
        return record.context && record.context->GetFocusElement();
    });
}

} // namespace noveltea::ui::rmlui
