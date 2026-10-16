#include "integrated_rmlui.hpp"
#include "benchmark_bgfx_diagnostics.hpp"
#include "benchmark_android_lifecycle.hpp"

#include "reference_scene.hpp"
#include "benchmark_assets.hpp"
#include "benchmark_window_size.hpp"
#include "ui_effect_verification.hpp"
#include "noveltea/engine.hpp"
#include "noveltea/engine_tooling.hpp"
#include "noveltea/platform.hpp"
#include "noveltea/renderer.hpp"

#include <SDL3/SDL.h>
#include <RmlUi/Core/Core.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/Element.h>
#include <bgfx/bgfx.h>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>

namespace noveltea::benchmark {
namespace {

// Vary only CSS spelling, not reference geometry or pixels. Engine RmlUi can
// skip cached static UI submissions; the effects workload explicitly exercises
// actual effect rendering every frame, in warmup as well as measurement.
void invalidate_effect_reference(uint32_t frame)
{
    for (int i = 0; i < Rml::GetNumContexts(); ++i) {
        if (auto* context = Rml::GetContext(i)) {
            for (int j = 0; j < context->GetNumDocuments(); ++j) {
                if (auto* document = context->GetDocument(j); document && document->IsVisible()) {
                    if (auto* background = document->GetElementById("reference-background"))
                        background->SetProperty("width", frame % 2 == 0 ? "1920.0px" : "1920px");
                }
            }
        }
    }
}

} // namespace

IntegratedRmlUi::IntegratedRmlUi(bool controlled, bool scaling, bool effects)
    : controlled_(controlled), scaling_(scaling), effects_(effects)
{
}
IntegratedRmlUi::~IntegratedRmlUi()
{
    std::string ignored;
    (void)cleanup(ignored);
}

const char* IntegratedRmlUi::id() const
{
    return effects_      ? "integrated-rmlui-effects"
           : scaling_    ? "integrated-rmlui-scaling"
           : controlled_ ? "integrated-rmlui-controlled"
                         : "integrated-rmlui-production";
}

const char* IntegratedRmlUi::description() const
{
    if (effects_)
        return "production Engine RmlUi advanced styling and nested layers";
    if (scaling_)
        return "production Engine/RmlUiHost scaling: elements, text and lifecycle contexts";
    return controlled_
               ? "production Engine/RuntimeUI/RmlUiHost reference, base-direct "
                 "compatibility"
               : "production Engine/RuntimeUI/RmlUiHost reference, normal renderer composition";
}

bool IntegratedRmlUi::prepare(const Options& options, std::string& reason)
{
    std::string ignored;
    (void)cleanup(ignored);
    environment_ = {};
    effects_requested_ = effects_ ? ui_effect_counts(options) : UiEffectCounts{};
    last_interruption_ = Interruption::None;
    scaling_options_ = options;
    frame_index_ = 0;
    // Use the exact same RML source as the standalone adapter, not a hand
    // maintained lookalike. Generation, disk I/O and Engine initialization
    // precede both warmup and measurement.
#if defined(__ANDROID__)
    // Android's APK assets are read-only; the generated reference document
    // belongs in the benchmark application's private writable storage.
    const char* pref_root = SDL_GetPrefPath("org.noveltea", "benchmark");
    if (!pref_root) {
        reason = "cannot resolve Android benchmark private storage";
        return false;
    }
    const auto project_root = std::filesystem::path(pref_root) / "integrated-reference-project";
#else
    const auto project_root =
        std::filesystem::path(NOVELTEA_BENCHMARK_RESULTS_DIR) / "integrated-reference-project";
#endif
    std::error_code error;
    std::filesystem::create_directories(project_root, error);
    if (error) {
        reason = "cannot prepare integrated reference project: " + error.message();
        return false;
    }
    const auto document_path = project_root / "benchmark-reference.rml";
    {
        std::ofstream output(document_path, std::ios::trunc);
        // Engine's reference canvas is 1920x1080. Convert the same
        // 1280x720 scene into that coordinate domain before loading RML.
        const auto scene =
            effects_   ? ui_effects_reference_scene(ui_effect_counts(options))
            : scaling_ ? ui_scaling_reference_scene(options.ui_elements, options.ui_text_lines)
                       : simple_ui_reference_scene();
        constexpr float engine_reference_width = 1920.0f;
        const float scale = engine_reference_width / static_cast<float>(scene.width);
        if (!output || !(output << simple_ui_reference_markup(scene, scale))) {
            reason = "cannot write integrated reference RML document";
            return false;
        }
    }

    PlatformConfig platform;
    platform.title = "NovelTea Benchmark: Integrated RmlUi";
    if (!requested_benchmark_window_size(options, nullptr, platform.width, platform.height, reason))
        return false;
    // Reject non-16:9 native modes explicitly rather than silently running a
    // smaller configured window and claiming it was native resolution.
    if (platform.width * 9 != platform.height * 16) {
        reason = "integrated reference requires a 16:9 window for visual equivalence";
        return false;
    }
    platform.resizable = false;
    platform.vsync = options.vsync;

    EngineConfig config;
    config.project_asset_root = project_root;
#if !defined(__ANDROID__)
    config.system_asset_root = benchmark_asset_path("system");
#endif
    config.load_title_screen = false;
    config.enable_audio = false;

    EngineToolingConfig tooling;
    tooling.runtime_ui_document = "project:/benchmark-reference.rml";
    tooling.enable_debug_ui = false;
    tooling.show_fps_counter = false;
    tooling.render_perf_logging = false; // Clean and Diagnostic share uninstrumented Engine.
    tooling.fps_cap = 0;
    tooling.rmlui_base_direct_compat = controlled_;
    tooling.rmlui_raster_snap = controlled_ ? RmlUiRasterSnapMode::None : RmlUiRasterSnapMode::All;

    engine_ = std::make_unique<Engine>();
    if (!EngineTooling::initialize(*engine_, platform, config, tooling)) {
        reason = "production Engine/RuntimeUI initialization failed; inspect Engine logs";
        (void)cleanup(ignored);
        return false;
    }

    // Engine deliberately degrades gracefully when runtime UI cannot start.
    // For this benchmark that is a *failure*, never a successful empty draw.
    if (!EngineTooling::runtime_ui_document_ready(*engine_, "runtime-acceptance")) {
        reason = "Engine started without the required integrated RmlUi document";
        (void)cleanup(ignored);
        return false;
    }

    if (scaling_) {
        const auto scene = ui_scaling_reference_scene(options.ui_elements, options.ui_text_lines);
        const auto markup = simple_ui_reference_markup(scene, 1.5f);
        const uint32_t total =
            options.ui_visible_contexts + options.ui_empty_contexts + options.ui_hidden_contexts;
        for (uint32_t index = 1; index < total; ++index) {
            const bool visible = index < options.ui_visible_contexts;
            const bool empty =
                index < options.ui_visible_contexts + options.ui_empty_contexts && !visible;
            const std::string id = "benchmark-layout-" + std::to_string(index);
            if (!EngineTooling::load_ui_fixture_context(*engine_, id, markup, index, visible,
                                                        empty)) {
                reason = "could not create Engine-owned UI context " + id;
                (void)cleanup(ignored);
                return false;
            }
            if (!empty && !EngineTooling::runtime_ui_document_ready(*engine_, id)) {
                reason = "Engine lost scaling fixture document " + id;
                (void)cleanup(ignored);
                return false;
            }
        }
    }

    const auto size = engine_->backbuffer_size();
    const auto& presentation = engine_->presentation();
    if (presentation.reference.size.width != 1920 || presentation.reference.size.height != 1080 ||
        presentation.viewport.host_framebuffer_rect.width < 1 ||
        presentation.viewport.host_framebuffer_rect.height < 1 ||
        presentation.viewport.host_framebuffer_rect.width > size.width ||
        presentation.viewport.host_framebuffer_rect.height > size.height) {
        reason = "unsupported Engine UI reference or letterboxed framebuffer configuration: " +
                 std::to_string(presentation.reference.size.width) + "x" +
                 std::to_string(presentation.reference.size.height) + " ref, viewport " +
                 std::to_string(presentation.viewport.host_framebuffer_rect.width) + "x" +
                 std::to_string(presentation.viewport.host_framebuffer_rect.height) +
                 ", backbuffer " + std::to_string(size.width) + "x" + std::to_string(size.height);
        (void)cleanup(ignored);
        return false;
    }
    environment_.platform = SDL_GetPlatform();
    environment_.frame_path = "engine-tick";
    if (const char* driver = SDL_GetCurrentVideoDriver())
        environment_.video_driver = driver;
    const auto* caps = bgfx::getCaps();
    if (caps) {
        environment_.renderer = bgfx::getRendererName(caps->rendererType);
        environment_.gpu_vendor_id = caps->vendorId;
        environment_.gpu_device_id = caps->deviceId;
    }
    // Engine::backbuffer_size() may be a padded allocation (e.g. 1280x768
    // for a 1280x720 browser canvas). Report the actual presented viewport.
    environment_.width_pixels = presentation.viewport.host_framebuffer_rect.width;
    environment_.height_pixels = presentation.viewport.host_framebuffer_rect.height;
    environment_.ui_reference_width = presentation.reference.size.width;
    environment_.ui_reference_height = presentation.reference.size.height;
    environment_.ui_raster_width = presentation.ui_raster.size.width;
    environment_.ui_raster_height = presentation.ui_raster.size.height;
    environment_.world_raster_width = presentation.world_raster.size.width;
    environment_.world_raster_height = presentation.world_raster.size.height;
    if (size.width < 1 || size.height < 1) {
        reason = "Engine reported invalid integrated framebuffer dimensions";
        (void)cleanup(ignored);
        return false;
    }

    // No extra clock reads or stage accumulation in Clean-mode Engine ticks.
    EngineTooling::set_ui_benchmark_timing(*engine_, options.profile == "diagnostic");

    if (effects_)
        EngineTooling::set_ui_effect_observation(*engine_, true);

    // Prime the production renderer outside any timed samples. Under host
    // contention the first few Engine ticks may not submit the runtime UI,
    // even though its document has loaded. Do not misdiagnose those frames as
    // unsupported CSS. Allow bounded additional preparation frames until
    // all requested backend callbacks have actually appeared.
    for (int i = 0; i < (effects_ ? 48 : 4); ++i) {
        if (effects_)
            invalidate_effect_reference(frame_index_++);
        const bool ticked = engine_->is_running() && engine_->tick();
        if (EngineTooling::host_quit_requested(*engine_)) {
            last_interruption_ = Interruption::Cancelled;
            reason = "integrated Engine cancelled by host quit during preparation";
            (void)cleanup(ignored);
            return false;
        }
        if (!ticked) {
            reason = "production Engine stopped during integrated UI preparation";
            (void)cleanup(ignored);
            return false;
        }
        if (effects_ && i >= 3) {
            const auto observed = EngineTooling::ui_effect_activity(*engine_);
            std::string ignored_reason;
            if (observed &&
                verify_ui_effect_activity(ui_effect_counts(options), *observed, ignored_reason))
                break;
        }
    }
    if (effects_) {
        environment_.ui_effect_activity = EngineTooling::ui_effect_activity(*engine_);
        EngineTooling::set_ui_effect_observation(*engine_, false);
        if (!environment_.ui_effect_activity ||
            !verify_ui_effect_activity(ui_effect_counts(options), *environment_.ui_effect_activity,
                                       reason)) {
            if (reason.empty())
                reason = "integrated RmlUi effect backend not available";
            (void)cleanup(ignored);
            return false;
        }
    }
    // Capture Engine-observed framebuffer/compositor state only after real
    // frames have run; the report must not infer it from the scenario name.
    const auto& renderer = EngineTooling::renderer(*engine_);
    environment_.engine_postprocess_active = renderer.postprocess_surface_diagnostics().active;
    const auto backend = EngineTooling::runtime_ui_render_configuration(*engine_);
    if (!backend) {
        reason = "Engine UI renderer settings unavailable despite loaded document";
        (void)cleanup(ignored);
        return false;
    }
    environment_.ui_backend = UiBackendSettings{
        .reference_msaa_samples = backend->reference_msaa_samples,
        .base_direct_compatibility_requested = backend->base_direct_compatibility_requested,
        .preserve_backbuffer = backend->preserve_backbuffer,
        .optimized_render_path = backend->optimized_render_path,
        .output_framebuffer_bound = backend->output_framebuffer_bound,
        .geometry_raster_snapping = backend->geometry_raster_snapping,
        .text_raster_snapping = backend->text_raster_snapping,
        .viewport_width = backend->viewport_width,
        .viewport_height = backend->viewport_height,
    };
    return true;
}

Readiness IntegratedRmlUi::readiness(std::string& reason)
{
    if (!engine_ || !engine_->is_running()) {
        if (engine_ && EngineTooling::host_quit_requested(*engine_)) {
            last_interruption_ = Interruption::Cancelled;
            reason = "integrated Engine cancelled by host quit before measurement";
        } else {
            reason = "integrated production Engine is not running";
        }
        return Readiness::Failed;
    }
    return Readiness::Ready;
}

bool IntegratedRmlUi::frame(std::string& reason)
{
#if defined(__ANDROID__)
    if (!android_benchmark_foreground()) {
        last_interruption_ = Interruption::Recoverable;
        reason = "Android Activity suspended during integrated RmlUi benchmark";
        return false;
    }
#endif
    if (scaling_ &&
        (scaling_options_.ui_redraw == "continuous" ||
         (scaling_options_.ui_text_mode == "dynamic" && scaling_options_.ui_dynamic_lines > 0))) {
        const bool dynamic =
            scaling_options_.ui_text_mode == "dynamic" && scaling_options_.ui_dynamic_lines > 0;
        const bool continuous = scaling_options_.ui_redraw == "continuous";
        // Every Engine-created lifecycle context is updated/rendered through the
        // production host; only the text mutation is driven by this fixture.
        for (int i = 0; i < Rml::GetNumContexts(); ++i) {
            if (auto* context = Rml::GetContext(i)) {
                for (int j = 0; j < context->GetNumDocuments(); ++j) {
                    if (auto* document = context->GetDocument(j)) {
                        if (document->IsVisible()) {
                            if (continuous) {
                                if (auto* element = document->GetElementById("ui-element-0"))
                                    element->SetProperty("width", frame_index_ % 2 == 0 ? "22.50px"
                                                                                        : "22.5px");
                            }
                            if (dynamic) {
                                for (uint32_t line = 0; line < scaling_options_.ui_dynamic_lines;
                                     ++line) {
                                    if (auto* text = document->GetElementById("ui-text-" +
                                                                              std::to_string(line)))
                                        text->SetInnerRML(ui_dynamic_text(frame_index_, line));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if (effects_)
        invalidate_effect_reference(frame_index_);
    ++frame_index_;
    const bool ticked = engine_ && engine_->is_running() && engine_->tick();
    if (engine_ && EngineTooling::host_quit_requested(*engine_)) {
        last_interruption_ = Interruption::Cancelled;
        reason = "integrated Engine cancelled by host quit (Escape/close)";
        return false;
    }
    if (!ticked) {
        reason = "production Engine frame failed or was interrupted";
        return false;
    }
#if defined(__ANDROID__)
    if (!android_benchmark_foreground()) {
        last_interruption_ = Interruption::Recoverable;
        reason = "Android Activity suspended during integrated RmlUi frame";
        return false;
    }
#endif
    return true; // One tick renders one full Engine frame, not context completions.
}

void IntegratedRmlUi::diagnostic_frame(DiagnosticObservation& observation)
{
    capture_bgfx_diagnostics(observation);
    if (engine_) {
        if (const auto stages = EngineTooling::ui_benchmark_frame_timing(*engine_)) {
            observation.cpu_update_ms = stages->first * 1000.0;
            observation.cpu_submission_ms = stages->second * 1000.0;
        }
    }
    // No submitted-frame identity crosses the production Engine tick boundary.
}

bool IntegratedRmlUi::complete(std::string& reason)
{
    if (!effects_)
        return true;
    environment_.ui_effect_activity = EngineTooling::ui_effect_activity(*engine_);
    if (!environment_.ui_effect_activity) {
        reason = "integrated RmlUi effect backend unavailable after measured frames";
        return false;
    }
    return verify_ui_effect_activity(effects_requested_, *environment_.ui_effect_activity, reason);
}

bool IntegratedRmlUi::cleanup(std::string& reason)
{
    if (!engine_)
        return true;
    engine_->shutdown();
    // Engine::shutdown() is void; check that the production renderer actually
    // released its bgfx device before another host is allowed to initialize.
    const bool released = !EngineTooling::renderer(*engine_).is_initialized();
    engine_.reset(); // Engine is single-use; each trial gets a fresh instance.
    if (!released) {
        reason = "production Engine shutdown did not release its renderer";
        return false;
    }
    return true;
}

} // namespace noveltea::benchmark
