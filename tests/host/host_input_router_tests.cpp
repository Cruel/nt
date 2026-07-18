#include "host/host_input_router.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <variant>
#include <vector>

namespace noveltea::host {
namespace {

PresentationMetrics test_presentation()
{
    return make_presentation_metrics(make_surface_metrics(1000, 1000, 1000, 1000));
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

TEST_CASE("HostInputRouter debug overlay capture stops lower input")
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

TEST_CASE("HostInputRouter emits captured RuntimeUI inputs after routing")
{
    HostInputRouter router;
    const auto presentation = test_presentation();

    const auto result =
        router.route(gameplay_key(), {.presentation = &presentation}, {.runtime_ui = [] {
                         RuntimeUiInputResult result;
                         result.consumed = true;
                         result.runtime_inputs.emplace_back(core::ContinueInput{});
                         result.shell_commands.emplace_back(core::OpenPauseShellCommand{});
                         return result;
                     }});

    REQUIRE(result.runtime_inputs.size() == 1);
    CHECK(std::holds_alternative<core::ContinueInput>(result.runtime_inputs.front()));
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
    CHECK(inside.pointer_update->game_position.x ==
          500.0f - static_cast<float>(presentation.host_logical_viewport.x));
    CHECK(inside.pointer_update->game_position.y ==
          500.0f - static_cast<float>(presentation.host_logical_viewport.y));
    REQUIRE(inside.tooling_actions.size() == 1);
    CHECK(std::holds_alternative<PointerPressedToolingAction>(inside.tooling_actions.front()));

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
    REQUIRE(focus_lost.lifecycle_actions.size() == 1);
    CHECK(std::holds_alternative<SuspendHostAction>(focus_lost.lifecycle_actions.front()));
    CHECK(debug_calls == 1);
    CHECK(runtime_ui_calls == 1);

    const auto focus_gained = router.route({.kind = NormalizedHostEventKind::FocusGained},
                                           {.presentation = &presentation}, passive_consumers());
    REQUIRE(focus_gained.lifecycle_actions.size() == 1);
    CHECK(std::holds_alternative<ResumeHostAction>(focus_gained.lifecycle_actions.front()));
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

} // namespace
} // namespace noveltea::host
