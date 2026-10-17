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
#include "benchmark_capacity.hpp"
#include "benchmark_completed_run.hpp"
#include "cpu_workloads.hpp"
#include "benchmark_dashboard.hpp"
#include "benchmark_inspection.hpp"
#include "benchmark_options.hpp"
#include "benchmark_window_size.hpp"
#include "benchmark_report.hpp"
#include "benchmark_storage.hpp"
#include "benchmark_runner.hpp"
#include "empty_engine.hpp"
#include "integrated_rmlui.hpp"
#include "raw_bgfx_geometry.hpp"
#include "raw_bgfx_workloads.hpp"
#include "reference_workloads.hpp"
#include "reference_scene.hpp"
#include "standalone_rmlui.hpp"

#include <chrono>
#include <cstdio>
#include <cstdlib>
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
    std::puts("       [--scenario raw-bgfx-empty|raw-bgfx-geometry|raw-bgfx-clear|"
              "raw-bgfx-single-quad|raw-bgfx-textured|raw-bgfx-offscreen|raw-bgfx-draw-calls|"
              "raw-bgfx-composition|"
              "standalone-rmlui-simple|standalone-rmlui-scaling|integrated-rmlui-scaling|"
              "standalone-rmlui-effects|integrated-rmlui-effects|"
              "integrated-rmlui-controlled|integrated-rmlui-production|engine-empty|"
              "engine-compiled-empty|engine-compiled-menu|engine-feature-lab|"
              "cpu-lua|cpu-runtime-session|cpu-flow-prediction] [--rect-count N]");
    std::puts("       [--clock-policy realtime|fixed-step] [--feature-lab-package FILE]");
    std::puts("       [--cpu-work-units 1..4096] (CPU-only --no-ui batch size)");
    std::puts("       [--rect-scale 0.25..1.0] [--draw-calls N] [--quad-count N]");
    std::puts("       [--texture-size N] [--coverage 0.125..1.0] [--raw-samples]");
    std::puts("       [--composition-path direct|offscreen] [--composite-passes 0..4]");
    std::puts("       [--target-scale 0.25..1.0] [--msaa-samples 0|2|4]");
    std::puts("       [--capacity-dimension geometry|ui|pixels] [--capacity-target "
              "cpu-ms|gpu-ms|presented-fps]");
    std::puts("       [--capacity-threshold N] [--capacity-mode presented|offscreen]");
    std::puts("       [--native-resolution] (use current display dimensions)");
    std::puts("       [--no-transparent-overlay] (composition scenario only)");
    std::puts("       [--ui-elements 1..2048] [--ui-text-lines 0..256]"
              " [--ui-dynamic-lines 0..256]");
    std::puts("       [--ui-visible-contexts 1..8] [--ui-empty-contexts 0..16]");
    std::puts("       [--ui-hidden-contexts 0..16] [--ui-text-mode static|dynamic]");
    std::puts("       [--ui-redraw continuous|dirty-only] (RmlUi scaling only)");
    std::puts("       [--ui-clipping 0..16] [--ui-transforms 0..16]");
    std::puts("       [--ui-gradients 0..16] [--ui-filters 0..16]");
    std::puts("       [--ui-masks 0..16] [--ui-nested-layers 0..16] (effects; combined budget)");
    std::puts(
        "       [--ui-preset balanced|elements-heavy|text-heavy|contexts-heavy|dirty-static]");
    std::puts("       [--config PATH] [--output PATH]");
    std::puts("  --smoke         30 measured frames, no warmup");
    std::puts("  --quick-suite   Run all six reference comparisons with independent outcomes");
    std::puts("  --dashboard-smoke  Repeat dashboard teardown/recreate with 30-frame trials");
    std::puts("  --dashboard-visual-smoke  Untimed two-stage preview pixel fixture");
    std::puts("  --inspection-smoke       Untimed standalone or integrated PNG capture check");
    std::puts("  --frames        Fixed frames per trial; maximum 300000");
    std::puts("  --repeats       Trials per scenario (or A/B/A cycles); default 1, maximum 20");
    std::puts(
        "  --alternate-config  Candidate B JSON configuration; A/B/A repeats with fresh warmups");
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
    noveltea::benchmark::InspectionCapture inspection;
#if defined(__ANDROID__)
    ANativeWindow* held_native_window = nullptr;
