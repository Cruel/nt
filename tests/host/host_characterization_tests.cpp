#include "host/host_input_router.hpp"

#include "noveltea/engine.hpp"
#include "noveltea/engine_tooling.hpp"
#include "noveltea/runtime_preview_controller.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
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
    const auto presentation = make_presentation_metrics(make_surface_metrics(1280, 720, 1280, 720));
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
    STATIC_REQUIRE(HasDirectAudioControls<RuntimePreviewController>);
    STATIC_REQUIRE_FALSE(HasScreenshotConfig<EngineConfig>);
    STATIC_REQUIRE(HasScreenshotCommand<Engine>);
    STATIC_REQUIRE(HasScreenshotCommand<RuntimePreviewController>);

    Engine engine;
    const bool original_preview_running = engine.preview_running();

    CHECK_FALSE(engine.is_running());
    CHECK_FALSE(engine.runtime_preview().reset());
    engine.shutdown();
    engine.shutdown();

    CHECK_FALSE(engine.is_running());
    CHECK(engine.preview_running() == original_preview_running);
}

} // namespace
} // namespace noveltea::host
