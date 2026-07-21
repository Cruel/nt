#include "ui/rmlui/rmlui_host.hpp"

#include "ui/rmlui/rmlui_host_input.hpp"
#include "ui/rmlui/rmlui_input_sdl3.hpp"

#include <algorithm>
#include <optional>

#include <SDL3/SDL.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Element.h>

namespace noveltea::ui::rmlui {

SDL_Event project_pointer_event_to_context(const SDL_Event& event, Vec2 reference_pointer,
                                           const PresentationTransform& transform,
                                           const ResolvedContextMetrics& context) noexcept
{
    SDL_Event transformed = event;
    const Vec2 context_pointer = transform.reference_to_context_logical(reference_pointer, context);
    switch (transformed.type) {
    case SDL_EVENT_MOUSE_MOTION:
        transformed.motion.x = context_pointer.x;
        transformed.motion.y = context_pointer.y;
        break;
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
    case SDL_EVENT_MOUSE_BUTTON_UP:
        transformed.button.x = context_pointer.x;
        transformed.button.y = context_pointer.y;
        break;
    case SDL_EVENT_MOUSE_WHEEL:
        transformed.wheel.mouse_x = context_pointer.x;
        transformed.wheel.mouse_y = context_pointer.y;
        break;
    case SDL_EVENT_FINGER_DOWN:
    case SDL_EVENT_FINGER_UP:
    case SDL_EVENT_FINGER_MOTION:
    case SDL_EVENT_FINGER_CANCELED:
        transformed.tfinger.x = context_pointer.x / static_cast<float>(context.layout_size.width);
        transformed.tfinger.y = context_pointer.y / static_cast<float>(context.layout_size.height);
        break;
    default:
        break;
    }
    return transformed;
}

bool RmlUiHost::dispatch_transformed_event(const SDL_Event& event,
                                           const PresentationTransform& transform,
                                           std::optional<Vec2> reference_pointer,
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
            SDL_Event transformed = event;
            if (reference_pointer)
                transformed = project_pointer_event_to_context(event, *reference_pointer, transform,
                                                               it->metrics);
            return process_sdl_event(*it->context, m_window, transformed);
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

bool RmlUiHost::process_event(const SDL_Event& event,
                              const VisibleDocumentPredicate& has_visible_document,
                              const LayoutEventDispatch& dispatch_layout_event)
{
    if (m_contexts.empty())
        return false;

    const PresentationTransform transform{m_presentation};
    const auto dispatch = [&](const SDL_Event& routed,
                              std::optional<Vec2> reference_pointer = std::nullopt) {
        return dispatch_transformed_event(routed, transform, reference_pointer,
                                          has_visible_document, dispatch_layout_event);
    };
    const auto project_pointer = [&](Vec2 host_logical) -> std::optional<Vec2> {
        const auto normalized = transform.host_logical_to_normalized_game_viewport(host_logical);
        if (!normalized)
            return std::nullopt;
        return transform.normalized_game_viewport_to_reference(*normalized);
    };

    switch (event.type) {
    case SDL_EVENT_MOUSE_MOTION: {
        const auto point = project_pointer({event.motion.x, event.motion.y});
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
        return dispatch(event, point);
    }
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
    case SDL_EVENT_MOUSE_BUTTON_UP: {
        const auto point = project_pointer({event.button.x, event.button.y});
        if (!point) {
            if (event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
                const bool release_consumed = dispatch(event);
                m_pointer_inside = false;
                SDL_Event leave{};
                leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
                return release_consumed || dispatch(leave);
            }
            return false;
        }
        m_pointer_inside = true;
        return dispatch(event, point);
    }
    case SDL_EVENT_MOUSE_WHEEL: {
        const auto point = project_pointer({event.wheel.mouse_x, event.wheel.mouse_y});
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
        return dispatch(event, point);
    }
    case SDL_EVENT_FINGER_DOWN:
    case SDL_EVENT_FINGER_UP:
    case SDL_EVENT_FINGER_MOTION:
    case SDL_EVENT_FINGER_CANCELED: {
        const std::uint64_t touch_id = static_cast<std::uint64_t>(event.tfinger.fingerID);
        const Vec2 host_logical =
            transform.normalized_host_surface_to_host_logical({event.tfinger.x, event.tfinger.y});
        const auto point = project_pointer(host_logical);
        if (!point) {
            if (event.type != SDL_EVENT_FINGER_DOWN && m_active_touches.erase(touch_id) > 0) {
                SDL_Event canceled = event;
                canceled.type = SDL_EVENT_FINGER_CANCELED;
                canceled.tfinger.x = 0.0f;
                canceled.tfinger.y = 0.0f;
                return dispatch(canceled);
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
        return dispatch(event, point);
    }
    case SDL_EVENT_WINDOW_MOUSE_LEAVE:
        m_pointer_inside = false;
        break;
    default:
        break;
    }

    return dispatch(event);
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
