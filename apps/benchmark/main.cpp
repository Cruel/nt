#include <SDL3/SDL.h>
#include <SDL3/SDL_main.h>
#include <bgfx/bgfx.h>

#include "benchmark_completed_run.hpp"
#include "benchmark_dashboard.hpp"
#include "benchmark_options.hpp"
#include "benchmark_report.hpp"
#include "benchmark_runner.hpp"
#include "raw_bgfx_geometry.hpp"
#include "reference_scene.hpp"
#include "standalone_rmlui.hpp"

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <optional>
#include <string>
#include <utility>

namespace {
using noveltea::benchmark::Clock;
using noveltea::benchmark::Environment;
using noveltea::benchmark::Options;
using noveltea::benchmark::Readiness;
using noveltea::benchmark::Scenario;
using noveltea::benchmark::SuiteResult;

void print_usage()
{
    std::puts("noveltea-benchmark-app: standalone Linux SDL3/bgfx benchmark dashboard");
    std::puts("usage: noveltea-benchmark-app [--smoke] [--warmup-seconds N] [--seconds N]");
    std::puts("       [--frames N] [--repeats N] [--ready-timeout-seconds N]");
    std::puts(
        "       [--width N] [--height N] [--vsync] [--profile clean|diagnostic] [--no-ui|--ui]");
    std::puts("       [--scenario raw-bgfx-empty|raw-bgfx-geometry|standalone-rmlui-simple] "
              "[--rect-count N]");
    std::puts("       [--rect-scale 0.25..1.0] [--raw-samples] [--config PATH] [--output PATH]");
    std::puts("  --smoke         30 measured frames, no warmup");
    std::puts("  --dashboard-smoke  Repeat dashboard teardown/recreate with 30-frame trials");
    std::puts("  --frames        Fixed frames per trial; maximum 300000");
    std::puts("  --repeats       Trials per scenario; default 1, maximum 20");
    std::puts("  --config        Exact current JSON configuration; cannot mix with run flags");
    std::puts("  --raw-samples   Include per-frame CPU timing pairs in the report");
    std::puts("  --output        Report path (defaults to build/<preset>/benchmarks)");
    std::puts("  --help          Print help without initializing graphics");
    std::puts("Without arguments, opens the dashboard; CLI settings default to no-UI.");
    std::puts(
        "Reference scenes: empty bgfx, raw geometry and standalone RmlUi; GPU timing unavailable.");
}

struct SteadyClock final : Clock {
    double now_seconds() override
    {
        return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch())
            .count();
    }
};

struct Graphics {
    SDL_Window* window = nullptr;
    bool sdl_ready = false;
    bool bgfx_ready = false;
    bool vsync_enabled = false;
    Environment environment;

    void shutdown()
    {
        if (bgfx_ready) {
            bgfx::shutdown();
            bgfx_ready = false;
        }
        if (window) {
            SDL_DestroyWindow(window);
            window = nullptr;
        }
        if (sdl_ready) {
            SDL_Quit();
            sdl_ready = false;
        }
    }
    ~Graphics() { shutdown(); }

    bool reconfigure(const Options& options, std::string& reason)
    {
        if (!window || !bgfx_ready) {
            reason = "graphics host not initialized";
            return false;
        }
        int logical_width = 0;
        int logical_height = 0;
        SDL_GetWindowSize(window, &logical_width, &logical_height);
        if (logical_width != options.width || logical_height != options.height) {
            if (!SDL_SetWindowSize(window, options.width, options.height)) {
                reason = std::string("SDL_SetWindowSize: ") + SDL_GetError();
                return false;
            }
            if (!SDL_SyncWindow(window)) {
                reason = std::string("SDL_SyncWindow: ") + SDL_GetError();
                return false;
            }
        }
        int pixel_width = 0;
        int pixel_height = 0;
        if (!SDL_GetWindowSizeInPixels(window, &pixel_width, &pixel_height) || pixel_width < 1 ||
            pixel_height < 1 || pixel_width > 65535 || pixel_height > 65535) {
            reason = "invalid framebuffer dimensions";
            return false;
        }
        if (environment.width_pixels != pixel_width || environment.height_pixels != pixel_height ||
            vsync_enabled != options.vsync) {
            bgfx::SwapChain swap_chain;
            swap_chain.width = static_cast<uint32_t>(pixel_width);
            swap_chain.height = static_cast<uint32_t>(pixel_height);
            bgfx::reset(options.vsync ? BGFX_RESET_VSYNC : 0, &swap_chain);
            vsync_enabled = options.vsync;
        }
        bgfx::setViewRect(0, 0, 0, static_cast<uint16_t>(pixel_width),
                          static_cast<uint16_t>(pixel_height));
        environment.width_pixels = pixel_width;
        environment.height_pixels = pixel_height;
        SDL_PumpEvents();
        // Only our resize notification is discarded; mid-run resizing interrupts a trial.
        SDL_FlushEvent(SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED);
        return true;
    }

