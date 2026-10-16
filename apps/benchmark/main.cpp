#include <SDL3/SDL.h>
#include <SDL3/SDL_main.h>
#include <bgfx/bgfx.h>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#endif

#if defined(__ANDROID__)
#include <SDL3/SDL_system.h>
#include <android/native_window.h>
#include <jni.h>
#endif

#include "benchmark_bgfx_diagnostics.hpp"
#include "benchmark_completed_run.hpp"
#include "benchmark_dashboard.hpp"
#include "benchmark_options.hpp"
#include "benchmark_report.hpp"
#include "benchmark_runner.hpp"
#include "empty_engine.hpp"
#include "integrated_rmlui.hpp"
#include "raw_bgfx_geometry.hpp"
#include "reference_scene.hpp"
#include "standalone_rmlui.hpp"

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
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
    std::puts("noveltea-benchmark-app: standalone SDL3/bgfx benchmark dashboard");
    std::puts("usage: noveltea-benchmark-app [--smoke] [--warmup-seconds N] [--seconds N]");
    std::puts("       [--frames N] [--repeats N] [--ready-timeout-seconds N]");
    std::puts(
        "       [--width N] [--height N] [--vsync] [--profile clean|diagnostic] [--no-ui|--ui]");
    std::puts(
        "       [--scenario raw-bgfx-empty|raw-bgfx-geometry|standalone-rmlui-simple|"
        "integrated-rmlui-controlled|integrated-rmlui-production|engine-empty] [--rect-count N]");
    std::puts("       [--rect-scale 0.25..1.0] [--raw-samples] [--config PATH] [--output PATH]");
    std::puts("  --smoke         30 measured frames, no warmup");
    std::puts("  --quick-suite   Run all six reference comparisons with independent outcomes");
    std::puts("  --dashboard-smoke  Repeat dashboard teardown/recreate with 30-frame trials");
    std::puts("  --dashboard-visual-smoke  Untimed two-stage preview pixel fixture");
    std::puts("  --frames        Fixed frames per trial; maximum 300000");
    std::puts("  --repeats       Trials per scenario; default 1, maximum 20");
    std::puts("  --config        Exact current JSON configuration; cannot mix with run flags");
    std::puts("  --raw-samples   Include per-frame CPU timing pairs in the report");
    std::puts("  --output        Report path (defaults to platform-local benchmark storage)");
    std::puts("  --help          Print help without initializing graphics");
    std::puts("Without arguments, opens the dashboard; CLI settings default to no-UI.");
    std::puts("Reference scenes: Clean has no GPU timers; Diagnostic reports supported identified "
              "GPU frames.");
}

struct SteadyClock final : Clock {
    double now_seconds() override
    {
        return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch())
            .count();
    }
};

#if defined(__ANDROID__)
// ADB can start SDL_main on a sleeping device after the Activity has already
// paused. Do not create SDL/bgfx graphics against that transient ANativeWindow.
// This wait happens only during graphics initialization, never while sampling.
bool wait_for_android_foreground(std::string& reason)
{
    auto* env = static_cast<JNIEnv*>(SDL_GetAndroidJNIEnv());
    if (!env) {
        reason = "Android JNI environment unavailable during startup";
        return false;
    }
    auto activity = static_cast<jobject>(SDL_GetAndroidActivity());
    if (!activity) {
        reason = "Android benchmark Activity unavailable during startup";
        return false;
    }
    auto activity_class = env->GetObjectClass(activity);
    const jmethodID ready = activity_class
                                ? env->GetMethodID(activity_class, "isBenchmarkLaunchReady", "()Z")
                                : nullptr;
    if (env->ExceptionCheck())
        env->ExceptionClear();
    if (activity_class)
        env->DeleteLocalRef(activity_class);
    if (!ready) {
        env->DeleteLocalRef(activity);
        reason = "Android benchmark Activity lacks lifecycle readiness API";
        return false;
    }
    bool waiting = false;
    while (true) {
        const bool foreground = env->CallBooleanMethod(activity, ready) == JNI_TRUE;
        if (env->ExceptionCheck()) {
            env->ExceptionClear();
            env->DeleteLocalRef(activity);
            reason = "Android lifecycle readiness check failed";
            return false;
        }
        if (foreground)
            break;
        if (!waiting) {
            SDL_Log("[benchmark] waiting for awake, focused Activity before graphics init");
            waiting = true;
        }
        SDL_Delay(100);
    }
    if (waiting)
        SDL_Log("[benchmark] Activity awake and focused; initializing graphics");
    env->DeleteLocalRef(activity);
    return true;
}

