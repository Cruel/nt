// Included only by main.cpp in the benchmark's anonymous namespace.
// The Emscripten callback remains registered for the lifetime of the page.
struct WebBenchmarkApp {
    explicit WebBenchmarkApp(Options initial) : options(std::move(initial)) {}

    Options options;
    Graphics graphics;
    noveltea::benchmark::Dashboard dashboard;
    noveltea::benchmark::RawBgfxGeometry preview_geometry;
    noveltea::benchmark::RawBgfxWorkloads preview_workload;
    noveltea::benchmark::StandaloneRmlUi preview_ui;
    Options preview_ui_options;
    Options preview_raw_options;
    int preview_raw_width = 0;
    int preview_raw_height = 0;
    SteadyClock clock;
    std::optional<noveltea::benchmark::CompletedRun> completed_run;
    std::unique_ptr<Scenario> active_scenario;
    // Cancelling while WebGL is lost must not run a GPU destructor. Keep the
    // abandoned scenario alive until the restored context can release it.
    std::unique_ptr<Scenario> deferred_scenario;
    std::unique_ptr<noveltea::benchmark::FrameDrivenSuite> active;
    Options current_options;
    SuiteResult collected;
    std::vector<Environment> collected_environments;
    bool quick_suite_active = false;
    size_t quick_index = 0;
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
        if ((!options.quick_suite && !supported_scenario(options.scenario)) ||
            !graphics.initialize(options, error)) {
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
            start(options.quick_suite);
        return true;
    }

    static bool engine_owned(const std::string& id)
    {
        return id == "engine-empty" || id == "integrated-rmlui-controlled" ||
               id == "integrated-rmlui-production" || id == "integrated-rmlui-scaling" ||
               id == "integrated-rmlui-effects";
    }

    bool supported_scenario(const std::string& id) const
    {
        return engine_owned(id) || id == "raw-bgfx-empty" || id == "raw-bgfx-geometry" ||
               noveltea::benchmark::is_extended_raw_scenario(id) ||
               id == "standalone-rmlui-simple" || id == "standalone-rmlui-scaling" ||
               id == "standalone-rmlui-effects";
    }

    Environment scenario_environment() const
    {
        if (current_options.scenario == "engine-empty")
            return static_cast<const noveltea::benchmark::EmptyEngine&>(*active_scenario)
                .environment();
        if (current_options.scenario == "integrated-rmlui-controlled" ||
            current_options.scenario == "integrated-rmlui-production" ||
            current_options.scenario == "integrated-rmlui-scaling" ||
            current_options.scenario == "integrated-rmlui-effects")
            return static_cast<const noveltea::benchmark::IntegratedRmlUi&>(*active_scenario)
                .environment();
        return graphics.environment;
    }