    bool initialize(const Options& options, std::string& reason)
    {
        if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS)) {
            reason = std::string("SDL_Init: ") + SDL_GetError();
            return false;
        }
        sdl_ready = true;
        window = SDL_CreateWindow("NovelTea Graphics Benchmark: Empty bgfx", options.width,
                                  options.height, 0);
        if (!window) {
            reason = std::string("SDL_CreateWindow: ") + SDL_GetError();
            return false;
        }
        SDL_PropertiesID props = SDL_GetWindowProperties(window);
        void* display = SDL_GetPointerProperty(props, SDL_PROP_WINDOW_X11_DISPLAY_POINTER, nullptr);
        const uint64_t x11_window =
            SDL_GetNumberProperty(props, SDL_PROP_WINDOW_X11_WINDOW_NUMBER, 0);
        void* native_window = nullptr;
        bgfx::NativeWindowHandleType::Enum handle_type = bgfx::NativeWindowHandleType::Default;
        if (display && x11_window) {
            native_window = reinterpret_cast<void*>(static_cast<uintptr_t>(x11_window));
        } else {
            display =
                SDL_GetPointerProperty(props, SDL_PROP_WINDOW_WAYLAND_DISPLAY_POINTER, nullptr);
            native_window =
                SDL_GetPointerProperty(props, SDL_PROP_WINDOW_WAYLAND_SURFACE_POINTER, nullptr);
            handle_type = bgfx::NativeWindowHandleType::Wayland;
        }
        if (!display || !native_window) {
            reason = "no X11 or Wayland native window/display handles";
            return false;
        }
        int width = 0;
        int height = 0;
        if (!SDL_GetWindowSizeInPixels(window, &width, &height) || width <= 0 || height <= 0) {
            reason = std::string("invalid framebuffer size: ") + SDL_GetError();
            return false;
        }
        bgfx::Init init;
        init.type = bgfx::RendererType::OpenGL;
        init.platformData.type = handle_type;
        init.swapChain.nwh = native_window;
        init.swapChain.ndt = display;
        init.swapChain.width = static_cast<uint32_t>(width);
        init.swapChain.height = static_cast<uint32_t>(height);
        init.reset = options.vsync ? BGFX_RESET_VSYNC : 0;
        if (!bgfx::init(init)) {
            reason = "bgfx::init failed";
            return false;
        }
        bgfx_ready = true;
        vsync_enabled = options.vsync;
        bgfx::setDebug(BGFX_DEBUG_NONE);
        bgfx::setViewRect(0, 0, 0, static_cast<uint16_t>(width), static_cast<uint16_t>(height));
        bgfx::setViewClear(0, BGFX_CLEAR_NONE);
        environment.platform = SDL_GetPlatform();
        const char* driver = SDL_GetCurrentVideoDriver();
        environment.video_driver = driver ? driver : "";
        environment.renderer = bgfx::getRendererName(bgfx::getRendererType());
        const auto* caps = bgfx::getCaps();
        if (caps && caps->vendorId != 0) {
            environment.gpu_vendor_id = caps->vendorId;
            if (caps->deviceId != 0)
                environment.gpu_device_id = caps->deviceId;
        }
        environment.width_pixels = width;
        environment.height_pixels = height;
        // The initial surface notification is from our own startup, not a run interruption.
        SDL_PumpEvents();
        SDL_FlushEvent(SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED);
        // Startup window activation may deliver an initial focus loss on WSLg/X11.
        // A later focus loss remains a real run interruption.
        SDL_FlushEvent(SDL_EVENT_WINDOW_FOCUS_LOST);
        return true;
    }
};

