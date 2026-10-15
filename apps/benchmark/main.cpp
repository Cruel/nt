#include <SDL3/SDL.h>
#include <SDL3/SDL_main.h>
#include <bgfx/bgfx.h>

#include "benchmark_options.hpp"
#include "benchmark_report.hpp"
#include "benchmark_runner.hpp"

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>

namespace {
using noveltea::benchmark::Clock;
using noveltea::benchmark::Environment;
using noveltea::benchmark::Options;
using noveltea::benchmark::Readiness;
using noveltea::benchmark::Scenario;
using noveltea::benchmark::SuiteResult;

void print_usage()
{
    std::puts("noveltea-benchmark-app: standalone Linux SDL3/bgfx benchmark runner");
    std::puts("usage: noveltea-benchmark-app [--smoke] [--warmup-seconds N] [--seconds N]");
    std::puts("       [--frames N] [--repeats N] [--ready-timeout-seconds N]");
    std::puts("       [--width N] [--height N] [--vsync] [--profile clean] [--no-ui]");
    std::puts("       [--raw-samples] [--config PATH] [--output PATH]");
    std::puts("  --smoke         30 measured frames, no warmup");
    std::puts("  --frames        Fixed frames per trial; maximum 300000");
    std::puts("  --repeats       Trials per scenario; default 1, maximum 20");
    std::puts("  --config        Exact current JSON configuration; cannot mix with run flags");
    std::puts("  --raw-samples   Include per-frame CPU timing pairs in the report");
    std::puts("  --output        Report path (defaults to build/<preset>/benchmarks)");
    std::puts("  --help          Print help without initializing graphics");
    std::puts("Only Clean/no-UI raw-bgfx-empty is supported in this runner slice.");
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

struct EmptyBgfxScenario final : Scenario {
    Graphics graphics;

    const char* id() const override { return "raw-bgfx-empty"; }
    const char* description() const override
    {
        return "bgfx touch(0) + frame; no clear, geometry, Engine, or UI";
    }
    bool requires_graphics() const override { return true; }
    bool prepare(const Options& options, std::string& reason) override
    {
        return graphics.initialize(options, reason);
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
    void cleanup() override { graphics.shutdown(); }

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
               ("raw-bgfx-empty-" + std::to_string(stamp) + ".json");
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

int run(const Options& options)
{
    if (options.scenario != "raw-bgfx-empty") {
        std::fprintf(stderr, "[benchmark] unsupported scenario: %s\n", options.scenario.c_str());
        return 2;
    }
    SteadyClock clock;
    EmptyBgfxScenario scenario;
    const SuiteResult result = noveltea::benchmark::run_suite(options, {&scenario}, clock);
    const Environment environment = scenario.graphics.environment;
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
    if (!noveltea::benchmark::validate_run_options(options, error)) {
        std::fprintf(stderr, "[benchmark] %s\n", error.c_str());
        return 2;
    }
    return run(options);
}
