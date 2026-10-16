#include "benchmark_dashboard.hpp"
#include "benchmark_view_order.hpp"
#include "benchmark_assets.hpp"
#include "reference_workloads.hpp"

#include <imgui.h>
#include <imgui_impl_sdl3.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

namespace noveltea::benchmark {
namespace {

void show_distribution(const char* name, const Distribution& value)
{
    if (!value.count) {
        ImGui::Text("%s: unavailable", name);
        return;
    }
    ImGui::Text("%s: mean %.3f ms | p50 %.3f | p95 %.3f | p99 %.3f", name, value.mean_ms,
                value.p50_ms, value.p95_ms, value.p99_ms);
    ImGui::TextDisabled("  min %.3f ms | max %.3f ms | stddev %.3f ms | %llu samples", value.min_ms,
                        value.max_ms, value.standard_deviation_ms,
                        static_cast<unsigned long long>(value.count));
}

} // namespace

Dashboard::~Dashboard() { shutdown(); }

bool Dashboard::create_resources(std::string& error)
{
    const auto vertex = load_benchmark_shader(NOVELTEA_BENCHMARK_SHADER_ROOT "/imgui.vs.bin");
    if (!bgfx::isValid(vertex)) {
        error = "missing/unloadable benchmark ImGui vertex shader";
        return false;
    }
    const auto fragment = load_benchmark_shader(NOVELTEA_BENCHMARK_SHADER_ROOT "/imgui.fs.bin");
    if (!bgfx::isValid(fragment)) {
        bgfx::destroy(vertex);
        error = "missing/unloadable benchmark ImGui fragment shader";
        return false;
    }
    program_ = bgfx::createProgram(vertex, fragment, true);
    if (!bgfx::isValid(program_)) {
        error = "failed to create ImGui shader program";
        return false;
    }
    sampler_ = bgfx::createUniform("s_tex", bgfx::UniformType::Sampler);
    if (!bgfx::isValid(sampler_)) {
        error = "failed to create ImGui sampler";
        return false;
    }

    unsigned char* pixels = nullptr;
    int width = 0;
    int height = 0;
    ImGui::GetIO().Fonts->GetTexDataAsRGBA32(&pixels, &width, &height);
    if (!pixels || width < 1 || height < 1 || width > 65535 || height > 65535) {
        error = "failed to build ImGui font atlas";
        return false;
    }
    font_ = bgfx::createTexture2D(static_cast<uint16_t>(width), static_cast<uint16_t>(height),
                                  false, 1, bgfx::TextureFormat::RGBA8,
                                  BGFX_SAMPLER_MIN_POINT | BGFX_SAMPLER_MAG_POINT,
                                  bgfx::copy(pixels, static_cast<uint32_t>(width * height * 4)));
    if (!bgfx::isValid(font_)) {
        error = "failed to upload ImGui font texture";
        return false;
    }
    ImGui::GetIO().Fonts->TexID = static_cast<ImTextureID>(static_cast<uintptr_t>(font_.idx));
    return true;
}

bool Dashboard::initialize(SDL_Window* window, const Options& options, std::string& error)
{
    if (initialized_)
        return true;
    if (!window) {
        error = "dashboard requires an existing SDL window";
        return false;
    }
    window_ = window;
    output_path_.fill(0);
    std::snprintf(output_path_.data(), output_path_.size(), "%s", options.output_path.c_str());
    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGui::GetIO().IniFilename = nullptr;
    ImGui::GetIO().ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    ImGui::StyleColorsDark();
#if defined(__ANDROID__)
    // Touch targets must remain usable on high-density phone displays.
    ImGui::GetStyle().ScaleAllSizes(1.7f);
    ImGui::GetIO().FontGlobalScale = 1.7f;
#endif
    if (!ImGui_ImplSDL3_InitForOther(window)) {
        error = "ImGui SDL3 input initialization failed";
        ImGui::DestroyContext();
        return false;
    }
    initialized_ = true;
    first_frame_ = true;
    if (!create_resources(error)) {
        shutdown();
        return false;
    }
    return true;
}

void Dashboard::shutdown()
{
    if (!initialized_)
        return;
    // All GPU objects and the ImGui context are released before run_suite.
    if (bgfx::isValid(font_))
        bgfx::destroy(font_);
    if (bgfx::isValid(sampler_))
        bgfx::destroy(sampler_);
    if (bgfx::isValid(program_))
        bgfx::destroy(program_);
    font_ = BGFX_INVALID_HANDLE;
    sampler_ = BGFX_INVALID_HANDLE;
    program_ = BGFX_INVALID_HANDLE;
    // The custom preview ordering must not leak into Clean/Diagnostic runs.
    reset_dashboard_view_order();
    ImGui_ImplSDL3_Shutdown();
    ImGui::DestroyContext();
    window_ = nullptr;
    initialized_ = false;
}

void Dashboard::process_event(const SDL_Event& event)
{
    if (initialized_)
        ImGui_ImplSDL3_ProcessEvent(&event);
}

void Dashboard::render()
{
    ImDrawData* data = ImGui::GetDrawData();
    if (!data || data->DisplaySize.x <= 0.0f || data->DisplaySize.y <= 0.0f)
        return;
    const float sx = data->FramebufferScale.x;
    const float sy = data->FramebufferScale.y;
    const int fb_width = static_cast<int>(data->DisplaySize.x * sx);
    const int fb_height = static_cast<int>(data->DisplaySize.y * sy);
    if (fb_width <= 0 || fb_height <= 0 || fb_width > 65535 || fb_height > 65535)
        return;
    constexpr bgfx::ViewId view = 1;
    bgfx::setViewRect(view, 0, 0, static_cast<uint16_t>(fb_width),
                      static_cast<uint16_t>(fb_height));
    bgfx::setViewClear(view, BGFX_CLEAR_NONE);
    bgfx::setViewMode(view, bgfx::ViewMode::Sequential);

    const float left = data->DisplayPos.x;
    const float top = data->DisplayPos.y;
    const float right = left + data->DisplaySize.x;
    const float bottom = top + data->DisplaySize.y;
    const bool homogeneous = bgfx::getCaps()->homogeneousDepth;
    const float ortho[16] = {
        2.0f / (right - left),
        0,
        0,
        0,
        0,
        2.0f / (top - bottom),
        0,
        0,
        0,
        0,
        (homogeneous ? -2.0f : -1.0f) / 1000.0f,
        0,
        (left + right) / (left - right),
        (top + bottom) / (bottom - top),
        homogeneous ? -1.0f : 0.0f,
        1.0f,
    };
    bgfx::setViewTransform(view, nullptr, ortho);
    const uint64_t state =
        BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A |
        BGFX_STATE_BLEND_FUNC(BGFX_STATE_BLEND_SRC_ALPHA, BGFX_STATE_BLEND_INV_SRC_ALPHA);
    bgfx::VertexLayout layout;
    layout.begin()
        .add(bgfx::Attrib::Position, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::TexCoord0, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::Color0, 4, bgfx::AttribType::Uint8, true)
        .end();

    for (int n = 0; n < data->CmdListsCount; ++n) {
        const ImDrawList* list = data->CmdLists[n];
        const uint32_t nv = static_cast<uint32_t>(list->VtxBuffer.Size);
        const uint32_t ni = static_cast<uint32_t>(list->IdxBuffer.Size);
        if (!nv || !ni)
            continue;
        const bool index32 = sizeof(ImDrawIdx) == 4;
        if (bgfx::getAvailTransientVertexBuffer(nv, layout) < nv ||
            bgfx::getAvailTransientIndexBuffer(ni, index32) < ni)
            break;
        bgfx::TransientVertexBuffer vertices;
        bgfx::TransientIndexBuffer indices;
        bgfx::allocTransientVertexBuffer(&vertices, nv, layout);
        bgfx::allocTransientIndexBuffer(&indices, ni, index32);
        std::memcpy(vertices.data, list->VtxBuffer.Data, nv * sizeof(ImDrawVert));
        std::memcpy(indices.data, list->IdxBuffer.Data, ni * sizeof(ImDrawIdx));
        for (const ImDrawCmd& command : list->CmdBuffer) {
            if (command.UserCallback) {
                if (command.UserCallback != ImDrawCallback_ResetRenderState)
                    command.UserCallback(list, &command);
                continue;
            }
            const float x0 = (command.ClipRect.x - data->DisplayPos.x) * sx;
            const float y0 = (command.ClipRect.y - data->DisplayPos.y) * sy;
            const float x1 = (command.ClipRect.z - data->DisplayPos.x) * sx;
            const float y1 = (command.ClipRect.w - data->DisplayPos.y) * sy;
            const int sc_x0 = std::clamp(static_cast<int>(x0), 0, fb_width);
            const int sc_y0 = std::clamp(static_cast<int>(y0), 0, fb_height);
            const int sc_x1 = std::clamp(static_cast<int>(x1), 0, fb_width);
            const int sc_y1 = std::clamp(static_cast<int>(y1), 0, fb_height);
            if (sc_x1 <= sc_x0 || sc_y1 <= sc_y0 || !command.ElemCount)
                continue;
            bgfx::setScissor(static_cast<uint16_t>(sc_x0), static_cast<uint16_t>(sc_y0),
                             static_cast<uint16_t>(sc_x1 - sc_x0),
                             static_cast<uint16_t>(sc_y1 - sc_y0));
            const auto texture = bgfx::TextureHandle{
                static_cast<uint16_t>(static_cast<uintptr_t>(command.GetTexID()))};
            bgfx::setTexture(0, sampler_, texture);
            bgfx::setState(state);
            bgfx::setVertexBuffer(0, &vertices, command.VtxOffset, nv);
            bgfx::setIndexBuffer(&indices, command.IdxOffset, command.ElemCount);
            bgfx::submit(view, program_);
        }
    }
}

DashboardAction Dashboard::frame(Options& options, const CompletedRun* last_run,
                                 std::string_view error, const std::function<void()>& preview)
{
    if (!initialized_)
        return DashboardAction::Exit;
    ImGui_ImplSDL3_NewFrame();
    ImGui::NewFrame();
    const auto* viewport = ImGui::GetMainViewport();
    DashboardAction action = DashboardAction::None;
    if (inspection_only_) {
        // Keep the escape hatch in the unused top-right strip of the fixed
        // reference scene, so even the leftmost rectangle remains inspectable.
        ImGui::SetNextWindowPos(
            ImVec2(viewport->WorkPos.x + std::max(0.0f, viewport->WorkSize.x - 190.0f),
                   viewport->WorkPos.y + 8.0f),
            ImGuiCond_Always);
        ImGui::SetNextWindowBgAlpha(0.65f);
        ImGui::Begin("Full geometry inspection", nullptr,
                     ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoMove |
                         ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoSavedSettings);
        if (ImGui::Button("Return to dashboard"))
            inspection_only_ = false;
        ImGui::End();
    } else {
        ImGui::SetNextWindowPos(viewport->WorkPos, ImGuiCond_Always);
        ImGui::SetNextWindowSize(ImVec2(viewport->WorkSize.x * 0.55f, viewport->WorkSize.y),
                                 ImGuiCond_Always);
        ImGui::Begin("NovelTea Graphics Benchmark", nullptr,
                     ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoResize |
                         ImGuiWindowFlags_NoCollapse);
        ImGui::TextUnformatted("PREVIEW / INSPECTION");
        ImGui::SameLine();
        ImGui::TextDisabled("(dashboard and inspection frame excluded from measurement)");
        ImGui::Separator();
        ImGui::Text("Selected: %s", options.scenario.c_str());
        ImGui::TextDisabled("Full-scene inspection shows the selected workload.");
        ImGui::Spacing();

        if (options.scenario != "raw-bgfx-empty" &&
            options.scenario != "integrated-rmlui-controlled" &&
            options.scenario != "integrated-rmlui-production" &&
            options.scenario != "engine-empty") {
            if (ImGui::Button("Inspect full scene"))
                inspection_only_ = true;
        }

        if (ImGui::Button(options.profile == "clean" ? "Run Clean Benchmark"
                                                     : "Run Diagnostic Benchmark"))
            action = DashboardAction::Run;
        ImGui::SameLine();
        if (ImGui::Button("Quick Suite (available reference)"))
            action = DashboardAction::QuickSuite;
        ImGui::SameLine();
        if (ImGui::Button("Exit"))
            action = DashboardAction::Exit;

        if (!error.empty())
            ImGui::TextWrapped("Failure: %.*s", static_cast<int>(error.size()), error.data());
        if (ImGui::BeginTabBar("benchmark-tabs")) {
            if (ImGui::BeginTabItem("Scenarios")) {
                if (ImGui::BeginCombo("Selected scenario", options.scenario.c_str())) {
#if defined(__ANDROID__)
                    for (const char* candidate :
                         {"raw-bgfx-empty", "raw-bgfx-geometry", "raw-bgfx-clear",
                          "raw-bgfx-single-quad", "raw-bgfx-textured", "raw-bgfx-offscreen",
                          "raw-bgfx-draw-calls"}) {
#elif defined(__EMSCRIPTEN__)
                    for (const char* candidate :
                         {"raw-bgfx-empty", "raw-bgfx-geometry", "raw-bgfx-clear",
                          "raw-bgfx-single-quad", "raw-bgfx-textured", "raw-bgfx-offscreen",
                          "raw-bgfx-draw-calls", "standalone-rmlui-simple"}) {
#else
                    for (const char* candidate :
                         {"raw-bgfx-empty", "raw-bgfx-geometry", "raw-bgfx-clear",
                          "raw-bgfx-single-quad", "raw-bgfx-textured", "raw-bgfx-offscreen",
                          "raw-bgfx-draw-calls", "standalone-rmlui-simple",
                          "integrated-rmlui-controlled", "integrated-rmlui-production",
                          "engine-empty"}) {
#endif
                        if (ImGui::Selectable(candidate, options.scenario == candidate)) {
                            options.scenario = candidate;
                            options.rect_count = 3;
                            options.rect_scale = 1.0;
                            options.draw_calls = 64;
                            options.quad_count = 1;
                            options.texture_size = 256;
                            options.coverage = 1.0;
                        }
                    }
                    ImGui::EndCombo();
                }
                if (options.scenario == "raw-bgfx-geometry") {
                    int rect_count = static_cast<int>(options.rect_count);
                    if (ImGui::SliderInt("Rectangle count", &rect_count, 1, 256))
                        options.rect_count = static_cast<uint32_t>(rect_count);
                    float scale = static_cast<float>(options.rect_scale);
                    if (ImGui::SliderFloat("Rectangle scale", &scale, 0.25f, 1.0f))
                        options.rect_scale = scale;
                    if (ImGui::Button("Restore fixed reference")) {
                        options.rect_count = 3;
                        options.rect_scale = 1.0;
                    }
                }
                if (options.scenario == "raw-bgfx-draw-calls") {
                    int draw_calls = static_cast<int>(options.draw_calls);
                    if (ImGui::SliderInt("Draw submissions", &draw_calls, 1, 1024))
                        options.draw_calls = static_cast<uint32_t>(draw_calls);
                    int quads = static_cast<int>(options.quad_count);
                    if (ImGui::SliderInt("Quads per draw", &quads, 1, 512))
                        options.quad_count = static_cast<uint32_t>(quads);
                }
                if (options.scenario == "raw-bgfx-textured" ||
                    options.scenario == "raw-bgfx-offscreen" ||
                    options.scenario == "raw-bgfx-draw-calls") {
                    if (ImGui::BeginCombo("Texture edge (px)",
                                          std::to_string(options.texture_size).c_str())) {
                        for (uint32_t edge : {1u, 16u, 64u, 256u, 512u, 1024u, 2048u}) {
                            const auto label = std::to_string(edge);
                            if (ImGui::Selectable(label.c_str(), options.texture_size == edge))
                                options.texture_size = edge;
                        }
                        ImGui::EndCombo();
                    }
                    float coverage = static_cast<float>(options.coverage);
                    if (ImGui::SliderFloat("Linear coverage", &coverage, 0.125f, 1.0f))
                        options.coverage = coverage;
                    if (ImGui::Button("Restore raw reference")) {
                        options.draw_calls = 64;
                        options.quad_count = 1;
                        options.texture_size = 256;
                        options.coverage = 1.0;
                    }
                }
#if defined(__ANDROID__)
                ImGui::TextDisabled("Android: raw bgfx references only.");
#elif defined(__EMSCRIPTEN__)
                ImGui::TextDisabled("Web: raw bgfx and standalone RmlUi references.");
#else
                ImGui::TextDisabled("Engine-owned scenarios use the production Engine and a "
                                    "separate graphics host.");
                if (options.scenario == "integrated-rmlui-controlled" ||
                    options.scenario == "integrated-rmlui-production" ||
                    options.scenario == "engine-empty")
                    ImGui::TextWrapped("Engine preview requires exclusive graphics ownership. "
                                       "The actual Engine output is visible during a run; the "
                                       "dashboard does not substitute a fake Engine preview.");
#endif
                ImGui::Spacing();
                ImGui::TextWrapped(
                    "Preview renders the selected reference outside sampling. "
                    "Inspect full scene hides the dashboard to reveal all rectangles.");
                ImGui::EndTabItem();
            }
            if (ImGui::BeginTabItem("Run Settings")) {
#if defined(__ANDROID__)
                ImGui::TextDisabled("Using Android's native fullscreen framebuffer.");
#else
                int width = options.width;
                int height = options.height;
                if (ImGui::InputInt("Window width", &width))
                    options.width = std::clamp(width, 1, 8192);
                if (ImGui::InputInt("Window height", &height))
                    options.height = std::clamp(height, 1, 8192);
#endif
                ImGui::Checkbox("VSync", &options.vsync);
                ImGui::InputDouble("Warmup seconds", &options.warmup_seconds, 0.5, 1.0, "%.2f");
                ImGui::InputDouble("Measurement seconds", &options.duration_seconds, 1.0, 5.0,
                                   "%.2f");
                int frames = static_cast<int>(options.measurement_frames);
                if (ImGui::InputInt("Fixed frame count (0 = duration)", &frames))
                    options.measurement_frames =
                        static_cast<uint64_t>(std::clamp(frames, 0, 300000));
                int repeats = static_cast<int>(options.repeats);
                if (ImGui::InputInt("Repeated trials", &repeats))
                    options.repeats = static_cast<uint32_t>(std::clamp(repeats, 1, 20));
                ImGui::InputDouble("Readiness timeout seconds", &options.ready_timeout_seconds, 0.5,
                                   1.0, "%.2f");
                // Profile is a canonical string, never an extra boolean saved in the configuration.
                if (ImGui::RadioButton("Diagnostic (separate, non-authoritative)",
                                       options.profile == "diagnostic"))
                    options.profile = "diagnostic";
                if (ImGui::RadioButton("Clean profile", options.profile == "clean"))
                    options.profile = "clean";
                ImGui::Checkbox("Export raw timing samples", &options.raw_samples);
                if (ImGui::InputText("Report file (blank = generated)", output_path_.data(),
                                     output_path_.size()))
                    options.output_path = output_path_.data();
                ImGui::EndTabItem();
            }
            if (ImGui::BeginTabItem("Results", nullptr,
                                    first_frame_ && last_run ? ImGuiTabItemFlags_SetSelected : 0)) {
                if (!last_run) {
                    ImGui::TextDisabled("No run completed in this session.");
                } else {
                    const std::string identity = completed_run_identity(*last_run);
                    ImGui::TextWrapped("Completed run: %s", identity.c_str());
                    ImGui::Text("Outcome: %s", last_run->result.outcome.c_str());
                    if (!last_run->report_path.empty())
                        ImGui::TextWrapped("Report: %s", last_run->report_path.c_str());
                    for (const auto& scenario : last_run->result.scenarios) {
                        ImGui::Separator();
                        ImGui::Text("%s: %s", scenario.scenario.c_str(), scenario.outcome.c_str());
                        ImGui::Text("%llu measured work units in %.3f s",
                                    static_cast<unsigned long long>(scenario.measured_frames),
                                    scenario.measured_wall_seconds);
                        if (scenario.measured_wall_seconds > 0)
                            ImGui::Text(
                                "CPU frame-loop cadence: %.2f Hz (not confirmed display FPS)",
                                static_cast<double>(scenario.measured_frames) /
                                    scenario.measured_wall_seconds);
                        show_distribution("Wall-frame", scenario.wall_frame);
                        show_distribution("CPU operation", scenario.cpu_operation);
                        for (size_t n = 0; n < scenario.trials.size(); ++n) {
                            const auto& trial = scenario.trials[n];
                            if (trial.outcome != "complete") {
                                ImGui::TextWrapped("Trial %zu %s: %s", n + 1, trial.outcome.c_str(),
                                                   trial.reason.c_str());
                                continue;
                            }
                            if (last_run->configuration.profile != "diagnostic")
                                continue;
                            ImGui::SeparatorText("Diagnostic (non-authoritative)");
                            ImGui::Text(
                                "Trial %zu: %llu CPU observations, %llu bgfx snapshots", n + 1,
                                static_cast<unsigned long long>(trial.diagnostic.observations),
                                static_cast<unsigned long long>(
                                    trial.diagnostic.bgfx_stats_observations));
                            show_distribution("UI update", trial.diagnostic.cpu_update_ms);
                            show_distribution("CPU submission", trial.diagnostic.cpu_submission_ms);
                            show_distribution("bgfx::frame CPU handoff",
                                              trial.diagnostic.bgfx_frame_cpu_ms);
                            show_distribution("bgfx render-thread",
                                              trial.diagnostic.bgfx_render_thread_ms);
                            show_distribution("bgfx waitRender",
                                              trial.diagnostic.bgfx_wait_render_ms);
                            show_distribution("bgfx waitSubmit",
                                              trial.diagnostic.bgfx_wait_submit_ms);
                            show_distribution("GPU execution (identified completions)",
                                              trial.diagnostic.gpu_execution_ms);
                            if (trial.diagnostic.draw_calls.count)
                                ImGui::Text("bgfx snapshots: draw mean %.1f, textures mean %.1f, "
                                            "programs mean %.1f",
                                            trial.diagnostic.draw_calls.mean,
                                            trial.diagnostic.textures.mean,
                                            trial.diagnostic.programs.mean);
                            if (trial.diagnostic.view_count.count)
                                ImGui::Text("Profiled view records: mean %.1f (%llu snapshots)",
                                            trial.diagnostic.view_count.mean,
                                            static_cast<unsigned long long>(
                                                trial.diagnostic.view_count.count));
                            else
                                ImGui::TextUnformatted("Profiled view records: unavailable");
                            ImGui::TextDisabled(
                                "bgfx counters may lag/repeat; never paired to CPU frames.");
                        }
                        if (last_run->configuration.profile == "diagnostic" &&
                            last_run->result.instrumentation_control) {
                            const auto& control = *last_run->result.instrumentation_control;
                            ImGui::Text("Clock-only control: 2 reads %.1f ns, 4 reads %.1f ns, "
                                        "increment %.1f ns",
                                        control.two_clock_reads_ns, control.four_clock_reads_ns,
                                        control.incremental_ns);
                            ImGui::TextDisabled(
                                "Lower-bound timer overhead, not full profiling cost.");
                        }
                    }
                }
                ImGui::EndTabItem();
            }
            if (ImGui::BeginTabItem("Advanced")) {
                ImGui::TextWrapped(
                    "Strict samples exclude ImGui allocations, context, events, "
                    "rendering and GPU objects. Raw/standalone trials retain the host; "
                    "Engine-owned trials recreate their own SDL/bgfx host.");
                ImGui::TextUnformatted("GPU driver version: unavailable");
                ImGui::TextUnformatted("Confirmed presented FPS: unavailable");
                ImGui::TextWrapped("Diagnostic adds bgfx CPU handoff, render-thread waits, "
                                   "draw/resource snapshots, profiler-supported view "
                                   "records and GPU completed-frame "
                                   "timestamps only when a measured bgfx::frame ID matches. "
                                   "Asynchronous snapshots may lag or repeat and cannot be "
                                   "aligned to CPU samples by array index.");
                ImGui::TextWrapped("The production Engine does not expose bgfx submitted-frame "
                                   "identity, so GPU timing is unavailable there. Clean runs "
                                   "never sample diagnostic counters.");
                ImGui::EndTabItem();
            }
            ImGui::EndTabBar();
        }
        ImGui::End();
        first_frame_ = false;
    }
    ImGui::Render();
    bgfx::setViewClear(0, BGFX_CLEAR_COLOR, 0x17212cff);
    bgfx::touch(0);
    if (preview)
        preview();
    // Default bgfx ID sorting would composite views 2..63 over ImGui view 1.
    set_dashboard_view_order();
    render();
    bgfx::frame();
    return action;
}

} // namespace noveltea::benchmark