struct EmptyBgfxScenario : Scenario {
    explicit EmptyBgfxScenario(Graphics* shared = nullptr) : shared_graphics(shared) {}
    Graphics graphics;
    Graphics* shared_graphics = nullptr;
    Graphics& host() { return shared_graphics ? *shared_graphics : graphics; }

    const char* id() const override { return "raw-bgfx-empty"; }
    const char* description() const override
    {
        return "bgfx touch(0) + frame; no clear, geometry, Engine, or UI";
    }
    bool requires_graphics() const override { return true; }
    bool prepare(const Options& options, std::string& reason) override
    {
        if (!shared_graphics)
            return graphics.initialize(options, reason);
        if (!shared_graphics->bgfx_ready) {
            reason = "shared graphics host is unavailable";
            return false;
        }
        bgfx::setViewClear(0, BGFX_CLEAR_NONE);
        return true;
    }
    Readiness readiness(std::string& reason) override
    {
        return poll(reason) ? Readiness::Ready : Readiness::Failed;
    }
    bool frame(std::string& reason) override
    {
        if (!poll(reason))
            return false;
        bgfx::touch(0);
        bgfx::frame();
        return true;
    }
    bool complete(std::string&) override { return true; }
    bool cleanup(std::string&) override
    {
        if (!shared_graphics)
            graphics.shutdown();
        return true; // The interactive graphics host belongs to the app.
    }

    bool poll(std::string& reason)
    {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_QUIT || event.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED ||
                event.type == SDL_EVENT_WINDOW_FOCUS_LOST ||
                event.type == SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED) {
                reason = "interrupted by SDL event " + std::to_string(event.type);
                return false;
            }
        }
        return true;
    }
};

struct GeometryBgfxScenario final : EmptyBgfxScenario {
    explicit GeometryBgfxScenario(Graphics* shared = nullptr) : EmptyBgfxScenario(shared) {}
    noveltea::benchmark::RawBgfxGeometry geometry;

    const char* id() const override { return "raw-bgfx-geometry"; }
    const char* description() const override
    {
        return "deterministic reference rectangles using a raw bgfx indexed draw";
    }
    bool prepare(const Options& options, std::string& reason) override
    {
        if (!EmptyBgfxScenario::prepare(options, reason))
            return false;
        const auto scene =
            noveltea::benchmark::geometry_reference_scene(options.rect_count, options.rect_scale);
        if (!geometry.initialize(scene, host().environment.width_pixels,
                                 host().environment.height_pixels, reason))
            return false;
        // Upload buffers and compile the shader before reporting Ready. This is
        // outside Warmup and Measurement, including for zero-warmup smoke runs.
        for (int i = 0; i < 4; ++i) {
            if (!geometry.submit(reason))
                return false;
            bgfx::frame();
        }
        return true;
    }
    bool frame(std::string& reason) override
    {
        if (!poll(reason) || !geometry.submit(reason))
            return false;
        bgfx::frame();
        return true;
    }
    bool cleanup(std::string& reason) override
    {
        geometry.shutdown();
        return EmptyBgfxScenario::cleanup(reason);
    }
};

struct RmlUiScenario final : EmptyBgfxScenario {
    explicit RmlUiScenario(Graphics* shared = nullptr) : EmptyBgfxScenario(shared) {}
    noveltea::benchmark::StandaloneRmlUi ui;
    bool diagnostic = false;

    const char* id() const override { return "standalone-rmlui-simple"; }
    const char* description() const override
    {
        return "standalone RmlUi context + rmlui-bgfx colored rectangles and text";
    }
    bool prepare(const Options& options, std::string& reason) override
    {
        if (!EmptyBgfxScenario::prepare(options, reason))
            return false;
        diagnostic = options.profile == "diagnostic";
        if (!ui.initialize(noveltea::benchmark::simple_ui_reference_scene(),
                           host().environment.width_pixels, host().environment.height_pixels,
                           reason))
            return false;
        // Compile font glyphs and upload backend resources outside all measured frames.
        for (int i = 0; i < 4; ++i) {
            if (!ui.submit(false, reason))
                return false;
            bgfx::frame();
        }
        return true;
    }
    bool frame(std::string& reason) override
    {
        if (!poll(reason) || !ui.submit(diagnostic, reason))
            return false;
        bgfx::frame();
        return true;
    }
    bool cleanup(std::string& reason) override
    {
        ui.shutdown();
        return EmptyBgfxScenario::cleanup(reason);
    }
};