// Android EGL may present undefined old buffer contents when the empty reference
// submits no clear/draw. Conceal those pixels outside the strict bgfx host, without
// adding GPU work or Java calls to its measured frame loop.
bool set_empty_benchmark_cover(bool visible, std::string& reason)
{
    auto* env = static_cast<JNIEnv*>(SDL_GetAndroidJNIEnv());
    if (!env) {
        reason = "Android JNI environment unavailable";
        return false;
    }
    auto activity = static_cast<jobject>(SDL_GetAndroidActivity());
    if (!activity) {
        reason = "Android benchmark Activity unavailable";
        return false;
    }
    auto activity_class = env->GetObjectClass(activity);
    jmethodID method = activity_class
                           ? env->GetMethodID(activity_class, "setEmptyBenchmarkCover", "(Z)Z")
                           : nullptr;
    bool success = false;
    if (method && !env->ExceptionCheck())
        success = env->CallBooleanMethod(activity, method, visible ? JNI_TRUE : JNI_FALSE);
    if (env->ExceptionCheck()) {
        env->ExceptionClear();
        success = false;
    }
    if (activity_class)
        env->DeleteLocalRef(activity_class);
    env->DeleteLocalRef(activity);
    if (!success)
        reason = visible ? "unable to cover undefined Android empty-frame presentation"
                         : "unable to restore Android dashboard presentation";
    return success;
}

struct EmptyBenchmarkCover {
    bool visible = false;
    bool show(std::string& reason)
    {
        if (!set_empty_benchmark_cover(true, reason)) {
            // A timed-out UI-thread request may complete later; queue a hide
            // behind it so a failed run cannot leave the dashboard covered.
            std::string recovery_error;
            if (!set_empty_benchmark_cover(false, recovery_error))
                SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[benchmark] %s",
                             recovery_error.c_str());
            return false;
        }
        visible = true;
        // The Java view is installed on Android's UI thread. Allow its first
        // composition before submitting the strict benchmark's frames.
        SDL_Delay(80);
        return true;
    }
    void hide()
    {
        if (visible) {
            std::string error;
            if (!set_empty_benchmark_cover(false, error))
                SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[benchmark] %s", error.c_str());
            visible = false;
        }
    }
    ~EmptyBenchmarkCover() { hide(); }
};
#endif

struct Graphics {
    SDL_Window* window = nullptr;
    bool sdl_ready = false;
    bool bgfx_ready = false;
    bool vsync_enabled = false;
#if defined(__ANDROID__)
    ANativeWindow* held_native_window = nullptr;
#endif
    Environment environment;

    void shutdown()
    {
        if (bgfx_ready) {
            bgfx::shutdown();
            bgfx_ready = false;
        }
#if defined(__ANDROID__)
        if (held_native_window) {
            ANativeWindow_release(held_native_window);
            held_native_window = nullptr;
        }
#endif
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
#if !defined(__ANDROID__)
        if (logical_width != options.width || logical_height != options.height) {
            if (!SDL_SetWindowSize(window, options.width, options.height)) {
                reason = std::string("SDL_SetWindowSize: ") + SDL_GetError();
                return false;
            }
#if !defined(__EMSCRIPTEN__)
            if (!SDL_SyncWindow(window)) {
                reason = std::string("SDL_SyncWindow: ") + SDL_GetError();
                return false;
            }
#endif
        }
#else
        (void)logical_width;
        (void)logical_height;
#endif
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
#if defined(__ANDROID__)
        if (!wait_for_android_foreground(reason))
            return false;
#endif
        if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS)) {
            reason = std::string("SDL_Init: ") + SDL_GetError();
            return false;
        }
        sdl_ready = true;
#if defined(__ANDROID__)
        SDL_Log("[benchmark] SDL video initialized; creating Android window");
        window = SDL_CreateWindow("NovelTea Graphics Benchmark", 0, 0,
                                  SDL_WINDOW_FULLSCREEN | SDL_WINDOW_HIGH_PIXEL_DENSITY);
#else
        window = SDL_CreateWindow("NovelTea Graphics Benchmark: Empty bgfx", options.width,
                                  options.height, 0);
#endif
        if (!window) {
            reason = std::string("SDL_CreateWindow: ") + SDL_GetError();
            return false;
        }
#if defined(__ANDROID__)
        SDL_Log("[benchmark] Android SDL window created; waiting for native surface");
        // SDL_CreateWindow may change orientation and temporarily replace the
        // Activity's surface. Wait through that transition before handing bgfx
        // an EGL native window.
        if (!wait_for_android_foreground(reason))
            return false;
#endif
        SDL_PropertiesID props = SDL_GetWindowProperties(window);
#if defined(__EMSCRIPTEN__)
        void* display = nullptr;
        void* native_window = const_cast<char*>("#canvas");
        const auto handle_type = bgfx::NativeWindowHandleType::Default;
#elif defined(__ANDROID__)
        void* display = nullptr;
        void* native_window =
            SDL_GetPointerProperty(props, SDL_PROP_WINDOW_ANDROID_WINDOW_POINTER, nullptr);
        const auto handle_type = bgfx::NativeWindowHandleType::Default;
#else
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
#endif
#if defined(__ANDROID__)
        if (!native_window) {
            reason = "Android surface is not ready";
            return false;
        }
        // SDL owns the window, but its pointer property is borrowed. Retain
        // the ANativeWindow across bgfx's EGL initialization and shutdown so
        // a concurrent surfaceDestroyed callback cannot free it mid-init.
        held_native_window = static_cast<ANativeWindow*>(native_window);
        ANativeWindow_acquire(held_native_window);
