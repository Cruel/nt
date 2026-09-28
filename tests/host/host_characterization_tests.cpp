#include "host/host_input_router.hpp"

#include "noveltea/engine.hpp"
#include "noveltea/engine_tooling.hpp"
#include "noveltea/devtools_console.hpp"
#include "noveltea/devtools_trace.hpp"
#include "noveltea/platform.hpp"
#include "noveltea/runtime_preview_controller.hpp"

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <filesystem>
#include <vector>

namespace noveltea::host {
namespace {

template<typename T>
concept HasDemoModeConfig = requires(T value) { value.demo_mode; };

template<typename T>
concept HasFixtureAudioConfig = requires(T value) {
    value.audio_sfx_paths;
    value.audio_track_specs;
};

template<typename T>
concept HasDemoCoordinates = requires(T value) {
    value.demo_position();
    value.set_demo_position(0.5f, 0.5f);
    value.reset_demo_position();
};

template<typename T>
concept HasDirectAudioControls = requires(T value) {
    value.play_audio_sfx("project:/preview.ogg");
    value.play_audio_track("preview", "project:/preview.ogg");
    value.stop_audio_track("preview");
};

template<typename T>
concept HasScreenshotConfig = requires(T value) { value.screenshot_path; };

template<typename T>
concept HasScreenshotCommand = requires(T value) { value.request_screenshot("capture.png"); };

template<typename T>
concept HasPreviewAccess = requires(T value) {
    value.runtime_preview();
    value.preview_running();
    value.set_preview_running(true);
};

template<typename T>
concept HasFpsTooling = requires(T value) {
    value.set_show_fps_counter(true);
    value.set_fps_cap(60);
    value.show_fps_counter();
    value.fps_cap();
};

template<typename Adapter>
concept HasEngineToolingAccess = requires(Engine& engine, const Engine& const_engine) {
    Adapter::request_screenshot(engine, "capture.png");
    Adapter::set_preview_running(engine, true);
    Adapter::set_show_fps_counter(engine, true);
    Adapter::set_fps_cap(engine, 60);
    Adapter::preview(engine);
    Adapter::preview(const_engine);
    Adapter::preview_running(const_engine);
};

template<typename Adapter>
concept HasDevtoolsToolingAccess = requires(const Engine& engine) {
    Adapter::devtools_capabilities();
    Adapter::devtools_snapshot(engine);
};

template<typename T>
concept HasRuntimeDebugMutationAccess = requires(T value) {
    value.set_variable("flag", core::RuntimeValue{true});
    value.reset_variable("flag");
    value.teleport_room("room");
    value.create_runtime_instance("interactable", "definition", "source");
    value.replace_runtime_instance_configuration("interactable", "instance", "definition",
                                                 "source");
    value.clear_runtime_instance_configuration("interactable", "instance");
    value.destroy_runtime_instance("interactable", "instance");
    value.retarget_runtime_room_exit("room", "exit", "target");
};

template<typename T>
concept HasSandboxTimingConfig = requires(T value) {
    value.frame_limit;
    value.fixed_delta_seconds;
};

template<typename T>
concept HasPreviewDocumentConfig = requires(T value) { value.runtime_ui_document; };

template<typename T>
concept HasPreviewModeConfig = requires(T value) {
    value.keep_runtime_running;
    value.preview_widget;
};

template<typename T>
concept HasReadbackCompatibilityConfig = requires(T value) { value.rmlui_base_direct_compat; };

TEST_CASE("host input routing preserves devtools RuntimeUI Layout and gameplay order")
{
    constexpr std::array expected{
        HostInputRouteStage::PlatformLifecycle, HostInputRouteStage::Devtools,
        HostInputRouteStage::RuntimeUi,         HostInputRouteStage::MountedLayoutAdmission,
        HostInputRouteStage::Gameplay,
    };
    STATIC_REQUIRE(kHostInputRouteOrder == expected);

    HostInputRouter router;
    const auto presentation_result =
        make_presentation_metrics(make_host_surface_metrics(1280, 720, 1280, 720), {});
    REQUIRE(presentation_result);
    const auto presentation = presentation_result.value();
    std::vector<HostInputRouteStage> observed;
    const auto routed =
        router.route({.kind = NormalizedHostEventKind::KeyDown,
                      .proposed_runtime_input = core::RuntimeInputMessage{core::ContinueInput{}}},
                     {.presentation = &presentation, .devtools_enabled = true},
                     {.debug =
                          [&] {
                              observed.push_back(HostInputRouteStage::Devtools);
                              return DebugInputResult{};
                          },
                      .runtime_ui =
                          [&] {
                              observed.push_back(HostInputRouteStage::RuntimeUi);
                              return RuntimeUiInputResult{};
                          }});

    REQUIRE(observed.size() == 2);
    CHECK(observed[0] == HostInputRouteStage::Devtools);
    CHECK(observed[1] == HostInputRouteStage::RuntimeUi);
    CHECK(routed.route_diagnostics.gameplay_admitted);
    REQUIRE(routed.runtime_inputs.size() == 1);
}

TEST_CASE("Engine partial shutdown and unloaded preview reset are cleanup safe")
{
    STATIC_REQUIRE(!HasDemoModeConfig<EngineConfig>);
    STATIC_REQUIRE(!HasFixtureAudioConfig<EngineConfig>);
    STATIC_REQUIRE_FALSE(HasSandboxTimingConfig<EngineConfig>);
    STATIC_REQUIRE_FALSE(HasPreviewDocumentConfig<EngineConfig>);
    STATIC_REQUIRE_FALSE(HasPreviewModeConfig<EngineConfig>);
    STATIC_REQUIRE_FALSE(HasReadbackCompatibilityConfig<EngineConfig>);
    STATIC_REQUIRE(HasSandboxTimingConfig<EngineToolingConfig>);
    STATIC_REQUIRE(HasPreviewDocumentConfig<EngineToolingConfig>);
    STATIC_REQUIRE(HasPreviewModeConfig<EngineToolingConfig>);
    STATIC_REQUIRE(HasReadbackCompatibilityConfig<EngineToolingConfig>);
    STATIC_REQUIRE(!HasDemoCoordinates<Engine>);
    STATIC_REQUIRE(!HasDirectAudioControls<Engine>);
    STATIC_REQUIRE_FALSE(HasPreviewAccess<Engine>);
    STATIC_REQUIRE_FALSE(HasFpsTooling<Engine>);
    STATIC_REQUIRE(HasDirectAudioControls<RuntimePreviewController>);
    STATIC_REQUIRE_FALSE(HasScreenshotConfig<EngineConfig>);
    STATIC_REQUIRE_FALSE(HasScreenshotCommand<Engine>);
    STATIC_REQUIRE(HasScreenshotCommand<RuntimePreviewController>);
    STATIC_REQUIRE(HasEngineToolingAccess<EngineTooling>);
#if NOVELTEA_ENABLE_DEVTOOLS
    STATIC_REQUIRE(HasDevtoolsToolingAccess<EngineTooling>);
    STATIC_REQUIRE(HasRuntimeDebugMutationAccess<RuntimePreviewController>);
#else
    STATIC_REQUIRE_FALSE(HasDevtoolsToolingAccess<EngineTooling>);
    STATIC_REQUIRE_FALSE(HasRuntimeDebugMutationAccess<RuntimePreviewController>);
#endif

    Engine engine;
    const bool original_preview_running = EngineTooling::preview_running(engine);

    CHECK_FALSE(engine.is_running());
    CHECK_FALSE(EngineTooling::preview(engine).reset());
    engine.shutdown();
    engine.shutdown();

    CHECK_FALSE(engine.is_running());
    CHECK(EngineTooling::preview_running(engine) == original_preview_running);
}

TEST_CASE("Asset profiler tooling fails clearly without an active preview service")
{
    Engine engine;

    const auto snapshot = EngineTooling::asset_profiler_snapshot(engine);
    REQUIRE_FALSE(snapshot);
    CHECK(snapshot.error().code == "assets.editor_profiler_unavailable");

    const auto delta = EngineTooling::asset_profiler_delta(engine, core::AssetProfilerSessionId{1},
                                                           core::AssetProfilerSequence{0});
    REQUIRE_FALSE(delta);
    CHECK(delta.error().code == "assets.editor_profiler_unavailable");
}

TEST_CASE("Devtools tooling advertises its shared snapshot capability")
{
    Engine engine;

#if NOVELTEA_ENABLE_DEVTOOLS
    const auto capabilities = EngineTooling::devtools_capabilities();
    REQUIRE_FALSE(capabilities.empty());
    CHECK(std::find(capabilities.begin(), capabilities.end(), "devtools-snapshot-v1") !=
          capabilities.end());

    const auto snapshot = EngineTooling::devtools_snapshot(engine);
    REQUIRE_FALSE(snapshot);
    CHECK(snapshot.error().code == "devtools.engine_uninitialized");
#else
    STATIC_REQUIRE_FALSE(HasDevtoolsToolingAccess<EngineTooling>);
#endif
}

TEST_CASE("Devtools Snapshot owns one typed Runtime Debug Snapshot section")
{
    devtools::DevtoolsSnapshot snapshot;
    CHECK_FALSE(snapshot.runtime.has_value());
    CHECK(snapshot.host.surface == HostSurfaceMetrics{});
    CHECK_FALSE(snapshot.tooling.preview_running);
}

TEST_CASE("Devtools Console retains bounded sequenced history and reports cursor gaps")
{
    devtools::ConsoleBuffer console(3);
    console.set_generations(7, 11);
    console.append(devtools::ConsoleSeverity::Info, "lua", "one");
    console.append(devtools::ConsoleSeverity::Warning, "lua", "two");
    console.append(devtools::ConsoleSeverity::Error, "runtime", "three");

    const auto delta = console.delta_after(0);
    REQUIRE(delta.records.size() == 3);
    CHECK(delta.history_gap);
    CHECK(delta.lost_record_count == 1);
    CHECK(delta.records.front().sequence == 2);
    CHECK(delta.records.front().host_generation == 7);
    CHECK(delta.records.front().runtime_generation == 11);

    const auto cursor_delta = console.delta_after(2);
    REQUIRE(cursor_delta.records.size() == 2);
    CHECK_FALSE(cursor_delta.history_gap);
    CHECK(cursor_delta.records.front().sequence == 3);

    const auto latest_before_clear = console.latest_sequence();
    console.clear();
    CHECK(console.records().empty());
    console.append(devtools::ConsoleSeverity::Info, "lua", "after-clear");
    CHECK(console.records().front().sequence == latest_before_clear + 1);
}

TEST_CASE("Devtools Console retains runtime generation transitions as records")
{
    devtools::ConsoleBuffer console;
    console.set_generations(1, 3);
    console.set_generations(1, 4);

    REQUIRE(console.records().size() == 2);
    CHECK(console.records()[0].generation_marker);
    CHECK(console.records()[0].runtime_generation == 3);
    CHECK(console.records()[1].generation_marker);
    CHECK(console.records()[1].runtime_generation == 4);
    CHECK(console.records()[1].message.find("replacing 3") != std::string::npos);
}

TEST_CASE("Devtools Trace coalesces equivalent routing outcomes without hiding transitions")
{
    devtools::TraceBuffer trace(4);
    trace.set_generations(2, 5, 10);
    devtools::TraceInputRouting over_world{
        .event = "mouse-motion",
        .host_x = 320.0f,
        .host_y = 180.0f,
        .reference_x = 640.0f,
        .reference_y = 360.0f,
        .reference_valid = true,
        .runtime_ui_processed = true,
        .runtime_ui_wants_pointer = false,
        .gameplay_event = true,
        .gameplay_admitted = true,
        .gameplay_block_reason = "none",
        .governing_layout_mode = "none",
        .rmlui_hover = devtools::TraceElementRef{.context = "gameplay",
                                                 .tag = "body",
                                                 .id = "",
                                                 .classes = "",
                                                 .pointer_events = "none"},
        .world_evaluated = true,
        .world_hit = "room/foyer/hotspot/door",
        .world_hovered = "room/foyer/hotspot/door",
    };
    trace.append_input(over_world, 11);
    over_world.host_x = 321.0f;
    over_world.reference_x = 642.0f;
    trace.append_input(over_world, 12);
    over_world.host_x = 322.0f;
    over_world.reference_x = 644.0f;
    trace.append_input(over_world, 13);

    REQUIRE(trace.records().size() == 2);
    const auto& repeated = trace.records().back();
    CHECK(repeated.repeat_count == 3);
    CHECK(repeated.first_frame == 11);
    CHECK(repeated.last_frame == 13);
    CHECK(repeated.sequence > repeated.first_sequence);
    CHECK(repeated.input->host_x == 322.0f);
    CHECK(repeated.input->reference_x == 644.0f);

    auto blocked = over_world;
    blocked.gameplay_admitted = false;
    blocked.gameplay_block_reason = "runtime-ui";
    blocked.runtime_ui_consumed = true;
    blocked.runtime_ui_wants_pointer = true;
    blocked.rmlui_hover = devtools::TraceElementRef{.context = "gameplay",
                                                    .tag = "button",
                                                    .id = "overlay",
                                                    .classes = "",
                                                    .pointer_events = "auto"};
    blocked.world_evaluated = false;
    blocked.world_hit.reset();
    blocked.world_hovered.reset();
    trace.append_input(blocked, 14);
    trace.append_input(over_world, 15);

    REQUIRE(trace.records().size() == 4);
    CHECK(trace.evicted_record_count() == 0);
    CHECK(trace.records()[2].input->gameplay_block_reason == "runtime-ui");
    CHECK(trace.records()[2].input->runtime_ui_consumed);
    REQUIRE(trace.records()[2].input->rmlui_hover);
    CHECK(trace.records()[2].input->rmlui_hover->pointer_events == "auto");
    CHECK_FALSE(trace.records()[2].input->world_evaluated);
    CHECK_FALSE(trace.records()[2].input->world_hit);
    CHECK(trace.records()[3].input->gameplay_admitted);
    CHECK_FALSE(trace.records()[3].input->runtime_ui_consumed);
    REQUIRE(trace.records()[3].input->rmlui_hover);
    CHECK(trace.records()[3].input->rmlui_hover->pointer_events == "none");
    CHECK(trace.records()[3].input->world_evaluated);
    CHECK(trace.records()[3].input->world_hit == "room/foyer/hotspot/door");
    CHECK(trace.records()[3].input->world_hovered == "room/foyer/hotspot/door");

    devtools::TraceBuffer wheel_trace;
    devtools::TraceInputRouting wheel{
        .event = "mouse-wheel",
        .wheel_x = 0.0f,
        .wheel_y = 1.0f,
        .gameplay_event = true,
        .gameplay_admitted = true,
        .gameplay_block_reason = "none",
        .governing_layout_mode = "none",
    };
    wheel_trace.append_input(wheel, 20);
    wheel_trace.append_input(wheel, 21);
    wheel.wheel_y = -1.0f;
    wheel_trace.append_input(wheel, 22);
    REQUIRE(wheel_trace.records().size() == 2);
    CHECK(wheel_trace.records()[0].repeat_count == 2);
    CHECK(wheel_trace.records()[0].input->wheel_y == 1.0f);
    CHECK(wheel_trace.records()[1].input->wheel_y == -1.0f);
}

TEST_CASE("Devtools Trace reports retained gaps and keeps generation and debugger records distinct")
{
    devtools::TraceBuffer trace(3);
    trace.set_generations(1, 7, 1);
    trace.append_debugger_mutation("set variable trust", 2);
    trace.append_input({.event = "mouse-button-down",
                        .mouse_button = 1,
                        .gameplay_event = true,
                        .gameplay_admitted = true,
                        .gameplay_block_reason = "none",
                        .governing_layout_mode = "none",
                        .world_evaluated = true},
                       3);
    trace.set_generations(1, 8, 4);

    const auto delta = trace.delta_after(0);
    REQUIRE(delta.records.size() == 3);
    CHECK(trace.evicted_record_count() == 1);
    CHECK(delta.history_gap);
    CHECK(delta.lost_record_count == 1);
    CHECK(delta.records[0].kind == devtools::TraceRecordKind::DebuggerMutation);
    CHECK(delta.records[1].kind == devtools::TraceRecordKind::InputRouting);
    CHECK(delta.records[1].input->mouse_button == 1);
    CHECK(delta.records[2].kind == devtools::TraceRecordKind::Generation);
    CHECK(delta.records[2].generation_marker);
    CHECK(delta.records[2].runtime_generation == 8);

    trace.clear();
    CHECK(trace.evicted_record_count() == 0);
}

#if NOVELTEA_ENABLE_DEVTOOLS
TEST_CASE("Devtools Snapshot tracks the populated canonical Runtime Debug Snapshot")
{
    const std::filesystem::path runtime_assets{NOVELTEA_TEST_RUNTIME_ASSET_ROOT};
    Engine engine;
    const PlatformConfig platform_config{
        .title = "NovelTea devtools snapshot test",
        .width = 640,
        .height = 360,
        .resizable = false,
        .vsync = false,
    };
    const EngineConfig engine_config{
        .system_asset_root = runtime_assets / "system",
        .project_asset_root = runtime_assets / "project",
        .compiled_project = "project:/projects/runtime_layout_scale_readback.json",
        .load_title_screen = false,
        .enable_audio = false,
    };
    EngineToolingConfig tooling_config;
    tooling_config.keep_runtime_running = true;
    tooling_config.enable_debug_ui = false;
    tooling_config.preview_widget = true;

    REQUIRE(EngineTooling::initialize(engine, platform_config, engine_config, tooling_config));
    EngineTooling::set_preview_running(engine, true);

    const auto narrow_before = EngineTooling::preview(engine).debug_snapshot_value();
    REQUIRE(narrow_before);
    const auto devtools_before = EngineTooling::devtools_snapshot(engine);
    REQUIRE(devtools_before);
    REQUIRE(devtools_before.value_if()->runtime);
    CHECK(RuntimePreviewController::encode_debug_snapshot(*devtools_before.value_if()->runtime) ==
          RuntimePreviewController::encode_debug_snapshot(*narrow_before));
    CHECK(devtools_before.value_if()->runtime->preview_running);
    CHECK(devtools_before.value_if()->tooling.preview_running);

    EngineTooling::set_preview_running(engine, false);
    const auto narrow_after = EngineTooling::preview(engine).debug_snapshot_value();
    REQUIRE(narrow_after);
    const auto devtools_after = EngineTooling::devtools_snapshot(engine);
    REQUIRE(devtools_after);
    REQUIRE(devtools_after.value_if()->runtime);
    CHECK(RuntimePreviewController::encode_debug_snapshot(*devtools_after.value_if()->runtime) ==
          RuntimePreviewController::encode_debug_snapshot(*narrow_after));
    CHECK_FALSE(devtools_after.value_if()->runtime->preview_running);
    CHECK_FALSE(devtools_after.value_if()->tooling.preview_running);
    CHECK(RuntimePreviewController::encode_debug_snapshot(*narrow_before) !=
          RuntimePreviewController::encode_debug_snapshot(*narrow_after));
}
#endif

} // namespace
} // namespace noveltea::host
