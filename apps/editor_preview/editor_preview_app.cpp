#include "editor_preview_app.hpp"

#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
#include "core/editor_asset_profiler_json.hpp"
#endif
#include "noveltea/core/editor_runtime_protocol.hpp"
#include "noveltea/engine_tooling.hpp"
#include "noveltea/platform.hpp"
#include "noveltea/preview_bridge.hpp"
#include "noveltea/runtime_preview_controller.hpp"

#include <nlohmann/json.hpp>

#include <cstdint>
#include <charconv>
#include <cstdio>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include <emscripten/emscripten.h>
#include <emscripten/html5.h>

namespace noveltea::editor_preview {
Engine* g_engine = nullptr;

namespace {

bool g_host_active = true;

bool has_argument(int argc, char** argv, std::string_view expected)
{
    for (int index = 1; index < argc; ++index) {
        if (argv[index] && std::string_view(argv[index]) == expected)
            return true;
    }
    return false;
}

std::optional<RmlUiRasterSnapMode> rmlui_raster_snap_mode(int argc, char** argv)
{
    for (int index = 1; index < argc; ++index) {
        if (!argv[index] || std::string_view(argv[index]) != "--rmlui-snap")
            continue;
        if (index + 1 >= argc || !argv[index + 1]) {
            std::fprintf(stderr, "[editor-preview] --rmlui-snap requires a mode\n");
            return std::nullopt;
        }
        const std::string_view value = argv[index + 1];
        if (value == "none")
            return RmlUiRasterSnapMode::None;
        if (value == "geometry")
            return RmlUiRasterSnapMode::Geometry;
        if (value == "text")
            return RmlUiRasterSnapMode::Text;
        if (value == "all")
            return RmlUiRasterSnapMode::All;
        std::fprintf(stderr, "[editor-preview] unknown --rmlui-snap mode: %.*s\n",
                     static_cast<int>(value.size()), value.data());
        return std::nullopt;
    }
    return RmlUiRasterSnapMode::All;
}

} // namespace

void set_host_active(bool active)
{
    if (g_host_active == active)
        return;
    g_host_active = active;
    if (active) {
        emscripten_set_main_loop_timing(EM_TIMING_RAF, 1);
        emscripten_resume_main_loop();
    } else {
        emscripten_pause_main_loop();
    }
}

App::~App()
{
    if (g_engine == &m_engine)
        g_engine = nullptr;
    m_engine.shutdown();
}

bool App::initialize(int argc, char** argv)
{
    PlatformConfig platform_config;
    platform_config.title = "NovelTea Editor Preview";

    EngineConfig engine_config;
    engine_config.load_title_screen = false;
    engine_config.enable_audio = !has_argument(argc, argv, "--no-audio");

    EngineToolingConfig tooling_config;
    tooling_config.enable_debug_ui = false;
    tooling_config.preview_widget = true;
    tooling_config.keep_runtime_running = true;
    const auto raster_snap_mode = rmlui_raster_snap_mode(argc, argv);
    if (!raster_snap_mode)
        return false;
    tooling_config.rmlui_raster_snap = *raster_snap_mode;

    if (!EngineTooling::initialize(m_engine, platform_config, engine_config, tooling_config)) {
        std::fprintf(stderr, "[editor-preview] engine initialization failed\n");
        return false;
    }
    g_engine = &m_engine;
    preview_bridge::emit_ready({}, EngineTooling::preview_running(m_engine));
    return true;
}

int App::run(int argc, char* argv[])
{
    if (!initialize(argc, argv))
        return 1;
    emscripten_set_main_loop_arg(&App::web_tick, this, 0, true);
    return 0;
}

bool App::tick_engine()
{
    if (!g_host_active)
        return true;
    return m_engine.tick();
}

void App::web_tick(void* user_data)
{
    auto* app = static_cast<App*>(user_data);
    if (!app->tick_engine()) {
        emscripten_cancel_main_loop();
        if (g_engine == &app->m_engine)
            g_engine = nullptr;
        app->m_engine.shutdown();
    }
}
} // namespace noveltea::editor_preview

