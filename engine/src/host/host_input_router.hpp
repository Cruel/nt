#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/gameplay_pause.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/core/runtime_shell_contracts.hpp"
#include "noveltea/presentation/runtime_layout_manager.hpp"
#include "noveltea/surface.hpp"

#include <array>
#include <cstdint>
#include <functional>
#include <optional>
#include <unordered_set>
#include <variant>
#include <vector>

union SDL_Event;

namespace noveltea::host {

enum class HostInputRouteStage : std::uint8_t {
    PlatformLifecycle,
    Devtools,
    RuntimeUi,
    MountedLayoutAdmission,
    Gameplay,
};

inline constexpr std::array kHostInputRouteOrder{
    HostInputRouteStage::PlatformLifecycle, HostInputRouteStage::Devtools,
    HostInputRouteStage::RuntimeUi,         HostInputRouteStage::MountedLayoutAdmission,
    HostInputRouteStage::Gameplay,
};

enum class NormalizedHostEventKind : std::uint8_t {
    Unknown,
    QuitRequested,
    WindowMinimized,
    WindowRestored,
    FocusLost,
    FocusGained,
    EnteredBackground,
    EnteredForeground,
    WindowResized,
    PointerLeft,
    MouseButtonDown,
    MouseButtonUp,
    MouseMotion,
    MouseWheel,
    KeyDown,
    KeyUp,
    TextInput,
    TouchDown,
    TouchUp,
    TouchMotion,
    TouchCanceled,
};

enum class NormalizedHostKey : std::uint8_t {
    Unknown,
    Escape,
};

struct NormalizedHostEvent {
    NormalizedHostEventKind kind = NormalizedHostEventKind::Unknown;
    NormalizedHostKey key = NormalizedHostKey::Unknown;
    std::int32_t scancode = 0;
    std::uint8_t mouse_button = 0;
    std::uint64_t touch_id = 0;
    Vec2 host_position{};
    bool has_host_position = false;
    bool repeat = false;
    std::optional<core::RuntimeInputMessage> proposed_runtime_input;
};

[[nodiscard]] NormalizedHostEvent normalize_host_event(const SDL_Event& event,
                                                       const SurfaceMetrics& host_surface);

enum class HostInputMode : std::uint8_t {
    Runtime,
    Preview,
};

struct DebugInputResult {
    bool consumed = false;
};

struct RuntimeUiInputResult {
    bool consumed = false;
    bool wants_pointer = false;
    bool wants_keyboard = false;
    std::vector<core::RuntimeInputMessage> runtime_inputs;
    std::vector<core::RuntimeShellCommand> shell_commands;
};

struct HostInputRoutingContext {
    const PresentationMetrics* presentation = nullptr;
    presentation::RuntimeLayoutInputPolicyEvaluation layout_admission;
    core::EffectiveGameplayPause effective_pause;
    std::optional<presentation::RuntimeLayoutDismissal> escape_dismissal;
    HostInputMode mode = HostInputMode::Runtime;
    bool preview_visible = true;
    bool devtools_enabled = false;
};

struct RequestQuitHostAction {};
struct SuspendHostAction {};
struct ResumeHostAction {};
struct RefreshHostSurfaceAction {};

using HostLifecycleAction = std::variant<RequestQuitHostAction, SuspendHostAction, ResumeHostAction,
                                         RefreshHostSurfaceAction>;

struct HostInputConsumers {
    std::function<DebugInputResult()> debug;
    std::function<RuntimeUiInputResult()> runtime_ui;
};

struct RouteSystemEscapeAction {};

struct DismissLayoutEscapeAction {
    presentation::RuntimeLayoutDismissal dismissal;
};

struct RequestQuitFallbackAction {
    bool admitted = false;
};

struct RuntimeShellCommandToolingAction {
    core::RuntimeShellCommand command;
};

using HostToolingAction = std::variant<RouteSystemEscapeAction, DismissLayoutEscapeAction,
                                       RequestQuitFallbackAction, RuntimeShellCommandToolingAction>;

struct HostPointerStateUpdate {
    Vec2 game_position{};
    bool valid = false;
};

enum class HostGameplayInputBlockReason : std::uint8_t {
    None,
    HiddenPreview,
    DebugOverlay,
    RuntimeUi,
    OutsidePresentation,
    MountedLayout,
    EffectivePause,
};

struct HostInputRouteDiagnostics {
    bool debug_processed = false;
    bool runtime_ui_processed = false;
    bool gameplay_event = false;
    bool gameplay_admitted = false;
    HostGameplayInputBlockReason block_reason = HostGameplayInputBlockReason::None;
    std::optional<core::MountedLayoutInstanceId> governing_layout;
    core::LayoutInputMode governing_layout_mode = core::LayoutInputMode::None;
};

enum class HostInputDisposition : std::uint8_t {
    Unhandled,
    Consumed,
};

struct HostInputRouteResult {
    std::vector<HostLifecycleAction> lifecycle_actions;
    std::vector<core::RuntimeInputMessage> runtime_inputs;
    std::vector<HostToolingAction> tooling_actions;
    std::optional<HostPointerStateUpdate> pointer_update;
    DebugInputResult debug_result;
    RuntimeUiInputResult runtime_ui_result;
    HostInputRouteDiagnostics route_diagnostics;
    core::Diagnostics diagnostics;
    HostInputDisposition disposition = HostInputDisposition::Unhandled;
};

class HostInputRouter final {
public:
    [[nodiscard]] HostInputRouteResult route(const NormalizedHostEvent& event,
                                             const HostInputRoutingContext& context,
                                             const HostInputConsumers& consumers);

    void reset() noexcept;

private:
    [[nodiscard]] std::optional<Vec2> project_pointer(const NormalizedHostEvent& event,
                                                      const HostInputRoutingContext& context) const;

    Vec2 m_pointer_position{};
    bool m_pointer_valid = false;
    std::unordered_set<std::uint64_t> m_active_touches;
};

} // namespace noveltea::host
