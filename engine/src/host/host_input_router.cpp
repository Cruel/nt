#include "host/host_input_router.hpp"

#include <SDL3/SDL.h>

#include <utility>

namespace noveltea::host {
namespace {

[[nodiscard]] bool is_pointer_event(NormalizedHostEventKind kind) noexcept
{
    switch (kind) {
    case NormalizedHostEventKind::PointerLeft:
    case NormalizedHostEventKind::MouseButtonDown:
    case NormalizedHostEventKind::MouseButtonUp:
    case NormalizedHostEventKind::MouseMotion:
    case NormalizedHostEventKind::MouseWheel:
    case NormalizedHostEventKind::TouchDown:
    case NormalizedHostEventKind::TouchUp:
    case NormalizedHostEventKind::TouchMotion:
    case NormalizedHostEventKind::TouchCanceled:
        return true;
    default:
        return false;
    }
}

[[nodiscard]] bool is_gameplay_event(NormalizedHostEventKind kind) noexcept
{
    switch (kind) {
    case NormalizedHostEventKind::MouseButtonDown:
    case NormalizedHostEventKind::MouseButtonUp:
    case NormalizedHostEventKind::MouseMotion:
    case NormalizedHostEventKind::MouseWheel:
    case NormalizedHostEventKind::KeyDown:
    case NormalizedHostEventKind::KeyUp:
    case NormalizedHostEventKind::TextInput:
    case NormalizedHostEventKind::TouchDown:
    case NormalizedHostEventKind::TouchUp:
    case NormalizedHostEventKind::TouchMotion:
    case NormalizedHostEventKind::TouchCanceled:
        return true;
    default:
        return false;
    }
}

[[nodiscard]] bool is_interactive_event(NormalizedHostEventKind kind) noexcept
{
    return is_gameplay_event(kind) || kind == NormalizedHostEventKind::PointerLeft;
}

[[nodiscard]] bool invalidates_pointer(NormalizedHostEventKind kind) noexcept
{
    switch (kind) {
    case NormalizedHostEventKind::WindowMinimized:
    case NormalizedHostEventKind::FocusLost:
    case NormalizedHostEventKind::EnteredBackground:
    case NormalizedHostEventKind::WindowResized:
    case NormalizedHostEventKind::PointerLeft:
        return true;
    default:
        return false;
    }
}

void append_invalid_presentation_diagnostic(HostInputRouteResult& result)
{
    result.diagnostics.push_back(
        {.code = "host.input.presentation_unavailable",
         .message =
             "Pointer input could not be projected because presentation metrics are unavailable"});
}

} // namespace

NormalizedHostEvent normalize_host_event(const SDL_Event& event,
                                         const HostSurfaceMetrics& host_surface)
{
    NormalizedHostEvent normalized;
    switch (event.type) {
    case SDL_EVENT_QUIT:
        normalized.kind = NormalizedHostEventKind::QuitRequested;
        break;
    case SDL_EVENT_WINDOW_MINIMIZED:
        normalized.kind = NormalizedHostEventKind::WindowMinimized;
        break;
    case SDL_EVENT_WINDOW_RESTORED:
        normalized.kind = NormalizedHostEventKind::WindowRestored;
        break;
    case SDL_EVENT_WINDOW_FOCUS_LOST:
        normalized.kind = NormalizedHostEventKind::FocusLost;
        break;
    case SDL_EVENT_WINDOW_FOCUS_GAINED:
        normalized.kind = NormalizedHostEventKind::FocusGained;
        break;
    case SDL_EVENT_DID_ENTER_BACKGROUND:
        normalized.kind = NormalizedHostEventKind::EnteredBackground;
        break;
    case SDL_EVENT_DID_ENTER_FOREGROUND:
        normalized.kind = NormalizedHostEventKind::EnteredForeground;
        break;
    case SDL_EVENT_WINDOW_RESIZED:
    case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED:
    case SDL_EVENT_WINDOW_DISPLAY_SCALE_CHANGED:
        normalized.kind = NormalizedHostEventKind::WindowResized;
        break;
    case SDL_EVENT_WINDOW_MOUSE_LEAVE:
        normalized.kind = NormalizedHostEventKind::PointerLeft;
        break;
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
    case SDL_EVENT_MOUSE_BUTTON_UP:
        normalized.kind = event.type == SDL_EVENT_MOUSE_BUTTON_DOWN
                              ? NormalizedHostEventKind::MouseButtonDown
                              : NormalizedHostEventKind::MouseButtonUp;
        normalized.mouse_button = event.button.button;
        normalized.host_position = {event.button.x, event.button.y};
        normalized.has_host_position = true;
        break;
    case SDL_EVENT_MOUSE_MOTION:
        normalized.kind = NormalizedHostEventKind::MouseMotion;
        normalized.host_position = {event.motion.x, event.motion.y};
        normalized.has_host_position = true;
        break;
    case SDL_EVENT_MOUSE_WHEEL:
        normalized.kind = NormalizedHostEventKind::MouseWheel;
        normalized.host_position = {event.wheel.mouse_x, event.wheel.mouse_y};
        normalized.has_host_position = true;
        break;
    case SDL_EVENT_KEY_DOWN:
    case SDL_EVENT_KEY_UP:
        normalized.kind = event.type == SDL_EVENT_KEY_DOWN ? NormalizedHostEventKind::KeyDown
                                                           : NormalizedHostEventKind::KeyUp;
        normalized.key =
            event.key.key == SDLK_ESCAPE ? NormalizedHostKey::Escape : NormalizedHostKey::Unknown;
        normalized.scancode = static_cast<std::int32_t>(event.key.scancode);
        normalized.repeat = event.key.repeat;
        break;
    case SDL_EVENT_TEXT_INPUT:
        normalized.kind = NormalizedHostEventKind::TextInput;
        break;
    case SDL_EVENT_FINGER_DOWN:
    case SDL_EVENT_FINGER_UP:
    case SDL_EVENT_FINGER_MOTION:
    case SDL_EVENT_FINGER_CANCELED:
        if (event.type == SDL_EVENT_FINGER_DOWN)
            normalized.kind = NormalizedHostEventKind::TouchDown;
        else if (event.type == SDL_EVENT_FINGER_UP)
            normalized.kind = NormalizedHostEventKind::TouchUp;
        else if (event.type == SDL_EVENT_FINGER_MOTION)
            normalized.kind = NormalizedHostEventKind::TouchMotion;
        else
            normalized.kind = NormalizedHostEventKind::TouchCanceled;
        normalized.touch_id = static_cast<std::uint64_t>(event.tfinger.fingerID);
        normalized.host_position = {
            event.tfinger.x * static_cast<float>(host_surface.logical_size.width),
            event.tfinger.y * static_cast<float>(host_surface.logical_size.height),
        };
        normalized.has_host_position =
            host_surface.logical_size.width > 0 && host_surface.logical_size.height > 0;
        break;
    default:
        break;
    }
    return normalized;
}

HostInputRouteResult HostInputRouter::route(const NormalizedHostEvent& event,
                                            const HostInputRoutingContext& context,
                                            const HostInputConsumers& consumers)
{
    HostInputRouteResult result;

    switch (event.kind) {
    case NormalizedHostEventKind::QuitRequested:
        result.lifecycle_actions.emplace_back(RequestQuitHostAction{});
        break;
    case NormalizedHostEventKind::WindowMinimized:
    case NormalizedHostEventKind::FocusLost:
    case NormalizedHostEventKind::EnteredBackground:
        result.lifecycle_actions.emplace_back(SuspendHostAction{});
        break;
    case NormalizedHostEventKind::WindowRestored:
    case NormalizedHostEventKind::FocusGained:
    case NormalizedHostEventKind::EnteredForeground:
        result.lifecycle_actions.emplace_back(ResumeHostAction{});
        break;
    case NormalizedHostEventKind::WindowResized:
        result.lifecycle_actions.emplace_back(RefreshHostSurfaceAction{});
        break;
    default:
        break;
    }

    const bool hidden_preview = context.mode == HostInputMode::Preview && !context.preview_visible;
    const bool suppress_hidden_interaction = hidden_preview && is_interactive_event(event.kind);

    if (!suppress_hidden_interaction && context.devtools_enabled && consumers.debug) {
        result.route_diagnostics.debug_processed = true;
        result.debug_result = consumers.debug();
    }
    if (!suppress_hidden_interaction && !result.debug_result.consumed && consumers.runtime_ui) {
        result.route_diagnostics.runtime_ui_processed = true;
        result.runtime_ui_result = consumers.runtime_ui();
        for (const auto& command : result.runtime_ui_result.shell_commands) {
            result.tooling_actions.emplace_back(
                RuntimeShellCommandToolingAction{.command = command});
        }
    }

    result.route_diagnostics.gameplay_event = is_gameplay_event(event.kind);
    result.route_diagnostics.governing_layout = context.layout_admission.governing_instance;
    result.route_diagnostics.governing_layout_mode = context.layout_admission.governing_mode;

    std::optional<Vec2> projected_pointer;
    if (event.has_host_position && !suppress_hidden_interaction)
        projected_pointer = project_pointer(event, context);

    if (invalidates_pointer(event.kind) ||
        (suppress_hidden_interaction && is_pointer_event(event.kind))) {
        m_pointer_valid = false;
        m_active_touches.clear();
        result.pointer_update =
            HostPointerStateUpdate{.reference_position = m_pointer_position, .valid = false};
    } else if (is_pointer_event(event.kind) && event.kind != NormalizedHostEventKind::PointerLeft) {
        if (projected_pointer) {
            m_pointer_position = *projected_pointer;
            m_pointer_valid = true;
        } else {
            m_pointer_valid = false;
            if (event.has_host_position && !context.presentation)
                append_invalid_presentation_diagnostic(result);
        }

        if (event.kind == NormalizedHostEventKind::TouchDown && projected_pointer)
            m_active_touches.insert(event.touch_id);
        if (event.kind == NormalizedHostEventKind::TouchUp ||
            event.kind == NormalizedHostEventKind::TouchCanceled) {
            m_active_touches.erase(event.touch_id);
            if (m_active_touches.empty())
                m_pointer_valid = false;
        }
        result.pointer_update = HostPointerStateUpdate{.reference_position = m_pointer_position,
                                                       .valid = m_pointer_valid};
    }

    if (result.route_diagnostics.gameplay_event) {
        auto& diagnostics = result.route_diagnostics;
        if (hidden_preview) {
            diagnostics.block_reason = HostGameplayInputBlockReason::HiddenPreview;
        } else if (result.debug_result.consumed) {
            diagnostics.block_reason = HostGameplayInputBlockReason::DebugOverlay;
        } else if (result.runtime_ui_result.consumed) {
            diagnostics.block_reason = HostGameplayInputBlockReason::RuntimeUi;
        } else if (is_pointer_event(event.kind) && event.has_host_position && !projected_pointer) {
            diagnostics.block_reason = HostGameplayInputBlockReason::OutsidePresentation;
        } else if (context.layout_admission.gameplay ==
                   presentation::GameplayInputDisposition::BlockedByLayout) {
            diagnostics.block_reason = HostGameplayInputBlockReason::MountedLayout;
        } else if (context.effective_pause.paused) {
            diagnostics.block_reason = HostGameplayInputBlockReason::EffectivePause;
        } else {
            diagnostics.gameplay_admitted = true;
        }

        if (!diagnostics.gameplay_admitted) {
            result.disposition = HostInputDisposition::Consumed;
        } else if (event.proposed_runtime_input) {
            result.runtime_inputs.push_back(*event.proposed_runtime_input);
            result.disposition = HostInputDisposition::Consumed;
        }
    }

    if (!result.runtime_ui_result.runtime_inputs.empty()) {
        if (context.layout_admission.gameplay == presentation::GameplayInputDisposition::Eligible &&
            !context.effective_pause.paused) {
            result.runtime_inputs.insert(result.runtime_inputs.end(),
                                         result.runtime_ui_result.runtime_inputs.begin(),
                                         result.runtime_ui_result.runtime_inputs.end());
        } else {
            result.diagnostics.push_back(
                {.code = context.effective_pause.paused
                             ? "host.input.runtime_ui_input_paused"
                             : "host.input.runtime_ui_input_blocked_by_layout",
                 .message =
                     context.effective_pause.paused
                         ? "RuntimeUI gameplay input was suppressed while gameplay is paused"
                         : "RuntimeUI gameplay input was suppressed by mounted Layout policy"});
        }
        result.disposition = HostInputDisposition::Consumed;
    }

    if (!hidden_preview && event.kind == NormalizedHostEventKind::KeyDown &&
        event.key == NormalizedHostKey::Escape && !event.repeat && !result.debug_result.consumed) {
        result.tooling_actions.emplace_back(RouteSystemEscapeAction{});
        if (context.escape_dismissal)
            result.tooling_actions.emplace_back(
                DismissLayoutEscapeAction{.dismissal = *context.escape_dismissal});
        result.tooling_actions.emplace_back(
            RequestQuitFallbackAction{.admitted = result.route_diagnostics.gameplay_admitted});
        result.disposition = HostInputDisposition::Consumed;
    }

    if (!result.lifecycle_actions.empty() || !result.tooling_actions.empty() ||
        result.debug_result.consumed || result.runtime_ui_result.consumed) {
        result.disposition = HostInputDisposition::Consumed;
    }

    return result;
}

void HostInputRouter::reset() noexcept
{
    m_pointer_position = {};
    m_pointer_valid = false;
    m_active_touches.clear();
}

std::optional<Vec2> HostInputRouter::project_pointer(const NormalizedHostEvent& event,
                                                     const HostInputRoutingContext& context) const
{
    if (!event.has_host_position || !context.presentation)
        return std::nullopt;
    const PresentationTransform transform{*context.presentation};
    const auto normalized = transform.host_logical_to_normalized_game_viewport(event.host_position);
    if (!normalized)
        return std::nullopt;
    return transform.normalized_game_viewport_to_reference(*normalized);
}

} // namespace noveltea::host