bool write_report(const Options& options, const Environment& environment, const SuiteResult& result,
                  std::string& output)
{
    namespace fs = std::filesystem;
    fs::path path;
    if (options.output_path.empty()) {
        const auto stamp = std::chrono::duration_cast<std::chrono::microseconds>(
                               std::chrono::system_clock::now().time_since_epoch())
                               .count();
        path = fs::path(NOVELTEA_BENCHMARK_RESULTS_DIR) /
               (options.scenario + "-" + std::to_string(stamp) + ".json");
    } else {
        path = options.output_path;
    }
    std::error_code error;
    if (!path.parent_path().empty())
        fs::create_directories(path.parent_path(), error);
    if (error) {
        std::fprintf(stderr, "[benchmark] cannot create report directory: %s\n",
                     error.message().c_str());
        return false;
    }
    std::ofstream file(path, std::ios::trunc);
    if (!file) {
        std::fprintf(stderr, "[benchmark] cannot open report %s\n", path.string().c_str());
        return false;
    }
    file << noveltea::benchmark::encode_result(options, environment, result) << '\n';
    file.close();
    if (!file) {
        std::fprintf(stderr, "[benchmark] could not write report %s\n", path.string().c_str());
        return false;
    }
    output = path.string();
    return true;
}

int run_dashboard(Options options)
{
    if (options.scenario != "raw-bgfx-empty" && options.scenario != "raw-bgfx-geometry" &&
        options.scenario != "standalone-rmlui-simple") {
        std::fprintf(stderr, "[benchmark] unsupported scenario: %s\n", options.scenario.c_str());
        return 2;
    }
    Graphics graphics;
    std::string error;
    if (!graphics.initialize(options, error)) {
        std::fprintf(stderr, "[benchmark] dashboard graphics init: %s\n", error.c_str());
        return 3;
    }
    noveltea::benchmark::Dashboard dashboard;
    if (!dashboard.initialize(graphics.window, options, error)) {
        std::fprintf(stderr, "[benchmark] dashboard init: %s\n", error.c_str());
        return 3;
    }
    SteadyClock clock;
    std::optional<noveltea::benchmark::CompletedRun> completed_run;
    std::string feedback;
    noveltea::benchmark::RawBgfxGeometry preview_geometry;
    noveltea::benchmark::StandaloneRmlUi preview_ui;
    uint32_t preview_count = 0;
    double preview_scale = 0;
    int preview_width = 0;
    int preview_height = 0;
    const auto draw_preview = [&]() {
        if (options.scenario != "raw-bgfx-geometry")
            preview_geometry.shutdown();
        if (options.scenario != "standalone-rmlui-simple")
            preview_ui.shutdown();
        if (options.scenario == "standalone-rmlui-simple") {
            if (!preview_ui.initialized() &&
                !preview_ui.initialize(noveltea::benchmark::simple_ui_reference_scene(),
                                       graphics.environment.width_pixels,
                                       graphics.environment.height_pixels, feedback))
                return;
            (void)preview_ui.submit(false, feedback);
            return;
        }
        if (options.scenario != "raw-bgfx-geometry")
            return;
        const int width = graphics.environment.width_pixels;
        const int height = graphics.environment.height_pixels;
        if (!preview_geometry.initialized() || preview_count != options.rect_count ||
            preview_scale != options.rect_scale || preview_width != width ||
            preview_height != height) {
            const auto scene = noveltea::benchmark::geometry_reference_scene(options.rect_count,
                                                                             options.rect_scale);
            if (!preview_geometry.initialize(scene, width, height, feedback))
                return;
            preview_count = options.rect_count;
            preview_scale = options.rect_scale;
            preview_width = width;
            preview_height = height;
        }
        if (!preview_geometry.submit(feedback))
            return;
    };

    const auto benchmark_once = [&]() {
        std::string validation;
        if (!noveltea::benchmark::validate_run_options(options, validation) ||
            !noveltea::benchmark::validate_reference_options(options, validation)) {
            feedback = validation;
            return;
        }
        // The run configuration is frozen before any result is produced; later
        // dashboard edits must not change the identity of displayed samples.
        const Options run_options = options;
        // Preview GPU geometry also has to be released before the strict run.
        preview_geometry.shutdown();
        preview_ui.shutdown();
        // No context, ImGui CPU frame, backend, atlas, shader or draw submissions
        // exist while the runner enters Preparation, Warmup or Measurement.
        dashboard.shutdown();
        // Drain deferred bgfx resource destruction outside the sampling window.
        bgfx::frame();
        bgfx::frame();
        if (graphics.reconfigure(run_options, validation)) {
            // The reference workload deliberately does not clear its frame. Remove any
            // previously presented dashboard pixels from swap-chain buffers before timing.
            bgfx::setViewClear(0, BGFX_CLEAR_COLOR, 0x000000ff);
            for (int i = 0; i < 4; ++i) {
                bgfx::touch(0);
                bgfx::frame();
            }
            bgfx::setViewClear(0, BGFX_CLEAR_NONE);
            // Drain the inspection clear passes as well, including zero-warmup runs.
            for (int i = 0; i < 2; ++i) {
                bgfx::touch(0);
                bgfx::frame();
            }
            EmptyBgfxScenario empty(&graphics);
            GeometryBgfxScenario geometry(&graphics);
            RmlUiScenario rmlui(&graphics);
            Scenario* selected = run_options.scenario == "raw-bgfx-geometry"
                                     ? static_cast<Scenario*>(&geometry)
                                 : run_options.scenario == "standalone-rmlui-simple"
                                     ? static_cast<Scenario*>(&rmlui)
                                     : static_cast<Scenario*>(&empty);
            auto result = noveltea::benchmark::run_suite(run_options, {selected}, clock);
            completed_run = noveltea::benchmark::CompletedRun{run_options, std::move(result), {}};
            if (!write_report(completed_run->configuration, graphics.environment,
                              completed_run->result, completed_run->report_path)) {
                feedback = "failed to write benchmark report";
            } else {
                feedback.clear();
            }
            for (const auto& item : completed_run->result.scenarios) {
                std::printf("[benchmark] %s: %s, %llu measured frames, %.3f s; "
                            "CPU mean %.3f ms (not GPU time)\n",
                            item.scenario.c_str(), item.outcome.c_str(),
                            static_cast<unsigned long long>(item.measured_frames),
                            item.measured_wall_seconds, item.cpu_operation.mean_ms);
                for (const auto& trial : item.trials) {
                    if (trial.outcome != "complete")
                        std::fprintf(stderr, "[benchmark] trial failed: %s\n",
                                     trial.reason.c_str());
                }
            }
            if (!completed_run->report_path.empty())
                std::printf("[benchmark] report: %s (outcome=%s)\n",
                            completed_run->report_path.c_str(),
                            completed_run->result.outcome.c_str());
        } else {
            feedback = validation;
        }
        // Sampled bgfx views must no longer be active; re-create UI only after cleanup.
        if (!dashboard.initialize(graphics.window, options, error)) {
            feedback = "dashboard reinitialization: " + error;
            std::fprintf(stderr, "[benchmark] %s\n", feedback.c_str());
        }
    };

    if (options.dashboard_smoke) {
        const Options original_options = options;
        for (int cycle = 0; cycle < 3; ++cycle) {
            if (cycle == 1) {
                // Cross renderer ownership boundaries without destroying the SDL/bgfx host.
                options.scenario = original_options.scenario == "standalone-rmlui-simple"
                                       ? "raw-bgfx-geometry"
                                       : "standalone-rmlui-simple";
                options.rect_count = 3;
                options.rect_scale = 1.0;
            } else if (cycle == 2) {
                options = original_options;
            }
            // Exercise both the full-scene inspection and ordinary dashboard
            // draw paths before running strict no-ImGui trials.
            if (options.scenario != "raw-bgfx-empty")
                dashboard.set_inspection_only(cycle % 2 == 0);
            (void)dashboard.frame(options, completed_run ? &*completed_run : nullptr, feedback,
                                  draw_preview);
            benchmark_once();
            if (!dashboard.initialized() || !completed_run ||
                completed_run->result.outcome != "complete" || !feedback.empty())
                return 4;
            std::printf("[benchmark] dashboard cycle %d complete\n", cycle + 1);
        }
        dashboard.set_inspection_only(false);
        (void)dashboard.frame(options, &*completed_run, feedback, draw_preview);
        return 0;
    }

    while (dashboard.initialized()) {
        SDL_Event event;
        bool exit_requested = false;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_QUIT || event.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED) {
                exit_requested = true;
                break;
            }
            dashboard.process_event(event);
        }
        if (exit_requested)
            break;
        const auto action = dashboard.frame(options, completed_run ? &*completed_run : nullptr,
                                            feedback, draw_preview);
        if (action == noveltea::benchmark::DashboardAction::Exit)
            break;
        if (action == noveltea::benchmark::DashboardAction::Run ||
            action == noveltea::benchmark::DashboardAction::QuickSuite)
            benchmark_once();
        SDL_Delay(10);
    }
    preview_geometry.shutdown();
    preview_ui.shutdown();
    return 0;
}

