#include <SDL3/SDL.h>
#include <SDL3/SDL_main.h>
#include <bgfx/bgfx.h>

#include "benchmark_options.hpp"

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <string>
#include <string_view>
#include <system_error>

namespace {

using Clock = std::chrono::steady_clock;
using noveltea::benchmark::FrameSummary;
using noveltea::benchmark::Options;

constexpr std::string_view kScenario = "raw-bgfx-empty";

void print_usage()
{
    std::puts("noveltea-benchmark-app: standalone Linux SDL3/bgfx empty-frame baseline");
    std::puts("usage: noveltea-benchmark-app [--smoke] [--warmup-seconds N] [--seconds N]");
    std::puts("       [--frames N] [--width N] [--height N] [--vsync] [--output PATH]");
    std::puts("  --smoke            Run 30 measured frames without warmup (hardware smoke)");
    std::puts("  --warmup-seconds   Warmup duration, default 3 (0..3600)");
    std::puts("  --seconds          Measurement duration, default 10 (0..3600, exclusive 0)");
    std::puts("  --frames           Use fixed measured frame count instead of duration");
    std::puts("  --width/--height   Fixed window dimensions, default 1280x720");
    std::puts("  --vsync            Request swapchain VSync (disabled by default)");
    std::puts("  --output           JSON report path (default: build/<preset>/benchmarks/)");
    std::puts("  --help             Show this help without initializing graphics");
}

struct Graphics {
    SDL_Window* window = nullptr;
    bool sdl_ready = false;
    bool bgfx_ready = false;
    int width = 0;
    int height = 0;

    ~Graphics()
    {
        if (bgfx_ready)
            bgfx::shutdown();
        if (window)
            SDL_DestroyWindow(window);
        if (sdl_ready)
            SDL_Quit();
    }

    bool initialize(const Options& options)
    {
        if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS)) {
            std::fprintf(stderr, "[benchmark] SDL_Init failed: %s\n", SDL_GetError());
            return false;
        }
        sdl_ready = true;
        window = SDL_CreateWindow("NovelTea Graphics Benchmark: Empty bgfx", options.width,
                                  options.height, 0);
        if (!window) {
            std::fprintf(stderr, "[benchmark] SDL_CreateWindow failed: %s\n", SDL_GetError());
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
            std::fputs("[benchmark] no X11 or Wayland native window/display handles\n", stderr);
            return false;
        }
        if (!SDL_GetWindowSizeInPixels(window, &width, &height) || width <= 0 || height <= 0) {
            std::fprintf(stderr, "[benchmark] invalid framebuffer size: %s\n", SDL_GetError());
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
            std::fputs("[benchmark] bgfx::init failed\n", stderr);
            return false;
        }
        bgfx_ready = true;
        bgfx::setDebug(BGFX_DEBUG_NONE);
        bgfx::setViewRect(0, 0, 0, static_cast<uint16_t>(width), static_cast<uint16_t>(height));
        bgfx::setViewClear(0, BGFX_CLEAR_NONE);
        return true;
    }
};

// Stable benchmark work unit: submit an empty view and advance exactly one bgfx frame.
// This measures the CPU frame loop and handoff, not GPU duration or confirmed presentation.
void empty_bgfx_frame()
{
    bgfx::touch(0);
    bgfx::frame();
}

bool poll_events(const Graphics& graphics)
{
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
        if (event.type == SDL_EVENT_QUIT || event.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED ||
            event.type == SDL_EVENT_WINDOW_FOCUS_LOST ||
            event.type == SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED) {
            std::fprintf(stderr, "[benchmark] interrupted by SDL event %u\n", event.type);
            return false;
        }
    }
    (void)graphics;
    return true;
}

std::string json_string(std::string_view source)
{
    std::string encoded = "\"";
    constexpr char digits[] = "0123456789abcdef";
    for (unsigned char byte : source) {
        if (byte == '"' || byte == '\\') {
            encoded += '\\';
            encoded += static_cast<char>(byte);
        } else if (byte < 0x20) {
            encoded += "\\u00";
            encoded += digits[byte >> 4];
            encoded += digits[byte & 0x0f];
        } else {
            encoded += static_cast<char>(byte);
        }
    }
    encoded += '"';
    return encoded;
}