#endif
        int width = 0;
        int height = 0;
        if (!SDL_GetWindowSizeInPixels(window, &width, &height) || width <= 0 || height <= 0) {
            reason = std::string("invalid framebuffer size: ") + SDL_GetError();
            return false;
        }
        bgfx::Init init;
#if defined(__ANDROID__) || defined(__EMSCRIPTEN__)
        init.type = bgfx::RendererType::OpenGLES;
#else
        init.type = bgfx::RendererType::OpenGL;
#endif
        init.platformData.type = handle_type;
        init.swapChain.nwh = native_window;
        init.swapChain.ndt = display;
        init.swapChain.width = static_cast<uint32_t>(width);
        init.swapChain.height = static_cast<uint32_t>(height);
        init.reset = options.vsync ? BGFX_RESET_VSYNC : 0;
#if defined(__ANDROID__)
        SDL_Log("[benchmark] Android EGL/bgfx initialization beginning");
#endif
        if (!bgfx::init(init)) {
            reason = "bgfx::init failed";
            return false;
        }
        bgfx_ready = true;
#if defined(__ANDROID__)
        SDL_Log("[benchmark] Android EGL/bgfx initialized");
#endif
        vsync_enabled = options.vsync;
        bgfx::setDebug(BGFX_DEBUG_NONE);
        bgfx::setViewRect(0, 0, 0, static_cast<uint16_t>(width), static_cast<uint16_t>(height));
        bgfx::setViewClear(0, BGFX_CLEAR_NONE);
        environment.platform = SDL_GetPlatform();
        const char* driver = SDL_GetCurrentVideoDriver();
        environment.video_driver = driver ? driver : "";
        environment.renderer = bgfx::getRendererName(bgfx::getRendererType());
        environment.frame_path = "bgfx-frame";
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
    bool diagnostic = false;
    noveltea::benchmark::Interruption last_interruption = noveltea::benchmark::Interruption::None;
    [[nodiscard]] noveltea::benchmark::Interruption interruption() const override
    {
        return last_interruption;
    }
    uint32_t submitted_frame = 0;
    double cpu_submission_ms = 0.0;
    double bgfx_frame_cpu_ms = 0.0;
    Graphics& host() { return shared_graphics ? *shared_graphics : graphics; }

    const char* id() const override { return "raw-bgfx-empty"; }
    const char* description() const override
    {
        return "bgfx touch(0) + frame; no clear, geometry, Engine, or UI";
    }
    bool requires_graphics() const override { return true; }
    bool prepare(const Options& options, std::string& reason) override
    {
        last_interruption = noveltea::benchmark::Interruption::None;
        diagnostic = options.profile == "diagnostic";
        host().environment.ui_backend.reset();
        if (!shared_graphics) {
            if (!graphics.initialize(options, reason))
                return false;
        } else if (!shared_graphics->bgfx_ready) {
            reason = "shared graphics host is unavailable";
            return false;
        }
        // Only the opt-in Diagnostic host requests non-rendering per-view
        // profiling. Clean samples and the dashboard never enable it.
        bgfx::setDebug(diagnostic ? BGFX_DEBUG_PROFILER : BGFX_DEBUG_NONE);
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
        return submit_frame([&]() {
            bgfx::touch(0);
            return true;
        });
    }
    template<typename Submit> bool submit_frame(Submit&& submit)
    {
        if (!diagnostic) {
            if (!submit())
                return false;
            bgfx::frame();
            return true;
        }
        const auto begin = std::chrono::steady_clock::now();
        if (!submit())
            return false;
        const auto submitted = std::chrono::steady_clock::now();
        submitted_frame = bgfx::frame();
        const auto completed = std::chrono::steady_clock::now();
        cpu_submission_ms = std::chrono::duration<double, std::milli>(submitted - begin).count();
        bgfx_frame_cpu_ms =
            std::chrono::duration<double, std::milli>(completed - submitted).count();
        return true;
    }
    void diagnostic_frame(noveltea::benchmark::DiagnosticObservation& observation) override
    {
        observation.submitted_frame = submitted_frame;
        observation.cpu_submission_ms = cpu_submission_ms;
        observation.bgfx_frame_cpu_ms = bgfx_frame_cpu_ms;
        noveltea::benchmark::capture_bgfx_diagnostics(observation, diagnostic);
    }
    void
    diagnostic_completion(std::vector<noveltea::benchmark::DiagnosticObservation>& late) override
    {
        // Only three untimed bgfx advances, not one GPU fence per sample.
        // GPU IDs outside the measured submissions are rejected by the runner.
        for (int i = 0; i < 3; ++i) {
            bgfx::touch(0);
            bgfx::frame();
            noveltea::benchmark::DiagnosticObservation observation;
            noveltea::benchmark::capture_bgfx_diagnostics(observation, diagnostic);
            late.push_back(observation);
        }
    }
    bool complete(std::string&) override { return true; }
    bool cleanup(std::string&) override
    {
        if (host().bgfx_ready)
            bgfx::setDebug(BGFX_DEBUG_NONE);
        if (!shared_graphics)
            graphics.shutdown();
        return true; // The interactive graphics host belongs to the app.
    }

    bool poll(std::string& reason)
    {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_QUIT || event.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED ||
                (event.type == SDL_EVENT_KEY_DOWN &&
                 (event.key.key == SDLK_ESCAPE || event.key.key == SDLK_AC_BACK))) {
                last_interruption = noveltea::benchmark::Interruption::Cancelled;
                reason = "benchmark cancelled by SDL input or window close";
                return false;
            }
            if (event.type == SDL_EVENT_WINDOW_FOCUS_LOST ||
                event.type == SDL_EVENT_WILL_ENTER_BACKGROUND ||
                event.type == SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED) {
                last_interruption = noveltea::benchmark::Interruption::Recoverable;
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
        if (!poll(reason))
            return false;
        return submit_frame([&]() { return geometry.submit(reason); });
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
        host().environment.ui_backend = ui.backend_settings();
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
        if (!poll(reason))
            return false;
        return submit_frame([&]() { return ui.submit(diagnostic, reason); });
    }
    void diagnostic_frame(noveltea::benchmark::DiagnosticObservation& observation) override
    {
        EmptyBgfxScenario::diagnostic_frame(observation);
        const auto stages = ui.last_diagnostic_stages();
        observation.cpu_update_ms = stages.update_seconds * 1000.0;
        // RmlUi Render() submits its draws; this stays distinct from bgfx::frame().
        observation.cpu_submission_ms = stages.render_seconds * 1000.0;
    }
    bool cleanup(std::string& reason) override
    {
        ui.shutdown();
        return EmptyBgfxScenario::cleanup(reason);
    }
};