int run(const Options& options)
{
    if (options.scenario != "raw-bgfx-empty" && options.scenario != "raw-bgfx-geometry" &&
        options.scenario != "standalone-rmlui-simple") {
        std::fprintf(stderr, "[benchmark] unsupported scenario: %s\n", options.scenario.c_str());
        return 2;
    }
    SteadyClock clock;
    EmptyBgfxScenario empty;
    GeometryBgfxScenario geometry;
    RmlUiScenario rmlui;
    EmptyBgfxScenario* selected =
        options.scenario == "raw-bgfx-geometry"         ? static_cast<EmptyBgfxScenario*>(&geometry)
        : options.scenario == "standalone-rmlui-simple" ? static_cast<EmptyBgfxScenario*>(&rmlui)
                                                        : &empty;
    const SuiteResult result = noveltea::benchmark::run_suite(options, {selected}, clock);
    const Environment environment = selected->graphics.environment;
    std::string output;
    if (!write_report(options, environment, result, output))
        return 3;
    const auto& scenario_result = result.scenarios.front();
    if (scenario_result.outcome == "complete") {
        std::printf("[benchmark] complete: %llu frames across %zu trial(s) in %.6f s, "
                    "cadence %.3f Hz, CPU operation mean %.3f ms (not GPU time)\n",
                    static_cast<unsigned long long>(scenario_result.measured_frames),
                    scenario_result.trials.size(), scenario_result.measured_wall_seconds,
                    static_cast<double>(scenario_result.measured_frames) /
                        scenario_result.measured_wall_seconds,
                    scenario_result.cpu_operation.mean_ms);
    } else {
        for (const auto& trial : scenario_result.trials) {
            if (trial.outcome != "complete")
                std::fprintf(stderr, "[benchmark] trial failed: %s\n", trial.reason.c_str());
        }
    }
    std::printf("[benchmark] report: %s (outcome=%s)\n", output.c_str(), result.outcome.c_str());
    return result.outcome == "complete" ? 0 : 2;
}

} // namespace

