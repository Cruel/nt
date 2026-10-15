#include "benchmark_dashboard.hpp"

#include <imgui.h>
#include <imgui_impl_sdl3.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <vector>

namespace noveltea::benchmark {
namespace {

bgfx::ShaderHandle load_shader(const char* file)
{
    std::ifstream input(file, std::ios::binary);
    if (!input)
        return BGFX_INVALID_HANDLE;
    const std::vector<char> data((std::istreambuf_iterator<char>(input)),
                                 std::istreambuf_iterator<char>());
    if (data.empty())
        return BGFX_INVALID_HANDLE;
    return bgfx::createShader(bgfx::copy(data.data(), static_cast<uint32_t>(data.size())));
}

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
    const auto vertex = load_shader(NOVELTEA_BENCHMARK_SHADER_ROOT "/imgui.vs.bin");
    if (!bgfx::isValid(vertex)) {
        error = "missing/unloadable benchmark ImGui vertex shader";
        return false;
    }
    const auto fragment = load_shader(NOVELTEA_BENCHMARK_SHADER_ROOT "/imgui.fs.bin");
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

DashboardAction Dashboard::frame(Options& options, const SuiteResult* last_result,
                                 std::string_view report_path, std::string_view error)
{
    if (!initialized_)
        return DashboardAction::Exit;
    ImGui_ImplSDL3_NewFrame();
    ImGui::NewFrame();
    const auto* viewport = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(viewport->WorkPos, ImGuiCond_Always);
    ImGui::SetNextWindowSize(viewport->WorkSize, ImGuiCond_Always);
    ImGui::Begin("NovelTea Graphics Benchmark", nullptr,
                 ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoCollapse);
    ImGui::TextUnformatted("PREVIEW / INSPECTION");
    ImGui::SameLine();
    ImGui::TextDisabled("(dashboard and inspection frame excluded from measurement)");
    ImGui::Separator();
    ImGui::TextUnformatted("Available Linux reference workload: raw-bgfx-empty");
    ImGui::TextDisabled("Empty bgfx frame: no clear, geometry, NovelTea Engine or RmlUi.");
    ImGui::Spacing();

    DashboardAction action = DashboardAction::None;
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
                if (ImGui::Selectable("raw-bgfx-empty", options.scenario == "raw-bgfx-empty"))
                    options.scenario = "raw-bgfx-empty";
                ImGui::EndCombo();
            }
            ImGui::BulletText("raw-bgfx-empty (v1) - available");
            ImGui::TextDisabled("Other renderer workloads will arrive in later tickets.");
            ImGui::Spacing();
            ImGui::TextWrapped("Preview displays the same empty reference workload under a "
                               "dashboard. Strict benchmark frames have no dashboard or HUD.");
            ImGui::EndTabItem();
        }
        if (ImGui::BeginTabItem("Run Settings")) {
            int width = options.width;
            int height = options.height;
            if (ImGui::InputInt("Window width", &width))
                options.width = std::clamp(width, 1, 8192);
            if (ImGui::InputInt("Window height", &height))
                options.height = std::clamp(height, 1, 8192);
            ImGui::Checkbox("VSync", &options.vsync);
            ImGui::InputDouble("Warmup seconds", &options.warmup_seconds, 0.5, 1.0, "%.2f");
            ImGui::InputDouble("Measurement seconds", &options.duration_seconds, 1.0, 5.0, "%.2f");
            int frames = static_cast<int>(options.measurement_frames);
            if (ImGui::InputInt("Fixed frame count (0 = duration)", &frames))
                options.measurement_frames = static_cast<uint64_t>(std::clamp(frames, 0, 300000));
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
                                first_frame_ && last_result ? ImGuiTabItemFlags_SetSelected : 0)) {
            if (!last_result) {
                ImGui::TextDisabled("No run completed in this session.");
            } else {
                ImGui::Text("Outcome: %s", last_result->outcome.c_str());
                if (!report_path.empty())
                    ImGui::TextWrapped("Report: %.*s", static_cast<int>(report_path.size()),
                                       report_path.data());
                for (const auto& scenario : last_result->scenarios) {
                    ImGui::Separator();
                    ImGui::Text("%s: %s", scenario.scenario.c_str(), scenario.outcome.c_str());
                    ImGui::Text("%llu measured work units in %.3f s",
                                static_cast<unsigned long long>(scenario.measured_frames),
                                scenario.measured_wall_seconds);
                    if (scenario.measured_wall_seconds > 0)
                        ImGui::Text("CPU frame-loop cadence: %.2f Hz (not confirmed display FPS)",
                                    static_cast<double>(scenario.measured_frames) /
                                        scenario.measured_wall_seconds);
                    show_distribution("Wall-frame", scenario.wall_frame);
                    show_distribution("CPU operation", scenario.cpu_operation);
                    for (size_t n = 0; n < scenario.trials.size(); ++n) {
                        const auto& trial = scenario.trials[n];
                        if (trial.outcome != "complete")
                            ImGui::TextWrapped("Trial %zu %s: %s", n + 1, trial.outcome.c_str(),
                                               trial.reason.c_str());
                    }
                }
            }
            ImGui::EndTabItem();
        }
        if (ImGui::BeginTabItem("Advanced")) {
            ImGui::TextWrapped("Strict samples exclude ImGui allocations, context, events, "
                               "rendering and GPU objects. The window and bgfx backend persist.");
            ImGui::TextUnformatted("GPU execution time: unavailable");
            ImGui::TextUnformatted("GPU driver version: unavailable");
            ImGui::TextUnformatted("Confirmed presented FPS: unavailable");
            ImGui::TextUnformatted("bgfx wait statistics: unavailable");
            ImGui::TextWrapped("Diagnostic runs are labeled separately; they currently provide "
                               "the same CPU boundary timers, not fabricated GPU counters.");
            ImGui::EndTabItem();
        }
        ImGui::EndTabBar();
    }
    ImGui::End();
    first_frame_ = false;
    ImGui::Render();
    bgfx::setViewClear(0, BGFX_CLEAR_COLOR, 0x17212cff);
    bgfx::touch(0);
    render();
    bgfx::frame();
    return action;
}

} // namespace noveltea::benchmark
