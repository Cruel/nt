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
#include <cstdio>
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

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_dialogue_option(int option_index)
{
    auto* preview = preview_controller();
    return preview && preview->select_dialogue_option(option_index) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_navigate(int direction)
{
    auto* preview = preview_controller();
    return preview && preview->navigate(direction) ? 1 : 0;
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

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_clear_subject_selection()
{
    auto* preview = preview_controller();
    return preview && preview->clear_subject_selection() ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int noveltea_runtime_run_interaction(const char* verb_id,
                                                          const char* operands_json)
{
    auto* preview = preview_controller();
    if (!preview || !verb_id)
        return 0;
    auto operands = noveltea::core::editor::decode_editor_interaction_subjects_text(
        operands_json ? operands_json : "[]");
    if (!operands) {
        preview->report_diagnostics(std::move(operands).error());
        return 0;
    }
    return preview->run_interaction(verb_id, std::move(*operands.value_if())) ? 1 : 0;
}

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
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_runtime_reset_variable(const char* variable_id)
{
    static std::string result;
    result.clear();
    if (auto* preview = preview_controller(); preview && variable_id)
        result = preview->reset_variable(variable_id);
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_runtime_give_object(const char* object_id)
{
    static std::string result;
    result.clear();
    if (auto* preview = preview_controller(); preview && object_id)
        result = preview->give_object(object_id);
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_runtime_remove_inventory_object(const char* object_id)
{
    static std::string result;
    result.clear();
    if (auto* preview = preview_controller(); preview && object_id)
        result = preview->remove_inventory_object(object_id);
    return result.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* noveltea_runtime_teleport_room(const char* room_id)
{
    static std::string result;
    result.clear();
    if (auto* preview = preview_controller(); preview && room_id)
        result = preview->teleport_room(room_id);
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

EMSCRIPTEN_KEEPALIVE const char* noveltea_runtime_fast_forward_to_input()
{
    static std::string result;
    result.clear();
    if (auto* preview = preview_controller())
        result = preview->fast_forward_to_input();
    return result.c_str();
}

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