int main(int argc, char* argv[])
{
    Options options;
    std::string error;
    if (!noveltea::benchmark::parse_options(argc, const_cast<const char* const*>(argv), options,
                                            error)) {
        std::fprintf(stderr, "[benchmark] %s\n", error.c_str());
        print_usage();
        return 2;
    }
    if (options.help) {
        print_usage();
        return 0;
    }
    if (!options.config_path.empty()) {
        std::ifstream input(options.config_path);
        if (!input) {
            std::fprintf(stderr, "[benchmark] cannot open config: %s\n",
                         options.config_path.c_str());
            return 2;
        }
        const std::string json((std::istreambuf_iterator<char>(input)),
                               std::istreambuf_iterator<char>());
        const std::string output_override = options.output_path;
        if (!noveltea::benchmark::decode_configuration(json, options, error)) {
            std::fprintf(stderr, "[benchmark] %s\n", error.c_str());
            return 2;
        }
        if (!output_override.empty())
            options.output_path = output_override;
    }
    if (!noveltea::benchmark::validate_run_options(options, error) ||
        !noveltea::benchmark::validate_reference_options(options, error)) {
        std::fprintf(stderr, "[benchmark] %s\n", error.c_str());
        return 2;
    }
    return options.no_ui ? run(options) : run_dashboard(options);
}
