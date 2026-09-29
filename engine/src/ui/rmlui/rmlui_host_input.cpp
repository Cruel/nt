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

SDL_Event project_pointer_event_to_host_context(const SDL_Event& event, Vec2 host_pointer,
                                                const ResolvedContextMetrics& context) noexcept
{
    SDL_Event transformed = event;
    switch (transformed.type) {
    case SDL_EVENT_MOUSE_MOTION:
        transformed.motion.x = host_pointer.x;
        transformed.motion.y = host_pointer.y;
        break;
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
    case SDL_EVENT_MOUSE_BUTTON_UP:
        transformed.button.x = host_pointer.x;
        transformed.button.y = host_pointer.y;
        break;
    case SDL_EVENT_MOUSE_WHEEL:
        transformed.wheel.mouse_x = host_pointer.x;
        transformed.wheel.mouse_y = host_pointer.y;
        break;
    case SDL_EVENT_FINGER_DOWN:
    case SDL_EVENT_FINGER_UP:
    case SDL_EVENT_FINGER_MOTION:
    case SDL_EVENT_FINGER_CANCELED:
        transformed.tfinger.x = host_pointer.x / static_cast<float>(context.layout_size.width);
        transformed.tfinger.y = host_pointer.y / static_cast<float>(context.layout_size.height);
        break;
    default:
        break;
    }
    return transformed;
}

bool RmlUiHost::dispatch_transformed_event(const SDL_Event& event,
                                           const PresentationTransform& transform,
                                           std::optional<Vec2> host_pointer,
                                           std::optional<Vec2> reference_pointer,
                                           const VisibleDocumentPredicate& has_visible_document,
                                           const LayoutEventDispatch& dispatch_layout_event,
                                           bool dispatch_runtime, bool dispatch_debugger)
{
    const bool updates_cursor =
        event.type == SDL_EVENT_MOUSE_MOTION || event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ||
        event.type == SDL_EVENT_MOUSE_BUTTON_UP || event.type == SDL_EVENT_MOUSE_WHEEL;
    const bool pointer_position_event = updates_cursor || event.type == SDL_EVENT_FINGER_DOWN ||
                                        event.type == SDL_EVENT_FINGER_UP ||
                                        event.type == SDL_EVENT_FINGER_MOTION ||
                                        event.type == SDL_EVENT_FINGER_CANCELED;
    std::vector<std::uint64_t> cursor_order;
    bool consumed = false;
    for (auto it = m_contexts.rbegin(); it != m_contexts.rend(); ++it) {
        bool debugger_active = false;
#if NOVELTEA_ENABLE_DEVTOOLS
        debugger_active = it->context == m_debugger_host_context && debugger_snapshot().visible;
#endif
        if (!it->context || it->key.input == core::LayoutInputMode::None ||
            (debugger_active && !dispatch_debugger) || (!debugger_active && !dispatch_runtime) ||
            (!debugger_active && has_visible_document && !has_visible_document(it->context)))
            continue;
        if (updates_cursor)
            cursor_order.push_back(it->cursor_source_id);
        if (pointer_position_event && !debugger_active && !reference_pointer)
            continue;
        const auto process_context = [&]() {
            set_context_clock(it->key);
            SDL_Event transformed = event;
            if (debugger_active && host_pointer) {
                transformed =
                    project_pointer_event_to_host_context(event, *host_pointer, it->metrics);
            } else if (reference_pointer) {
                transformed = project_pointer_event_to_context(event, *reference_pointer, transform,
                                                               it->metrics);
            }
            Rml::Context* previous_cursor_context = m_active_cursor_context;
            m_active_cursor_context = it->context;
            const bool result = process_sdl_event(*it->context, m_window, transformed);
            m_active_cursor_context = previous_cursor_context;
            return result;
        };
        const bool context_consumed =
            debugger_active ? process_context()
                            : (dispatch_layout_event
                                   ? dispatch_layout_event(it->key, it->key.owner, process_context)
                                   : process_context());
#if NOVELTEA_ENABLE_DEVTOOLS
        it->recent_event_processed = true;
        it->recent_event_consumed = context_consumed;
#endif
        consumed = context_consumed || consumed;
        if (stops_lower_presentation_input(it->key.input, consumed))
            break;
    }
    if (updates_cursor)
        resolve_cursor_requests(cursor_order);
    return consumed;
}

