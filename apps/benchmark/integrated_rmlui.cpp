#include "integrated_rmlui.hpp"

#include "reference_scene.hpp"
#include "benchmark_assets.hpp"
#include "noveltea/engine.hpp"
#include "noveltea/engine_tooling.hpp"
#include "noveltea/platform.hpp"
#include "noveltea/renderer.hpp"

#include <SDL3/SDL.h>
#include <bgfx/bgfx.h>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>

namespace noveltea::benchmark {

IntegratedRmlUi::IntegratedRmlUi(bool controlled) : controlled_(controlled) {}
IntegratedRmlUi::~IntegratedRmlUi()
{
    std::string ignored;
    (void)cleanup(ignored);
}

const char* IntegratedRmlUi::id() const
{
    return controlled_ ? "integrated-rmlui-controlled" : "integrated-rmlui-production";
}

const char* IntegratedRmlUi::description() const
{
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
    // A different aspect ratio introduces production letterboxing. This
    // Stage-1 fixed reference deliberately supports only comparable 16:9
    // windows, rather than presenting misleading cross-host equivalence.
    if (options.width * 9 != options.height * 16) {
        reason = "integrated reference requires a 16:9 window for visual equivalence";
        return false;
    }

    // Use the exact same RML source as the standalone adapter, not a hand
    // maintained lookalike. Generation, disk I/O and Engine initialization
    // precede both warmup and measurement.
    const auto project_root =
        std::filesystem::path(NOVELTEA_BENCHMARK_RESULTS_DIR) / "integrated-reference-project";
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
        const auto scene = simple_ui_reference_scene();
        constexpr float engine_reference_width = 1920.0f;
        const float scale = engine_reference_width / static_cast<float>(scene.width);
        if (!output || !(output << simple_ui_reference_markup(scene, scale))) {
            reason = "cannot write integrated reference RML document";
            return false;
        }
    }

    PlatformConfig platform;
    platform.title = "NovelTea Benchmark: Integrated RmlUi";
    platform.width = options.width;
    platform.height = options.height;
    platform.resizable = false;
    platform.vsync = options.vsync;

    EngineConfig config;
    config.project_asset_root = project_root;
    config.system_asset_root = benchmark_asset_path("assets/system");
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

    const auto size = engine_->backbuffer_size();
    const auto& presentation = engine_->presentation();
    if (presentation.reference.size.width != 1920 || presentation.reference.size.height != 1080 ||
        presentation.viewport.host_framebuffer_rect.width != size.width ||
        presentation.viewport.host_framebuffer_rect.height != size.height) {
        reason = "unsupported Engine UI reference or letterboxed framebuffer configuration";
        (void)cleanup(ignored);
        return false;
    }
    environment_.platform = SDL_GetPlatform();
    if (const char* driver = SDL_GetCurrentVideoDriver())
        environment_.video_driver = driver;
    const auto* caps = bgfx::getCaps();
    if (caps) {
        environment_.renderer = bgfx::getRendererName(caps->rendererType);
        environment_.gpu_vendor_id = caps->vendorId;
        environment_.gpu_device_id = caps->deviceId;
    }
    environment_.width_pixels = size.width;
    environment_.height_pixels = size.height;
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

    // First rendered frames exercise the real UI compilation and font atlas
    // outside any timed samples, including --smoke / zero-warmup runs.
    for (int i = 0; i < 4; ++i) {
        if (!engine_->is_running() || !engine_->tick()) {
            reason = "production Engine stopped during integrated UI preparation";
            (void)cleanup(ignored);
            return false;
        }
    }
    // Capture Engine-observed framebuffer/compositor state only after real
    // frames have run; the report must not infer it from the scenario name.
    const auto& renderer = EngineTooling::renderer(*engine_);
    environment_.engine_postprocess_active = renderer.postprocess_surface_diagnostics().active;
    return true;
}

Readiness IntegratedRmlUi::readiness(std::string& reason)
{
    if (!engine_ || !engine_->is_running()) {
        reason = "integrated production Engine is not running";
        return Readiness::Failed;
    }
    return Readiness::Ready;
}

bool IntegratedRmlUi::frame(std::string& reason)
{
    if (!engine_ || !engine_->is_running() || !engine_->tick()) {
        reason = "production Engine frame failed or was interrupted";
        return false;
    }
    return true; // One tick renders one full Engine frame, not context completions.
}

bool IntegratedRmlUi::complete(std::string&) { return true; }

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
