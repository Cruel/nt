#include "host/host_input_router.hpp"

#include <catch2/catch_test_macros.hpp>
#include <SDL3/SDL_events.h>
#include <SDL3/SDL_keycode.h>
#include <SDL3/SDL_mouse.h>

#include <array>
#include <type_traits>
#include <variant>
#include <vector>

namespace noveltea::host {

using presentation::GameplayInputDisposition;
using presentation::RuntimeLayoutDismissal;

static_assert(!std::is_copy_constructible_v<HostInputRouter>);
static_assert(!std::is_copy_assignable_v<HostInputRouter>);
static_assert(!std::is_move_constructible_v<HostInputRouter>);
static_assert(!std::is_move_assignable_v<HostInputRouter>);

namespace {

PresentationMetrics test_presentation()
{
    auto presentation =
        make_presentation_metrics(make_host_surface_metrics(1000, 1000, 1000, 1000), {});
    REQUIRE(presentation);
    return std::move(presentation).value();
}

NormalizedHostEvent gameplay_key()
{
    return {.kind = NormalizedHostEventKind::KeyDown,
            .proposed_runtime_input = core::RuntimeInputMessage{core::ContinueInput{}}};
}

HostInputConsumers passive_consumers(int* debug_calls = nullptr, int* runtime_ui_calls = nullptr)
{
    return {
        .debug =
            [debug_calls] {
                if (debug_calls)
                    ++*debug_calls;
                return DebugInputResult{};
            },
        .runtime_ui =
            [runtime_ui_calls] {
                if (runtime_ui_calls)
                    ++*runtime_ui_calls;
                return RuntimeUiInputResult{};
            },
    };
}

TEST_CASE("normalize_host_event preserves native debugger shortcut state")
{
    SDL_Event event{};
    event.type = SDL_EVENT_KEY_DOWN;
    event.key.key = SDLK_F10;
    event.key.mod = SDL_KMOD_LSHIFT;
    event.key.repeat = true;

    const auto normalized = normalize_host_event(event, {});
    CHECK(normalized.kind == NormalizedHostEventKind::KeyDown);
    CHECK(normalized.key == NormalizedHostKey::F10);
    CHECK(normalized.shift);
    CHECK(normalized.repeat);
}

TEST_CASE("gamepad East button uses the same typed shell Escape route")
{
    SDL_Event event{};
    event.type = SDL_EVENT_GAMEPAD_BUTTON_DOWN;
    event.gbutton.button = SDL_GAMEPAD_BUTTON_EAST;
    const auto normalized = normalize_host_event(event, {});
    CHECK(normalized.kind == NormalizedHostEventKind::KeyDown);
    CHECK(normalized.key == NormalizedHostKey::Escape);

    HostInputRouter router;
    const auto presentation = test_presentation();
    const auto routed =
        router.route(normalized, {.presentation = &presentation}, passive_consumers());
    REQUIRE_FALSE(routed.tooling_actions.empty());
    CHECK(std::holds_alternative<RouteSystemEscapeAction>(routed.tooling_actions.front()));
    event.type = SDL_EVENT_GAMEPAD_BUTTON_UP;
    CHECK(normalize_host_event(event, {}).kind == NormalizedHostEventKind::KeyUp);
}

TEST_CASE("HostInputRouter orders debug RuntimeUI and typed runtime admission")
{
    HostInputRouter router;
    const auto presentation = test_presentation();
    std::vector<HostInputRouteStage> order;

    const auto result =
        router.route(gameplay_key(), {.presentation = &presentation, .devtools_enabled = true},
                     {.debug =
                          [&] {
                              order.push_back(HostInputRouteStage::Devtools);
                              return DebugInputResult{};
                          },
                      .runtime_ui =
                          [&] {
                              order.push_back(HostInputRouteStage::RuntimeUi);
                              return RuntimeUiInputResult{};
                          }});

    REQUIRE(order.size() == 2);
    CHECK(order[0] == HostInputRouteStage::Devtools);
    CHECK(order[1] == HostInputRouteStage::RuntimeUi);
    CHECK(result.route_diagnostics.gameplay_admitted);
    CHECK(result.route_diagnostics.block_reason == HostGameplayInputBlockReason::None);
    REQUIRE(result.runtime_inputs.size() == 1);
    CHECK(std::holds_alternative<core::ContinueInput>(result.runtime_inputs.front()));
    CHECK(result.disposition == HostInputDisposition::Consumed);
}

TEST_CASE("HostInputRouter native debugger capture stops lower input")
{
    HostInputRouter router;
    const auto presentation = test_presentation();
    int runtime_ui_calls = 0;

    const auto result =
        router.route(gameplay_key(), {.presentation = &presentation, .devtools_enabled = true},
                     {.debug = [] { return DebugInputResult{.consumed = true}; },
                      .runtime_ui =
                          [&] {
                              ++runtime_ui_calls;
                              return RuntimeUiInputResult{};
                          }});

    CHECK(result.route_diagnostics.debug_processed);
    CHECK_FALSE(result.route_diagnostics.runtime_ui_processed);
    CHECK(runtime_ui_calls == 0);
    CHECK(result.route_diagnostics.block_reason == HostGameplayInputBlockReason::DebugOverlay);
    CHECK(result.runtime_inputs.empty());
    CHECK(result.disposition == HostInputDisposition::Consumed);
}

TEST_CASE("HostInputRouter handles native debugger shortcuts before debug and RuntimeUI input")
{
    HostInputRouter router;
    const auto presentation = test_presentation();
    int debug_calls = 0;
    int runtime_ui_calls = 0;

    const NormalizedHostEvent toggle{
        .kind = NormalizedHostEventKind::KeyDown,
        .key = NormalizedHostKey::F10,
    };
    const auto toggled =
        router.route(toggle, {.presentation = &presentation, .devtools_enabled = true},
                     passive_consumers(&debug_calls, &runtime_ui_calls));

    REQUIRE(toggled.tooling_actions.size() == 1);
    CHECK(
        std::holds_alternative<ToggleNativeDebugUiToolingAction>(toggled.tooling_actions.front()));
    CHECK(toggled.disposition == HostInputDisposition::Consumed);
    CHECK_FALSE(toggled.route_diagnostics.debug_processed);
    CHECK_FALSE(toggled.route_diagnostics.runtime_ui_processed);
    CHECK_FALSE(toggled.route_diagnostics.gameplay_admitted);
    CHECK(toggled.route_diagnostics.block_reason == HostGameplayInputBlockReason::DevtoolsShortcut);
    CHECK(debug_calls == 0);
    CHECK(runtime_ui_calls == 0);

    const NormalizedHostEvent reset{
        .kind = NormalizedHostEventKind::KeyDown,
        .key = NormalizedHostKey::F10,
        .shift = true,
    };
    const auto reset_result =
        router.route(reset, {.presentation = &presentation, .devtools_enabled = true},
                     passive_consumers(&debug_calls, &runtime_ui_calls));

    REQUIRE(reset_result.tooling_actions.size() == 1);
    CHECK(std::holds_alternative<ResetNativeDebugUiRectToolingAction>(
        reset_result.tooling_actions.front()));
    CHECK(reset_result.disposition == HostInputDisposition::Consumed);
    CHECK(debug_calls == 0);
    CHECK(runtime_ui_calls == 0);
}

TEST_CASE("HostInputRouter ignores repeated or unavailable native debugger shortcuts")
{
    HostInputRouter router;
    const auto presentation = test_presentation();
    int debug_calls = 0;
    int runtime_ui_calls = 0;

    const NormalizedHostEvent repeated{
        .kind = NormalizedHostEventKind::KeyDown,
        .key = NormalizedHostKey::F10,
        .repeat = true,
    };
    const auto repeated_result =
        router.route(repeated, {.presentation = &presentation, .devtools_enabled = true},
                     passive_consumers(&debug_calls, &runtime_ui_calls));
    CHECK(repeated_result.tooling_actions.empty());
    CHECK(repeated_result.route_diagnostics.debug_processed);
    CHECK(repeated_result.route_diagnostics.runtime_ui_processed);

    const NormalizedHostEvent unavailable{
        .kind = NormalizedHostEventKind::KeyDown,
        .key = NormalizedHostKey::F10,
    };
    const auto unavailable_result =
        router.route(unavailable, {.presentation = &presentation, .devtools_enabled = false},
                     passive_consumers(&debug_calls, &runtime_ui_calls));
    CHECK(unavailable_result.tooling_actions.empty());
    CHECK_FALSE(unavailable_result.route_diagnostics.debug_processed);
    CHECK(unavailable_result.route_diagnostics.runtime_ui_processed);
}

TEST_CASE("HostInputRouter RuntimeUI consumption stops gameplay")
{
    HostInputRouter router;
    const auto presentation = test_presentation();

    const auto result =
        router.route(gameplay_key(), {.presentation = &presentation, .devtools_enabled = true},
                     {.debug = [] { return DebugInputResult{}; },
                      .runtime_ui =
                          [] {
                              return RuntimeUiInputResult{
                                  .consumed = true, .wants_pointer = false, .wants_keyboard = true};
                          }});

    CHECK(result.route_diagnostics.runtime_ui_processed);
    CHECK(result.runtime_ui_result.wants_keyboard);
    CHECK(result.route_diagnostics.block_reason == HostGameplayInputBlockReason::RuntimeUi);
    CHECK(result.runtime_inputs.empty());
}

TEST_CASE("HostInputRouter offers admitted primary presses to skippable presentation handling")
{
    HostInputRouter router;
    const auto presentation = test_presentation();
    const NormalizedHostEvent primary_press{.kind = NormalizedHostEventKind::MouseButtonDown,
                                            .mouse_button = SDL_BUTTON_LEFT,
                                            .host_position = {500.0f, 500.0f},
                                            .has_host_position = true};

    const auto admitted =
        router.route(primary_press, {.presentation = &presentation}, passive_consumers());
    CHECK(admitted.route_diagnostics.gameplay_admitted);
    REQUIRE(admitted.tooling_actions.size() == 1);
    CHECK(std::holds_alternative<FastForwardPresentationToolingAction>(
        admitted.tooling_actions.front()));

    const auto ui_consumed =
        router.route(primary_press, {.presentation = &presentation}, {.runtime_ui = [] {
                         return RuntimeUiInputResult{.consumed = true, .wants_pointer = true};
                     }});
    CHECK_FALSE(ui_consumed.route_diagnostics.gameplay_admitted);
    CHECK(ui_consumed.tooling_actions.empty());
}

TEST_CASE("HostInputRouter emits captured RuntimeUI inputs after routing")
{
    HostInputRouter router;
    const auto presentation = test_presentation();
    const auto exit = core::RoomExitId::create("north-exit");
    REQUIRE(exit);

    const auto result = router.route(
        gameplay_key(), {.presentation = &presentation}, {.runtime_ui = [exit] {
            RuntimeUiInputResult result;
            result.consumed = true;
            result.runtime_inputs.emplace_back(core::ContinueInput{});
            result.runtime_inputs.emplace_back(core::NavigateRoomInput{*exit.value_if()});
            result.shell_commands.emplace_back(core::OpenPauseShellCommand{});
            return result;
        }});

    REQUIRE(result.runtime_inputs.size() == 2);
    CHECK(std::holds_alternative<core::ContinueInput>(result.runtime_inputs.front()));
    const auto* navigation = std::get_if<core::NavigateRoomInput>(&result.runtime_inputs.back());
    REQUIRE(navigation);
    CHECK(navigation->exit == *exit.value_if());
    REQUIRE(result.tooling_actions.size() == 1);
    REQUIRE(
        std::holds_alternative<RuntimeShellCommandToolingAction>(result.tooling_actions.front()));
    CHECK(std::holds_alternative<core::OpenPauseShellCommand>(
        std::get<RuntimeShellCommandToolingAction>(result.tooling_actions.front()).command));
}

TEST_CASE("HostInputRouter suppresses captured RuntimeUI gameplay input while paused")
{
    HostInputRouter router;
    const auto presentation = test_presentation();

    const auto result = router.route(
        gameplay_key(),
        {.presentation = &presentation,
         .effective_pause =
             {.paused = true,
              .active_sources = {{.kind = core::GameplayPauseSourceKind::ExplicitSession}}}},
        {.runtime_ui = [] {
            RuntimeUiInputResult result;
            result.consumed = true;
            result.runtime_inputs.emplace_back(core::ContinueInput{});
            return result;
        }});

    CHECK(result.runtime_inputs.empty());
    REQUIRE(result.diagnostics.size() == 1);
    CHECK(result.diagnostics.front().code == "host.input.runtime_ui_input_paused");
}

TEST_CASE("HostInputRouter distinguishes modal and BlockGameplay admission")
{
    const auto presentation = test_presentation();
    const auto instance = core::MountedLayoutInstanceId::from_number(7);

    for (const auto mode :
         std::array{core::LayoutInputMode::Modal, core::LayoutInputMode::BlockGameplay}) {
        HostInputRouter router;
        const auto result = router.route(
            gameplay_key(),
            {.presentation = &presentation,
             .layout_admission = {.gameplay = GameplayInputDisposition::BlockedByLayout,
                                  .governing_instance = instance,
                                  .governing_mode = mode}},
            passive_consumers());

        CHECK_FALSE(result.route_diagnostics.gameplay_admitted);
        CHECK(result.route_diagnostics.block_reason == HostGameplayInputBlockReason::MountedLayout);
        CHECK(result.route_diagnostics.governing_layout == instance);
        CHECK(result.route_diagnostics.governing_layout_mode == mode);
        CHECK(result.runtime_inputs.empty());
    }
}

TEST_CASE("HostInputRouter preserves active UI while effective pause blocks gameplay")
{
    HostInputRouter router;
    const auto presentation = test_presentation();
    int runtime_ui_calls = 0;

    const auto result = router.route(
        gameplay_key(),
        {.presentation = &presentation,
         .effective_pause =
             {.paused = true,
              .active_sources = {{.kind = core::GameplayPauseSourceKind::ExplicitSession}}}},
        passive_consumers(nullptr, &runtime_ui_calls));

    CHECK(runtime_ui_calls == 1);
    CHECK(result.route_diagnostics.runtime_ui_processed);
    CHECK(result.route_diagnostics.block_reason == HostGameplayInputBlockReason::EffectivePause);
    CHECK(result.runtime_inputs.empty());
}

TEST_CASE("HostInputRouter suppresses hidden preview interaction")
{
    HostInputRouter router;
    const auto presentation = test_presentation();
    int debug_calls = 0;
    int runtime_ui_calls = 0;

    const auto result =
        router.route({.kind = NormalizedHostEventKind::MouseButtonDown,
                      .mouse_button = 1,
                      .host_position = {500.0f, 500.0f},
                      .has_host_position = true,
                      .proposed_runtime_input = core::RuntimeInputMessage{core::ContinueInput{}}},
                     {.presentation = &presentation,
                      .mode = HostInputMode::Preview,
                      .preview_visible = false,
                      .devtools_enabled = true},
                     passive_consumers(&debug_calls, &runtime_ui_calls));

    CHECK(debug_calls == 0);
    CHECK(runtime_ui_calls == 0);
    CHECK(result.route_diagnostics.block_reason == HostGameplayInputBlockReason::HiddenPreview);
    CHECK(result.runtime_inputs.empty());
    CHECK(result.tooling_actions.empty());
    REQUIRE(result.pointer_update);
    CHECK_FALSE(result.pointer_update->valid);
}

TEST_CASE("embedded preview focus changes do not suspend or resume the runtime")
{
    HostInputRouter router;
    const auto presentation = test_presentation();

    const auto lost = router.route(
        {.kind = NormalizedHostEventKind::FocusLost},
        {.presentation = &presentation, .mode = HostInputMode::Preview, .preview_visible = true},
        passive_consumers());
    CHECK(lost.lifecycle_actions.empty());

    const auto gained = router.route(
        {.kind = NormalizedHostEventKind::FocusGained},
        {.presentation = &presentation, .mode = HostInputMode::Preview, .preview_visible = true},
        passive_consumers());
    CHECK(gained.lifecycle_actions.empty());
}

TEST_CASE("standalone runtime focus changes do not suspend or resume the host")
{
    HostInputRouter router;
    const auto presentation = test_presentation();

    const auto lost = router.route({.kind = NormalizedHostEventKind::FocusLost},
                                   {.presentation = &presentation, .mode = HostInputMode::Runtime},
                                   passive_consumers());
    CHECK(lost.lifecycle_actions.empty());

    const auto gained = router.route(
        {.kind = NormalizedHostEventKind::FocusGained},
        {.presentation = &presentation, .mode = HostInputMode::Runtime}, passive_consumers());
    CHECK(gained.lifecycle_actions.empty());
}

TEST_CASE("HostInputRouter projects mouse coordinates and rejects presentation bars")
{
    HostInputRouter router;
    const auto presentation = test_presentation();

    const auto inside = router.route({.kind = NormalizedHostEventKind::MouseButtonDown,
                                      .mouse_button = 1,
                                      .host_position = {500.0f, 500.0f},
                                      .has_host_position = true},
                                     {.presentation = &presentation}, passive_consumers());

    REQUIRE(inside.pointer_update);
    CHECK(inside.pointer_update->valid);
    const PresentationTransform transform{presentation};
    const auto normalized = transform.host_logical_to_normalized_game_viewport({500.0f, 500.0f});
    REQUIRE(normalized);
    const Vec2 expected = transform.normalized_game_viewport_to_reference(*normalized);
    CHECK(inside.pointer_update->reference_position.x == expected.x);
    CHECK(inside.pointer_update->reference_position.y == expected.y);
    REQUIRE(inside.tooling_actions.size() == 1);
    CHECK(std::holds_alternative<FastForwardPresentationToolingAction>(
        inside.tooling_actions.front()));

    const auto outside = router.route({.kind = NormalizedHostEventKind::MouseMotion,
                                       .host_position = {500.0f, 10.0f},
                                       .has_host_position = true},
                                      {.presentation = &presentation}, passive_consumers());

    REQUIRE(outside.pointer_update);
    CHECK_FALSE(outside.pointer_update->valid);
    CHECK(outside.route_diagnostics.block_reason ==
          HostGameplayInputBlockReason::OutsidePresentation);
}

TEST_CASE("HostInputRouter tracks touch release and cancellation")
{
    HostInputRouter router;
    const auto presentation = test_presentation();

    const auto down = router.route({.kind = NormalizedHostEventKind::TouchDown,
                                    .touch_id = 42,
                                    .host_position = {500.0f, 500.0f},
                                    .has_host_position = true},
                                   {.presentation = &presentation}, passive_consumers());
    REQUIRE(down.pointer_update);
    CHECK(down.pointer_update->valid);

    const auto up = router.route({.kind = NormalizedHostEventKind::TouchUp,
                                  .touch_id = 42,
                                  .host_position = {500.0f, 500.0f},
                                  .has_host_position = true},
                                 {.presentation = &presentation}, passive_consumers());
    REQUIRE(up.pointer_update);
    CHECK_FALSE(up.pointer_update->valid);

    const auto canceled = router.route({.kind = NormalizedHostEventKind::TouchCanceled,
                                        .touch_id = 99,
                                        .host_position = {500.0f, 500.0f},
                                        .has_host_position = true},
                                       {.presentation = &presentation}, passive_consumers());
    REQUIRE(canceled.pointer_update);
    CHECK_FALSE(canceled.pointer_update->valid);
}

TEST_CASE("HostInputRouter invalidates pointer for resize and focus loss")
{
    HostInputRouter router;
    const auto presentation = test_presentation();
    (void)router.route({.kind = NormalizedHostEventKind::MouseMotion,
                        .host_position = {500.0f, 500.0f},
                        .has_host_position = true},
                       {.presentation = &presentation}, passive_consumers());

    const auto resized = router.route({.kind = NormalizedHostEventKind::WindowResized},
                                      {.presentation = &presentation}, passive_consumers());
    REQUIRE(resized.pointer_update);
    CHECK_FALSE(resized.pointer_update->valid);
    REQUIRE(resized.lifecycle_actions.size() == 1);
    CHECK(std::holds_alternative<RefreshHostSurfaceAction>(resized.lifecycle_actions.front()));

    int debug_calls = 0;
    int runtime_ui_calls = 0;
    const auto focus_lost = router.route({.kind = NormalizedHostEventKind::FocusLost},
                                         {.presentation = &presentation, .devtools_enabled = true},
                                         {.debug =
                                              [&] {
                                                  ++debug_calls;
                                                  return DebugInputResult{};
                                              },
                                          .runtime_ui =
                                              [&] {
                                                  ++runtime_ui_calls;
                                                  return RuntimeUiInputResult{};
                                              }});
    REQUIRE(focus_lost.pointer_update);
    CHECK_FALSE(focus_lost.pointer_update->valid);
    CHECK(focus_lost.lifecycle_actions.empty());
    CHECK(debug_calls == 1);
    CHECK(runtime_ui_calls == 1);

    const auto focus_gained = router.route({.kind = NormalizedHostEventKind::FocusGained},
                                           {.presentation = &presentation}, passive_consumers());
    CHECK(focus_gained.lifecycle_actions.empty());
}

TEST_CASE("HostInputRouter emits deterministic Escape fallback actions")
{
    HostInputRouter router;
    const auto presentation = test_presentation();
    const RuntimeLayoutDismissal dismissal{
        .instance = core::MountedLayoutInstanceId::from_number(12),
        .owner = core::MountedLayoutOwner::Gameplay,
    };

    const auto result = router.route(
        {.kind = NormalizedHostEventKind::KeyDown, .key = NormalizedHostKey::Escape},
        {.presentation = &presentation, .escape_dismissal = dismissal}, passive_consumers());

    REQUIRE(result.tooling_actions.size() == 3);
    CHECK(std::holds_alternative<RouteSystemEscapeAction>(result.tooling_actions[0]));
    CHECK(std::holds_alternative<DismissLayoutEscapeAction>(result.tooling_actions[1]));
    CHECK(std::holds_alternative<RequestQuitFallbackAction>(result.tooling_actions[2]));
    CHECK(std::get<RequestQuitFallbackAction>(result.tooling_actions[2]).admitted);
    CHECK(result.runtime_inputs.empty());
    CHECK(result.disposition == HostInputDisposition::Consumed);
}

TEST_CASE("SDL normalization preserves touch clock and synthetic mouse identity",
          "[devtools-touch]")
{
    SDL_Event event{};
    event.type = SDL_EVENT_FINGER_DOWN;
    event.tfinger.timestamp = 1234000000;
    event.tfinger.fingerID = 42;
    event.tfinger.x = 0.25f;
    event.tfinger.y = 0.5f;
    const auto normalized =
        normalize_host_event(event, make_host_surface_metrics(1000, 1000, 1000, 1000));
    CHECK(normalized.timestamp_ms == 1234);
    CHECK(normalized.touch_id == 42);
    CHECK(normalized.host_position.x == 250);
    event = {};
    event.type = SDL_EVENT_MOUSE_BUTTON_UP;
    event.button.which = SDL_TOUCH_MOUSEID;
    CHECK(normalize_host_event(event, {}).touch_generated_mouse);
}

TEST_CASE("Android devtools two-finger holds toggle on release and reset while stationary",
          "[devtools-touch]")
{
    HostInputRouter router;
    const auto presentation = test_presentation();
    const HostInputRoutingContext context{
        .presentation = &presentation, .devtools_enabled = true, .devtools_touch_gestures = true};
    int debug_calls = 0;
    int ui_calls = 0;
    const auto send = [&](NormalizedHostEventKind kind, std::uint64_t id, std::uint64_t time,
                          Vec2 position = {100, 100}) {
        return router.route({.kind = kind,
                             .touch_id = id,
                             .host_position = position,
                             .has_host_position = true,
                             .timestamp_ms = time},
                            context, passive_consumers(&debug_calls, &ui_calls));
    };
    (void)send(NormalizedHostEventKind::TouchDown, 1, 100);
    const auto captured = send(NormalizedHostEventKind::TouchDown, 2, 200);
    REQUIRE(captured.canceled_touch);
    CHECK(captured.canceled_touch->touch_id == 1);
    CHECK(captured.route_diagnostics.block_reason ==
          HostGameplayInputBlockReason::DevtoolsShortcut);
    CHECK(debug_calls == 1);
    CHECK(ui_calls == 1);
    CHECK_FALSE(router.advance_devtools_touch_hold(1199));

    SECTION("one second arms toggle but does not toggle before release")
    {
        CHECK_FALSE(router.advance_devtools_touch_hold(1200));
        const auto release = send(NormalizedHostEventKind::TouchUp, 1, 1200);
        REQUIRE(release.tooling_actions.size() == 1);
        CHECK(std::holds_alternative<ToggleNativeDebugUiToolingAction>(release.tooling_actions[0]));
        CHECK(send(NormalizedHostEventKind::TouchUp, 2, 1250).tooling_actions.empty());
    }
    SECTION("three seconds resets without any motion events and fires once")
    {
        CHECK_FALSE(router.advance_devtools_touch_hold(3199));
        CHECK(router.advance_devtools_touch_hold(3200));
        CHECK_FALSE(router.advance_devtools_touch_hold(5000));
        CHECK(send(NormalizedHostEventKind::TouchUp, 1, 5100).tooling_actions.empty());
        CHECK(send(NormalizedHostEventKind::TouchUp, 2, 5200).tooling_actions.empty());
    }
    SECTION("release at three seconds resets and shows instead of toggling")
    {
        const auto release = send(NormalizedHostEventKind::TouchUp, 1, 3200);
        REQUIRE(release.tooling_actions.size() == 1);
        CHECK(std::holds_alternative<ResetAndShowNativeDebugUiToolingAction>(
            release.tooling_actions[0]));
    }
    SECTION("both fingers must lift before rearming")
    {
        (void)send(NormalizedHostEventKind::TouchUp, 1, 1500);
        CHECK_FALSE(send(NormalizedHostEventKind::TouchDown, 3, 1550).canceled_touch);
        CHECK_FALSE(router.advance_devtools_touch_hold(5000));
        (void)send(NormalizedHostEventKind::TouchUp, 2, 5100);
        (void)send(NormalizedHostEventKind::TouchUp, 3, 5101);
        (void)send(NormalizedHostEventKind::TouchDown, 4, 5200);
        REQUIRE(send(NormalizedHostEventKind::TouchDown, 5, 5250).canceled_touch);
        const auto release = send(NormalizedHostEventKind::TouchUp, 4, 6250);
        REQUIRE(release.tooling_actions.size() == 1);
        CHECK(std::holds_alternative<ToggleNativeDebugUiToolingAction>(release.tooling_actions[0]));
    }
    SECTION("early release cancels")
    {
        CHECK(send(NormalizedHostEventKind::TouchUp, 1, 1199).tooling_actions.empty());
    }
    SECTION("movement cancels and remaining touches stay consumed")
    {
        const auto moved = send(NormalizedHostEventKind::TouchMotion, 1, 1100, {113, 100});
        CHECK(moved.disposition == HostInputDisposition::Consumed);
        CHECK_FALSE(router.advance_devtools_touch_hold(4000));
        CHECK(send(NormalizedHostEventKind::TouchUp, 1, 4100).tooling_actions.empty());
    }
    SECTION("OS cancellation never toggles")
    {
        CHECK(send(NormalizedHostEventKind::TouchCanceled, 1, 1500).tooling_actions.empty());
        CHECK_FALSE(router.advance_devtools_touch_hold(4000));
    }
    SECTION("third finger cancels")
    {
        (void)send(NormalizedHostEventKind::TouchDown, 3, 250);
        CHECK_FALSE(router.advance_devtools_touch_hold(4000));
        CHECK(send(NormalizedHostEventKind::TouchUp, 1, 4100).tooling_actions.empty());
    }
    SECTION("focus loss cancels")
    {
        (void)router.route({.kind = NormalizedHostEventKind::FocusLost}, context,
                           passive_consumers());
        CHECK_FALSE(router.advance_devtools_touch_hold(4000));
    }
    SECTION("SDL synthesized mouse events cannot leak a gesture click")
    {
        (void)send(NormalizedHostEventKind::TouchUp, 1, 1500);
        (void)send(NormalizedHostEventKind::TouchUp, 2, 1501);
        const auto mouse = router.route(
            {.kind = NormalizedHostEventKind::MouseButtonUp, .touch_generated_mouse = true},
            context, passive_consumers(&debug_calls, &ui_calls));
        CHECK(mouse.disposition == HostInputDisposition::Consumed);
        CHECK_FALSE(mouse.route_diagnostics.runtime_ui_processed);
        CHECK(debug_calls == 1);
    }
}

TEST_CASE("Devtools touch gestures require enabled Android routing and near-simultaneous fingers",
          "[devtools-touch]")
{
    HostInputRouter router;
    HostInputRoutingContext context{.devtools_enabled = true, .devtools_touch_gestures = true};
    std::uint64_t second_time = 200;
    SECTION("devtools disabled") { context.devtools_enabled = false; }
    SECTION("non-Android host") { context.devtools_touch_gestures = false; }
    SECTION("second finger too late") { second_time = 301; }
    (void)router.route({.kind = NormalizedHostEventKind::TouchDown,
                        .touch_id = 1,
                        .has_host_position = true,
                        .timestamp_ms = 100},
                       context, passive_consumers());
    const auto second = router.route({.kind = NormalizedHostEventKind::TouchDown,
                                      .touch_id = 2,
                                      .has_host_position = true,
                                      .timestamp_ms = second_time},
                                     context, passive_consumers());
    CHECK_FALSE(second.canceled_touch);
    CHECK_FALSE(router.advance_devtools_touch_hold(4000));
}

} // namespace
} // namespace noveltea::host