bool RmlUiHost::process_event(const SDL_Event& event,
                              const VisibleDocumentPredicate& has_visible_document,
                              const LayoutEventDispatch& dispatch_layout_event)
{
    if (m_contexts.empty())
        return false;

#if NOVELTEA_ENABLE_DEVTOOLS
    for (auto& record : m_contexts) {
        record.recent_event_processed = false;
        record.recent_event_consumed = false;
    }
#endif

    const PresentationTransform transform{m_presentation};
    const auto dispatch = [&](const SDL_Event& routed,
                              std::optional<Vec2> host_pointer = std::nullopt,
                              std::optional<Vec2> reference_pointer = std::nullopt,
                              bool dispatch_runtime = true, bool dispatch_debugger = true) {
        return dispatch_transformed_event(routed, transform, host_pointer, reference_pointer,
                                          has_visible_document, dispatch_layout_event,
                                          dispatch_runtime, dispatch_debugger);
    };
    const auto project_pointer = [&](Vec2 host_logical) -> std::optional<Vec2> {
        const auto normalized = transform.host_logical_to_normalized_game_viewport(host_logical);
        if (!normalized)
            return std::nullopt;
        return transform.normalized_game_viewport_to_reference(*normalized);
    };

    switch (event.type) {
    case SDL_EVENT_MOUSE_MOTION: {
        const Vec2 host_pointer{event.motion.x, event.motion.y};
        const auto point = project_pointer(host_pointer);
        bool leave_consumed = false;
        if (!point) {
            if (m_pointer_inside) {
                m_pointer_inside = false;
                m_reference_pointer.reset();
                resolve_cursor_requests({});
                SDL_Event leave{};
                leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
                leave_consumed = dispatch(leave);
            }
            return dispatch(event, host_pointer, std::nullopt) || leave_consumed;
        }
        m_pointer_inside = true;
        m_reference_pointer = *point;
        if (!m_active_mouse_buttons.empty())
            m_mouse_capture_reference = *point;
        return dispatch(event, host_pointer, point);
    }
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
    case SDL_EVENT_MOUSE_BUTTON_UP: {
        const Vec2 host_pointer{event.button.x, event.button.y};
        const auto point = project_pointer(host_pointer);
        if (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN && point) {
            m_active_mouse_buttons.insert(event.button.button);
            m_mouse_capture_reference = *point;
        }
        if (!point) {
            const auto cleanup_reference =
                m_mouse_capture_reference ? m_mouse_capture_reference : m_reference_pointer;
            const bool release_consumed = event.type == SDL_EVENT_MOUSE_BUTTON_UP
                                              ? dispatch(event, host_pointer, cleanup_reference)
                                              : dispatch(event, host_pointer, std::nullopt);
            if (event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
                m_active_mouse_buttons.erase(event.button.button);
                if (m_active_mouse_buttons.empty())
                    m_mouse_capture_reference.reset();
            }
            if (m_pointer_inside) {
                m_pointer_inside = false;
                m_reference_pointer.reset();
                resolve_cursor_requests({});
                SDL_Event leave{};
                leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
                return release_consumed || dispatch(leave);
            }
            return release_consumed;
        }
        m_pointer_inside = true;
        m_reference_pointer = *point;
        if (!m_active_mouse_buttons.empty())
            m_mouse_capture_reference = *point;
        const bool consumed = dispatch(event, host_pointer, point);
        if (event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
            m_active_mouse_buttons.erase(event.button.button);
            if (m_active_mouse_buttons.empty())
                m_mouse_capture_reference.reset();
        }
        return consumed;
    }
    case SDL_EVENT_MOUSE_WHEEL: {
        const Vec2 host_pointer{event.wheel.mouse_x, event.wheel.mouse_y};
        const auto point = project_pointer(host_pointer);
        bool leave_consumed = false;
        if (!point) {
            if (m_pointer_inside) {
                m_pointer_inside = false;
                m_reference_pointer.reset();
                resolve_cursor_requests({});
                SDL_Event leave{};
                leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
                leave_consumed = dispatch(leave);
            }
            return dispatch(event, host_pointer, std::nullopt) || leave_consumed;
        }
        m_pointer_inside = true;
        m_reference_pointer = *point;
        return dispatch(event, host_pointer, point);
    }
    case SDL_EVENT_FINGER_DOWN:
    case SDL_EVENT_FINGER_UP:
    case SDL_EVENT_FINGER_MOTION:
    case SDL_EVENT_FINGER_CANCELED: {
        const std::uint64_t touch_id = static_cast<std::uint64_t>(event.tfinger.fingerID);
        const Vec2 host_logical =
            transform.normalized_host_surface_to_host_logical({event.tfinger.x, event.tfinger.y});
        const auto point = project_pointer(host_logical);

        if (event.type == SDL_EVENT_FINGER_DOWN) {
            bool debugger_visible = false;
#if NOVELTEA_ENABLE_DEVTOOLS
            debugger_visible = debugger_snapshot().visible;
#endif
            const bool debugger_consumed = dispatch(event, host_logical, std::nullopt, false, true);
            if (debugger_visible)
                m_debugger_observed_touches.insert(touch_id);
            if (debugger_consumed) {
                m_debugger_active_touches.insert(touch_id);
                return true;
            }
            if (!point)
                return false;
            m_active_touches[touch_id] = *point;
            return dispatch(event, host_logical, point, true, false);
        }

        if (m_debugger_active_touches.contains(touch_id)) {
            const bool consumed = dispatch(event, host_logical, std::nullopt, false, true);
            if (event.type == SDL_EVENT_FINGER_UP || event.type == SDL_EVENT_FINGER_CANCELED) {
                m_debugger_active_touches.erase(touch_id);
                m_debugger_observed_touches.erase(touch_id);
            }
            return consumed;
        }

        bool debugger_consumed = false;
        const bool debugger_observed = m_debugger_observed_touches.contains(touch_id);
        if (debugger_observed)
            debugger_consumed = dispatch(event, host_logical, std::nullopt, false, true);

        auto runtime_touch = m_active_touches.find(touch_id);
        if (runtime_touch == m_active_touches.end()) {
            if (event.type == SDL_EVENT_FINGER_UP || event.type == SDL_EVENT_FINGER_CANCELED)
                m_debugger_observed_touches.erase(touch_id);
            return debugger_consumed;
        }
        if (!point) {
            SDL_Event canceled = event;
            canceled.type = SDL_EVENT_FINGER_CANCELED;
            const bool runtime_consumed =
                dispatch(canceled, host_logical, runtime_touch->second, true, false);
            m_active_touches.erase(runtime_touch);
            m_debugger_observed_touches.erase(touch_id);
            return debugger_consumed || runtime_consumed;
        }

        runtime_touch->second = *point;
        const bool runtime_consumed = dispatch(event, host_logical, point, true, false);
        if (event.type == SDL_EVENT_FINGER_UP || event.type == SDL_EVENT_FINGER_CANCELED) {
            m_active_touches.erase(touch_id);
            m_debugger_observed_touches.erase(touch_id);
        }
        return debugger_consumed || runtime_consumed;
    }
    case SDL_EVENT_WINDOW_MOUSE_LEAVE:
    case SDL_EVENT_WINDOW_FOCUS_LOST:
        reset_pointer_state();
        break;
    default:
        break;
    }

    return dispatch(event);
}

void RmlUiHost::reset_pointer_state()
{
    m_pointer_inside = false;
    m_reference_pointer.reset();
    m_active_touches.clear();
    m_debugger_observed_touches.clear();
    m_debugger_active_touches.clear();
    m_active_mouse_buttons.clear();
    m_mouse_capture_reference.reset();
    resolve_cursor_requests({});
}

void RmlUiHost::refresh_pointer_cursor(const VisibleDocumentPredicate& has_visible_document,
                                       const LayoutEventDispatch& dispatch_layout_event)
{
    if (!m_pointer_inside || !m_reference_pointer) {
        resolve_cursor_requests({});
        return;
    }

    SDL_Event motion{};
    motion.type = SDL_EVENT_MOUSE_MOTION;
    const PresentationTransform transform{m_presentation};
    const Vec2 host_pointer = transform.reference_to_host_logical(*m_reference_pointer);
    (void)dispatch_transformed_event(motion, transform, host_pointer, m_reference_pointer,
                                     has_visible_document, dispatch_layout_event);
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