bool write_report(const Options& options, const Environment& environment, const SuiteResult& result,
                  std::string& output, const std::vector<Environment>& scenario_environments = {})
{
    namespace fs = std::filesystem;
    fs::path path;
    if (options.output_path.empty()) {
        const auto stamp = std::chrono::duration_cast<std::chrono::microseconds>(
                               std::chrono::system_clock::now().time_since_epoch())
                               .count();
#if defined(__ANDROID__)
        const char* private_path = SDL_GetPrefPath("NovelTea", "Benchmark");
        if (!private_path) {
            std::fprintf(stderr, "[benchmark] SDL_GetPrefPath failed: %s\n", SDL_GetError());
            return false;
        }
        path = fs::path(private_path) / "results" /
               ((options.quick_suite ? "quick-suite" : options.scenario) + "-" +
                std::to_string(stamp) + ".json");
#else
        path = fs::path(NOVELTEA_BENCHMARK_RESULTS_DIR) /
               ((options.quick_suite ? "quick-suite" : options.scenario) + "-" +
                std::to_string(stamp) + ".json");
#endif
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
    file << noveltea::benchmark::encode_result(options, environment, result, scenario_environments)
         << '\n';
    file.close();
    if (!file) {
        std::fprintf(stderr, "[benchmark] could not write report %s\n", path.string().c_str());
        return false;
    }
    output = path.string();
#if defined(__EMSCRIPTEN__)
    const std::string name = path.filename().string();
    const std::string json =
        noveltea::benchmark::encode_result(options, environment, result, scenario_environments);
    EM_ASM(
        {
            if (window.NovelTeaBenchmark)
                window.NovelTeaBenchmark.report(UTF8ToString($0), UTF8ToString($1),
                                                UTF8ToString($2));
        },
        name.c_str(), json.c_str(), result.outcome.c_str());
    output = "download: " + name;
#endif
    return true;
}

#if !defined(__EMSCRIPTEN__)
// One suite collection keeps the ImGui host absent across all measurements.
// Hosts with incompatible ownership never coexist: the Engine creates its own
// SDL window and bgfx device, while the raw/standalone cases borrow Graphics.
SuiteResult run_native_quick_suite(const Options& base, Graphics& graphics, Clock& clock,
                                   std::vector<Environment>& environments,
                                   bool* ownership_safe = nullptr)
{
    SuiteResult collection;
    bool unsafe_cleanup = false;
    for (const auto& id : noveltea::benchmark::quick_suite_scenarios()) {
        if (unsafe_cleanup) {
            noveltea::benchmark::append_failed_scenario(
                collection, id, "previous renderer cleanup failed; ownership transfer unsafe");
            environments.emplace_back();
            continue;
        }
        Options selected = base;
        selected.scenario = id;
        selected.rect_count = 3;
        selected.rect_scale = 1.0;
        std::string reason;
        const bool engine_owned = id == "engine-empty" || id == "integrated-rmlui-controlled" ||
                                  id == "integrated-rmlui-production";
#if defined(__ANDROID__)
        if (engine_owned || id == "standalone-rmlui-simple") {
            noveltea::benchmark::append_failed_scenario(
                collection, id, "This reference renderer is not yet supported by the Android host");
            environments.emplace_back();
            continue;
        }
#endif
        SuiteResult item;
        if (engine_owned) {
            // Shutdown bgfx and SDL before EngineTooling takes ownership.
            graphics.shutdown();
            noveltea::benchmark::EmptyEngine empty;
            noveltea::benchmark::IntegratedRmlUi controlled(true);
            noveltea::benchmark::IntegratedRmlUi production(false);
            Scenario* target = id == "engine-empty" ? static_cast<Scenario*>(&empty)
                               : id == "integrated-rmlui-controlled"
                                   ? static_cast<Scenario*>(&controlled)
                                   : static_cast<Scenario*>(&production);
            item = noveltea::benchmark::run_suite(selected, {target}, clock);
            environments.push_back(id == "engine-empty" ? empty.environment()
                                   : id == "integrated-rmlui-controlled"
                                       ? controlled.environment()
                                       : production.environment());
        } else {
            if ((!graphics.bgfx_ready && !graphics.initialize(selected, reason)) ||
                !graphics.reconfigure(selected, reason)) {
                noveltea::benchmark::append_failed_scenario(collection, id, reason);
                environments.emplace_back();
                // A failed bgfx initialization cannot safely be followed by another host.
                graphics.shutdown();
                unsafe_cleanup = true;
                continue;
            }
            // Clear old UI/Engine contents before the next timed raw reference.
            bgfx::setViewClear(0, BGFX_CLEAR_COLOR, 0x000000ff);
            for (int i = 0; i < 4; ++i) {
                bgfx::touch(0);
                bgfx::frame();
            }
            bgfx::setViewClear(0, BGFX_CLEAR_NONE);
            for (int i = 0; i < 2; ++i) {
                bgfx::touch(0);
                bgfx::frame();
            }
#if defined(__ANDROID__)
            EmptyBenchmarkCover cover;
            if (id == "raw-bgfx-empty" && !cover.show(reason)) {
                noveltea::benchmark::append_failed_scenario(collection, id, reason);
                environments.emplace_back();
                continue;
            }
#endif
            EmptyBgfxScenario empty(&graphics);
            GeometryBgfxScenario geometry(&graphics);
            RmlUiScenario rmlui(&graphics);
            Scenario* target = id == "raw-bgfx-geometry"         ? static_cast<Scenario*>(&geometry)
                               : id == "standalone-rmlui-simple" ? static_cast<Scenario*>(&rmlui)
                                                                 : static_cast<Scenario*>(&empty);
            item = noveltea::benchmark::run_suite(selected, {target}, clock);
            environments.push_back(graphics.environment);
        }
        for (const auto& scenario : item.scenarios) {
            for (const auto& trial : scenario.trials) {
                if (trial.reason.find("cleanup failed") != std::string::npos)
                    unsafe_cleanup = true;
            }
        }
        const bool cancelled = item.outcome == "cancelled";
        noveltea::benchmark::append_suite_result(collection, std::move(item));
        if (cancelled)
            break;
    }
    if (ownership_safe)
        *ownership_safe = !unsafe_cleanup;
    return collection;
}

int run_dashboard(Options options)
{
#if defined(__ANDROID__)
    if (options.scenario != "raw-bgfx-empty" && options.scenario != "raw-bgfx-geometry") {
        std::fprintf(stderr, "[benchmark] Android Stage 1 supports raw-bgfx only\n");
        return 2;
    }
#endif
    if (options.scenario != "raw-bgfx-empty" && options.scenario != "raw-bgfx-geometry" &&
        options.scenario != "standalone-rmlui-simple" &&
        options.scenario != "integrated-rmlui-controlled" &&
        options.scenario != "integrated-rmlui-production" && options.scenario != "engine-empty") {
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
#if defined(__ANDROID__)
    bool suspended = false;
    bool needs_surface_recreation = false;
#endif
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

    const auto benchmark_once = [&](bool quick = false) {
        std::string validation;
        if (!noveltea::benchmark::validate_run_options(options, validation) ||
            (!quick && !noveltea::benchmark::validate_reference_options(options, validation))) {
            feedback = validation;
            return;
        }
        // The run configuration is frozen before any result is produced; later
        // dashboard edits must not change the identity of displayed samples.
        Options run_options = options;
        run_options.quick_suite = quick;
        if (quick) {
            run_options.rect_count = 3;
            run_options.rect_scale = 1.0;
        }
#if defined(__ANDROID__)
        if (run_options.scenario != "raw-bgfx-empty" &&
            run_options.scenario != "raw-bgfx-geometry") {
            feedback = "Android Stage 1 supports raw-bgfx-empty and raw-bgfx-geometry only";
            return;
        }
        EmptyBenchmarkCover cover;
        if (!quick && run_options.scenario == "raw-bgfx-empty" && !cover.show(feedback))
            return;
#endif
        // Preview GPU geometry also has to be released before the strict run.
        preview_geometry.shutdown();
        preview_ui.shutdown();
        // No context, ImGui CPU frame, backend, atlas, shader or draw submissions
        // exist while the runner enters Preparation, Warmup or Measurement.
        dashboard.shutdown();
        // Drain deferred bgfx resource destruction outside the sampling window.
        bgfx::frame();
        bgfx::frame();
        const bool integrated = run_options.scenario == "integrated-rmlui-controlled" ||
                                run_options.scenario == "integrated-rmlui-production";
        const bool engine_owned = integrated || run_options.scenario == "engine-empty";
        bool ran = false;
        if (quick) {
            std::vector<Environment> environments;
            bool ownership_safe = true;
            auto result =
                run_native_quick_suite(run_options, graphics, clock, environments, &ownership_safe);
            ran = true;
            completed_run = noveltea::benchmark::CompletedRun{run_options, std::move(result), {}};
            if (!write_report(run_options, graphics.environment, completed_run->result,
                              completed_run->report_path, environments))
                feedback = "failed to write benchmark report";
            else
                feedback.clear();
            if (!ownership_safe) {
                // The report is safe to publish, but a new bgfx owner is not.
                // Leave the UI stopped instead of initializing over a live device.
                feedback = "Quick Suite renderer cleanup failed; dashboard cannot be restored";
                std::fprintf(stderr, "[benchmark] %s\n", feedback.c_str());
                return;
            }
            if (!graphics.bgfx_ready && !graphics.initialize(options, error)) {
                feedback = "dashboard graphics recreation: " + error;
                std::fprintf(stderr, "[benchmark] %s\n", feedback.c_str());
                return;
            }
        } else if (engine_owned) {
            // Engine must own SDL, its window and bgfx. Do not overlap hosts.
            graphics.shutdown();
            noveltea::benchmark::IntegratedRmlUi engine_ui(run_options.scenario ==
                                                           "integrated-rmlui-controlled");
            noveltea::benchmark::EmptyEngine empty_engine;
            Scenario* selected = integrated ? static_cast<Scenario*>(&engine_ui)
                                            : static_cast<Scenario*>(&empty_engine);
            auto result = noveltea::benchmark::run_suite(run_options, {selected}, clock);
            ran = true;
            completed_run = noveltea::benchmark::CompletedRun{run_options, std::move(result), {}};
            const auto& environment =
                integrated ? engine_ui.environment() : empty_engine.environment();
            if (!write_report(run_options, environment, completed_run->result,
                              completed_run->report_path)) {
                feedback = "failed to write benchmark report";
            } else {
                feedback.clear();
            }
            if (!graphics.initialize(options, error)) {
                feedback = "dashboard graphics recreation: " + error;
                std::fprintf(stderr, "[benchmark] %s\n", feedback.c_str());
                return;
            }
        } else if (graphics.reconfigure(run_options, validation)) {
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
            noveltea::benchmark::Recovery recover;
#if defined(__ANDROID__)
            recover = [&](std::string& reason) {
                if (!wait_for_android_foreground(reason))
                    return noveltea::benchmark::RecoveryState::Failed;
                // Surface loss invalidates the old ANativeWindow/EGL host.
                // Rebuild only after the failed attempt has cleaned up.
                graphics.shutdown();
                if (!graphics.initialize(run_options, reason) ||
                    !graphics.reconfigure(run_options, reason))
                    return noveltea::benchmark::RecoveryState::Failed;
                return noveltea::benchmark::RecoveryState::Ready;
            };
#endif
            auto result = noveltea::benchmark::run_suite(run_options, {selected}, clock, recover);
            ran = true;
            completed_run = noveltea::benchmark::CompletedRun{run_options, std::move(result), {}};
            if (!write_report(completed_run->configuration, graphics.environment,
                              completed_run->result, completed_run->report_path)) {
                feedback = "failed to write benchmark report";
            } else {
                feedback.clear();
            }
        } else {
            feedback = validation;
        }
        if (ran && completed_run) {
            for (const auto& item : completed_run->result.scenarios) {
                std::printf("[benchmark] %s: %s, %llu measured frames, %.3f s; "
                            "CPU mean %.3f ms (not GPU time)\n",
                            item.scenario.c_str(), item.outcome.c_str(),
                            static_cast<unsigned long long>(item.measured_frames),
                            item.measured_wall_seconds, item.cpu_operation.mean_ms);
#if defined(__ANDROID__)
                SDL_Log(
                    "[benchmark] %s: %s, %llu frames in %.3f s; CPU mean %.3f ms (not GPU time)",
                    item.scenario.c_str(), item.outcome.c_str(),
                    static_cast<unsigned long long>(item.measured_frames),
                    item.measured_wall_seconds, item.cpu_operation.mean_ms);
#endif
                for (const auto& trial : item.trials) {
                    if (trial.outcome != "complete")
                        std::fprintf(stderr, "[benchmark] trial %s: %s\n", trial.outcome.c_str(),
                                     trial.reason.c_str());
                }
            }
            if (!completed_run->report_path.empty()) {
                std::printf("[benchmark] report: %s (outcome=%s)\n",
                            completed_run->report_path.c_str(),
                            completed_run->result.outcome.c_str());
#if defined(__ANDROID__)
                SDL_Log("[benchmark] report: %s (outcome=%s)", completed_run->report_path.c_str(),
                        completed_run->result.outcome.c_str());
#endif
            }
        }
        // Sampled bgfx views must no longer be active; re-create UI only after cleanup.
#if defined(__ANDROID__)
        if (graphics.window && !(SDL_GetWindowFlags(graphics.window) & SDL_WINDOW_INPUT_FOCUS)) {
            suspended = true;
            needs_surface_recreation = true;
            return;
        }
#endif
        if (!dashboard.initialize(graphics.window, options, error)) {
            feedback = "dashboard reinitialization: " + error;
            std::fprintf(stderr, "[benchmark] %s\n", feedback.c_str());
        }
#if defined(__ANDROID__)
        if (cover.visible && dashboard.initialized()) {
            // Present a fully recreated dashboard before exposing its surface.
            (void)dashboard.frame(options, completed_run ? &*completed_run : nullptr, feedback,
                                  draw_preview);
        }
        cover.hide();
#endif
    };

    if (options.dashboard_visual_smoke) {
        if (options.scenario != "standalone-rmlui-simple") {
            std::fprintf(stderr, "[benchmark] visual preview fixture requires standalone RmlUi\n");
            return 2;
        }
        // This fixture only renders the dashboard and preview, never invokes
        // run_suite or measures frames. External pixel tests can inspect both
        // the ordinary panel and the return-to-dashboard control.
        for (bool inspect : {false, true}) {
            dashboard.set_inspection_only(inspect);
            for (int frame = 0; frame < 15; ++frame)
                (void)dashboard.frame(options, nullptr, feedback, draw_preview);
            std::printf("[benchmark] visual %s ready\n", inspect ? "inspection" : "dashboard");
            std::fflush(stdout);
            SDL_Delay(1800);
        }
        preview_ui.shutdown();
        return feedback.empty() ? 0 : 3;
    }

    if (options.dashboard_smoke) {
        const Options original_options = options;
        for (int cycle = 0; cycle < 3; ++cycle) {
            if (cycle == 1) {
                // Cross renderer ownership boundaries without destroying the SDL/bgfx host.
#if defined(__ANDROID__)
                options.scenario = original_options.scenario == "raw-bgfx-geometry"
                                       ? "raw-bgfx-empty"
                                       : "raw-bgfx-geometry";
#else
                options.scenario = (original_options.scenario == "standalone-rmlui-simple" ||
                                    original_options.scenario == "integrated-rmlui-controlled" ||
                                    original_options.scenario == "integrated-rmlui-production" ||
                                    original_options.scenario == "engine-empty")
                                       ? "raw-bgfx-geometry"
                                       : "integrated-rmlui-production";
#endif
                options.rect_count = 3;
                options.rect_scale = 1.0;
            } else if (cycle == 2) {
                options = original_options;
            }
            // Exercise both the full-scene inspection and ordinary dashboard
            // draw paths before running strict no-ImGui trials.
            if (options.scenario != "raw-bgfx-empty" &&
                options.scenario != "integrated-rmlui-production" &&
                options.scenario != "integrated-rmlui-controlled" &&
                options.scenario != "engine-empty")
                dashboard.set_inspection_only(cycle % 2 == 0);
            else
                dashboard.set_inspection_only(false);
            (void)dashboard.frame(options, completed_run ? &*completed_run : nullptr, feedback,
                                  draw_preview);
            benchmark_once(options.quick_suite);
            if (!dashboard.initialized() || !completed_run ||
                completed_run->result.outcome != "complete" || !feedback.empty())
                return 4;
            std::printf("[benchmark] dashboard cycle %d complete\n", cycle + 1);
        }
        dashboard.set_inspection_only(false);
        (void)dashboard.frame(options, &*completed_run, feedback, draw_preview);
        return 0;
    }

    while (dashboard.initialized()
#if defined(__ANDROID__)
           || suspended
#endif
    ) {
        SDL_Event event;
        bool exit_requested = false;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_QUIT || event.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED) {
                exit_requested = true;
                break;
            }
#if defined(__ANDROID__)
            if (event.type == SDL_EVENT_WILL_ENTER_BACKGROUND ||
                event.type == SDL_EVENT_WINDOW_FOCUS_LOST) {
                suspended = true;
                needs_surface_recreation = true;
                continue;
            }
            if (event.type == SDL_EVENT_DID_ENTER_FOREGROUND ||
                event.type == SDL_EVENT_WINDOW_FOCUS_GAINED) {
                suspended = false;
                continue;
            }
            if (event.type == SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED) {
                needs_surface_recreation = true;
                continue;
            }
#endif
            if (dashboard.initialized())
                dashboard.process_event(event);
        }
        if (exit_requested)
            break;
#if defined(__ANDROID__)
        if (suspended) {
            SDL_Delay(50);
            continue;
        }
        if (needs_surface_recreation) {
            // Android may replace its ANativeWindow while the Activity is paused.
            // Do not reuse bgfx's old EGL surface or the old ImGui GPU resources.
            preview_geometry.shutdown();
            preview_ui.shutdown();
            dashboard.shutdown();
            graphics.shutdown();
            if (!graphics.initialize(options, error) ||
                !dashboard.initialize(graphics.window, options, error)) {
                std::fprintf(stderr, "[benchmark] Android surface recovery: %s\n", error.c_str());
                return 3;
            }
            needs_surface_recreation = false;
        }
#endif
        const auto action = dashboard.frame(options, completed_run ? &*completed_run : nullptr,
                                            feedback, draw_preview);
        if (action == noveltea::benchmark::DashboardAction::Exit)
            break;
        if (action == noveltea::benchmark::DashboardAction::Run ||
            action == noveltea::benchmark::DashboardAction::QuickSuite)
            benchmark_once(action == noveltea::benchmark::DashboardAction::QuickSuite);
        SDL_Delay(10);
    }
    preview_geometry.shutdown();
    preview_ui.shutdown();
    return 0;
}