#endif
    Environment environment;

    void shutdown()
    {
        inspection.cancel();
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
        int requested_width = 0;
        int requested_height = 0;
        if (!noveltea::benchmark::requested_benchmark_window_size(options, window, requested_width,
                                                                  requested_height, reason))
            return false;
        if (logical_width != requested_width || logical_height != requested_height) {
            if (!SDL_SetWindowSize(window, requested_width, requested_height)) {
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
        int requested_width = 0;
        int requested_height = 0;
        if (!noveltea::benchmark::requested_benchmark_window_size(options, nullptr, requested_width,
                                                                  requested_height, reason))
            return false;
        window = SDL_CreateWindow("NovelTea Graphics Benchmark: Empty bgfx", requested_width,
                                  requested_height, 0);
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
        init.callback = &inspection;
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
#if defined(__EMSCRIPTEN__)
        char* browser = reinterpret_cast<char*>(
            EM_ASM_PTR({ return stringToNewUTF8(navigator.userAgent || ""); }));
        if (browser) {
            environment.browser = browser;
            std::free(browser);
        }
#endif
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

#if defined(__ANDROID__)
// Shared-host trials release their scenario-owned GPU objects on interruption, but
// intentionally retain Graphics. Rebuild that Android surface/EGL owner before
// retrying after foreground restoration, just like a single dashboard run.
noveltea::benchmark::Recovery android_engine_recovery()
{
    return [](std::string& reason) {
        return wait_for_android_foreground(reason) ? noveltea::benchmark::RecoveryState::Ready
                                                   : noveltea::benchmark::RecoveryState::Failed;
    };
}

noveltea::benchmark::Recovery android_shared_graphics_recovery(Graphics& graphics,
                                                               const Options& selected)
{
    return [&graphics, selected](std::string& reason) {
        if (!wait_for_android_foreground(reason))
            return noveltea::benchmark::RecoveryState::Failed;
        graphics.shutdown();
        if (!graphics.initialize(selected, reason) || !graphics.reconfigure(selected, reason)) {
            graphics.shutdown();
            return noveltea::benchmark::RecoveryState::Failed;
        }
        return noveltea::benchmark::RecoveryState::Ready;
    };
}
#endif

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
        host().environment.clear_scenario_metadata();
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

struct RawReferenceScenario final : EmptyBgfxScenario {
    RawReferenceScenario(Graphics* shared, std::string name)
        : EmptyBgfxScenario(shared), name_(std::move(name))
    {
    }
    std::string name_;
    noveltea::benchmark::RawBgfxWorkloads workload;
    bool offscreen_capacity = false;

    const char* id() const override { return name_.c_str(); }
    const char* description() const override
    {
        if (name_ == "raw-bgfx-clear")
            return "backbuffer clear and present, with no geometry";
        if (name_ == "raw-bgfx-single-quad")
            return "one indexed quad over a cleared backbuffer";
        if (name_ == "raw-bgfx-textured")
            return "full-screen texture lookup with adjustable footprint and coverage";
        if (name_ == "raw-bgfx-offscreen")
            return "render textured quad to an offscreen target, then composite to backbuffer";
        if (name_ == "raw-bgfx-composition")
            return "controlled direct/offscreen composition, MSAA, coverage and transparent "
                   "overlay";
        return "independent draw submissions, geometry, texture footprint and coverage";
    }
    bool prepare(const Options& options, std::string& reason) override
    {
        if (!EmptyBgfxScenario::prepare(options, reason))
            return false;
        offscreen_capacity =
            options.capacity_mode == "offscreen" && !options.capacity_dimension.empty();
        const auto spec = noveltea::benchmark::raw_workload_reference(
            options, static_cast<uint32_t>(host().environment.width_pixels),
            static_cast<uint32_t>(host().environment.height_pixels));
        if (!spec) {
            reason = "invalid raw workload parameters";
            return false;
        }
        if (!workload.initialize(*spec, static_cast<uint32_t>(host().environment.width_pixels),
                                 static_cast<uint32_t>(host().environment.height_pixels), reason))
            return false;
        host().environment.raw_workload = *spec;
        if (offscreen_capacity) {
            auto& recorded = *host().environment.raw_workload;
            recorded.view_count = 1;
            recorded.draws_per_frame =
                recorded.draw_calls * noveltea::benchmark::kOffscreenWorkUnitsPerBatch;
            recorded.vertices_per_frame = recorded.quads_per_draw * 4ull * recorded.draws_per_frame;
            recorded.triangles_per_frame =
                recorded.quads_per_draw * 2ull * recorded.draws_per_frame;
        }
        for (int i = 0; i < 4; ++i) {
            if (!workload.submit(reason, !offscreen_capacity))
                return false;
            bgfx::frame();
        }
        return true;
    }
    bool frame(std::string& reason) override
    {
        if (!poll(reason))
            return false;
        return submit_frame([&]() {
            const uint32_t units =
                offscreen_capacity ? noveltea::benchmark::kOffscreenWorkUnitsPerBatch : 1u;
            for (uint32_t i = 0; i < units; ++i) {
                if (!workload.submit(reason, !offscreen_capacity))
                    return false;
            }
            return true;
        });
    }
    bool cleanup(std::string& reason) override
    {
        workload.shutdown();
        return EmptyBgfxScenario::cleanup(reason);
    }
};

struct RmlUiScenario final : EmptyBgfxScenario {
    explicit RmlUiScenario(Graphics* shared = nullptr, bool scaling = false, bool effects = false)
        : EmptyBgfxScenario(shared), scaling(scaling), effects(effects)
    {
    }
    noveltea::benchmark::StandaloneRmlUi ui;
    bool scaling = false;
    bool effects = false;

    const char* id() const override
    {
        return effects   ? "standalone-rmlui-effects"
               : scaling ? "standalone-rmlui-scaling"
                         : "standalone-rmlui-simple";
    }
    const char* description() const override
    {
        return effects   ? "standalone RmlUi advanced styling and nested layers"
               : scaling ? "standalone RmlUi scaling: elements, text and lifecycle contexts"
                         : "standalone RmlUi context + rmlui-bgfx colored rectangles and text";
    }
    bool prepare(const Options& options, std::string& reason) override
    {
        if (!EmptyBgfxScenario::prepare(options, reason))
            return false;
        diagnostic = options.profile == "diagnostic";
        const auto scene = effects ? noveltea::benchmark::ui_effects_reference_scene(
                                         noveltea::benchmark::ui_effect_counts(options))
                           : scaling ? noveltea::benchmark::ui_scaling_reference_scene(
                                           options.ui_elements, options.ui_text_lines)
                                     : noveltea::benchmark::simple_ui_reference_scene();
        if (!ui.initialize(scene, host().environment.width_pixels, host().environment.height_pixels,
                           reason, scaling ? &options : nullptr))
            return false;
        host().environment.ui_backend = ui.backend_settings();
        // Compile font glyphs and upload backend resources outside all measured frames.
        for (int i = 0; i < 4; ++i) {
            if (!ui.submit(false, reason))
                return false;
            bgfx::frame();
        }
        if (effects) {
            host().environment.ui_effect_activity = ui.effect_activity();
            if (!ui.verify_effects(reason))
                return false;
        }
        return true;
    }
    bool frame(std::string& reason) override
    {
        if (!poll(reason))
            return false;
        return submit_frame([&]() { return ui.submit(diagnostic, reason); });
    }
    bool complete(std::string& reason) override
    {
        if (!effects)
            return true;
        host().environment.ui_effect_activity = ui.effect_activity();
        if (host().environment.ui_effect_activity->backend_errors > 0) {
            reason = "standalone RmlUi backend reported errors during measured effects";
            return false;
        }
        return true;
    }
    void diagnostic_frame(noveltea::benchmark::DiagnosticObservation& observation) override
    {
        EmptyBgfxScenario::diagnostic_frame(observation);
        const auto stages = ui.last_diagnostic_stages();
        observation.cpu_update_ms = stages.update_seconds * 1000.0;
        observation.rmlui_update_ms = observation.cpu_update_ms;
        observation.ui_fixture_mutation_ms = stages.fixture_mutation_seconds * 1000.0;
        // RmlUi Render() submits its draws; this stays distinct from bgfx::frame().
        observation.cpu_submission_ms = stages.render_seconds * 1000.0;
        observation.rmlui_render_ms = observation.cpu_submission_ms;
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

int run_cpu(const Options& options)
{
    if (!options.no_ui) {
        std::fprintf(stderr, "[benchmark] CPU workloads require --no-ui (no SDL/bgfx host)\n");
        return 2;
    }
    noveltea::benchmark::CpuScenario lua(noveltea::benchmark::CpuWorkload::Lua);
    noveltea::benchmark::CpuScenario session(noveltea::benchmark::CpuWorkload::RuntimeSession);
    noveltea::benchmark::CpuScenario prediction(noveltea::benchmark::CpuWorkload::FlowPrediction);
    Scenario* selected = options.scenario == "cpu-lua" ? static_cast<Scenario*>(&lua)
                         : options.scenario == "cpu-runtime-session"
                             ? static_cast<Scenario*>(&session)
                             : static_cast<Scenario*>(&prediction);
    SteadyClock clock;
    const SuiteResult result = noveltea::benchmark::run_suite(options, {selected}, clock);
    Environment environment;
    environment.platform = SDL_GetPlatform();
    environment.frame_path = "cpu-work-batch-no-presentation";
    std::string output;
    if (!write_report(options, environment, result, output))
        return 3;
    const auto& scenario = result.scenarios.front();
    if (scenario.outcome == "complete") {
        std::printf("[benchmark] complete: %llu CPU work batches across %zu trial(s), "
                    "%u work units/batch, CPU operation mean %.3f ms (no SDL/bgfx or GPU time)\n",
                    static_cast<unsigned long long>(scenario.measured_frames),
                    scenario.trials.size(), options.cpu_work_units, scenario.cpu_operation.mean_ms);
    } else {
        for (const auto& trial : scenario.trials) {
            if (trial.outcome != "complete")
                std::fprintf(stderr, "[benchmark] CPU trial %s: %s\n", trial.outcome.c_str(),
                             trial.reason.c_str());
        }
    }
    std::printf("[benchmark] report: %s (outcome=%s)\n", output.c_str(), result.outcome.c_str());
    return result.outcome == "complete" ? 0 : 2;
}

#if !defined(__EMSCRIPTEN__)
SuiteResult run_native_capacity(const Options& base, Scenario& scenario, Clock& clock,
                                std::vector<Environment>& environments,
                                const std::function<Environment()>& environment,
                                noveltea::benchmark::Recovery recovery = {})
{
    noveltea::benchmark::CapacitySearch search(base);
    SuiteResult collection;
    while (!search.done()) {
        const Options candidate = search.candidate_options();
        std::string error;
        if (!noveltea::benchmark::validate_run_options(candidate, error) ||
            !noveltea::benchmark::validate_reference_options(candidate, error)) {
            noveltea::benchmark::append_failed_scenario(collection, scenario.id(), error);
            search.observe(collection);
            environments.emplace_back();
            break;
        }
        SuiteResult item = noveltea::benchmark::run_suite(candidate, {&scenario}, clock, recovery);
        environments.push_back(environment());
        search.observe(item);
        noveltea::benchmark::append_suite_result(collection, std::move(item));
    }
    collection.capacity = search.result();
    if (collection.capacity->status == "inconclusive")
        collection.outcome = "partial";
    return collection;
}

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
        Options selected = noveltea::benchmark::reference_scenario_options(base, id);
        std::string reason;
        const bool engine_owned = id == "engine-empty" || id == "integrated-rmlui-controlled" ||
                                  id == "integrated-rmlui-production";
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
#if defined(__ANDROID__)
            item = noveltea::benchmark::run_suite(selected, {target}, clock,
                                                  android_engine_recovery());
#else
            item = noveltea::benchmark::run_suite(selected, {target}, clock);
#endif
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
#if defined(__ANDROID__)
            item = noveltea::benchmark::run_suite(
                selected, {target}, clock, android_shared_graphics_recovery(graphics, selected));
#else
            item = noveltea::benchmark::run_suite(selected, {target}, clock);
#endif
            environments.push_back(graphics.environment);
        }
        for (const auto& scenario : item.scenarios) {
            for (const auto& trial : scenario.trials) {
                if (trial.reason.find("cleanup failed") != std::string::npos ||
                    trial.reason.find("graphics recovery failed") != std::string::npos)
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
    if (options.scenario != "raw-bgfx-empty" && options.scenario != "raw-bgfx-geometry" &&
        !noveltea::benchmark::is_extended_raw_scenario(options.scenario) &&
        !noveltea::benchmark::is_ui_scaling_scenario(options.scenario) &&
        !noveltea::benchmark::is_ui_effects_scenario(options.scenario) &&
        !noveltea::benchmark::is_compiled_project_scenario(options.scenario) &&
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
    noveltea::benchmark::RawBgfxWorkloads preview_workload;
    noveltea::benchmark::StandaloneRmlUi preview_ui;
    Options preview_ui_options;
    Options preview_raw_options;
    int preview_raw_width = 0;
    int preview_raw_height = 0;
    uint32_t preview_count = 0;
    double preview_scale = 0;
    int preview_width = 0;
    int preview_height = 0;
    const auto draw_preview = [&]() -> bool {
        const auto checked = [&](bool success) {
            if (!success && feedback.empty())
                feedback = "Reference preview preparation or submission failed";
            return success;
        };
        if (options.scenario != "raw-bgfx-geometry")
            preview_geometry.shutdown();
        if (!noveltea::benchmark::is_extended_raw_scenario(options.scenario))
            preview_workload.shutdown();
        const bool scaling_preview = options.scenario == "standalone-rmlui-scaling";
        const bool effects_preview = options.scenario == "standalone-rmlui-effects";
        if (options.scenario != "standalone-rmlui-simple" && !scaling_preview && !effects_preview)
            preview_ui.shutdown();
        if (options.scenario == "standalone-rmlui-simple" || scaling_preview || effects_preview) {
            if (preview_ui.initialized() &&
                (options.scenario != preview_ui_options.scenario ||
                 options.ui_elements != preview_ui_options.ui_elements ||
                 options.ui_text_lines != preview_ui_options.ui_text_lines ||
                 options.ui_dynamic_lines != preview_ui_options.ui_dynamic_lines ||
                 options.ui_visible_contexts != preview_ui_options.ui_visible_contexts ||
                 options.ui_empty_contexts != preview_ui_options.ui_empty_contexts ||
                 options.ui_hidden_contexts != preview_ui_options.ui_hidden_contexts ||
                 options.ui_text_mode != preview_ui_options.ui_text_mode ||
                 options.ui_redraw != preview_ui_options.ui_redraw ||
                 options.ui_clipping != preview_ui_options.ui_clipping ||
                 options.ui_transforms != preview_ui_options.ui_transforms ||
                 options.ui_gradients != preview_ui_options.ui_gradients ||
                 options.ui_filters != preview_ui_options.ui_filters ||
                 options.ui_masks != preview_ui_options.ui_masks ||
                 options.ui_nested_layers != preview_ui_options.ui_nested_layers))
                preview_ui.shutdown();
            if (!preview_ui.initialized()) {
                const auto scene =
                    effects_preview ? noveltea::benchmark::ui_effects_reference_scene(
                                          noveltea::benchmark::ui_effect_counts(options))
                    : scaling_preview ? noveltea::benchmark::ui_scaling_reference_scene(
                                            options.ui_elements, options.ui_text_lines)
                                      : noveltea::benchmark::simple_ui_reference_scene();
                if (!preview_ui.initialize(scene, graphics.environment.width_pixels,
                                           graphics.environment.height_pixels, feedback,
                                           scaling_preview ? &options : nullptr))
                    return checked(false);
                preview_ui_options = options;
            }
            return checked(preview_ui.submit(false, feedback));
        }
        if (noveltea::benchmark::is_extended_raw_scenario(options.scenario)) {
            const int width = graphics.environment.width_pixels;
            const int height = graphics.environment.height_pixels;
            if (!preview_workload.initialized() ||
                options.scenario != preview_raw_options.scenario ||
                options.draw_calls != preview_raw_options.draw_calls ||
                options.quad_count != preview_raw_options.quad_count ||
                options.texture_size != preview_raw_options.texture_size ||
                options.coverage != preview_raw_options.coverage ||
                options.composition_path != preview_raw_options.composition_path ||
                options.composite_passes != preview_raw_options.composite_passes ||
                options.target_scale != preview_raw_options.target_scale ||
                options.msaa_samples != preview_raw_options.msaa_samples ||
                options.transparent_overlay != preview_raw_options.transparent_overlay ||
                width != preview_raw_width || height != preview_raw_height) {
                const auto spec = noveltea::benchmark::raw_workload_reference(
                    options, static_cast<uint32_t>(width), static_cast<uint32_t>(height));
                if (!spec || !preview_workload.initialize(*spec, static_cast<uint32_t>(width),
                                                          static_cast<uint32_t>(height), feedback))
                    return checked(false);
                preview_raw_options = options;
                preview_raw_width = width;
                preview_raw_height = height;
            }
            return checked(preview_workload.submit(feedback));
        }
        if (options.scenario != "raw-bgfx-geometry")
            return false;
        const int width = graphics.environment.width_pixels;
        const int height = graphics.environment.height_pixels;
        if (!preview_geometry.initialized() || preview_count != options.rect_count ||
            preview_scale != options.rect_scale || preview_width != width ||
            preview_height != height) {
            const auto scene = noveltea::benchmark::geometry_reference_scene(options.rect_count,
                                                                             options.rect_scale);
            if (!preview_geometry.initialize(scene, width, height, feedback))
                return checked(false);
            preview_count = options.rect_count;
            preview_scale = options.rect_scale;
            preview_width = width;
            preview_height = height;
        }
        return checked(preview_geometry.submit(feedback));
    };
    const auto& checked_preview = draw_preview;

    if (options.inspection_smoke) {
        std::string reason;
        if (!noveltea::benchmark::validate_run_options(options, reason) ||
            !noveltea::benchmark::validate_reference_options(options, reason)) {
            std::fprintf(stderr, "[benchmark] inspection smoke: %s\n", reason.c_str());
            return 2;
        }
        if (noveltea::benchmark::supports_inspection(options.scenario)) {
            for (int i = 0; i < 4; ++i)
                (void)dashboard.frame(options, nullptr, feedback, checked_preview);
            if (!feedback.empty() ||
                !graphics.inspection.request(options, graphics.environment.width_pixels,
                                             graphics.environment.height_pixels, feedback)) {
                std::fprintf(stderr, "[benchmark] inspection smoke: %s\n", feedback.c_str());
                return 3;
            }
            for (int i = 0; i < 300 && graphics.inspection.pending(); ++i) {
                bgfx::setViewClear(0, BGFX_CLEAR_COLOR, 0x17212cff);
                bgfx::touch(0);
                draw_preview();
                bgfx::frame();
                graphics.inspection.poll(feedback);
                SDL_Delay(16);
            }
        } else if (noveltea::benchmark::supports_engine_inspection(options.scenario)) {
            preview_geometry.shutdown();
            preview_workload.shutdown();
            preview_ui.shutdown();
            dashboard.shutdown();
            graphics.shutdown();
            noveltea::benchmark::IntegratedInspection capture;
            if (capture.begin(options, reason)) {
                for (int i = 0; i < 600; ++i) {
                    if (capture.step(reason))
                        break;
                    SDL_Delay(16);
                }
            }
            feedback = reason.empty() ? "Untimed screenshot: " + capture.path().string()
                                      : "Screenshot failed: " + reason;
            capture.shutdown();
        } else {
            feedback = "Screenshot unsupported: no reference preview for this scenario";
        }
        if (feedback.starts_with("Untimed screenshot: ") &&
            std::filesystem::exists(feedback.substr(sizeof("Untimed screenshot: ") - 1))) {
            std::printf("[benchmark] inspection smoke complete: %s\n", feedback.c_str());
            return 0;
        }
        std::fprintf(stderr, "[benchmark] inspection smoke failed: %s\n", feedback.c_str());
        return 3;
    }

    const auto benchmark_once = [&](bool quick = false) {
        if (graphics.inspection.pending()) {
            feedback = "Finish the pending inspection screenshot before benchmarking";
            return;
        }
        std::string validation;
        if (!noveltea::benchmark::validate_run_options(options, validation) ||
            (!quick && !noveltea::benchmark::validate_reference_options(options, validation))) {
            feedback = validation;
            return;
        }
        // The run configuration is frozen before any result is produced; later
        // dashboard edits must not change the identity of displayed samples.
        Options run_options =
            quick ? noveltea::benchmark::reference_scenario_options(options, options.scenario)
                  : options;
        // The six Quick Suite references never advance a Compiled Project session.
        if (quick) {
            run_options.clock_policy = "realtime";
            run_options.feature_lab_package.clear();
        }
        run_options.quick_suite = quick;
#if defined(__ANDROID__)
        EmptyBenchmarkCover cover;
        if (!quick && run_options.scenario == "raw-bgfx-empty" && !cover.show(feedback))
            return;
#endif
        // Preview GPU resources are released before the strict run.
        preview_geometry.shutdown();
        preview_workload.shutdown();
        preview_ui.shutdown();
        // No context, ImGui CPU frame, backend, atlas, shader or draw submissions
        // exist while the runner enters Preparation, Warmup or Measurement.
        dashboard.shutdown();
        // Drain deferred bgfx resource destruction outside the sampling window.
        bgfx::frame();
        bgfx::frame();
        const bool integrated = run_options.scenario == "integrated-rmlui-controlled" ||
                                run_options.scenario == "integrated-rmlui-production" ||
                                run_options.scenario == "integrated-rmlui-scaling" ||
                                run_options.scenario == "integrated-rmlui-effects";
        const bool engine_owned =
            integrated || run_options.scenario == "engine-empty" ||
            noveltea::benchmark::is_compiled_project_scenario(run_options.scenario);
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
            noveltea::benchmark::IntegratedRmlUi engine_ui(
                run_options.scenario == "integrated-rmlui-controlled",
                run_options.scenario == "integrated-rmlui-scaling",
                run_options.scenario == "integrated-rmlui-effects");
            noveltea::benchmark::EmptyEngine empty_engine(
                {}, noveltea::benchmark::engine_workload(run_options.scenario));
            Scenario* selected = integrated ? static_cast<Scenario*>(&engine_ui)
                                            : static_cast<Scenario*>(&empty_engine);
            noveltea::benchmark::Recovery recover;
#if defined(__ANDROID__)
            recover = android_engine_recovery();
#endif
            std::vector<Environment> environments;
            const auto current_environment = [&]() {
                return integrated ? engine_ui.environment() : empty_engine.environment();
            };
            auto result =
                run_options.capacity_dimension.empty()
                    ? noveltea::benchmark::run_suite(run_options, {selected}, clock, recover)
                    : run_native_capacity(run_options, *selected, clock, environments,
                                          current_environment, recover);
            ran = true;
            completed_run = noveltea::benchmark::CompletedRun{run_options, std::move(result), {}};
            const auto environment = current_environment();
            if (!write_report(run_options, environment, completed_run->result,
                              completed_run->report_path, environments)) {
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
            RawReferenceScenario raw(&graphics, run_options.scenario);
            RmlUiScenario rmlui(&graphics);
            RmlUiScenario scaling_ui(&graphics, true);
            RmlUiScenario effects_ui(&graphics, false, true);
            Scenario* selected =
                run_options.scenario == "raw-bgfx-geometry" ? static_cast<Scenario*>(&geometry)
                : noveltea::benchmark::is_extended_raw_scenario(run_options.scenario)
                    ? static_cast<Scenario*>(&raw)
                : run_options.scenario == "standalone-rmlui-simple" ? static_cast<Scenario*>(&rmlui)
                : run_options.scenario == "standalone-rmlui-scaling"
                    ? static_cast<Scenario*>(&scaling_ui)
                : run_options.scenario == "standalone-rmlui-effects"
                    ? static_cast<Scenario*>(&effects_ui)
                    : static_cast<Scenario*>(&empty);
            noveltea::benchmark::Recovery recover;
#if defined(__ANDROID__)
            recover = android_shared_graphics_recovery(graphics, run_options);
#endif
            std::vector<Environment> environments;
            auto result =
                run_options.capacity_dimension.empty()
                    ? noveltea::benchmark::run_suite(run_options, {selected}, clock, recover)
                    : run_native_capacity(
                          run_options, *selected, clock, environments,
                          [&]() { return graphics.environment; }, recover);
            ran = true;
            completed_run = noveltea::benchmark::CompletedRun{run_options, std::move(result), {}};
            if (!write_report(completed_run->configuration, graphics.environment,
                              completed_run->result, completed_run->report_path, environments)) {
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
                                  checked_preview);
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
                (void)dashboard.frame(options, nullptr, feedback, checked_preview);
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
                options.scenario =
                    (original_options.scenario == "standalone-rmlui-simple" ||
                     original_options.scenario == "integrated-rmlui-controlled" ||
                     original_options.scenario == "integrated-rmlui-production" ||
                     original_options.scenario == "engine-empty" ||
                     noveltea::benchmark::is_compiled_project_scenario(original_options.scenario))
                        ? "raw-bgfx-geometry"
                        : "integrated-rmlui-production";
#endif
                options =
                    noveltea::benchmark::reference_scenario_options(options, options.scenario);
            } else if (cycle == 2) {
                options = original_options;
            }
            // Exercise both the full-scene inspection and ordinary dashboard
            // draw paths before running strict no-ImGui trials.
            if (options.scenario != "raw-bgfx-empty" &&
                options.scenario != "integrated-rmlui-production" &&
                options.scenario != "integrated-rmlui-controlled" &&
                options.scenario != "engine-empty" &&
                !noveltea::benchmark::is_compiled_project_scenario(options.scenario))
                dashboard.set_inspection_only(cycle % 2 == 0);
            else
                dashboard.set_inspection_only(false);
            (void)dashboard.frame(options, completed_run ? &*completed_run : nullptr, feedback,
                                  checked_preview);
            benchmark_once(options.quick_suite);
            if (!dashboard.initialized() || !completed_run ||
                completed_run->result.outcome != "complete" || !feedback.empty())
                return 4;
            std::printf("[benchmark] dashboard cycle %d complete\n", cycle + 1);
        }
        dashboard.set_inspection_only(false);
        (void)dashboard.frame(options, &*completed_run, feedback, checked_preview);
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
            preview_workload.shutdown();
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
        graphics.inspection.poll(feedback);
        const auto action = dashboard.frame(
            options, completed_run ? &*completed_run : nullptr, feedback, checked_preview, [&]() {
                // A previous screenshot error is status, not a permanent latch;
                // the user must be able to retry an untimed capture.
                (void)graphics.inspection.request(options, graphics.environment.width_pixels,
                                                  graphics.environment.height_pixels, feedback);
            });
        if (action == noveltea::benchmark::DashboardAction::Exit)
            break;
        if (action == noveltea::benchmark::DashboardAction::CaptureEngine) {
            std::string reason;
            if (!noveltea::benchmark::validate_run_options(options, reason) ||
                !noveltea::benchmark::validate_reference_options(options, reason)) {
                feedback = "Screenshot failed: " + reason;
                continue;
            }
            // The production Engine must own SDL/bgfx exclusively, even for
            // untimed inspection. Never substitute a standalone lookalike.
            preview_geometry.shutdown();
            preview_workload.shutdown();
            preview_ui.shutdown();
            dashboard.shutdown();
            graphics.shutdown();
            noveltea::benchmark::IntegratedInspection capture;
            if (capture.begin(options, reason)) {
                for (;;) {
                    if (capture.step(reason))
                        break;
                    SDL_Delay(16);
                }
            }
            const auto path = capture.path();
            capture.shutdown();
            std::string restore_error;
            if (!graphics.initialize(options, restore_error) ||
                !dashboard.initialize(graphics.window, options, restore_error)) {
                std::fprintf(stderr, "[benchmark] dashboard restoration after screenshot: %s\n",
                             restore_error.c_str());
                return 3;
            }
            feedback = reason.empty() ? "Untimed screenshot: " + path.string()
                                      : "Screenshot failed: " + reason;
            continue;
        }
        if (action == noveltea::benchmark::DashboardAction::Run ||
            action == noveltea::benchmark::DashboardAction::QuickSuite)
            benchmark_once(action == noveltea::benchmark::DashboardAction::QuickSuite);
        SDL_Delay(10);
    }
    preview_geometry.shutdown();
    preview_workload.shutdown();
    preview_ui.shutdown();
    return 0;
}

int run(const Options& options)
{
    if (options.scenario != "raw-bgfx-empty" && options.scenario != "raw-bgfx-geometry" &&
        !noveltea::benchmark::is_extended_raw_scenario(options.scenario) &&
        !noveltea::benchmark::is_ui_scaling_scenario(options.scenario) &&
        !noveltea::benchmark::is_ui_effects_scenario(options.scenario) &&
        !noveltea::benchmark::is_compiled_project_scenario(options.scenario) &&
        options.scenario != "standalone-rmlui-simple" &&
        options.scenario != "integrated-rmlui-controlled" &&
        options.scenario != "integrated-rmlui-production" && options.scenario != "engine-empty") {
        std::fprintf(stderr, "[benchmark] unsupported scenario: %s\n", options.scenario.c_str());
        return 2;
    }
    SteadyClock clock;
    if (options.quick_suite) {
        Graphics graphics;
        Options suite_options =
            noveltea::benchmark::reference_scenario_options(options, options.scenario);
        suite_options.clock_policy = "realtime";
        suite_options.feature_lab_package.clear();
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
    RawReferenceScenario raw(nullptr, options.scenario);
    RmlUiScenario rmlui;
    RmlUiScenario scaling_ui(nullptr, true);
    RmlUiScenario effects_ui(nullptr, false, true);
    noveltea::benchmark::IntegratedRmlUi scaling_engine(false, true);
    noveltea::benchmark::IntegratedRmlUi effects_engine(false, false, true);
    noveltea::benchmark::IntegratedRmlUi controlled(true);
    noveltea::benchmark::IntegratedRmlUi production(false);
    noveltea::benchmark::EmptyEngine empty_engine(
        {}, noveltea::benchmark::engine_workload(options.scenario));
    Scenario* selected =
        options.scenario == "raw-bgfx-geometry" ? static_cast<Scenario*>(&geometry)
        : noveltea::benchmark::is_extended_raw_scenario(options.scenario)
            ? static_cast<Scenario*>(&raw)
        : options.scenario == "standalone-rmlui-simple"  ? static_cast<Scenario*>(&rmlui)
        : options.scenario == "standalone-rmlui-scaling" ? static_cast<Scenario*>(&scaling_ui)
        : options.scenario == "standalone-rmlui-effects" ? static_cast<Scenario*>(&effects_ui)
        : options.scenario == "integrated-rmlui-effects" ? static_cast<Scenario*>(&effects_engine)
        : options.scenario == "integrated-rmlui-scaling" ? static_cast<Scenario*>(&scaling_engine)
        : options.scenario == "integrated-rmlui-controlled" ? static_cast<Scenario*>(&controlled)
        : options.scenario == "integrated-rmlui-production" ? static_cast<Scenario*>(&production)
        : options.scenario == "engine-empty" ||
                noveltea::benchmark::is_compiled_project_scenario(options.scenario)
            ? static_cast<Scenario*>(&empty_engine)
            : static_cast<Scenario*>(&empty);
    noveltea::benchmark::Recovery recover;
#if defined(__ANDROID__)
    if (options.scenario == "engine-empty" ||
        noveltea::benchmark::is_compiled_project_scenario(options.scenario) ||
        options.scenario == "integrated-rmlui-controlled" ||
        options.scenario == "integrated-rmlui-production" ||
        options.scenario == "integrated-rmlui-scaling" ||
        options.scenario == "integrated-rmlui-effects")
        recover = android_engine_recovery();
#endif
    std::vector<Environment> capacity_environments;
    const auto measured_environment = [&]() -> Environment {
        return options.scenario == "engine-empty" ||
                       noveltea::benchmark::is_compiled_project_scenario(options.scenario)
                   ? empty_engine.environment()
               : options.scenario == "integrated-rmlui-controlled" ? controlled.environment()
               : options.scenario == "integrated-rmlui-production" ? production.environment()
               : options.scenario == "integrated-rmlui-scaling"    ? scaling_engine.environment()
               : options.scenario == "integrated-rmlui-effects"    ? effects_engine.environment()
               : options.scenario == "standalone-rmlui-effects"    ? effects_ui.graphics.environment
               : options.scenario == "standalone-rmlui-simple"     ? rmlui.graphics.environment
               : options.scenario == "standalone-rmlui-scaling"    ? scaling_ui.graphics.environment
               : options.scenario == "raw-bgfx-geometry"           ? geometry.graphics.environment
               : noveltea::benchmark::is_extended_raw_scenario(options.scenario)
                   ? raw.graphics.environment
                   : empty.graphics.environment;
    };
    const SuiteResult result =
        options.capacity_dimension.empty()
            ? noveltea::benchmark::run_suite(options, {selected}, clock, recover)
            : run_native_capacity(options, *selected, clock, capacity_environments,
                                  measured_environment, recover);
    const Environment environment =
        options.scenario == "engine-empty" ||
                noveltea::benchmark::is_compiled_project_scenario(options.scenario)
            ? empty_engine.environment()
        : options.scenario == "integrated-rmlui-controlled" ? controlled.environment()
        : options.scenario == "integrated-rmlui-production" ? production.environment()
        : options.scenario == "integrated-rmlui-scaling"    ? scaling_engine.environment()
        : options.scenario == "integrated-rmlui-effects"    ? effects_engine.environment()
        : options.scenario == "standalone-rmlui-effects"    ? effects_ui.graphics.environment
        : options.scenario == "standalone-rmlui-simple"     ? rmlui.graphics.environment
        : options.scenario == "standalone-rmlui-scaling"    ? scaling_ui.graphics.environment
        : options.scenario == "raw-bgfx-geometry"           ? geometry.graphics.environment
        : noveltea::benchmark::is_extended_raw_scenario(options.scenario)
            ? raw.graphics.environment
            : empty.graphics.environment;
    std::string output;
    if (!write_report(options, environment, result, output, capacity_environments))
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
    const std::string alternate_path = options.alternate_config_path;
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
    if (!alternate_path.empty()) {
        if (options.alternate) {
            std::fprintf(stderr, "[benchmark] candidate B already embedded in --config\n");
            return 2;
        }
        std::ifstream input(alternate_path);
        if (!input) {
            std::fprintf(stderr, "[benchmark] cannot open alternate config: %s\n",
                         alternate_path.c_str());
            return 2;
        }
        const std::string json((std::istreambuf_iterator<char>(input)),
                               std::istreambuf_iterator<char>());
        Options candidate;
        if (!noveltea::benchmark::decode_configuration(json, candidate, error) ||
            candidate.alternate) {
            std::fprintf(stderr, "[benchmark] invalid candidate B: %s\n", error.c_str());
            return 2;
        }
        options.alternate = std::make_shared<Options>(std::move(candidate));
    }
    if (argc == 1) {
        noveltea::benchmark::DashboardPreferences preferences;
        std::string storage_error;
        if (noveltea::benchmark::load_dashboard_preferences(preferences, storage_error)) {
            // Restore an interactive session, never silently run a saved unattended configuration.
            // Explicit CLI and --config always take precedence over local preferences.
            if (preferences.last_configuration.no_ui ||
                !preferences.last_configuration.scenario.empty()) {
                options = preferences.last_configuration;
                options.no_ui = false;
                options.quick_suite = false;
            }
        } else {
            std::fprintf(stderr, "[benchmark] dashboard preferences: %s\n", storage_error.c_str());
        }
    }
    if (!noveltea::benchmark::validate_run_options(options, error) ||
        !noveltea::benchmark::validate_reference_options(options, error)) {
        std::fprintf(stderr, "[benchmark] %s\n", error.c_str());
        return 2;
    }
    if (noveltea::benchmark::is_cpu_scenario(options.scenario))
        return run_cpu(options);
#if defined(__EMSCRIPTEN__)
    return run_web(options);
#else
    return options.no_ui ? run(options) : run_dashboard(options);
#endif
}
