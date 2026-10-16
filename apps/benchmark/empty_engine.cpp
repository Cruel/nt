#include "empty_engine.hpp"

#include "benchmark_assets.hpp"
#include "benchmark_android_lifecycle.hpp"
#include "benchmark_bgfx_diagnostics.hpp"
#include "benchmark_window_size.hpp"
#include "noveltea/engine.hpp"
#include "noveltea/engine_tooling.hpp"
#include "noveltea/platform.hpp"
#include "noveltea/renderer.hpp"

#include <SDL3/SDL.h>
#include <bgfx/bgfx.h>

#include <fstream>
#include <utility>

namespace noveltea::benchmark {

namespace {

bool stage_project(const Options& options, EngineWorkload workload,
                   const std::filesystem::path& root, std::string& reason)
{
    std::error_code error;
    std::filesystem::create_directories(root, error);
    if (error) {
        reason = "cannot create benchmark Compiled Project directory: " + error.message();
        return false;
    }
    if (workload == EngineWorkload::FeatureLab && options.feature_lab_package.empty()) {
        reason = "Feature Lab is optional: supply --feature-lab-package with an exported .ntpkg";
        return false;
    }
    const auto source = workload == EngineWorkload::FeatureLab
                            ? std::filesystem::path(options.feature_lab_package)
                            : benchmark_asset_path("compiled-project-minimal.json");
    size_t length = 0;
    void* bytes = SDL_LoadFile(source.string().c_str(), &length);
    if (!bytes || length == 0) {
        SDL_free(bytes);
        reason = "cannot read benchmark Compiled Project asset: " + source.string();
        return false;
    }
    const auto destination =
        root /
        (workload == EngineWorkload::FeatureLab ? "feature-lab.ntpkg" : "benchmark-compiled.json");
    std::ofstream output(destination, std::ios::binary | std::ios::trunc);
    const bool saved = output && bool(output.write(static_cast<const char*>(bytes),
                                                   static_cast<std::streamsize>(length)));
    SDL_free(bytes);
    if (!saved) {
        reason = "cannot stage benchmark Compiled Project: " + destination.string();
        return false;
    }
    if (workload != EngineWorkload::FeatureLab) {
        // The canonical compiled golden fixture references this real Lua bootstrap.
        // Copying the compiled project is not a synthetic Runtime Session.
        std::filesystem::create_directories(root / "scripts", error);
        if (error) {
            reason = "cannot stage bootstrap script: " + error.message();
            return false;
        }
        std::ofstream script(root / "scripts/bootstrap.lua", std::ios::trunc);
        if (!(script << "return {}\n")) {
            reason = "cannot write benchmark bootstrap script";
            return false;
        }
    }
    return true;
}

} // namespace

EmptyEngine::EmptyEngine(std::filesystem::path system_asset_root, EngineWorkload workload)
    : system_asset_root_(std::move(system_asset_root)), workload_(workload)
{
}

const char* EmptyEngine::id() const
{
    switch (workload_) {
    case EngineWorkload::EmptyEngine:
        return "engine-empty";
    case EngineWorkload::EmptyProject:
        return "engine-compiled-empty";
    case EngineWorkload::StaticMenu:
        return "engine-compiled-menu";
    case EngineWorkload::FeatureLab:
        return "engine-feature-lab";
    }
    return "engine-empty";
}

const char* EmptyEngine::description() const
{
    switch (workload_) {
    case EngineWorkload::EmptyEngine:
        return "production Engine tick without a loaded Compiled Project";
    case EngineWorkload::EmptyProject:
        return "production Engine and running empty Compiled Project Runtime Session";
    case EngineWorkload::StaticMenu:
        return "production Engine with Compiled Project and static title-menu UI";
    case EngineWorkload::FeatureLab:
        return "production Engine with optional packaged Feature Lab authored home UI and "
               "Runtime Session";
    }
    return "";
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
    platform.title = workload_ == EngineWorkload::EmptyEngine
                         ? "NovelTea Benchmark: Empty Engine"
                         : "NovelTea Benchmark: Compiled Project";
    if (!requested_benchmark_window_size(options, nullptr, platform.width, platform.height, reason))
        return false;
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
    if (workload_ != EngineWorkload::EmptyEngine) {
#if defined(__ANDROID__)
        const char* preference = SDL_GetPrefPath("org.noveltea", "benchmark");
        if (!preference) {
            reason = "cannot resolve Android benchmark project storage";
            return false;
        }
        const auto project_root = std::filesystem::path(preference) / "compiled-project-workload";
#else
        const auto project_root =
            std::filesystem::path(NOVELTEA_BENCHMARK_RESULTS_DIR) / "compiled-project-workload";
#endif
        if (!stage_project(options, workload_, project_root, reason))
            return false;
        config.project_asset_root = project_root;
        config.compiled_project = workload_ == EngineWorkload::FeatureLab
                                      ? "project:/feature-lab.ntpkg"
                                      : "project:/benchmark-compiled.json";
        config.load_title_screen = workload_ == EngineWorkload::StaticMenu;
    }

    EngineToolingConfig tooling;
    tooling.enable_debug_ui = false;
    tooling.show_fps_counter = false;
    tooling.render_perf_logging = false;
    tooling.fps_cap = 0;
    tooling.keep_runtime_running = workload_ != EngineWorkload::EmptyEngine;
    tooling.fixed_delta_seconds = options.clock_policy == "fixed-step" ? 1.0 / 60.0 : 0.0;

    engine_ = std::make_unique<Engine>();
    if (!EngineTooling::initialize(*engine_, platform, config, tooling)) {
        reason = "production Engine initialization failed; inspect Engine logs";
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
        const bool ticked = engine_->is_running() && engine_->tick();
        if (EngineTooling::host_quit_requested(*engine_)) {
            last_interruption_ = Interruption::Cancelled;
            reason = "empty Engine cancelled by host quit during preparation";
            return false;
        }
        if (!ticked) {
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
        if (engine_ && EngineTooling::host_quit_requested(*engine_)) {
            last_interruption_ = Interruption::Cancelled;
            reason = "empty Engine cancelled by host quit before measurement";
        } else {
            reason = "empty Engine is not running";
        }
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
    const bool ticked = engine_ && engine_->is_running() && engine_->tick();
    if (engine_ && EngineTooling::host_quit_requested(*engine_)) {
        last_interruption_ = Interruption::Cancelled;
        reason = "empty Engine cancelled by host quit (Escape/close)";
        return false;
    }
    if (!ticked) {
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
