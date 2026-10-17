#include "benchmark_dashboard.hpp"
#include "benchmark_view_order.hpp"
#include "benchmark_assets.hpp"
#include "benchmark_inspection.hpp"
#include "benchmark_report.hpp"
#include "benchmark_storage.hpp"
#include "reference_workloads.hpp"
#include "reference_scene.hpp"

#include <imgui.h>
#include <imgui_impl_sdl3.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <vector>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#include <cstdlib>
#endif

namespace noveltea::benchmark {
namespace {

// A/B/A compares workload parameters only. The dashboard owns the shared
// execution settings; a saved B preset cannot silently change the clock/host.
void align_alternate_execution_settings(Options& baseline)
{
    if (!baseline.alternate)
        return;
    auto b = std::make_shared<Options>(*baseline.alternate);
    b->width = baseline.width;
    b->height = baseline.height;
    b->native_resolution = baseline.native_resolution;
    b->vsync = baseline.vsync;
    b->clock_policy = baseline.clock_policy;
    b->profile = baseline.profile;
    b->warmup_seconds = baseline.warmup_seconds;
    b->duration_seconds = baseline.duration_seconds;
    b->measurement_frames = baseline.measurement_frames;
    b->ready_timeout_seconds = baseline.ready_timeout_seconds;
    b->repeats = baseline.repeats;
    b->raw_samples = baseline.raw_samples;
    b->no_ui = baseline.no_ui;
    b->quick_suite = false;
    b->capacity_dimension.clear();
    b->capacity_target = baseline.capacity_target;
    b->capacity_threshold = baseline.capacity_threshold;
    b->capacity_mode = baseline.capacity_mode;
    b->output_path = baseline.output_path;
    baseline.alternate = std::move(b);
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

void Dashboard::import_report(int slot, std::string_view text, std::string name)
{
    ImportedReport next;
    if (!decode_imported_report(text, std::move(name), next, import_error_[slot]))
        return;
    imported_[slot] = std::move(next);
    import_error_[slot].clear();
}

void Dashboard::import_path(int slot)
{
    const std::string path = import_paths_[slot].data();
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file) {
        import_error_[slot] = "cannot open report: " + path;
        return;
    }
    const auto size = file.tellg();
    if (size < 0 || size > 16 * 1024 * 1024) {
        import_error_[slot] = "report exceeds 16 MiB limit";
        return;
    }
    file.seekg(0);
    const std::string source((std::istreambuf_iterator<char>(file)),
                             std::istreambuf_iterator<char>());
    if (!file.eof() && file.fail()) {
        import_error_[slot] = "unable to read report: " + path;
        return;
    }
    import_report(slot, source, path);
}

void Dashboard::persist_preferences(const Options& options)
{
    std::string reason;
    if (!validate_run_options(options, reason) || !validate_reference_options(options, reason))
        return; // Never replace a valid saved state with a partially edited invalid configuration.
    const std::string current = encode_configuration(options);
    if (current == last_stored_configuration_ && preferences_error_.empty())
        return;
    preferences_.last_configuration = options;
    if (save_dashboard_preferences(preferences_, preferences_error_))
        last_stored_configuration_ = current;
}

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
    if (!preferences_loaded_) {
        preferences_loaded_ = true;
        if (!load_dashboard_preferences(preferences_, preferences_error_))
            preferences_ = {};
        else
            last_stored_configuration_ = encode_configuration(preferences_.last_configuration);
    }
    output_path_.fill(0);
    std::snprintf(output_path_.data(), output_path_.size(), "%s", options.output_path.c_str());
    std::snprintf(feature_lab_path_.data(), feature_lab_path_.size(), "%s",
                  options.feature_lab_package.c_str());
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
    if (!initialized_)
        return;
    if (event.type == SDL_EVENT_KEY_DOWN && event.key.key == SDLK_F9 && !event.key.repeat)
        capture_requested_ = true;
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

DashboardAction Dashboard::frame(Options& options, const CompletedRun* last_run, std::string& error,
                                 const std::function<bool()>& preview,
                                 const std::function<void()>& capture)
{
    if (!initialized_)
        return DashboardAction::Exit;
#if defined(__EMSCRIPTEN__)
    for (int slot = 0; slot != 2; ++slot) {
        char* selected = reinterpret_cast<char*>(EM_ASM_PTR(
            {
                const pending = window.NovelTeaBenchmark.importText;
                if (!pending || pending[$0] == null)
                    return 0;
                const text = pending[$0];
                pending[$0] = null;
                return stringToNewUTF8(text);
            },
            slot));
        if (selected) {
            import_report(slot, selected, std::string("browser report ") + (slot ? "B" : "A"));
            std::free(selected);
        }
    }
#endif
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
        if (supports_inspection(options.scenario) && ImGui::Button("Save inspection PNG"))
            action = DashboardAction::Capture;
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
        ImGui::TextDisabled("Full-scene inspection shows the selected workload (F9 saves PNG).");
        ImGui::Spacing();

        if (options.scenario != "raw-bgfx-empty" &&
            options.scenario != "integrated-rmlui-controlled" &&
            options.scenario != "integrated-rmlui-production" &&
            options.scenario != "engine-empty" && options.scenario != "engine-compiled-empty" &&
            options.scenario != "engine-compiled-menu" &&
            options.scenario != "engine-feature-lab") {
            if (ImGui::Button("Inspect full scene"))
                inspection_only_ = true;
        }

        if (supports_inspection(options.scenario)) {
            if (ImGui::Button("Save inspection PNG (untimed)"))
                action = DashboardAction::Capture;
        } else if (supports_engine_inspection(options.scenario)) {
            if (ImGui::Button("Capture Engine reference PNG (untimed)"))
                action = DashboardAction::CaptureEngine;
        } else {
            ImGui::TextDisabled(
                "Screenshot unavailable: this scene has no benchmark-owned preview/readback.");
        }

        if (ImGui::Button(options.profile == "clean" ? "Run Clean Benchmark"
                                                     : "Run Diagnostic Benchmark"))
            action = DashboardAction::Run;
        ImGui::SameLine();
        ImGui::BeginDisabled(options.alternate != nullptr);
        if (ImGui::Button("Quick Suite (available reference)"))
            action = DashboardAction::QuickSuite;
        ImGui::EndDisabled();
        ImGui::SameLine();
        if (ImGui::Button("Exit"))
            action = DashboardAction::Exit;

        if (!error.empty())
            ImGui::TextWrapped("Status: %.*s", static_cast<int>(error.size()), error.data());
        if (ImGui::BeginTabBar("benchmark-tabs")) {
            if (ImGui::BeginTabItem("Scenarios")) {
                if (ImGui::BeginCombo("Selected scenario", options.scenario.c_str())) {
                    for (const char* candidate :
                         {"raw-bgfx-empty", "raw-bgfx-geometry", "raw-bgfx-clear",
                          "raw-bgfx-single-quad", "raw-bgfx-textured", "raw-bgfx-offscreen",
                          "raw-bgfx-draw-calls", "raw-bgfx-composition", "standalone-rmlui-simple",
                          "integrated-rmlui-controlled", "integrated-rmlui-production",
                          "standalone-rmlui-scaling", "integrated-rmlui-scaling",
                          "standalone-rmlui-effects", "integrated-rmlui-effects", "engine-empty",
                          "engine-compiled-empty", "engine-compiled-menu", "engine-feature-lab"}) {
                        if (ImGui::Selectable(candidate, options.scenario == candidate)) {
                            options = reference_scenario_options(options, candidate);
                            // Preserve the explicitly chosen optional package across scenario
                            // switches without attaching it to unrelated references.
                            if (options.scenario == "engine-feature-lab")
                                options.feature_lab_package = feature_lab_path_.data();
                        }
                    }
                    ImGui::EndCombo();
                }
                if (options.scenario == "engine-compiled-empty" ||
                    options.scenario == "engine-compiled-menu" ||
                    options.scenario == "engine-feature-lab") {
                    if (ImGui::BeginCombo("Runtime Session clock", options.clock_policy.c_str())) {
                        for (const char* policy : {"realtime", "fixed-step"}) {
                            if (ImGui::Selectable(policy, options.clock_policy == policy))
                                options.clock_policy = policy;
                        }
                        ImGui::EndCombo();
                    }
                    ImGui::TextWrapped(
                        "Fixed-step uses 1/60 s per Engine tick; real-time "
                        "uses the production host clock. Both present frames normally.");
                    if (options.scenario == "engine-feature-lab") {
                        if (ImGui::InputText("Exported Feature Lab package (.ntpkg)",
                                             feature_lab_path_.data(), feature_lab_path_.size()))
                            options.feature_lab_package = feature_lab_path_.data();
                        ImGui::TextWrapped("Feature Lab is optional. Export its runtime package "
                                           "before running; preparation does not enter sampling.");
                    }
                }
                if (is_ui_scaling_scenario(options.scenario)) {
                    int count = static_cast<int>(options.ui_elements);
                    if (ImGui::SliderInt("UI elements", &count, 1, 2048))
                        options.ui_elements = static_cast<uint32_t>(count);
                    count = static_cast<int>(options.ui_text_lines);
                    if (ImGui::SliderInt("Text lines", &count, 0, 256)) {
                        options.ui_text_lines = static_cast<uint32_t>(count);
                        options.ui_dynamic_lines =
                            std::min(options.ui_dynamic_lines, options.ui_text_lines);
                    }
                    count = static_cast<int>(options.ui_dynamic_lines);
                    if (ImGui::SliderInt("Changing text lines", &count, 0,
                                         static_cast<int>(options.ui_text_lines)))
                        options.ui_dynamic_lines = static_cast<uint32_t>(count);
                    count = static_cast<int>(options.ui_visible_contexts);
                    if (ImGui::SliderInt("Visible contexts", &count, 1, 8))
                        options.ui_visible_contexts = static_cast<uint32_t>(count);
                    count = static_cast<int>(options.ui_empty_contexts);
                    if (ImGui::SliderInt("Empty contexts", &count, 0, 16))
                        options.ui_empty_contexts = static_cast<uint32_t>(count);
                    count = static_cast<int>(options.ui_hidden_contexts);
                    if (ImGui::SliderInt("Hidden contexts", &count, 0, 16))
                        options.ui_hidden_contexts = static_cast<uint32_t>(count);
                    if (ImGui::BeginCombo("Text changes", options.ui_text_mode.c_str())) {
                        for (const char* value : {"static", "dynamic"}) {
                            if (ImGui::Selectable(value, options.ui_text_mode == value))
                                options.ui_text_mode = value;
                        }
                        ImGui::EndCombo();
                    }
                    if (ImGui::BeginCombo("RmlUi redraw policy", options.ui_redraw.c_str())) {
                        for (const char* value : {"continuous", "dirty-only"}) {
                            if (ImGui::Selectable(value, options.ui_redraw == value))
                                options.ui_redraw = value;
                        }
                        ImGui::EndCombo();
                    }
                    ImGui::TextWrapped("Counts are independent. The sum of visible, empty and "
                                       "hidden contexts must not exceed 24.");
                    if (ImGui::BeginCombo("Scaling reference presets", "Select preset")) {
                        for (const char* preset : {"balanced", "elements-heavy", "text-heavy",
                                                   "contexts-heavy", "dirty-static"}) {
                            if (ImGui::Selectable(preset))
                                (void)apply_ui_scaling_preset(options, preset);
                        }
                        ImGui::EndCombo();
                    }
                    if (ImGui::Button("Restore RmlUi reference"))
                        (void)apply_ui_scaling_preset(options, "balanced");
                }
                if (is_ui_effects_scenario(options.scenario)) {
                    auto count_slider = [](const char* label, uint32_t& value) {
                        int count = static_cast<int>(value);
                        if (ImGui::SliderInt(label, &count, 0, 16))
                            value = static_cast<uint32_t>(count);
                    };
                    count_slider("Clipping", options.ui_clipping);
                    count_slider("Transforms", options.ui_transforms);
                    count_slider("Gradients", options.ui_gradients);
                    count_slider("Filters", options.ui_filters);
                    count_slider("Masks", options.ui_masks);
                    count_slider("Nested layers", options.ui_nested_layers);
                    ImGui::TextWrapped("Each column independently repeats its own effect. "
                                       "At least one effect must be enabled.");
                    if (ImGui::Button("Restore effects reference")) {
                        const Options defaults;
                        options.ui_clipping = defaults.ui_clipping;
                        options.ui_transforms = defaults.ui_transforms;
                        options.ui_gradients = defaults.ui_gradients;
                        options.ui_filters = defaults.ui_filters;
                        options.ui_masks = defaults.ui_masks;
                        options.ui_nested_layers = defaults.ui_nested_layers;
                    }
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
                if (options.scenario == "raw-bgfx-offscreen") {
                    float scale = static_cast<float>(options.target_scale);
                    if (ImGui::SliderFloat("Offscreen render scale", &scale, 0.25f, 1.0f))
                        options.target_scale = scale;
                    ImGui::TextDisabled("Host framebuffer retains native physical dimensions.");
                }
                if (options.scenario == "raw-bgfx-composition") {
                    if (ImGui::BeginCombo("Composition path", options.composition_path.c_str())) {
                        for (const char* path : {"direct", "offscreen"}) {
                            if (ImGui::Selectable(path, options.composition_path == path)) {
                                options.composition_path = path;
                                options.composite_passes =
                                    options.composition_path == "offscreen" ? 1u : 0u;
                                options.msaa_samples = 0;
                                options.target_scale = 1.0;
                            }
                        }
                        ImGui::EndCombo();
                    }
                    ImGui::Checkbox("Transparent overlay over world", &options.transparent_overlay);
                    if (options.composition_path == "offscreen") {
                        int passes = static_cast<int>(options.composite_passes);
                        if (ImGui::SliderInt("Fullscreen composites", &passes, 1, 4))
                            options.composite_passes = static_cast<uint32_t>(passes);
                        float scale = static_cast<float>(options.target_scale);
                        if (ImGui::SliderFloat("Offscreen target scale", &scale, 0.25f, 1.0f))
                            options.target_scale = scale;
                        if (ImGui::BeginCombo("Offscreen MSAA samples",
                                              std::to_string(options.msaa_samples).c_str())) {
                            for (uint32_t samples : {0u, 2u, 4u}) {
                                if (ImGui::Selectable(std::to_string(samples).c_str(),
                                                      options.msaa_samples == samples))
                                    options.msaa_samples = samples;
                            }
                            ImGui::EndCombo();
                        }
                    }
                    ImGui::TextWrapped(
                        "Comparable direct/offscreen visuals require target scale 1.0, "
                        "MSAA 0, identical coverage and overlay. Additional passes replay "
                        "the same fullscreen image; downscaling and MSAA change raster output.");
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
                    options.scenario == "raw-bgfx-draw-calls" ||
                    options.scenario == "raw-bgfx-composition") {
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
                ImGui::TextDisabled("Engine-owned scenarios use the production Engine and a "
                                    "separate graphics host on all platforms.");
                if (options.scenario == "integrated-rmlui-controlled" ||
                    options.scenario == "integrated-rmlui-production" ||
                    options.scenario == "engine-empty" ||
                    options.scenario == "engine-compiled-empty" ||
                    options.scenario == "engine-compiled-menu" ||
                    options.scenario == "engine-feature-lab")
                    ImGui::TextWrapped(
                        "Engine references require exclusive graphics ownership. "
                        "Capture Engine reference starts a separate untimed Engine "
                        "session, saves the screenshot, and restores the dashboard.");
                ImGui::Spacing();
                ImGui::TextWrapped(
                    "Preview renders the selected reference outside sampling. "
                    "Inspect full scene hides the dashboard to reveal all rectangles.");
                ImGui::EndTabItem();
            }
            if (ImGui::BeginTabItem("Run Settings")) {
                ImGui::SeparatorText("Saved configurations");
                ImGui::InputText("Preset name", preset_name_.data(), preset_name_.size());
                if (ImGui::Button("Save named preset")) {
                    const std::string name = preset_name_.data();
                    const auto valid = !name.empty() && name.size() <= 64 &&
                                       std::none_of(name.begin(), name.end(), [](unsigned char ch) {
                                           return ch < 0x20 || ch == 0x7f;
                                       });
                    std::string invalid_reason;
                    if (!valid)
                        preferences_error_ = "preset name must be 1-64 non-control characters";
                    else if (!validate_run_options(options, invalid_reason) ||
                             !validate_reference_options(options, invalid_reason))
                        preferences_error_ = "cannot save invalid preset: " + invalid_reason;
                    else {
                        auto& presets = preferences_.presets;
                        const auto entry = std::find_if(
                            presets.begin(), presets.end(),
                            [&](const NamedBenchmarkPreset& p) { return p.name == name; });
                        if (entry != presets.end()) {
                            entry->configuration = options;
                            last_stored_configuration_.clear();
                            persist_preferences(options);
                        } else if (presets.size() < 32) {
                            presets.push_back({name, options});
                            last_stored_configuration_.clear();
                            persist_preferences(options);
                        } else {
                            preferences_error_ = "maximum 32 named presets";
                        }
                    }
                }
                ImGui::SameLine();
                if (ImGui::Button("Delete named preset")) {
                    const std::string name = preset_name_.data();
                    auto& presets = preferences_.presets;
                    const auto old_size = presets.size();
                    std::erase_if(presets, [&](const NamedBenchmarkPreset& preset) {
                        return preset.name == name;
                    });
                    if (presets.size() != old_size) {
                        last_stored_configuration_.clear();
                        persist_preferences(options);
                    }
                }
                if (ImGui::BeginCombo("Load named preset", "Choose a saved configuration")) {
                    for (const auto& preset : preferences_.presets) {
                        if (ImGui::Selectable(preset.name.c_str())) {
                            options = preset.configuration;
                            options.no_ui = false;
                            options.quick_suite = false;
                            std::snprintf(output_path_.data(), output_path_.size(), "%s",
                                          options.output_path.c_str());
                            std::snprintf(feature_lab_path_.data(), feature_lab_path_.size(), "%s",
                                          options.feature_lab_package.c_str());
                            std::snprintf(preset_name_.data(), preset_name_.size(), "%s",
                                          preset.name.c_str());
                        }
                    }
                    ImGui::EndCombo();
                }
                if (!preferences_error_.empty())
                    ImGui::TextWrapped("Saved settings: %s", preferences_error_.c_str());
#if defined(__ANDROID__)
                ImGui::TextDisabled("Using Android's native fullscreen framebuffer.");
#else
                ImGui::Checkbox("Use native display resolution", &options.native_resolution);
                int width = options.width;
                int height = options.height;
                ImGui::BeginDisabled(options.native_resolution);
                if (ImGui::InputInt("Window width", &width))
                    options.width = std::clamp(width, 1, 8192);
                if (ImGui::InputInt("Window height", &height))
                    options.height = std::clamp(height, 1, 8192);
                ImGui::EndDisabled();
#endif
                ImGui::Checkbox("VSync", &options.vsync);
                ImGui::SeparatorText("Automatic capacity search");
                if (ImGui::BeginCombo("Search dimension",
                                      options.capacity_dimension.empty()
                                          ? "Disabled"
                                          : options.capacity_dimension.c_str())) {
                    if (ImGui::Selectable("Disabled", options.capacity_dimension.empty()))
                        options.capacity_dimension.clear();
                    if ((options.scenario == "raw-bgfx-geometry" ||
                         options.scenario == "raw-bgfx-draw-calls") &&
                        ImGui::Selectable("geometry", options.capacity_dimension == "geometry"))
                        options.capacity_dimension = "geometry";
                    if (is_ui_scaling_scenario(options.scenario) &&
                        ImGui::Selectable("ui", options.capacity_dimension == "ui"))
                        options.capacity_dimension = "ui";
                    if ((options.scenario == "raw-bgfx-offscreen" ||
                         (options.scenario == "raw-bgfx-composition" &&
                          options.composition_path == "offscreen")) &&
                        ImGui::Selectable("pixels", options.capacity_dimension == "pixels")) {
                        options.capacity_dimension = "pixels";
                        options.target_scale = 1.0;
                    }
                    ImGui::EndCombo();
                }
                if (!options.capacity_dimension.empty()) {
                    if (ImGui::BeginCombo("Budget metric", options.capacity_target.c_str())) {
                        for (const char* target : {"cpu-ms", "gpu-ms", "presented-fps"}) {
                            if (ImGui::Selectable(target, options.capacity_target == target)) {
                                options.capacity_target = target;
                                if (options.capacity_target == "gpu-ms")
                                    options.profile = "diagnostic";
                                if (options.capacity_target == "presented-fps")
                                    options.capacity_mode = "presented";
                            }
                        }
                        ImGui::EndCombo();
                    }
                    ImGui::InputDouble("Budget threshold", &options.capacity_threshold, 0.5, 1.0,
                                       "%.2f");
                    if (options.scenario == "raw-bgfx-offscreen" &&
                        options.capacity_target != "presented-fps") {
                        if (ImGui::BeginCombo("Measurement mode", options.capacity_mode.c_str())) {
                            for (const char* mode : {"presented", "offscreen"}) {
                                if (ImGui::Selectable(mode, options.capacity_mode == mode)) {
                                    options.capacity_mode = mode;
                                    if (options.capacity_mode == "offscreen")
                                        options.vsync = false;
                                }
                            }
                            ImGui::EndCombo();
                        }
                    } else {
                        options.capacity_mode = "presented";
                    }
                    ImGui::TextWrapped(
                        "Each candidate is a fresh trial. GPU time requires valid Diagnostic "
                        "completions. Presented mode is paced by the host, not uncapped FPS. "
                        "Offscreen mode issues at most four work units per callback and "
                        "reports them separately from displayed frames.");
                }
                ImGui::InputDouble("Warmup seconds", &options.warmup_seconds, 0.5, 1.0, "%.2f");
                ImGui::InputDouble("Measurement seconds", &options.duration_seconds, 1.0, 5.0,
                                   "%.2f");
                int frames = static_cast<int>(options.measurement_frames);
                if (ImGui::InputInt("Fixed frame count (0 = duration)", &frames))
                    options.measurement_frames =
                        static_cast<uint64_t>(std::clamp(frames, 0, 300000));
                int repeats = static_cast<int>(options.repeats);
                if (ImGui::InputInt(options.alternate ? "A/B/A cycles" : "Repeated trials",
                                    &repeats))
                    options.repeats = static_cast<uint32_t>(std::clamp(repeats, 1, 20));
                if (ImGui::BeginCombo("A/B/A candidate B",
                                      options.alternate ? "Named preset selected" : "Disabled")) {
                    if (ImGui::Selectable("Disabled", !options.alternate))
                        options.alternate.reset();
                    for (const auto& preset : preferences_.presets) {
                        if (preset.configuration.scenario != options.scenario ||
                            preset.configuration.alternate)
                            continue;
                        if (ImGui::Selectable(preset.name.c_str()))
                            options.alternate = std::make_shared<Options>(preset.configuration);
                    }
                    ImGui::EndCombo();
                }
                if (options.alternate)
                    ImGui::TextWrapped(
                        "A/B/A runs %u fresh A-B-A cycles. B uses the named preset's "
                        "workload parameters; shared execution settings come from A. "
                        "No dashboard is rendered between trials.",
                        options.repeats);
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
                ImGui::SeparatorText("Compare saved JSON reports");
                for (int slot = 0; slot < 2; ++slot) {
                    ImGui::PushID(slot);
#if defined(__EMSCRIPTEN__)
                    ImGui::TextWrapped("%s", slot ? "Candidate: use the Import candidate JSON "
                                                    "button above the Web canvas."
                                                  : "Baseline: use the Import baseline JSON "
                                                    "button above the Web canvas.");
#else
                    ImGui::InputText(slot ? "Candidate JSON path" : "Baseline JSON path",
                                     import_paths_[slot].data(), import_paths_[slot].size());
                    if (ImGui::Button(slot ? "Import candidate" : "Import baseline"))
                        import_path(slot);
#endif
                    if (imported_[slot])
                        ImGui::TextWrapped("%s: %s", slot ? "Candidate" : "Baseline",
                                           imported_[slot]->source.c_str());
                    if (!import_error_[slot].empty())
                        ImGui::TextWrapped("Import failed: %s", import_error_[slot].c_str());
                    ImGui::PopID();
                }
                if (imported_[0] && imported_[1]) {
                    const auto comparison = compare_reports(*imported_[0], *imported_[1]);
                    ImGui::TextWrapped(
                        "%s",
                        comparison.controlled
                            ? "Compatible measured settings; verify physical conditions manually."
                            : "EXPLORATORY / UNCONTROLLED COMPARISON: differences or unknown "
                              "conditions mean deltas are not isolated regressions.");
                    for (const auto& warning : comparison.warnings)
                        ImGui::BulletText("%s", warning.c_str());
                    for (const auto& metric : comparison.metrics) {
                        ImGui::SeparatorText(metric.scenario.c_str());
                        ImGui::Text("%s: %.3f -> %.3f ms | delta %+.3f ms", metric.name.c_str(),
                                    metric.baseline, metric.candidate, metric.delta);
                        if (metric.percent)
                            ImGui::SameLine(), ImGui::Text("(%+.2f%%)", *metric.percent);
                        else
                            ImGui::TextDisabled("Percentage unavailable: zero baseline");
                        ImGui::TextDisabled(
                            "Variability stddev %.3f -> %.3f ms | samples %llu -> %llu",
                            metric.baseline_stddev, metric.candidate_stddev,
                            static_cast<unsigned long long>(metric.baseline_samples),
                            static_cast<unsigned long long>(metric.candidate_samples));
                    }
                    ImGui::TextDisabled(
                        "No pass/fail thresholds. Negative latency delta means lower time.");
                }
                ImGui::SeparatorText("Most recent session");
                if (!last_run) {
                    ImGui::TextDisabled("No run completed in this session.");
                } else {
                    const std::string identity = completed_run_identity(*last_run);
                    ImGui::TextWrapped("Completed run: %s", identity.c_str());
                    ImGui::Text("Outcome: %s", last_run->result.outcome.c_str());
                    if (last_run->result.capacity) {
                        const auto& search = *last_run->result.capacity;
                        ImGui::SeparatorText("Capacity search");
                        ImGui::Text("Dimension: %s | metric: %s | mode: %s",
                                    search.dimension.c_str(), search.target.c_str(),
                                    search.mode.c_str());
                        ImGui::Text("Budget: %.2f | status: %s", search.threshold,
                                    search.status.c_str());
                        ImGui::TextWrapped("%s", search.reason.c_str());
                        if (search.maximum_passing_workload)
                            ImGui::Text("Highest passing tested workload: %u",
                                        *search.maximum_passing_workload);
                        else
                            ImGui::TextUnformatted("Maximum passing workload: unavailable");
                        for (const auto& probe : search.probes) {
                            ImGui::Text("Load %u: %s, observed %s", probe.workload,
                                        probe.outcome.c_str(),
                                        probe.observed ? std::to_string(*probe.observed).c_str()
                                                       : "unavailable");
                            if (search.mode == "offscreen")
                                ImGui::TextDisabled(
                                    "%llu offscreen work units over %llu host callbacks "
                                    "(not displayed frames)",
                                    static_cast<unsigned long long>(probe.completed_work_units),
                                    static_cast<unsigned long long>(probe.completed_batches));
                        }
                    }
                    if (!last_run->report_path.empty())
                        ImGui::TextWrapped("Report: %s", last_run->report_path.c_str());
                    for (const auto& scenario : last_run->result.scenarios) {
                        ImGui::Separator();
                        ImGui::Text("%s: %s", scenario.scenario.c_str(), scenario.outcome.c_str());
                        ImGui::Text("%llu measured host callbacks in %.3f s",
                                    static_cast<unsigned long long>(scenario.measured_frames),
                                    scenario.measured_wall_seconds);
                        if (scenario.measured_wall_seconds > 0)
                            ImGui::Text(
                                "CPU frame-loop cadence: %.2f Hz (not confirmed display FPS)",
                                static_cast<double>(scenario.measured_frames) /
                                    scenario.measured_wall_seconds);
                        if (scenario.repeated) {
                            const auto& repeated = *scenario.repeated;
                            ImGui::SeparatorText("Repeated-trial reliability");
                            ImGui::Text("Completed trials: %u", repeated.trials.completed);
                            show_distribution("Trial CPU medians", repeated.trials.cpu_medians);
                            show_distribution("Trial wall medians", repeated.trials.wall_medians);
                            show_distribution("Trial CPU p95", repeated.trials.cpu_p95);
                            show_distribution("Trial wall p95", repeated.trials.wall_p95);
                            show_distribution("Trial CPU p99", repeated.trials.cpu_p99);
                            show_distribution("Trial wall p99", repeated.trials.wall_p99);
                            if (repeated.cpu_drift_percent)
                                ImGui::Text("CPU endpoint drift: %+.2f%%",
                                            *repeated.cpu_drift_percent);
                            if (repeated.wall_drift_percent)
                                ImGui::Text("Wall endpoint drift: %+.2f%%",
                                            *repeated.wall_drift_percent);
                            for (const auto& warning : repeated.warnings)
                                ImGui::BulletText("%s", warning.c_str());
                        }
                        if (scenario.alternating) {
                            const auto& alternating = *scenario.alternating;
                            ImGui::SeparatorText("A/B/A comparison (independent trials)");
                            ImGui::Text("A completed: %u | B completed: %u",
                                        alternating.baseline.completed,
                                        alternating.candidate.completed);
                            show_distribution("A trial CPU medians",
                                              alternating.baseline.cpu_medians);
                            show_distribution("B trial CPU medians",
                                              alternating.candidate.cpu_medians);
                            show_distribution("A trial wall medians",
                                              alternating.baseline.wall_medians);
                            show_distribution("B trial wall medians",
                                              alternating.candidate.wall_medians);
                            show_distribution("A CPU p95 across trials",
                                              alternating.baseline.cpu_p95);
                            show_distribution("B CPU p95 across trials",
                                              alternating.candidate.cpu_p95);
                            show_distribution("A CPU p99 across trials",
                                              alternating.baseline.cpu_p99);
                            show_distribution("B CPU p99 across trials",
                                              alternating.candidate.cpu_p99);
                            show_distribution("A wall p95 across trials",
                                              alternating.baseline.wall_p95);
                            show_distribution("B wall p95 across trials",
                                              alternating.candidate.wall_p95);
                            show_distribution("A wall p99 across trials",
                                              alternating.baseline.wall_p99);
                            show_distribution("B wall p99 across trials",
                                              alternating.candidate.wall_p99);
                            if (alternating.cpu_delta_percent)
                                ImGui::Text("B vs A CPU median: %+.2f%%",
                                            *alternating.cpu_delta_percent);
                            if (alternating.wall_delta_percent)
                                ImGui::Text("B vs A wall median: %+.2f%%",
                                            *alternating.wall_delta_percent);
                            if (alternating.cpu_drift_percent)
                                ImGui::Text("A endpoint CPU drift: %+.2f%%",
                                            *alternating.cpu_drift_percent);
                            if (alternating.wall_drift_percent)
                                ImGui::Text("A endpoint wall drift: %+.2f%%",
                                            *alternating.wall_drift_percent);
                            for (const auto& warning : alternating.warnings)
                                ImGui::BulletText("%s", warning.c_str());
                            ImGui::TextDisabled("Overall distributions below pool A and B; do not "
                                                "use for comparison.");
                        }
                        show_distribution("Wall-frame", scenario.wall_frame);
                        show_distribution("CPU operation", scenario.cpu_operation);
                        for (size_t n = 0; n < scenario.trials.size(); ++n) {
                            const auto& trial = scenario.trials[n];
                            if (trial.outcome != "complete") {
                                ImGui::TextWrapped("Trial %zu (%s) %s: %s", n + 1,
                                                   trial.arm.c_str(), trial.outcome.c_str(),
                                                   trial.reason.c_str());
                            }
                            for (const auto& attempt : trial.interrupted_attempts)
                                ImGui::TextWrapped(
                                    "Trial %zu (%s) discarded attempt: %s "
                                    "(%llu warmup, %llu measured frames)",
                                    n + 1, trial.arm.c_str(), attempt.reason.c_str(),
                                    static_cast<unsigned long long>(attempt.warmup_frames),
                                    static_cast<unsigned long long>(attempt.measured_frames));
                            if (trial.outcome != "complete" ||
                                last_run->configuration.profile != "diagnostic")
                                continue;
                            ImGui::SeparatorText("Diagnostic (non-authoritative)");
                            ImGui::Text(
                                "Trial %zu: %llu CPU observations, %llu bgfx snapshots", n + 1,
                                static_cast<unsigned long long>(trial.diagnostic.observations),
                                static_cast<unsigned long long>(
                                    trial.diagnostic.bgfx_stats_observations));
                            show_distribution("RmlUi Update (layout-inclusive)",
                                              trial.diagnostic.rmlui_update_ms);
                            show_distribution("RmlUi Render (CPU submit)",
                                              trial.diagnostic.rmlui_render_ms);
                            show_distribution("Standalone fixture mutation",
                                              trial.diagnostic.ui_fixture_mutation_ms);
                            show_distribution("Engine events", trial.diagnostic.engine_events_ms);
                            show_distribution("Engine jobs", trial.diagnostic.engine_jobs_ms);
                            show_distribution("Engine assets", trial.diagnostic.engine_assets_ms);
                            show_distribution("Engine update (jobs through layout; overlaps)",
                                              trial.diagnostic.engine_update_ms);
                            show_distribution("Engine runtime", trial.diagnostic.engine_runtime_ms);
                            show_distribution("Engine layout realization",
                                              trial.diagnostic.engine_layout_ms);
                            show_distribution("Engine render (CPU including waits)",
                                              trial.diagnostic.engine_render_ms);
                            show_distribution("Legacy CPU update", trial.diagnostic.cpu_update_ms);
                            show_distribution("Legacy CPU submission",
                                              trial.diagnostic.cpu_submission_ms);
                            ImGui::TextDisabled(
                                "Owner-thread stages are non-additive across owners. "
                                "RmlUi Update includes CSS layout work when dirty.");
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
                            if (trial.diagnostic.compute_calls.count)
                                ImGui::Text("bgfx compute submissions (async): mean %.1f",
                                            trial.diagnostic.compute_calls.mean);
                            if (trial.diagnostic.blit_calls.count)
                                ImGui::Text("bgfx blit submissions (async): mean %.1f",
                                            trial.diagnostic.blit_calls.mean);
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
        align_alternate_execution_settings(options);
        persist_preferences(options);
        first_frame_ = false;
    }
    if (capture_requested_) {
        if (supports_inspection(options.scenario))
            action = DashboardAction::Capture;
        else if (supports_engine_inspection(options.scenario))
            action = DashboardAction::CaptureEngine;
        capture_requested_ = false;
    }
    ImGui::Render();
    bgfx::setViewClear(0, BGFX_CLEAR_COLOR, 0x17212cff);
    bgfx::touch(0);
    // Only a new capture attempt clears stale screenshot status. The preview
    // callback can now report a fresh preparation/submission error.
    if (action == DashboardAction::Capture)
        error.clear();
    const bool preview_succeeded = !preview || preview();
    // Default bgfx ID sorting would composite views 2..63 over ImGui view 1.
    set_dashboard_view_order();
    if (action == DashboardAction::Capture) {
        // A failed preview must never yield a blank or partial 'successful' screenshot.
        // Do not submit dashboard controls into the capture's frame.
        if (preview_succeeded && capture)
            capture();
        else {
            action = DashboardAction::None;
            render(); // Preserve the dashboard after a failed preview.
        }
    } else {
        render();
    }
    bgfx::frame();
    return action;
}

} // namespace noveltea::benchmark