namespace {
noveltea::Engine* preview_engine() { return noveltea::editor_preview::g_engine; }
noveltea::RuntimePreviewController* preview_controller()
{
    auto* engine = preview_engine();
    return engine ? &noveltea::EngineTooling::preview(*engine) : nullptr;
}

#if NOVELTEA_ENABLE_DEVTOOLS
void record_debugger_mutation_if_accepted(std::string_view mutation_result, std::string detail)
{
    const auto parsed = nlohmann::json::parse(mutation_result, nullptr, false);
    if (!parsed.is_object() || !parsed.value("accepted", false))
        return;
    if (auto* engine = preview_engine())
        noveltea::EngineTooling::record_debugger_mutation(*engine, std::move(detail));
}

nlohmann::json devtools_snapshot_json(const noveltea::devtools::DevtoolsSnapshot& value)
{
    const auto& surface = value.host.surface;
    nlohmann::json runtime = nullptr;
    if (value.runtime) {
        runtime = nlohmann::json::parse(
            noveltea::RuntimePreviewController::encode_debug_snapshot(*value.runtime), nullptr,
            false);
        if (runtime.is_discarded())
            return nullptr;
    }
    const auto encode_element = [](const auto& element) -> nlohmann::json {
        if (!element)
            return nullptr;
        return {{"tag", element->tag},
                {"id", element->id},
                {"classes", element->classes},
                {"pointerEvents", element->pointer_events}};
    };
    auto rmlui = nlohmann::json::array();
    for (const auto& context : value.rmlui) {
        rmlui.push_back({{"name", context.name},
                         {"width", context.width},
                         {"height", context.height},
                         {"mouseInteracting", context.mouse_interacting},
                         {"hover", encode_element(context.hover)},
                         {"focus", encode_element(context.focus)}});
    }
    auto hotspots = nlohmann::json::array();
    for (const auto& hotspot : value.world.hotspots) {
        hotspots.push_back(
            {{"identity", hotspot.identity},
             {"label", hotspot.label},
             {"conditionEligible", hotspot.condition_eligible},
             {"targetAvailable", hotspot.target_available},
             {"target", hotspot.target},
             {"highlight", hotspot.highlight},
             {"cursor", hotspot.cursor ? nlohmann::json(*hotspot.cursor) : nlohmann::json(nullptr)},
             {"underPointer", hotspot.under_pointer},
             {"hovered", hotspot.hovered},
             {"pressed", hotspot.pressed}});
    }
    return {
        {"host",
         {{"platform", value.host.platform},
          {"renderer", value.host.renderer},
          {"hostGeneration", value.host.host_generation
                                 ? nlohmann::json(*value.host.host_generation)
                                 : nlohmann::json(nullptr)},
          {"surface",
           {{"logicalWidth", surface.logical_size.width},
            {"logicalHeight", surface.logical_size.height},
            {"framebufferWidth", surface.framebuffer_size.width},
            {"framebufferHeight", surface.framebuffer_size.height},
            {"framebufferScaleX", surface.logical_to_framebuffer_scale.x},
            {"framebufferScaleY", surface.logical_to_framebuffer_scale.y}}}}},
        {"input",
         {{"referenceX", value.input.reference_pointer.x},
          {"referenceY", value.input.reference_pointer.y},
          {"pointerValid", value.input.pointer_valid},
          {"lastEvent", value.input.last_event},
          {"debugProcessed", value.input.debug_processed},
          {"debugConsumed", value.input.debug_consumed},
          {"runtimeUiProcessed", value.input.runtime_ui_processed},
          {"runtimeUiConsumed", value.input.runtime_ui_consumed},
          {"runtimeUiWantsPointer", value.input.runtime_ui_wants_pointer},
          {"gameplayEvent", value.input.gameplay_event},
          {"gameplayAdmitted", value.input.gameplay_admitted},
          {"gameplayBlockReason", value.input.gameplay_block_reason},
          {"governingLayout", value.input.governing_layout
                                  ? nlohmann::json(*value.input.governing_layout)
                                  : nlohmann::json(nullptr)},
          {"governingLayoutMode", value.input.governing_layout_mode}}},
        {"rmlui", std::move(rmlui)},
        {"rmluiDebugger",
         {{"available", value.rmlui_debugger.available},
          {"visible", value.rmlui_debugger.visible},
          {"context", value.rmlui_debugger.context}}},
        {"world",
         {{"referenceX", value.world.reference_pointer.x},
          {"referenceY", value.world.reference_pointer.y},
          {"pointerValid", value.world.pointer_valid},
          {"captureActive", value.world.capture_active},
          {"underPointer", value.world.under_pointer ? nlohmann::json(*value.world.under_pointer)
                                                     : nlohmann::json(nullptr)},
          {"hovered",
           value.world.hovered ? nlohmann::json(*value.world.hovered) : nlohmann::json(nullptr)},
          {"pressed",
           value.world.pressed ? nlohmann::json(*value.world.pressed) : nlohmann::json(nullptr)},
          {"hotspots", std::move(hotspots)}}},
        {"tooling",
         {{"previewRunning", value.tooling.preview_running},
          {"renderPerfLogging", value.tooling.render_perf_logging},
          {"nativeDebugUiAvailable", value.tooling.native_debug_ui_available},
          {"nativeDebugUiEnabled", value.tooling.native_debug_ui_enabled}}},
        {"runtime", std::move(runtime)},
    };
}

nlohmann::json devtools_console_delta_json(const noveltea::devtools::ConsoleDelta& value)
{
    auto records = nlohmann::json::array();
    for (const auto& record : value.records) {
        nlohmann::json source = nullptr;
        if (record.source) {
            source = {{"chunk", record.source->chunk},
                      {"line", record.source->line ? nlohmann::json(*record.source->line)
                                                   : nlohmann::json(nullptr)}};
        }
        records.push_back(
            {{"sequence", std::to_string(record.sequence)},
             {"hostGeneration", record.host_generation
                                    ? nlohmann::json(std::to_string(*record.host_generation))
                                    : nlohmann::json(nullptr)},
             {"runtimeGeneration", record.runtime_generation
                                       ? nlohmann::json(std::to_string(*record.runtime_generation))
                                       : nlohmann::json(nullptr)},
             {"severity", noveltea::devtools::console_severity_name(record.severity)},
             {"category", record.category},
             {"message", record.message},
             {"source", std::move(source)},
             {"generationMarker", record.generation_marker}});
    }
    return {{"afterSequence", std::to_string(value.after_sequence)},
            {"earliestRetainedSequence", std::to_string(value.earliest_retained_sequence)},
            {"latestSequence", std::to_string(value.latest_sequence)},
            {"lostRecordCount", std::to_string(value.lost_record_count)},
            {"historyGap", value.history_gap},
            {"records", std::move(records)}};
}

nlohmann::json devtools_trace_delta_json(const noveltea::devtools::TraceDelta& value)
{
    auto records = nlohmann::json::array();
    const auto encode_element = [](const auto& element) -> nlohmann::json {
        if (!element)
            return nullptr;
        return {{"context", element->context},
                {"tag", element->tag},
                {"id", element->id},
                {"classes", element->classes},
                {"pointerEvents", element->pointer_events}};
    };
    for (const auto& record : value.records) {
        nlohmann::json input = nullptr;
        if (record.input) {
            const auto& routed = *record.input;
            input = {
                {"event", routed.event},
                {"hostX", routed.host_x ? nlohmann::json(*routed.host_x) : nlohmann::json(nullptr)},
                {"hostY", routed.host_y ? nlohmann::json(*routed.host_y) : nlohmann::json(nullptr)},
                {"referenceX", routed.reference_x ? nlohmann::json(*routed.reference_x)
                                                  : nlohmann::json(nullptr)},
                {"referenceY", routed.reference_y ? nlohmann::json(*routed.reference_y)
                                                  : nlohmann::json(nullptr)},
                {"mouseButton", routed.mouse_button ? nlohmann::json(*routed.mouse_button)
                                                    : nlohmann::json(nullptr)},
                {"wheelX",
                 routed.wheel_x ? nlohmann::json(*routed.wheel_x) : nlohmann::json(nullptr)},
                {"wheelY",
                 routed.wheel_y ? nlohmann::json(*routed.wheel_y) : nlohmann::json(nullptr)},
                {"referenceValid", routed.reference_valid},
                {"debugProcessed", routed.debug_processed},
                {"debugConsumed", routed.debug_consumed},
                {"runtimeUiProcessed", routed.runtime_ui_processed},
                {"runtimeUiConsumed", routed.runtime_ui_consumed},
                {"runtimeUiWantsPointer", routed.runtime_ui_wants_pointer},
                {"gameplayEvent", routed.gameplay_event},
                {"gameplayAdmitted", routed.gameplay_admitted},
                {"gameplayBlockReason", routed.gameplay_block_reason},
                {"governingLayout", routed.governing_layout
                                        ? nlohmann::json(*routed.governing_layout)
                                        : nlohmann::json(nullptr)},
                {"governingLayoutMode", routed.governing_layout_mode},
                {"rmluiHover", encode_element(routed.rmlui_hover)},
                {"rmluiFocus", encode_element(routed.rmlui_focus)},
                {"worldEvaluated", routed.world_evaluated},
                {"worldConsumed", routed.world_consumed},
                {"worldHit",
                 routed.world_hit ? nlohmann::json(*routed.world_hit) : nlohmann::json(nullptr)},
                {"worldHovered", routed.world_hovered ? nlohmann::json(*routed.world_hovered)
                                                      : nlohmann::json(nullptr)},
                {"worldPressed", routed.world_pressed ? nlohmann::json(*routed.world_pressed)
                                                      : nlohmann::json(nullptr)},
                {"worldTarget", routed.world_target ? nlohmann::json(*routed.world_target)
                                                    : nlohmann::json(nullptr)}};
        }
        records.push_back(
            {{"sequence", std::to_string(record.sequence)},
             {"firstSequence", std::to_string(record.first_sequence)},
             {"hostGeneration", record.host_generation
                                    ? nlohmann::json(std::to_string(*record.host_generation))
                                    : nlohmann::json(nullptr)},
             {"runtimeGeneration", record.runtime_generation
                                       ? nlohmann::json(std::to_string(*record.runtime_generation))
                                       : nlohmann::json(nullptr)},
             {"kind", noveltea::devtools::trace_record_kind_name(record.kind)},
             {"category", record.category},
             {"repeatCount", record.repeat_count},
             {"firstFrame", std::to_string(record.first_frame)},
             {"lastFrame", std::to_string(record.last_frame)},
             {"input", std::move(input)},
             {"detail", record.detail},
             {"generationMarker", record.generation_marker}});
    }
    return {{"afterSequence", std::to_string(value.after_sequence)},
            {"earliestRetainedSequence", std::to_string(value.earliest_retained_sequence)},
            {"latestSequence", std::to_string(value.latest_sequence)},
            {"lostRecordCount", std::to_string(value.lost_record_count)},
            {"historyGap", value.history_gap},
            {"records", std::move(records)}};
}

const char* devtools_diagnostic_severity_name(noveltea::core::ErrorSeverity severity)
{
    switch (severity) {
    case noveltea::core::ErrorSeverity::Info:
        return "info";
    case noveltea::core::ErrorSeverity::Warning:
        return "warning";
    case noveltea::core::ErrorSeverity::Error:
        return "error";
    case noveltea::core::ErrorSeverity::Fatal:
        return "fatal";
    }
    return "error";
}

nlohmann::json devtools_diagnostic_json(const noveltea::core::Diagnostic& diagnostic)
{
    auto causes = nlohmann::json::array();
    for (const auto& cause : diagnostic.causes)
        causes.push_back(devtools_diagnostic_json(cause));
    return {{"code", diagnostic.code},
            {"severity", devtools_diagnostic_severity_name(diagnostic.severity)},
            {"message", diagnostic.message},
            {"sourcePath", diagnostic.source_path},
            {"jsonPointer", diagnostic.json_pointer},
            {"causes", std::move(causes)}};
}

nlohmann::json devtools_debug_report_json(const noveltea::devtools::DevtoolsDebugReport& report)
{
    auto snapshot = devtools_snapshot_json(report.snapshot);
    if (snapshot.is_null())
        return nullptr;
    auto diagnostics = nlohmann::json::array();
    for (const auto& diagnostic : report.diagnostics)
        diagnostics.push_back(devtools_diagnostic_json(diagnostic));
    auto capabilities = nlohmann::json::array();
    for (const auto& capability : report.capabilities)
        capabilities.push_back(capability);
    return {
        {"formatVersion", report.format_version},
        {"build",
         {{"engineVersion", report.build.engine_version},
          {"buildConfiguration", report.build.build_configuration},
          {"targetPlatform", report.build.target_platform},
          {"hostPlatform", report.build.host_platform},
          {"renderer", report.build.renderer}}},
        {"capabilities", std::move(capabilities)},
        {"snapshot", snapshot},
        {"diagnostics", std::move(diagnostics)},
        {"rmlui", {{"contexts", snapshot["rmlui"]}, {"debugger", snapshot["rmluiDebugger"]}}},
        {"console", devtools_console_delta_json(report.console)},
        {"trace", devtools_trace_delta_json(report.trace)},
    };
}
#endif

std::string diagnostics_json(const noveltea::core::Diagnostics& diagnostics)
{
    auto output = nlohmann::json::array();
    for (const auto& diagnostic : diagnostics) {
        const auto severity = diagnostic.severity == noveltea::core::ErrorSeverity::Info ? "info"
                              : diagnostic.severity == noveltea::core::ErrorSeverity::Warning
                                  ? "warning"
                                  : "error";
        output.push_back(nlohmann::json::object({
            {"severity", severity},
            {"code", diagnostic.code},
            {"message", diagnostic.message},
            {"path", diagnostic.json_pointer},
            {"sourceUrl", diagnostic.source_path},
        }));
    }
    return output.dump();
}

std::optional<noveltea::assets::AssetMemoryTarget> asset_memory_target(std::string_view value)
{
    if (value == "desktop")
        return noveltea::assets::AssetMemoryTarget::Desktop;
    if (value == "android")
        return noveltea::assets::AssetMemoryTarget::Android;
    if (value == "web")
        return noveltea::assets::AssetMemoryTarget::Web;
    return std::nullopt;
}

std::optional<noveltea::assets::AssetMemoryPreset> asset_memory_preset(std::string_view value)
{
    if (value == "low")
        return noveltea::assets::AssetMemoryPreset::Low;
    if (value == "balanced")
        return noveltea::assets::AssetMemoryPreset::Balanced;
    if (value == "high")
        return noveltea::assets::AssetMemoryPreset::High;
    if (value == "custom")
        return noveltea::assets::AssetMemoryPreset::Custom;
    return std::nullopt;
}

std::optional<std::uint64_t> policy_bytes(const nlohmann::json& value, std::string_view key,
                                          bool allow_zero = false)
{
    const auto found = value.find(key);
    if (found == value.end() || !found->is_number_unsigned())
        return std::nullopt;
    const auto parsed = found->get<std::uint64_t>();
    if (!allow_zero && parsed == 0)
        return std::nullopt;
    return parsed;
}
} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE void noveltea_preview_set_running(int running)
{
    if (auto* engine = preview_engine())
        noveltea::EngineTooling::set_preview_running(*engine, running != 0);
}

