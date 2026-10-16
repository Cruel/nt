// Included only by main.cpp in the benchmark's anonymous namespace.
// The Emscripten callback remains registered for the lifetime of the page.
struct WebBenchmarkApp {
    explicit WebBenchmarkApp(Options initial) : options(std::move(initial)) {}

    Options options;
    Graphics graphics;
    noveltea::benchmark::Dashboard dashboard;
    noveltea::benchmark::RawBgfxGeometry preview_geometry;
    noveltea::benchmark::StandaloneRmlUi preview_ui;
    SteadyClock clock;
    std::optional<noveltea::benchmark::CompletedRun> completed_run;
    std::unique_ptr<Scenario> active_scenario;
    std::unique_ptr<noveltea::benchmark::FrameDrivenSuite> active;
    std::string feedback;
    bool stopped = false;
    int smoke_cycle = 0;
    uint32_t preview_count = 0;
    double preview_scale = 0;
    int preview_width = 0;
    int preview_height = 0;

    bool initialize()
    {
        std::string error;
        if (!supported_scenario() || !graphics.initialize(options, error)) {
            std::fprintf(stderr, "[benchmark] Web initialization: %s\n",
                         error.empty() ? "unsupported Web scenario" : error.c_str());
            return false;
        }
        if (!options.no_ui && !dashboard.initialize(graphics.window, options, error)) {
            std::fprintf(stderr, "[benchmark] Web dashboard: %s\n", error.c_str());
            return false;
        }
        EM_ASM({ window.NovelTeaBenchmark.ready = true; });
        if (options.no_ui || options.dashboard_smoke)
            start();
        return true;
    }

    bool supported_scenario() const
    {
        return options.scenario == "raw-bgfx-empty" || options.scenario == "raw-bgfx-geometry" ||
               options.scenario == "standalone-rmlui-simple";
    }

    void draw_preview()
    {
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
        } else if (options.scenario == "raw-bgfx-geometry") {
            const auto scene = noveltea::benchmark::geometry_reference_scene(options.rect_count,
                                                                             options.rect_scale);
            // Preview construction and GPU uploads happen outside timed sampling.
            const int width = graphics.environment.width_pixels;
            const int height = graphics.environment.height_pixels;
            if (!preview_geometry.initialized() || preview_count != options.rect_count ||
                preview_scale != options.rect_scale || preview_width != width ||
                preview_height != height) {
                if (!preview_geometry.initialize(scene, width, height, feedback))
                    return;
                preview_count = options.rect_count;
                preview_scale = options.rect_scale;
                preview_width = width;
                preview_height = height;
            }
            (void)preview_geometry.submit(feedback);
        }
    }

    void start()
    {
        std::string error;
        if (!supported_scenario() || !noveltea::benchmark::validate_run_options(options, error) ||
            !noveltea::benchmark::validate_reference_options(options, error)) {
            feedback = error.empty() ? "Web supports raw bgfx and standalone RmlUi only" : error;
            return;
        }
        if (!graphics.reconfigure(options, error)) {
            feedback = error;
            return;
        }
        const Options frozen = options;
        preview_geometry.shutdown();
        preview_ui.shutdown();
        dashboard.shutdown();
        // Drain dashboard GPU allocations and clear prior UI pixels, all untimed.
        for (int i = 0; i < 2; ++i)
            bgfx::frame();
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
        if (frozen.scenario == "raw-bgfx-geometry")
            active_scenario = std::make_unique<GeometryBgfxScenario>(&graphics);
        else if (frozen.scenario == "standalone-rmlui-simple")
            active_scenario = std::make_unique<RmlUiScenario>(&graphics);
        else
            active_scenario = std::make_unique<EmptyBgfxScenario>(&graphics);
        // A hidden browser page cannot provide trustworthy frame cadence.
        // Reset the latch only at the start of a new trial collection.
        EM_ASM({ window.NovelTeaBenchmark.backgrounded = document.hidden; });
        active = std::make_unique<noveltea::benchmark::FrameDrivenSuite>(frozen, *active_scenario,
                                                                         clock);
        completed_run.reset();
        feedback.clear();
    }

    void finish()
    {
        completed_run = noveltea::benchmark::CompletedRun{options, active->result(), {}};
        active.reset();
        active_scenario.reset();
        if (!write_report(completed_run->configuration, graphics.environment, completed_run->result,
                          completed_run->report_path))
            feedback = "failed to save or download benchmark report";
        else
            feedback.clear();
        for (const auto& scenario : completed_run->result.scenarios) {
            std::printf("[benchmark] %s: %s, %llu frames, %.3f s rAF-paced cadence; CPU operation "
                        "mean %.3f ms\n",
                        scenario.scenario.c_str(), scenario.outcome.c_str(),
                        static_cast<unsigned long long>(scenario.measured_frames),
                        scenario.measured_wall_seconds, scenario.cpu_operation.mean_ms);
            for (const auto& trial : scenario.trials) {
                if (trial.outcome != "complete")
                    std::fprintf(stderr, "[benchmark] trial failed: %s\n", trial.reason.c_str());
            }
        }
        if (!options.no_ui) {
            std::string error;
            if (!dashboard.initialize(graphics.window, options, error))
                feedback = "dashboard recreation: " + error;
        }
        if (options.dashboard_smoke) {
            std::printf("[benchmark] web dashboard cycle %d complete\n", ++smoke_cycle);
            if (smoke_cycle < 3) {
                options.scenario =
                    smoke_cycle == 1 ? "raw-bgfx-geometry" : "standalone-rmlui-simple";
                start();
            }
        }
    }

    void tick()
    {
        if (stopped)
            return;
        SDL_Event event;
        bool should_exit = false;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_QUIT || event.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED)
                should_exit = true;
            else if (!active && dashboard.initialized())
                dashboard.process_event(event);
        }
        if (should_exit) {
            if (active)
                active->interrupt("browser window closed during benchmark");
            else {
                stopped = true;
                emscripten_cancel_main_loop();
                return;
            }
        }
        if (active) {
            if (EM_ASM_INT(
                    { return window.NovelTeaBenchmark.backgrounded || document.hidden ? 1 : 0; }))
                active->interrupt("browser tab backgrounded; requestAnimationFrame throttled");
            if (active->step())
                finish();
            return;
        }
        if (dashboard.initialized()) {
            const auto action = dashboard.frame(options, completed_run ? &*completed_run : nullptr,
                                                feedback, [this]() { draw_preview(); });
            if (action == noveltea::benchmark::DashboardAction::Exit) {
                stopped = true;
                emscripten_cancel_main_loop();
            } else if (action == noveltea::benchmark::DashboardAction::Run ||
                       action == noveltea::benchmark::DashboardAction::QuickSuite) {
                start();
            }
        } else {
            // Keep the browser's rAF callback live after unattended completion.
            bgfx::touch(0);
            bgfx::frame();
        }
    }
};

int run_web(Options options)
{
    auto* app = new WebBenchmarkApp(std::move(options));
    if (!app->initialize()) {
        delete app;
        return 3;
    }
    emscripten_set_main_loop_arg([](void* state) { static_cast<WebBenchmarkApp*>(state)->tick(); },
                                 app, 0, true);
    return 0;
}