bool write_report(const Options& options, const Graphics& graphics, uint64_t warmup_frames,
                  const FrameSummary& summary, double actual_seconds, std::string& report_path)
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
    std::ofstream out(path, std::ios::trunc);
    if (!out) {
        std::fprintf(stderr, "[benchmark] cannot open report %s\n", path.string().c_str());
        return false;
    }
    const double fps =
        actual_seconds > 0.0 ? static_cast<double>(summary.frames) / actual_seconds : 0.0;
    out << std::setprecision(12);
    out << "{\n  \"scenario\": " << json_string(kScenario)
        << ",\n  \"platform\": " << json_string(SDL_GetPlatform())
        << ",\n  \"video_driver\": " << json_string(SDL_GetCurrentVideoDriver())
        << ",\n  \"renderer\": " << json_string(bgfx::getRendererName(bgfx::getRendererType()))
        << ",\n  \"workload\": \"bgfx touch(0) + frame; no clear or geometry\""
        << ",\n  \"width_pixels\": " << graphics.width
        << ",\n  \"height_pixels\": " << graphics.height
        << ",\n  \"vsync_requested\": " << (options.vsync ? "true" : "false")
        << ",\n  \"warmup_requested_seconds\": " << options.warmup_seconds
        << ",\n  \"warmup_frames\": " << warmup_frames << ",\n  \"measurement_mode\": "
        << json_string(options.measurement_frames ? "fixed_frames" : "duration")
        << ",\n  \"requested_measurement_frames\": " << options.measurement_frames
        << ",\n  \"requested_measurement_seconds\": " << options.duration_seconds
        << ",\n  \"measured_frames\": " << summary.frames
        << ",\n  \"measured_wall_seconds\": " << actual_seconds
        << ",\n  \"frame_loop_cadence_hz\": " << fps
        << ",\n  \"bgfx_frame_call_mean_ms\": " << summary.mean_bgfx_call_ms()
        << ",\n  \"bgfx_frame_call_min_ms\": " << summary.min_bgfx_call_seconds * 1000.0
        << ",\n  \"bgfx_frame_call_max_ms\": " << summary.max_bgfx_call_seconds * 1000.0
        << ",\n  \"gpu_execution_ms\": null"
        << ",\n  \"gpu_timing_status\": \"unavailable; bgfx::frame is CPU handoff/wait\""
        << ",\n  \"presented_frame_count\": null"
        << ",\n  \"result\": \"complete\"\n}\n";
    out.close();
    if (!out) {
        std::fprintf(stderr, "[benchmark] unable to complete report %s\n", path.string().c_str());
        return false;
    }
    report_path = path.string();
    return true;
}

int run(const Options& options)
{
    Graphics graphics;
    if (!graphics.initialize(options))
        return 1;
    // Discard the initial window-size notification after the swapchain was created.
    // A subsequent surface change during the run still invalidates its measurements.
    SDL_PumpEvents();
    SDL_FlushEvent(SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED);
    std::printf("[benchmark] renderer=%s size=%dx%d vsync=%s\n",
                bgfx::getRendererName(bgfx::getRendererType()), graphics.width, graphics.height,
                options.vsync ? "on" : "off");

    uint64_t warmup_frames = 0;
    const auto warmup_start = Clock::now();
    while (std::chrono::duration<double>(Clock::now() - warmup_start).count() <
           options.warmup_seconds) {
        if (!poll_events(graphics))
            return 2;
        empty_bgfx_frame();
        ++warmup_frames;
    }

    FrameSummary summary;
    const auto measured_start = Clock::now();
    while (true) {
        if (!poll_events(graphics))
            return 2;
        const auto frame_start = Clock::now();
        empty_bgfx_frame();
        const auto frame_end = Clock::now();
        summary.record(std::chrono::duration<double>(frame_end - frame_start).count());
        const double elapsed = std::chrono::duration<double>(frame_end - measured_start).count();
        if ((options.measurement_frames != 0 && summary.frames >= options.measurement_frames) ||
            (options.measurement_frames == 0 && elapsed >= options.duration_seconds)) {
            std::string report_path;
            if (!write_report(options, graphics, warmup_frames, summary, elapsed, report_path))
                return 3;
            std::printf("[benchmark] complete: %llu frames in %.6f s, cadence %.3f Hz, "
                        "bgfx::frame mean %.3f ms (CPU call, not GPU time)\n",
                        static_cast<unsigned long long>(summary.frames), elapsed,
                        static_cast<double>(summary.frames) / elapsed, summary.mean_bgfx_call_ms());
            std::printf("[benchmark] report: %s\n", report_path.c_str());
            return 0;
        }
    }
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
    return run(options);
}