EMSCRIPTEN_KEEPALIVE void noveltea_preview_set_host_active(int active)
{
    noveltea::editor_preview::set_host_active(active != 0);
}

EMSCRIPTEN_KEEPALIVE void noveltea_engine_set_show_fps_counter(int show)
{
    if (auto* engine = preview_engine())
        noveltea::EngineTooling::set_show_fps_counter(*engine, show != 0);
}

EMSCRIPTEN_KEEPALIVE void noveltea_engine_set_fps_cap(int frames_per_second)
{
    if (auto* engine = preview_engine())
        noveltea::EngineTooling::set_fps_cap(
            *engine, frames_per_second > 0 ? static_cast<std::uint32_t>(frames_per_second) : 0u);
}

EMSCRIPTEN_KEEPALIVE void noveltea_engine_set_rmlui_raster_snapping(int geometry_enabled,
                                                                    int text_enabled)
{
    auto* engine = preview_engine();
    if (!engine)
        return;
    const auto mode = geometry_enabled != 0
                          ? (text_enabled != 0 ? noveltea::RmlUiRasterSnapMode::All
                                               : noveltea::RmlUiRasterSnapMode::Geometry)
                          : (text_enabled != 0 ? noveltea::RmlUiRasterSnapMode::Text
                                               : noveltea::RmlUiRasterSnapMode::None);
    noveltea::EngineTooling::set_rmlui_raster_snap(*engine, mode);
}