int run(const Options& options)
{
    if (options.scenario != "raw-bgfx-empty" && options.scenario != "raw-bgfx-geometry" &&
        options.scenario != "standalone-rmlui-simple" &&
        options.scenario != "integrated-rmlui-controlled" &&
        options.scenario != "integrated-rmlui-production" && options.scenario != "engine-empty") {
        std::fprintf(stderr, "[benchmark] unsupported scenario: %s\n", options.scenario.c_str());
        return 2;
    }
#if defined(__ANDROID__)
    if (options.scenario != "raw-bgfx-empty" && options.scenario != "raw-bgfx-geometry") {
        std::fprintf(stderr, "[benchmark] Android Stage 1 supports raw-bgfx only\n");
        return 2;
    }
#endif
    SteadyClock clock;
    if (options.quick_suite) {
        Graphics graphics;
        Options suite_options = options;
        suite_options.rect_count = 3;
        suite_options.rect_scale = 1.0;
        std::vector<Environment> environments;
        const SuiteResult suite =
            run_native_quick_suite(suite_options, graphics, clock, environments);
        std::string output;
        if (!write_report(suite_options, graphics.environment, suite, output, environments))
            return 3;
        for (const auto& scenario : suite.scenarios) {
            std::printf("[benchmark] suite %s: %s, %llu measured frames\n",
                        scenario.scenario.c_str(), scenario.outcome.c_str(),
                        static_cast<unsigned long long>(scenario.measured_frames));
            for (const auto& trial : scenario.trials)
                if (trial.outcome != "complete")
                    std::fprintf(stderr, "[benchmark] %s: %s\n", scenario.scenario.c_str(),
                                 trial.reason.c_str());
        }
        std::printf("[benchmark] Quick Suite %s: %s\n", suite.outcome.c_str(), output.c_str());
        return suite.outcome == "complete" ? 0 : 2;
    }
    EmptyBgfxScenario empty;
    GeometryBgfxScenario geometry;
    RmlUiScenario rmlui;
    noveltea::benchmark::IntegratedRmlUi controlled(true);
    noveltea::benchmark::IntegratedRmlUi production(false);
    noveltea::benchmark::EmptyEngine empty_engine;
    Scenario* selected =
        options.scenario == "raw-bgfx-geometry"             ? static_cast<Scenario*>(&geometry)
        : options.scenario == "standalone-rmlui-simple"     ? static_cast<Scenario*>(&rmlui)
        : options.scenario == "integrated-rmlui-controlled" ? static_cast<Scenario*>(&controlled)
        : options.scenario == "integrated-rmlui-production" ? static_cast<Scenario*>(&production)
        : options.scenario == "engine-empty"                ? static_cast<Scenario*>(&empty_engine)
                                                            : static_cast<Scenario*>(&empty);
    const SuiteResult result = noveltea::benchmark::run_suite(options, {selected}, clock);
    const Environment environment =
        options.scenario == "engine-empty"                  ? empty_engine.environment()
        : options.scenario == "integrated-rmlui-controlled" ? controlled.environment()
        : options.scenario == "integrated-rmlui-production" ? production.environment()
        : options.scenario == "standalone-rmlui-simple"     ? rmlui.graphics.environment
        : options.scenario == "raw-bgfx-geometry"           ? geometry.graphics.environment
                                                            : empty.graphics.environment;
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
                std::fprintf(stderr, "[benchmark] trial %s: %s\n", trial.outcome.c_str(),
                             trial.reason.c_str());
        }
    }
    std::printf("[benchmark] report: %s (outcome=%s)\n", output.c_str(), result.outcome.c_str());
#if defined(__ANDROID__)
    SDL_Log("[benchmark] %s: %s, %llu frames, CPU mean %.3f ms (not GPU time); report: %s",
            scenario_result.scenario.c_str(), scenario_result.outcome.c_str(),
            static_cast<unsigned long long>(scenario_result.measured_frames),
            scenario_result.cpu_operation.mean_ms, output.c_str());
#endif
    return result.outcome == "complete" ? 0 : 2;
}

#endif // !__EMSCRIPTEN__

#if defined(__EMSCRIPTEN__)
#include "benchmark_web_app.inl"
#endif

} // namespace

int main(int argc, char* argv[])
{
#if defined(__ANDROID__)
    SDL_Log("[benchmark] native launch: argc=%d first=%s", argc, argc > 1 ? argv[1] : "(none)");
#endif
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
#if defined(__EMSCRIPTEN__)
    return run_web(options);
#else
    return options.no_ui ? run(options) : run_dashboard(options);
#endif
}