    void draw_preview()
    {
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
                (options.scenario != preview_ui_options.scenario || options.ui_elements != preview_ui_options.ui_elements ||
                 options.ui_text_lines != preview_ui_options.ui_text_lines ||
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
                const auto scene = effects_preview
                    ? noveltea::benchmark::ui_effects_reference_scene(
                          noveltea::benchmark::ui_effect_counts(options))
                    : scaling_preview
                    ? noveltea::benchmark::ui_scaling_reference_scene(options.ui_elements, options.ui_text_lines)
                    : noveltea::benchmark::simple_ui_reference_scene();
                if (!preview_ui.initialize(scene, graphics.environment.width_pixels,
                                           graphics.environment.height_pixels, feedback,
                                           scaling_preview ? &options : nullptr))
                    return;
                preview_ui_options = options;
            }
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
        } else if (noveltea::benchmark::is_extended_raw_scenario(options.scenario)) {
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
                    return;
                preview_raw_options = options;
                preview_raw_width = width;
                preview_raw_height = height;
            }
            (void)preview_workload.submit(feedback);
        }
    }

    bool restore_graphics(std::string& error)
    {
        // Executed only after webglcontextrestored: no GL/bgfx calls may
        // touch deferred scenario resources while the context is lost.
        if (deferred_scenario) {
            std::string cleanup_error;
            if (!deferred_scenario->cleanup(cleanup_error))
                std::fprintf(stderr, "[benchmark] deferred WebGL cleanup: %s\n",
                             cleanup_error.c_str());
            deferred_scenario.reset();
        }
        preview_geometry.shutdown();
        preview_workload.shutdown();
        preview_ui.shutdown();
        dashboard.shutdown();
        graphics.shutdown();
        if (!graphics.initialize(options, error))
            return false;
        EM_ASM({
            window.NovelTeaBenchmark.contextRecoveryNeeded = false;
            window.NovelTeaBenchmark.backgrounded = document.hidden;
        });
        return true;
    }

    void start(bool suite = false)
    {
        quick_suite_active = suite;
        quick_index = 0;
        collected = {};
        collected_environments.clear();
        completed_run.reset();
        feedback.clear();
        start_next();
    }

    void start_next()
    {
        current_options = options;
        current_options.quick_suite = quick_suite_active;
        std::string error;
        if (quick_suite_active) {
            const auto& ids = noveltea::benchmark::quick_suite_scenarios();
            if (quick_index < ids.size()) {
                current_options = noveltea::benchmark::reference_scenario_options(
                    options, ids[quick_index]);
                current_options.quick_suite = true;
            }
            if (quick_index == ids.size()) {
                finish_collection();
                return;
            }
        }
        const bool owns_engine = engine_owned(current_options.scenario);
        const bool valid = supported_scenario(current_options.scenario) &&
                           noveltea::benchmark::validate_run_options(current_options, error) &&
                           noveltea::benchmark::validate_reference_options(current_options, error);
        const bool graphics_ok =
            !valid ? false
            : owns_engine ? true
            : (graphics.bgfx_ready || graphics.initialize(current_options, error)) &&
                  graphics.reconfigure(current_options, error);
        if (!valid || !graphics_ok) {
            // A failed raw host transition may have partially initialized
            // SDL or bgfx. Fully release it before another Engine takes over.
            if (valid && !graphics_ok && !owns_engine) {
                preview_geometry.shutdown();
                preview_workload.shutdown();
                preview_ui.shutdown();
                dashboard.shutdown();
                graphics.shutdown();
            }
            feedback = error.empty() ? "unsupported Web scenario" : error;
            if (quick_suite_active) {
                noveltea::benchmark::append_failed_scenario(
                    collected, current_options.scenario, feedback);
                collected_environments.emplace_back();
                ++quick_index;
                start_next();
            }
            return;
        }
        const Options frozen = current_options;
        preview_geometry.shutdown();
        preview_workload.shutdown();
        preview_ui.shutdown();
        dashboard.shutdown();
        if (graphics.bgfx_ready) {
            // Drain dashboard allocations and clear its pixels outside sampling.
            for (int i = 0; i < 2; ++i)
                bgfx::frame();
            if (owns_engine) {
                // The production Engine creates its own SDL window and bgfx device.
                // Keep the page and its registered rAF callback alive.
                graphics.shutdown();
            } else {
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
            }
        }
        if (frozen.scenario == "engine-empty")
            active_scenario = std::make_unique<noveltea::benchmark::EmptyEngine>();
        else if (frozen.scenario == "integrated-rmlui-controlled" ||
                 frozen.scenario == "integrated-rmlui-production" ||
                 frozen.scenario == "integrated-rmlui-scaling" ||
                 frozen.scenario == "integrated-rmlui-effects")
            active_scenario = std::make_unique<noveltea::benchmark::IntegratedRmlUi>(
                frozen.scenario == "integrated-rmlui-controlled",
                frozen.scenario == "integrated-rmlui-scaling",
                frozen.scenario == "integrated-rmlui-effects");
        else if (frozen.scenario == "raw-bgfx-geometry")
            active_scenario = std::make_unique<GeometryBgfxScenario>(&graphics);
        else if (noveltea::benchmark::is_extended_raw_scenario(frozen.scenario))
            active_scenario = std::make_unique<RawReferenceScenario>(&graphics, frozen.scenario);
        else if (frozen.scenario == "standalone-rmlui-simple" ||
                 frozen.scenario == "standalone-rmlui-scaling" ||
                 frozen.scenario == "standalone-rmlui-effects")
            active_scenario = std::make_unique<RmlUiScenario>(
                &graphics, frozen.scenario == "standalone-rmlui-scaling",
                frozen.scenario == "standalone-rmlui-effects");
        else
            active_scenario = std::make_unique<EmptyBgfxScenario>(&graphics);
        // A hidden browser page cannot provide trustworthy frame cadence.
        // Reset the latch only at the start of a new trial collection.
        EM_ASM({ window.NovelTeaBenchmark.backgrounded = document.hidden; });
        active = std::make_unique<noveltea::benchmark::FrameDrivenSuite>(
            frozen, *active_scenario, clock, [this](std::string& error) {
                if (EM_ASM_INT({ return document.hidden || window.NovelTeaBenchmark.contextLost; }))
                    return noveltea::benchmark::RecoveryState::Pending;
                if (EM_ASM_INT({ return window.NovelTeaBenchmark.contextRecoveryNeeded; })) {
                    if (engine_owned(current_options.scenario)) {
                        // The interrupted Engine has already shut down its bgfx owner;
                        // its next preparation creates a fresh Engine-owned device.
                        EM_ASM({ window.NovelTeaBenchmark.contextRecoveryNeeded = false; });
                    } else if (!restore_graphics(error)) {
                        return noveltea::benchmark::RecoveryState::Failed;
                    }
                }
                EM_ASM({ window.NovelTeaBenchmark.backgrounded = false; });
                return noveltea::benchmark::RecoveryState::Ready;
            });
        completed_run.reset();
        feedback.clear();
    }

    void finish(bool graphics_unavailable = false)
    {
        const auto latest = active->result();
        const Environment environment = scenario_environment();
        active.reset();
        if (graphics_unavailable)
            deferred_scenario = std::move(active_scenario);
        else
            active_scenario.reset();
        if (quick_suite_active) {
            collected_environments.push_back(environment);
            noveltea::benchmark::append_suite_result(collected, latest);
            if (!graphics_unavailable && latest.outcome != "cancelled") {
                ++quick_index;
                start_next();
                return;
            }
        } else {
            collected = latest;
            collected_environments = {environment};
        }
        finish_collection(graphics_unavailable);
    }

    void finish_collection(bool graphics_unavailable = false)
    {
        Options reported = quick_suite_active
                               ? noveltea::benchmark::reference_scenario_options(
                                     options, options.scenario)
                               : options;
        reported.quick_suite = quick_suite_active;
        completed_run = noveltea::benchmark::CompletedRun{reported, collected, {}};
        quick_suite_active = false;
        // Use the observed scenario host, not the dashboard host released
        // before Engine-owned runs. Mixed suites retain per-scenario metadata.
        const Environment& report_environment =
            collected.scenarios.size() == 1 && collected_environments.size() == 1
                ? collected_environments.front()
                : graphics.environment;
        if (!write_report(completed_run->configuration, report_environment, completed_run->result,
                          completed_run->report_path, collected_environments))
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
                    std::fprintf(stderr, "[benchmark] trial %s: %s\n", trial.outcome.c_str(),
                                 trial.reason.c_str());
            }
        }
        // The terminal Engine's SDL/bgfx owner is gone. Restore the benchmark
        // host before creating ImGui or continuing with idle rAF callbacks.
        if (!graphics_unavailable) {
            std::string error;
            if (EM_ASM_INT({ return window.NovelTeaBenchmark.contextRecoveryNeeded; })) {
                if (!restore_graphics(error))
                    feedback = "graphics recreation after context loss: " + error;
            } else if (!graphics.bgfx_ready && !graphics.initialize(options, error)) {
                feedback = "graphics recreation after Engine run: " + error;
            }
            if (!options.no_ui && graphics.bgfx_ready &&
                !dashboard.initialize(graphics.window, options, error))
                feedback = "dashboard recreation: " + error;
        }
        if (options.dashboard_smoke && completed_run->result.outcome == "complete") {
            std::printf("[benchmark] web dashboard cycle %d complete\n", ++smoke_cycle);
            if (smoke_cycle < 3) {
                options = noveltea::benchmark::reference_scenario_options(
                    options, smoke_cycle == 1 ? "raw-bgfx-geometry"
                                              : "standalone-rmlui-simple");
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
        bool escape_pressed = false;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_QUIT || event.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED)
                should_exit = true;
            else if (active && event.type == SDL_EVENT_KEY_DOWN && event.key.key == SDLK_ESCAPE)
                escape_pressed = true;
            else if (!active && dashboard.initialized())
                dashboard.process_event(event);
        }
        if (should_exit && !active) {
            stopped = true;
            emscripten_cancel_main_loop();
            return;
        }
        const bool context_lost =
            EM_ASM_INT({ return window.NovelTeaBenchmark.contextLost ? 1 : 0; });
        const bool context_changed =
            EM_ASM_INT({ return window.NovelTeaBenchmark.contextRecoveryNeeded ? 1 : 0; });
        if (active) {
            if (context_lost) {
                // Terminal cancellation is allowed during context loss. Avoid
                // both runner cleanup and the scenario's GPU-owning destructor
                // until the browser restores WebGL, but export JSON now.
                if (should_exit || escape_pressed) {
                    active->cancel_without_cleanup(should_exit
                                                       ? "browser window closed during benchmark"
                                                       : "benchmark cancelled with Escape");
                    if (active->step())
                        finish(true);
                }
                return;
            }
            if (should_exit)
                active->cancel("browser window closed during benchmark");
            else if (escape_pressed)
                active->cancel("benchmark cancelled with Escape");
            else if (context_changed)
                active->interrupt("WebGL context lost during benchmark");
            else if (EM_ASM_INT({
                         return window.NovelTeaBenchmark.backgrounded || document.hidden ? 1 : 0;
                     }))
                active->interrupt("browser tab backgrounded; requestAnimationFrame throttled");
            if (active->step())
                finish();
            return;
        }
        if (context_lost)
            return;
        if (context_changed) {
            std::string error;
            if (!restore_graphics(error)) {
                feedback = "WebGL graphics recovery failed: " + error;
                stopped = true;
                std::fprintf(stderr, "[benchmark] %s\n", feedback.c_str());
                emscripten_cancel_main_loop();
                return;
            }
            if (!options.no_ui && !dashboard.initialize(graphics.window, options, error)) {
                feedback = "dashboard recovery: " + error;
                std::fprintf(stderr, "[benchmark] %s\n", feedback.c_str());
            }
        }
        if (dashboard.initialized()) {
            const auto action = dashboard.frame(options, completed_run ? &*completed_run : nullptr,
                                                feedback, [this]() { draw_preview(); });
            if (action == noveltea::benchmark::DashboardAction::Exit) {
                stopped = true;
                emscripten_cancel_main_loop();
            } else if (action == noveltea::benchmark::DashboardAction::Run ||
                       action == noveltea::benchmark::DashboardAction::QuickSuite) {
                start(action == noveltea::benchmark::DashboardAction::QuickSuite);
            }
        } else if (graphics.bgfx_ready) {
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