EMSCRIPTEN_KEEPALIVE int noveltea_engine_set_asset_memory_policy(const char* policy_json)
{
    auto* engine = preview_engine();
    if (!engine || !policy_json)
        return 0;
    const auto value = nlohmann::json::parse(policy_json, nullptr, false);
    if (value.is_discarded() || !value.is_object())
        return 0;
    const auto target_it = value.find("target");
    const auto preset_it = value.find("preset");
    if (target_it == value.end() || preset_it == value.end() || !target_it->is_string() ||
        !preset_it->is_string())
        return 0;
    const auto target = asset_memory_target(target_it->get<std::string>());
    const auto preset = asset_memory_preset(preset_it->get<std::string>());
    const auto prepared_cpu = policy_bytes(value, "preparedCpuBytes");
    const auto gpu = policy_bytes(value, "gpuBytes");
    const auto audio = policy_bytes(value, "audioBytes");
    const auto temporary = policy_bytes(value, "temporaryBytes");
    const auto warm_prepared_cpu = policy_bytes(value, "warmPreparedCpuBytes", true);
    const auto warm_gpu = policy_bytes(value, "warmGpuBytes", true);
    const auto warm_audio = policy_bytes(value, "warmAudioBytes", true);
    if (!target || !preset || !prepared_cpu || !gpu || !audio || !temporary || !warm_prepared_cpu ||
        !warm_gpu || !warm_audio)
        return 0;
    if (*temporary < noveltea::assets::minimum_temporary_asset_budget_bytes ||
        *warm_prepared_cpu > *prepared_cpu || *warm_gpu > *gpu || *warm_audio > *audio)
        return 0;
    noveltea::assets::ResolvedAssetMemoryPolicy policy{
        .target = *target,
        .preset = *preset,
        .budget = {.source_bytes = *prepared_cpu,
                   .prepared_cpu_bytes = *prepared_cpu,
                   .gpu_bytes = *gpu,
                   .audio_bytes = *audio,
                   .temporary_bytes = *temporary,
                   .warm_prepared_cpu_bytes = *warm_prepared_cpu,
                   .warm_gpu_bytes = *warm_gpu,
                   .warm_audio_bytes = *warm_audio}};
    (void)noveltea::EngineTooling::set_asset_memory_policy(*engine, std::move(policy));
    return 1;
}

