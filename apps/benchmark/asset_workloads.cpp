#include "asset_workloads.hpp"

#include "benchmark_android_lifecycle.hpp"
#include "benchmark_bgfx_diagnostics.hpp"
#include "benchmark_assets.hpp"
#include "benchmark_window_size.hpp"
#include "noveltea/core/compiled_project_codec.hpp"

#include <SDL3/SDL.h>
#include <bgfx/bgfx.h>

#include <array>
#include <limits>
#include <utility>

namespace noveltea::benchmark {
namespace {

constexpr std::array<const char*, 3> kImages = {
    "project:/images/stress-image-1.png",
    "project:/images/stress-image-2.png",
    "project:/images/stress-image-3.png",
};
constexpr const char* kProject = "project:/compiled-project-minimal.json";

std::string source_failure(const assets::AssetSourceError& error)
{
    return error.code + ": " + error.message;
}

std::string diagnostic_failure(const core::Diagnostics& diagnostics)
{
    return diagnostics.empty() ? "no diagnostic supplied"
                               : diagnostics.front().code + ": " + diagnostics.front().message;
}

} // namespace

AssetScenario::~AssetScenario()
{
    std::string ignored;
    (void)cleanup(ignored);
}

const char* AssetScenario::description() const
{
    if (id_ == "asset-source-read")
        return "production AssetManager source read of three Feature Lab PNGs; CPU only, "
               "OS page cache not controlled";
    if (id_ == "asset-project-prepare")
        return "production AssetManager project read and Compiled Project codec validation; "
               "CPU only, no Engine or graphics";
    return "production typed PNG image preparation, residency admission and initial bgfx "
           "texture realization; no ordinary scene frames";
}

void AssetScenario::mount_assets()
{
#if defined(__ANDROID__)
    assets_.mount("project", std::make_shared<assets::SdlPackagedAssetSource>());
    if (requires_graphics())
        assets_.mount("system", std::make_shared<assets::SdlPackagedAssetSource>("system"));
#else
    assets_.mount_directory("project", benchmark_asset_path(""));
    if (requires_graphics())
        assets_.mount_directory("system", benchmark_asset_path("system"));
#endif
}

bool AssetScenario::initialize_graphics(const Options& options, std::string& reason)
{
    PlatformConfig config{.title = "NovelTea Asset Benchmark",
                          .width = options.width,
                          .height = options.height,
                          .resizable = false,
                          .vsync = options.vsync};
    if (!requested_benchmark_window_size(options, nullptr, config.width, config.height, reason))
        return false;
    if (!platform_.initialize(config)) {
        reason = "asset benchmark Platform initialization failed";
        return false;
    }
#if defined(__ANDROID__)
    while (!android_benchmark_foreground())
        SDL_Delay(100);
#endif
    executor_ = std::make_unique<jobs::InlineJobExecutor>();
    constexpr std::uint64_t budget = 128u * 1024u * 1024u;
    residency_ = std::make_shared<assets::AssetResidencyManager>(
        assets::ResidencyBudget{budget, budget, budget, budget, budget, budget, budget, budget});
    auto configured = assets_.configure_async_requests(*executor_, residency_);
    if (!configured) {
        reason = "asset requests could not be configured: " + configured.error().code + ": " +
                 configured.error().message;
        return false;
    }
    const auto surface = platform_.surface();
    environment_.width_pixels = surface.framebuffer_size.width;
    environment_.height_pixels = surface.framebuffer_size.height;
    const auto presentation =
        make_presentation_metrics(surface, {.reference = {.size = surface.framebuffer_size},
                                            .world_raster_policy = WorldRasterPolicy::Native});
    if (!presentation) {
        reason = "asset benchmark presentation metrics unavailable";
        return false;
    }
    const auto handles = platform_.native_window_handles();
    if (!renderer_.initialize({.native_display = handles.display,
                               .native_window = handles.window,
                               .native_window_type = handles.type,
                               .presentation = presentation.value(),
                               .vsync = options.vsync,
                               .assets = &assets_})) {
        reason = "production Renderer initialization failed for asset realization";
        return false;
    }
    if (const auto* caps = bgfx::getCaps()) {
        environment_.renderer = bgfx::getRendererName(caps->rendererType);
        environment_.gpu_vendor_id = caps->vendorId;
        environment_.gpu_device_id = caps->deviceId;
    }
    if (const char* driver = SDL_GetCurrentVideoDriver())
        environment_.video_driver = driver;
    return true;
}

bool AssetScenario::load_texture(uint32_t index, std::string& reason)
{
    assets::TextureAssetRequest request{.path = kImages[index % kImages.size()]};
    auto queued = assets_.request_texture(request, assets::AssetRequestReason::Demand);
    if (!queued) {
        reason = "texture admission failed: " + queued.error().code + ": " + queued.error().message;
        return false;
    }
    auto handle = std::move(queued).value();
    for (unsigned tick = 0; tick < 2048 && handle.state() == assets::AssetRequestState::Pending;
         ++tick) {
        (void)executor_->dispatch_owner_completions(64);
        (void)executor_->advance_one_step();
    }
    (void)executor_->dispatch_owner_completions(64);
    if (handle.state() != assets::AssetRequestState::Ready) {
        reason = "texture request was not ready: " + diagnostic_failure(handle.diagnostics());
        return false;
    }
    auto lease = std::move(handle).take_ready();
    if (!lease || lease->asset().handle == assets::invalid_typed_asset_handle) {
        reason = "typed image request produced no realized texture";
        return false;
    }
    // Warm runs retain one lease per source; cold runs release each operation
    // and advance the namespace generation before the next real request.
    if (!cold_ && resident_.size() < kImages.size())
        resident_.push_back(std::move(*lease));
    return true;
}

bool AssetScenario::prepare(const Options& options, std::string& reason)
{
    if (!cleanup(reason))
        return false;
    work_units_ = options.cpu_work_units;
    cold_ = options.asset_cache == "cold";
    batches_ = 0;
    interruption_ = Interruption::None;
    environment_ = {};
    environment_.platform = SDL_GetPlatform();
    environment_.frame_path = requires_graphics()
                                  ? "production-typed-texture-initial-realization-no-presentation"
                                  : "asset-source-and-compiled-project-cpu-only";
    if (work_units_ < 1 || work_units_ > 64 ||
        (options.asset_cache != "cold" && options.asset_cache != "warm")) {
        reason = "asset workload requires 1..64 work units and cold or warm cache mode";
        return false;
    }
    mount_assets();
    if (requires_graphics()) {
        if (!initialize_graphics(options, reason))
            return false;
        if (!cold_) {
            for (uint32_t i = 0; i < kImages.size(); ++i)
                if (!load_texture(i, reason))
                    return false;
            renderer_.begin_frame();
            renderer_.end_frame();
        }
    } else {
        auto loaded = assets_.read_binary(id_ == "asset-project-prepare" ? kProject : kImages[0]);
        if (!loaded || loaded.value->bytes.empty()) {
            reason = "missing staged asset fixture: " +
                     (loaded ? std::string("empty source") : source_failure(loaded.error));
            return false;
        }
    }
    ready_ = true;
    return true;
}

Readiness AssetScenario::readiness(std::string& reason)
{
    if (!ready_) {
        reason = "asset workload was not prepared";
        return Readiness::Failed;
    }
    return Readiness::Ready;
}

bool AssetScenario::frame(std::string& reason)
{
    if (!ready_) {
        reason = "asset workload not ready";
        return false;
    }
#if defined(__ANDROID__)
    if (requires_graphics() && !android_benchmark_foreground()) {
        interruption_ = Interruption::Recoverable;
        reason = "Android Activity suspended during asset realization";
        return false;
    }
#endif
    if (requires_graphics()) {
        platform_.poll_events();
        if (platform_.should_quit()) {
            interruption_ = Interruption::Cancelled;
            reason = "asset benchmark window closed";
            return false;
        }
    }
    for (uint32_t i = 0; i < work_units_; ++i) {
        if (requires_graphics()) {
            if (cold_) {
                auto refreshed = assets_.refresh_namespace_on_owner("project");
                if (!refreshed) {
                    reason = refreshed.error().code + ": " + refreshed.error().message;
                    return false;
                }
            }
            if (!load_texture(i, reason))
                return false;
            continue;
        }
        if (cold_) {
            assets_ = assets::AssetManager{};
            mount_assets();
        }
        const auto input = id_ == "asset-project-prepare" ? kProject : kImages[i % kImages.size()];
        auto loaded = assets_.read_binary(input);
        if (!loaded || loaded.value->bytes.empty()) {
            reason = "asset source read failed: " +
                     (loaded ? std::string("empty source") : source_failure(loaded.error));
            return false;
        }
        if (id_ == "asset-project-prepare") {
            const auto& bytes = loaded.value->bytes;
            std::string json(bytes.begin(), bytes.end());
            auto project = core::decode_compiled_project_json(json, input);
            if (!project) {
                reason =
                    "Compiled Project preparation failed: " + diagnostic_failure(project.error());
                return false;
            }
        }
    }
    if (requires_graphics()) {
        renderer_.begin_frame();
        renderer_.end_frame();
    }
    ++batches_;
    return true;
}

void AssetScenario::diagnostic_frame(DiagnosticObservation& observation)
{
    if (!requires_graphics())
        return;
    capture_bgfx_diagnostics(observation);
    observation.submitted_frame = renderer_.last_submitted_bgfx_frame();
    // Resource creation has no queryable GPU-completion fence here; a
    // completed bgfx frame must not be presented as texture-upload cost.
    observation.gpu_execution_ms.reset();
    observation.gpu_completed_frame.reset();
}

bool AssetScenario::complete(std::string& reason)
{
    if (batches_ == 0) {
        reason = "asset scenario completed without a workload operation";
        return false;
    }
    return true;
}

bool AssetScenario::cleanup(std::string& reason)
{
    reason.clear();
    ready_ = false;
    resident_.clear();
    renderer_.shutdown();
    if (executor_) {
        executor_->begin_shutdown();
        (void)executor_->dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    }
    assets_ = assets::AssetManager{};
    executor_.reset();
    residency_.reset();
    platform_.shutdown();
    return true;
}

} // namespace noveltea::benchmark
