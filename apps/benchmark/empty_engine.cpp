#include "empty_engine.hpp"

#include "benchmark_assets.hpp"
#include "benchmark_android_lifecycle.hpp"
#include "benchmark_bgfx_diagnostics.hpp"
#include "noveltea/engine.hpp"
#include "noveltea/engine_tooling.hpp"
#include "noveltea/platform.hpp"
#include "noveltea/renderer.hpp"

#include <SDL3/SDL.h>
#include <bgfx/bgfx.h>

#include <utility>

namespace noveltea::benchmark {

EmptyEngine::EmptyEngine(std::filesystem::path system_asset_root)
    : system_asset_root_(std::move(system_asset_root))
{
}

EmptyEngine::~EmptyEngine()
{
    std::string ignored;
    (void)cleanup(ignored);
}

bool EmptyEngine::prepare(const Options& options, std::string& reason)
{
    if (!cleanup(reason))
        return false;
    environment_ = {};
    last_interruption_ = Interruption::None;

    PlatformConfig platform;
    platform.title = "NovelTea Benchmark: Empty Engine";
    platform.width = options.width;
    platform.height = options.height;
    platform.resizable = false;
    platform.vsync = options.vsync;

    EngineConfig config;
#if defined(__ANDROID__)
    // The Android Engine mounts system:/ from the APK's SDL packaged asset source.
    // A filesystem override would bypass that source and fail to find its files.
    config.system_asset_root = system_asset_root_;
#else
    config.system_asset_root =
        system_asset_root_.empty() ? benchmark_asset_path("system") : system_asset_root_;
#endif
    config.compiled_project.clear();
    config.load_title_screen = false;
    config.enable_audio = false;

    EngineToolingConfig tooling;
    tooling.enable_debug_ui = false;
    tooling.show_fps_counter = false;
    tooling.render_perf_logging = false;
    tooling.fps_cap = 0;

    engine_ = std::make_unique<Engine>();
    if (!EngineTooling::initialize(*engine_, platform, config, tooling)) {
        reason = "empty Engine initialization failed; inspect Engine logs";
        return false; // The runner also cleans up failed preparation.
    }
    const auto size = engine_->backbuffer_size();
    if (size.width <= 0 || size.height <= 0) {
        reason = "empty Engine reported an invalid framebuffer size";
        return false;
    }
    environment_.platform = SDL_GetPlatform();
    if (const char* driver = SDL_GetCurrentVideoDriver())
        environment_.video_driver = driver;
    environment_.frame_path = "engine-tick";
    if (const auto* caps = bgfx::getCaps()) {
        environment_.renderer = bgfx::getRendererName(caps->rendererType);
        environment_.gpu_vendor_id = caps->vendorId;
        environment_.gpu_device_id = caps->deviceId;
    }
    const auto& presentation = engine_->presentation();
    // Padded bgfx allocation dimensions are not the presented framebuffer.
    environment_.width_pixels = presentation.viewport.host_framebuffer_rect.width;
    environment_.height_pixels = presentation.viewport.host_framebuffer_rect.height;
    environment_.ui_reference_width = presentation.reference.size.width;
    environment_.ui_reference_height = presentation.reference.size.height;
    environment_.ui_raster_width = presentation.ui_raster.size.width;
    environment_.ui_raster_height = presentation.ui_raster.size.height;
    environment_.world_raster_width = presentation.world_raster.size.width;
    environment_.world_raster_height = presentation.world_raster.size.height;

    // Submit real Engine frames and allow initial renderer work to settle
    // before Ready, including --smoke's zero-duration warmup.
    for (int frame = 0; frame < 4; ++frame) {
        if (!engine_->is_running() || !engine_->tick()) {
            reason = "empty Engine stopped during preparation";
            return false;
        }
    }
    environment_.engine_postprocess_active =
        EngineTooling::renderer(*engine_).postprocess_surface_diagnostics().active;
    if (const auto backend = EngineTooling::runtime_ui_render_configuration(*engine_)) {
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
    }
    return true;
}

Readiness EmptyEngine::readiness(std::string& reason)
{
    if (!engine_ || !engine_->is_running()) {
        reason = "empty Engine is not running";
        return Readiness::Failed;
    }
    return Readiness::Ready;
}

bool EmptyEngine::frame(std::string& reason)
{
#if defined(__ANDROID__)
    if (!android_benchmark_foreground()) {
        last_interruption_ = Interruption::Recoverable;
        reason = "Android Activity suspended during empty Engine benchmark";
        return false;
    }
#endif
    if (!engine_ || !engine_->is_running() || !engine_->tick()) {
        reason = "empty Engine frame failed or was interrupted";
        return false;
    }
#if defined(__ANDROID__)
    if (!android_benchmark_foreground()) {
        last_interruption_ = Interruption::Recoverable;
        reason = "Android Activity suspended during empty Engine frame";
        return false;
    }
#endif
    return true;
}

void EmptyEngine::diagnostic_frame(DiagnosticObservation& observation)
{
    capture_bgfx_diagnostics(observation);
    // Engine owns bgfx::frame(); its submitted frame ID is not exported, so
    // render-thread snapshots cannot establish a GPU measurement window.
}

bool EmptyEngine::complete(std::string&) { return true; }

bool EmptyEngine::cleanup(std::string& reason)
{
    if (!engine_)
        return true;
    engine_->shutdown();
    const bool released = !EngineTooling::renderer(*engine_).is_initialized();
    engine_.reset(); // The production Engine is single-use; never reuse across trials.
    if (!released) {
        reason = "empty Engine shutdown left its renderer initialized";
        return false;
    }
    return true;
}

} // namespace noveltea::benchmark