EMSCRIPTEN_KEEPALIVE int noveltea_preview_load_rml_document(const char* rml)
{
    auto* preview = preview_controller();
    return preview && rml && preview->load_document(rml) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_preview_execute_lua_script(const char* source)
{
    auto* preview = preview_controller();
    return preview && source && preview->execute_lua(source) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_preview_apply_editor_document(const char* request_json)
{
    auto* preview = preview_controller();
    if (!preview || !request_json)
        return 0;
    auto request =
        noveltea::core::editor::decode_focused_editor_document_request_text(request_json);
    if (!request) {
        preview->report_diagnostics(std::move(request).error());
        return 0;
    }
    auto* accepted = request.value_if();
    if (!accepted)
        return 0;
    return preview->apply_focused_editor_document(std::move(*accepted)) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_preview_active_shader_variant()
{
    const auto* preview = preview_controller();
    return preview ? preview->active_shader_variant() : "";
}

EMSCRIPTEN_KEEPALIVE double noveltea_preview_host_generation()
{
    const auto* preview = preview_controller();
    return preview ? static_cast<double>(preview->host_generation()) : 0.0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_load_project(const char* logical_path)
{
    auto* preview = preview_controller();
    return preview && logical_path && preview->load_project(logical_path) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_reset()
{
    auto* preview = preview_controller();
    return preview && preview->reset() ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_start()
{
    auto* preview = preview_controller();
    return preview && preview->start() ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_stop()
{
    auto* preview = preview_controller();
    return preview && preview->stop() ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_step(double delta_seconds)
{
    auto* preview = preview_controller();
    return preview && preview->step(delta_seconds) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_continue()
{
    auto* preview = preview_controller();
    return preview && preview->continue_dialogue() ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_dialogue_choice(const char* edge_id)
{
    auto* preview = preview_controller();
    return preview && edge_id && preview->select_dialogue_choice(edge_id) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_scene_choice(const char* option_id)
{
    auto* preview = preview_controller();
    return preview && option_id && preview->select_scene_choice(option_id) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_navigate(const char* exit_id)
{
    auto* preview = preview_controller();
    return preview && exit_id && preview->navigate(exit_id) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_select_subjects(const char* subjects_json)
{
    auto* preview = preview_controller();
    if (!preview || !subjects_json)
        return 0;
    auto subjects = noveltea::core::editor::decode_editor_interaction_subjects_text(subjects_json);
    if (!subjects) {
        preview->report_diagnostics(std::move(subjects).error());
        return 0;
    }
    return preview->select_subjects(std::move(*subjects.value_if())) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_primary_activate(const char* subjects_json)
{
    auto* preview = preview_controller();
    if (!preview || !subjects_json)
        return 0;
    auto subjects = noveltea::core::editor::decode_editor_interaction_subjects_text(subjects_json);
    if (!subjects) {
        preview->report_diagnostics(std::move(subjects).error());
        return 0;
    }
    auto* values = subjects.value_if();
    if (values == nullptr || values->size() != 1)
        return 0;
    return preview->primary_activate(std::move(values->front())) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_open_verb_menu(const char* subjects_json)
{
    auto* preview = preview_controller();
    if (!preview || !subjects_json)
        return 0;
    auto subjects = noveltea::core::editor::decode_editor_interaction_subjects_text(subjects_json);
    if (!subjects) {
        preview->report_diagnostics(std::move(subjects).error());
        return 0;
    }
    auto* values = subjects.value_if();
    if (values == nullptr || values->size() != 1)
        return 0;
    return preview->open_verb_menu(std::move(values->front())) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_clear_subject_selection()
{
    auto* preview = preview_controller();
    return preview && preview->clear_subject_selection() ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_run_interaction(const char* verb_id,
                                                          const char* bindings_json)
{
    auto* preview = preview_controller();
    if (!preview || !verb_id)
        return 0;
    auto bindings = noveltea::core::editor::decode_editor_interaction_bindings_text(
        bindings_json ? bindings_json : "[]");
    if (!bindings) {
        preview->report_diagnostics(std::move(bindings).error());
        return 0;
    }
    return preview->run_interaction(verb_id, std::move(*bindings.value_if())) ? 1 : 0;
}

#if NOVELTEA_ENABLE_DEVTOOLS
EMSCRIPTEN_KEEPALIVE const char* noveltea_runtime_set_variable(const char* variable_id,
                                                               const char* value_json)
{
    static std::string result;
    result.clear();
    auto* preview = preview_controller();
    if (!preview || !variable_id || !value_json)
        return result.c_str();
    auto value = noveltea::core::editor::decode_editor_runtime_value_text(value_json);
    if (!value) {
        preview->report_diagnostics(std::move(value).error());
        return result.c_str();
    }
    result = preview->set_variable(variable_id, std::move(*value.value_if()));
    record_debugger_mutation_if_accepted(result, "set variable " + std::string(variable_id));
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_runtime_reset_variable(const char* variable_id)
{
    static std::string result;
    result.clear();
    if (auto* preview = preview_controller(); preview && variable_id) {
        result = preview->reset_variable(variable_id);
        record_debugger_mutation_if_accepted(result, "reset variable " + std::string(variable_id));
    }
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_runtime_teleport_room(const char* room_id)
{
    static std::string result;
    result.clear();
    if (auto* preview = preview_controller(); preview && room_id) {
        result = preview->teleport_room(room_id);
        record_debugger_mutation_if_accepted(result, "teleport room " + std::string(room_id));
    }
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char*
noveltea_runtime_create_instance(const char* kind, const char* source_kind, const char* source_id)
{
    static std::string result;
    result.clear();
    if (auto* preview = preview_controller(); preview && kind && source_kind && source_id) {
        result = preview->create_runtime_instance(kind, source_kind, source_id);
        record_debugger_mutation_if_accepted(result, "create " + std::string(kind) + " from " +
                                                         source_kind + ":" + source_id);
    }
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char*
noveltea_runtime_replace_instance_configuration(const char* kind, const char* instance_id,
                                                const char* source_kind, const char* source_id)
{
    static std::string result;
    result.clear();
    if (auto* preview = preview_controller();
        preview && kind && instance_id && source_kind && source_id) {
        result = preview->replace_runtime_instance_configuration(kind, instance_id, source_kind,
                                                                 source_id);
        record_debugger_mutation_if_accepted(result, "replace " + std::string(kind) + " " +
                                                         instance_id + " from " + source_kind +
                                                         ":" + source_id);
    }
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char*
noveltea_runtime_clear_instance_configuration(const char* kind, const char* instance_id)
{
    static std::string result;
    result.clear();
    if (auto* preview = preview_controller(); preview && kind && instance_id) {
        result = preview->clear_runtime_instance_configuration(kind, instance_id);
        record_debugger_mutation_if_accepted(result, "clear " + std::string(kind) +
                                                         " configuration " + instance_id);
    }
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_runtime_destroy_instance(const char* kind,
                                                                   const char* instance_id)
{
    static std::string result;
    result.clear();
    if (auto* preview = preview_controller(); preview && kind && instance_id) {
        result = preview->destroy_runtime_instance(kind, instance_id);
        record_debugger_mutation_if_accepted(result,
                                             "destroy " + std::string(kind) + " " + instance_id);
    }
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_runtime_retarget_room_exit(const char* room_id,
                                                                     const char* exit_id,
                                                                     const char* target_room_id)
{
    static std::string result;
    result.clear();
    if (auto* preview = preview_controller(); preview && room_id && exit_id && target_room_id) {
        result = preview->retarget_runtime_room_exit(room_id, exit_id, target_room_id);
        record_debugger_mutation_if_accepted(result, "retarget room exit " + std::string(room_id) +
                                                         "/" + exit_id + " -> " + target_room_id);
    }
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_runtime_debug_snapshot()
{
    static std::string result;
    result.clear();
    if (auto* preview = preview_controller())
        result = preview->debug_snapshot();
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_devtools_capabilities()
{
    static std::string result;
    auto capabilities = nlohmann::json::array();
    for (const auto capability : noveltea::EngineTooling::devtools_capabilities())
        capabilities.push_back(capability);
    result = capabilities.dump();
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE int noveltea_devtools_set_rmlui_debugger(int visible, const char* context)
{
    auto* engine = preview_engine();
    if (!engine || !context || (visible != 0 && visible != 1))
        return 0;
    return noveltea::EngineTooling::set_rmlui_debugger(*engine, {visible != 0, context}) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_devtools_snapshot()
{
    static std::string result;
    result.clear();
    auto* engine = preview_engine();
    if (!engine)
        return result.c_str();
    auto snapshot = noveltea::EngineTooling::devtools_snapshot(*engine);
    if (!snapshot)
        return result.c_str();
    auto encoded = devtools_snapshot_json(*snapshot.value_if());
    if (encoded.is_null())
        return result.c_str();
    result = encoded.dump();
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_devtools_debug_report()
{
    static std::string result;
    result.clear();
    auto* engine = preview_engine();
    if (!engine)
        return result.c_str();
    auto report = noveltea::EngineTooling::devtools_debug_report(*engine);
    if (!report)
        return result.c_str();
    auto encoded = devtools_debug_report_json(*report.value_if());
    if (encoded.is_null())
        return result.c_str();
    result = encoded.dump();
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_devtools_trace_delta(const char* after_sequence)
{
    static std::string result;
    result.clear();
    auto* engine = preview_engine();
    if (!engine || !after_sequence)
        return result.c_str();

    std::uint64_t after = 0;
    const std::string_view text(after_sequence);
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), after);
    if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size())
        return result.c_str();

    auto delta = noveltea::EngineTooling::devtools_trace_delta(*engine, after);
    if (!delta)
        return result.c_str();

    result = devtools_trace_delta_json(*delta.value_if()).dump();
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_devtools_trace_clear()
{
    static std::string result;
    result.clear();
    if (auto* engine = preview_engine()) {
        result =
            nlohmann::json{{"latestSequence",
                            std::to_string(noveltea::EngineTooling::clear_devtools_trace(*engine))}}
                .dump();
    }
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_devtools_console_delta(const char* after_sequence)
{
    static std::string result;
    result.clear();
    auto* engine = preview_engine();
    if (!engine || !after_sequence)
        return result.c_str();

    std::uint64_t after = 0;
    const std::string_view text(after_sequence);
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), after);
    if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size())
        return result.c_str();

    auto delta = noveltea::EngineTooling::devtools_console_delta(*engine, after);
    if (!delta)
        return result.c_str();

    result = devtools_console_delta_json(*delta.value_if()).dump();
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_devtools_console_clear()
{
    static std::string result;
    result.clear();
    if (auto* engine = preview_engine()) {
        result =
            nlohmann::json{
                {"latestSequence",
                 std::to_string(noveltea::EngineTooling::clear_devtools_console(*engine))}}
                .dump();
    }
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_runtime_fast_forward_to_input()
{
    static std::string result;
    result.clear();
    if (auto* preview = preview_controller())
        result = preview->fast_forward_to_input();
    return result.c_str();
}
#endif

EMSCRIPTEN_KEEPALIVE int noveltea_preview_resize(int logical_width, int logical_height,
                                                 int framebuffer_width, int framebuffer_height,
                                                 float host_logical_to_framebuffer_scale_x,
                                                 float host_logical_to_framebuffer_scale_y)
{
    auto* engine = preview_engine();
    if (!engine)
        return 0;
    auto surface = noveltea::make_host_surface_metrics(logical_width, logical_height,
                                                       framebuffer_width, framebuffer_height);
    surface.logical_to_framebuffer_scale = {host_logical_to_framebuffer_scale_x,
                                            host_logical_to_framebuffer_scale_y};
    surface = noveltea::sanitize_host_surface_metrics(surface);
    engine->resize(surface);
    return 1;
}

EMSCRIPTEN_KEEPALIVE int noveltea_preview_backbuffer_width()
{
    auto* engine = preview_engine();
    return engine ? engine->backbuffer_size().width : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_preview_backbuffer_height()
{
    auto* engine = preview_engine();
    return engine ? engine->backbuffer_size().height : 0;
}

EMSCRIPTEN_KEEPALIVE void noveltea_audio_play_sfx(const char* path, float volume, float pitch)
{
    if (auto* preview = preview_controller(); preview && path)
        (void)preview->play_audio_sfx(path, volume, pitch);
}

EMSCRIPTEN_KEEPALIVE void noveltea_audio_play_track(const char* track_id, const char* path,
                                                    float volume, int loop)
{
    if (auto* preview = preview_controller(); preview && track_id && path)
        (void)preview->play_audio_track(track_id, path, volume, loop != 0);
}

EMSCRIPTEN_KEEPALIVE void noveltea_audio_stop_track(const char* track_id, float fade_seconds)
{
    if (auto* preview = preview_controller(); preview && track_id)
        preview->stop_audio_track(track_id, fade_seconds);
}

#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
EMSCRIPTEN_KEEPALIVE const char* noveltea_asset_profiler_snapshot()
{
    static std::string result_json;
    auto* engine = preview_engine();
    if (!engine) {
        result_json = noveltea::core::serialize_asset_profiler_failure(
            {.code = "assets.editor_profiler_unavailable",
             .message = "Asset profiler is unavailable for the current preview session"});
        return result_json.c_str();
    }
    auto result = noveltea::EngineTooling::asset_profiler_snapshot(*engine);
    result_json = result.has_value()
                      ? noveltea::core::serialize_asset_profiler_snapshot(*result.value_if())
                      : noveltea::core::serialize_asset_profiler_failure(result.error());
    return result_json.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_asset_profiler_delta(const char* expected_session_decimal,
                                                               const char* after_sequence_decimal)
{
    static std::string result_json;
    std::uint64_t session = 0;
    std::uint64_t sequence = 0;
    const std::string_view expected_session =
        expected_session_decimal ? expected_session_decimal : "";
    const std::string_view after_sequence = after_sequence_decimal ? after_sequence_decimal : "";
    if (!noveltea::core::parse_asset_profiler_decimal(expected_session, session) ||
        !noveltea::core::parse_asset_profiler_decimal(after_sequence, sequence)) {
        result_json = noveltea::core::serialize_asset_profiler_failure(
            {.code = "assets.editor_profiler_invalid_cursor",
             .message = "Asset profiler delta cursors must be canonical unsigned-decimal strings"});
        return result_json.c_str();
    }
    auto* engine = preview_engine();
    if (!engine) {
        result_json = noveltea::core::serialize_asset_profiler_failure(
            {.code = "assets.editor_profiler_unavailable",
             .message = "Asset profiler is unavailable for the current preview session"});
        return result_json.c_str();
    }
    auto result = noveltea::EngineTooling::asset_profiler_delta(
        *engine, noveltea::core::AssetProfilerSessionId{session},
        noveltea::core::AssetProfilerSequence{sequence});
    result_json = result.has_value()
                      ? noveltea::core::serialize_asset_profiler_delta(*result.value_if())
                      : noveltea::core::serialize_asset_profiler_failure(result.error());
    return result_json.c_str();
}
#endif
}
