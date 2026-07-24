#include "host/engine_impl.hpp"

#include "noveltea/audio/audio_backend.hpp"
#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/core/editor_runtime_protocol.hpp"
#include "noveltea/core/json_access.hpp"
#include "noveltea/render/material.hpp"
#include "noveltea/render/material_codec.hpp"
#include "noveltea/preview_bridge.hpp"
#include "noveltea/boundary/running_game_loader.hpp"
#include "noveltea/runtime/runtime_capabilities.hpp"
#include "platform/sdl/sdl_platform.hpp"
#include "ui/rmlui/runtime_ui_facade_access.hpp"

#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
#include "render/bgfx/editor_asset_profiler_renderer_memory.hpp"
#endif

#include <SDL3/SDL.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <charconv>
#include <chrono>
#include <map>
#include <limits>
#include <memory>
#include <optional>
#include <span>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#endif

namespace noveltea {

using presentation::RuntimeLayoutBuiltinDocument;
using presentation::RuntimeLayoutBuiltinSource;
using presentation::RuntimeLayoutMountRequest;
using presentation::RuntimeLayoutProjectSource;

Engine::Impl::Impl()
    : m_world_presentation_resources(m_assets),
      m_world_presentation(m_world_presentation_resources),
      m_world_transitions(m_world_presentation), m_audio(make_miniaudio_backend()),
      m_screenshot_capture_backend(m_renderer),
      m_checkpoint_thumbnail_captures(m_screenshot_capture_backend),
      m_layout_realizer(m_assets, m_runtime_ui),
      m_game_host(host::GameHost::Dependencies{
          .content_assets = m_assets,
          .script_invocations = m_scripts,
          .save_slots = m_typed_saves,
          .runtime_ui = m_runtime_ui,
          .layout_realizer = &m_layout_realizer,
          .audio = m_audio,
          .preview_publication_sink = nullptr,
          .observation_sink = nullptr,
          .runtime_clock = m_runtime_clock,
          .host_values = m_game_host_values,
          .system_layout_host = *this,
          .world_transitions = &m_world_transitions,
          .script_certifier = m_scripts,
          .diagnostic_sink =
              [](host::HostFrameStage stage, const core::Diagnostic& diagnostic) {
                  const auto stage_name = host::to_string(stage);
                  SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[runtime:%.*s] %s %s %s",
                               static_cast<int>(stage_name.size()), stage_name.data(),
                               diagnostic.code.c_str(), diagnostic.source_path.c_str(),
                               diagnostic.message.c_str());
              },
      }),
      m_presentation_layouts(m_game_host.runtime_layouts(), m_layout_realizer),
      m_preview_host(host::PreviewHost::Dependencies{
          .game_host = m_game_host,
          .runtime_ui = m_runtime_ui,
          .scripts = m_scripts,
          .renderer = m_renderer,
          .shader_materials = m_shader_materials,
          .assets = m_assets,
          .audio_backend = m_audio,
          .layout_realizer = m_layout_realizer,
          .load_game =
              [this](host::GameHostLoadRequest request) {
                  return load_compiled_project(request.logical_path, request.load_title_screen,
                                               request.stop_runtime_after_load);
              },
          .apply_authored_environment =
              [this](const core::editor::TypedEditorAuthoredPreviewEnvironment& environment) {
                  return apply_authored_preview_environment(environment);
              },
          .clear_authored_environment = [this]() { return clear_authored_preview_environment(); },
          .preview_running = m_preview_running,
      }),
      m_runtime_preview(m_preview_host)
{
}
namespace {

constexpr uint32_t kMaxFpsCap = 1000;
constexpr auto kNormalFrameJobBudget = std::chrono::milliseconds(2);
constexpr auto kLoadingFrameJobBudget = std::chrono::milliseconds(12);
constexpr std::size_t kNormalFrameCompletionLimit = 64;
constexpr std::size_t kLoadingFrameCompletionLimit = 256;
#if defined(__EMSCRIPTEN__)
constexpr uint32_t kPreviewDisplayPaceCap = 60;
#endif

assets::AssetMemoryTarget runtime_asset_memory_target() noexcept
{
#if defined(__EMSCRIPTEN__)
    return assets::AssetMemoryTarget::Web;
#elif defined(NOVELTEA_PLATFORM_ANDROID)
    return assets::AssetMemoryTarget::Android;
#else
    return assets::AssetMemoryTarget::Desktop;
#endif
}

const char* system_layout_role_key(core::compiled::SystemLayoutRole role)
{
    switch (role) {
    case core::compiled::SystemLayoutRole::Title:
        return "title";
    case core::compiled::SystemLayoutRole::GameHud:
        return "game-hud";
    case core::compiled::SystemLayoutRole::PauseMenu:
        return "pause-menu";
    case core::compiled::SystemLayoutRole::LoadMenu:
        return "load-menu";
    case core::compiled::SystemLayoutRole::SettingsMenu:
        return "settings-menu";
    case core::compiled::SystemLayoutRole::Modal:
        return "modal";
    case core::compiled::SystemLayoutRole::DebugOverlay:
        return "debug-overlay";
    case core::compiled::SystemLayoutRole::SaveMenu:
        return "save-menu";
    case core::compiled::SystemLayoutRole::TextLog:
        return "text-log";
    }
    return "unknown";
}

std::optional<RuntimeLayoutBuiltinDocument>
system_layout_builtin(core::compiled::SystemLayoutRole role)
{
    switch (role) {
    case core::compiled::SystemLayoutRole::Title:
        return RuntimeLayoutBuiltinDocument::Title;
    case core::compiled::SystemLayoutRole::GameHud:
        return RuntimeLayoutBuiltinDocument::GameHud;
    case core::compiled::SystemLayoutRole::PauseMenu:
        return RuntimeLayoutBuiltinDocument::PauseMenu;
    case core::compiled::SystemLayoutRole::SaveMenu:
        return RuntimeLayoutBuiltinDocument::SaveMenu;
    case core::compiled::SystemLayoutRole::LoadMenu:
        return RuntimeLayoutBuiltinDocument::LoadMenu;
    case core::compiled::SystemLayoutRole::SettingsMenu:
        return RuntimeLayoutBuiltinDocument::SettingsMenu;
    case core::compiled::SystemLayoutRole::TextLog:
        return RuntimeLayoutBuiltinDocument::TextLog;
    case core::compiled::SystemLayoutRole::Modal:
        return RuntimeLayoutBuiltinDocument::Modal;
    case core::compiled::SystemLayoutRole::DebugOverlay:
        return std::nullopt;
    }
    return std::nullopt;
}

host::HostGeneration host_generation(host::GameSessionGeneration generation)
{
    return *host::HostGeneration::from_number(generation.number());
}

const char* preview_severity(core::ErrorSeverity severity)
{
    switch (severity) {
    case core::ErrorSeverity::Info:
        return "info";
    case core::ErrorSeverity::Warning:
        return "warning";
    case core::ErrorSeverity::Error:
    case core::ErrorSeverity::Fatal:
        return "error";
    }
    return "error";
}

void emit_preview_diagnostic(const core::Diagnostic& diagnostic)
{
    std::string message =
        diagnostic.code.empty() ? diagnostic.message : diagnostic.code + ": " + diagnostic.message;
    std::string path = diagnostic.source_path;
    if (!diagnostic.json_pointer.empty()) {
        if (!path.empty())
            path += diagnostic.json_pointer;
        else
            path = diagnostic.json_pointer;
    }
    preview_bridge::emit_diagnostic(preview_severity(diagnostic.severity), "runtime", path.c_str(),
                                    message.c_str());
    for (const auto& cause : diagnostic.causes)
        emit_preview_diagnostic(cause);
}

std::optional<std::uint32_t> parse_bar_color_rgba(std::string_view value)
{
    if (value.size() != 7 || value.front() != '#')
        return std::nullopt;
    std::uint32_t rgb = 0;
    const auto* first = value.data() + 1;
    const auto* last = value.data() + value.size();
    const auto parsed = std::from_chars(first, last, rgb, 16);
    if (parsed.ec != std::errc{} || parsed.ptr != last)
        return std::nullopt;
    return (rgb << 8) | 0xffu;
}

PresentationSettings presentation_settings_from(const core::compiled::DisplaySettings& display)
{
    PresentationSettings settings;
    settings.reference.size = {
        static_cast<int>(display.reference_resolution.width),
        static_cast<int>(display.reference_resolution.height),
    };
    settings.world_raster_policy =
        display.world_raster_policy == core::compiled::WorldRasterPolicy::Native
            ? WorldRasterPolicy::Native
            : WorldRasterPolicy::Capped;
    if (const auto parsed_color = parse_bar_color_rgba(display.bar_color))
        settings.bar_color_rgba = *parsed_color;
    return settings;
}

uint32_t sanitize_fps_cap(uint32_t frames_per_second)
{
    return std::min(frames_per_second, kMaxFpsCap);
}

ShaderMaterialProject make_demo_shader_materials()
{
    ShaderStageDefinition vertex;
    vertex.stage = ShaderStage::Vertex;
    vertex.compiled = {
        {"glsl-120", "system:/shaders/bgfx/glsl-120/quad.vs.bin"},
        {"essl-100", "system:/shaders/bgfx/essl-100/quad.vs.bin"},
        {"essl-300", "system:/shaders/bgfx/essl-300/quad.vs.bin"},
    };

    ShaderStageDefinition fragment;
    fragment.stage = ShaderStage::Fragment;
    fragment.compiled = {
        {"glsl-120", "system:/shaders/bgfx/glsl-120/quad.fs.bin"},
        {"essl-100", "system:/shaders/bgfx/essl-100/quad.fs.bin"},
        {"essl-300", "system:/shaders/bgfx/essl-300/quad.fs.bin"},
    };

    ShaderDefinition shader;
    shader.id = ShaderId("quad");
    shader.display_name = "Demo Engine 2D Quad";
    shader.roles = {ShaderRole::Engine2D};
    shader.stages = {std::move(vertex), std::move(fragment)};
    ShaderUniformDeclaration use_texture;
    use_texture.name = "u_useTexture";
    use_texture.type = ShaderUniformType::Float;
    use_texture.default_value = 1.0f;
    shader.uniforms.push_back(std::move(use_texture));
    shader.samplers.push_back(ShaderSamplerDeclaration{.name = "s_texColor"});

    MaterialDefinition material;
    material.id = MaterialId("demo/engine_2d_quad");
    material.role = ShaderRole::Engine2D;
    material.shader = ShaderId("quad");
    material.display_name = "Demo Engine 2D Material Quad";
    material.textures.push_back(MaterialTextureAssignment{
        .sampler = "s_texColor",
        .source = "$draw.texture",
        .filtering = MaterialTextureSampler::ClampLinear,
    });

    ShaderStageDefinition postprocess_vertex;
    postprocess_vertex.stage = ShaderStage::Vertex;
    postprocess_vertex.compiled = {
        {"glsl-120", "system:/shaders/bgfx/glsl-120/postprocess_tint.vs.bin"},
        {"essl-100", "system:/shaders/bgfx/essl-100/postprocess_tint.vs.bin"},
        {"essl-300", "system:/shaders/bgfx/essl-300/postprocess_tint.vs.bin"},
    };

    ShaderStageDefinition postprocess_fragment;
    postprocess_fragment.stage = ShaderStage::Fragment;
    postprocess_fragment.compiled = {
        {"glsl-120", "system:/shaders/bgfx/glsl-120/postprocess_tint.fs.bin"},
        {"essl-100", "system:/shaders/bgfx/essl-100/postprocess_tint.fs.bin"},
        {"essl-300", "system:/shaders/bgfx/essl-300/postprocess_tint.fs.bin"},
    };

    ShaderDefinition postprocess_shader;
    postprocess_shader.id = ShaderId("demo/postprocess_tint_shader");
    postprocess_shader.display_name = "Demo Postprocess Tint";
    postprocess_shader.roles = {ShaderRole::Postprocess};
    postprocess_shader.stages = {std::move(postprocess_vertex), std::move(postprocess_fragment)};
    postprocess_shader.uniforms.push_back(
        ShaderUniformDeclaration{.name = "u_tint",
                                 .type = ShaderUniformType::Color,
                                 .default_value = ShaderColor{0.35f, 1.0f, 0.35f, 1.0f},
                                 .range = {},
                                 .editor_label = {},
                                 .binding = {}});
    postprocess_shader.samplers.push_back(ShaderSamplerDeclaration{.name = "s_texColor"});

    const auto make_postprocess_material = [&](std::string id, PostprocessScope scope) {
        MaterialDefinition result;
        result.id = MaterialId(std::move(id));
        result.role = ShaderRole::Postprocess;
        result.shader = postprocess_shader.id;
        result.display_name = "Demo Postprocess Tint";
        result.postprocess_scope = scope;
        result.uniforms.push_back(MaterialUniformAssignment{
            .name = "u_tint", .value = ShaderColor{0.35f, 1.0f, 0.35f, 1.0f}});
        result.textures.push_back(MaterialTextureAssignment{
            .sampler = "s_texColor",
            .source = "$draw.texture",
            .filtering = MaterialTextureSampler::ClampLinear,
        });
        return result;
    };
    auto world_postprocess_material =
        make_postprocess_material("demo/postprocess_world", PostprocessScope::World);
    auto full_game_postprocess_material =
        make_postprocess_material("demo/postprocess_full_game", PostprocessScope::FullGameViewport);

    ShaderStageDefinition rmlui_vertex;
    rmlui_vertex.stage = ShaderStage::Vertex;
    rmlui_vertex.compiled = {
        {"glsl-120", "system:/shaders/bgfx/glsl-120/rmlui_noise_panel.vs.bin"},
        {"essl-100", "system:/shaders/bgfx/essl-100/rmlui_noise_panel.vs.bin"},
        {"essl-300", "system:/shaders/bgfx/essl-300/rmlui_noise_panel.vs.bin"},
    };

    ShaderStageDefinition noise_fragment;
    noise_fragment.stage = ShaderStage::Fragment;
    noise_fragment.compiled = {
        {"glsl-120", "system:/shaders/bgfx/glsl-120/rmlui_noise_panel.fs.bin"},
        {"essl-100", "system:/shaders/bgfx/essl-100/rmlui_noise_panel.fs.bin"},
        {"essl-300", "system:/shaders/bgfx/essl-300/rmlui_noise_panel.fs.bin"},
    };

    ShaderDefinition rmlui_noise_shader;
    rmlui_noise_shader.id = ShaderId("ui/noise_panel");
    rmlui_noise_shader.display_name = "RmlUi Noise Panel";
    rmlui_noise_shader.roles = {ShaderRole::RmlUiDecorator};
    rmlui_noise_shader.stages = {std::move(rmlui_vertex), std::move(noise_fragment)};
    ShaderUniformDeclaration dimensions;
    dimensions.name = "u_dimensions";
    dimensions.type = ShaderUniformType::Vec2;
    dimensions.default_value = std::array<float, 2>{1.0f, 1.0f};
    dimensions.binding = ShaderInputSemantic::RmlUiPaintDimensions;
    rmlui_noise_shader.uniforms.push_back(std::move(dimensions));

    MaterialDefinition rmlui_material;
    rmlui_material.id = MaterialId("ui/noise_panel");
    rmlui_material.role = ShaderRole::RmlUiDecorator;
    rmlui_material.shader = ShaderId("ui/noise_panel");
    rmlui_material.display_name = "RmlUi Noise Panel";

    ShaderStageDefinition text_vertex;
    text_vertex.stage = ShaderStage::Vertex;
    text_vertex.compiled = {
        {"glsl-120", "system:/shaders/bgfx/glsl-120/text.vs.bin"},
        {"essl-100", "system:/shaders/bgfx/essl-100/text.vs.bin"},
        {"essl-300", "system:/shaders/bgfx/essl-300/text.vs.bin"},
    };

    ShaderStageDefinition text_fragment;
    text_fragment.stage = ShaderStage::Fragment;
    text_fragment.compiled = {
        {"glsl-120", "system:/shaders/bgfx/glsl-120/text.fs.bin"},
        {"essl-100", "system:/shaders/bgfx/essl-100/text.fs.bin"},
        {"essl-300", "system:/shaders/bgfx/essl-300/text.fs.bin"},
    };

    ShaderStageDefinition glow_fragment;
    glow_fragment.stage = ShaderStage::Fragment;
    glow_fragment.compiled = {
        {"glsl-120", "system:/shaders/bgfx/glsl-120/active_text_glow.fs.bin"},
        {"essl-100", "system:/shaders/bgfx/essl-100/active_text_glow.fs.bin"},
        {"essl-300", "system:/shaders/bgfx/essl-300/active_text_glow.fs.bin"},
    };

    ShaderDefinition active_text_shader;
    active_text_shader.id = ShaderId("demo/active_text_default_shader");
    active_text_shader.display_name = "Demo ActiveText Default Material Shader";
    active_text_shader.roles = {ShaderRole::ActiveText};
    active_text_shader.stages = {text_vertex, text_fragment};
    active_text_shader.samplers.push_back(ShaderSamplerDeclaration{.name = "s_textAtlas"});

    ShaderDefinition active_text_glow_shader;
    active_text_glow_shader.id = ShaderId("demo/active_text_glow_shader");
    active_text_glow_shader.display_name = "Demo ActiveText Glow Material Shader";
    active_text_glow_shader.roles = {ShaderRole::ActiveText};
    active_text_glow_shader.stages = {std::move(text_vertex), std::move(glow_fragment)};
    active_text_glow_shader.uniforms.push_back(
        ShaderUniformDeclaration{.name = "u_time",
                                 .type = ShaderUniformType::Float,
                                 .default_value = 0.0f,
                                 .range = {},
                                 .editor_label = {},
                                 .binding = ShaderInputSemantic::EngineTime});
    active_text_glow_shader.samplers.push_back(ShaderSamplerDeclaration{.name = "s_textAtlas"});

    MaterialDefinition active_text_material;
    active_text_material.id = MaterialId("demo/active_text_default");
    active_text_material.role = ShaderRole::ActiveText;
    active_text_material.shader = active_text_shader.id;
    active_text_material.display_name = "Demo ActiveText Default Material";

    MaterialDefinition active_text_glow_material;
    active_text_glow_material.id = MaterialId("demo/active_text_glow");
    active_text_glow_material.role = ShaderRole::ActiveText;
    active_text_glow_material.shader = active_text_glow_shader.id;
    active_text_glow_material.display_name = "Demo ActiveText Glow Material";

    ShaderMaterialProject project;
    project.shaders.push_back(std::move(shader));
    project.shaders.push_back(std::move(postprocess_shader));
    project.shaders.push_back(std::move(rmlui_noise_shader));
    project.shaders.push_back(std::move(active_text_shader));
    project.shaders.push_back(std::move(active_text_glow_shader));
    project.materials.push_back(std::move(material));
    project.materials.push_back(std::move(world_postprocess_material));
    project.materials.push_back(std::move(full_game_postprocess_material));
    project.materials.push_back(std::move(rmlui_material));
    project.materials.push_back(std::move(active_text_material));
    project.materials.push_back(std::move(active_text_glow_material));
    return project;
}

std::filesystem::path default_system_asset_root()
{
#if defined(NOVELTEA_PLATFORM_DESKTOP)
    if (const char* base = SDL_GetBasePath()) {
        std::filesystem::path packaged = std::filesystem::path(base) / "assets";
        std::error_code error;
        if (std::filesystem::exists(packaged / "system", error) && !error) {
            return packaged / "system";
        }
    }
    return NOVELTEA_DEFAULT_RUNTIME_ASSET_ROOT;
#elif defined(NOVELTEA_PLATFORM_WEB)
    return "/assets/system";
#else
    return {};
#endif
}

std::filesystem::path default_project_asset_root()
{
#if defined(NOVELTEA_PLATFORM_DESKTOP)
    if (const char* base = SDL_GetBasePath()) {
        std::filesystem::path packaged = std::filesystem::path(base) / "assets";
        std::error_code error;
        if (std::filesystem::exists(packaged / "project", error) && !error) {
            return packaged / "project";
        }
    }
#if defined(NOVELTEA_DEFAULT_PROJECT_ASSET_ROOT)
    return NOVELTEA_DEFAULT_PROJECT_ASSET_ROOT;
#else
    return NOVELTEA_DEFAULT_RUNTIME_ASSET_ROOT;
#endif
#elif defined(NOVELTEA_PLATFORM_WEB)
    return "/assets/project";
#else
    return {};
#endif
}

#if !defined(NOVELTEA_PLATFORM_DESKTOP)
std::filesystem::path sdl_pref_path()
{
    char* pref = SDL_GetPrefPath("Cruel", "NovelTea");
    if (!pref) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[assets] SDL_GetPrefPath failed: %s",
                     SDL_GetError());
        return {};
    }
    std::filesystem::path result(pref);
    SDL_free(pref);
    return result;
}
#endif

std::filesystem::path default_cache_asset_root()
{
#if defined(NOVELTEA_PLATFORM_DESKTOP)
    return NOVELTEA_DEFAULT_CACHE_ASSET_ROOT;
#else
    return sdl_pref_path() / "cache";
#endif
}

void mount_default_source(assets::AssetManager& assets, const char* ns,
                          const std::filesystem::path& override_root,
                          const std::filesystem::path& default_root, bool writable)
{
#if defined(NOVELTEA_PLATFORM_ANDROID)
    if (!override_root.empty()) {
        assets.mount_directory(ns, override_root, writable);
    } else if (writable) {
        assets.mount_directory(ns, default_root, true);
    } else {
        assets.mount(ns, std::make_shared<assets::SdlPackagedAssetSource>(ns));
    }
#else
    assets.mount_directory(ns, override_root.empty() ? default_root : override_root, writable);
#endif
}

} // namespace

bool Engine::Impl::load_project_shader_materials()
{
    if (!m_assets.exists("project:/shader-materials.json")) {
        return true;
    }

    auto metadata = m_assets.read_text("project:/shader-materials.json");
    if (!metadata) {
        std::fprintf(stderr, "[engine] failed to read project shader-materials.json: %s\n",
                     metadata.error.message.c_str());
        return false;
    }

    auto parsed = parse_shader_material_project_json(*metadata.value);
    for (const auto& diagnostic : parsed.diagnostics) {
        std::fprintf(stderr, "[engine] shader material diagnostic: %s: %s\n",
                     diagnostic.path.c_str(), diagnostic.message.c_str());
    }
    if (!parsed.project || parsed.has_errors()) {
        std::fprintf(stderr, "[engine] project shader-materials.json failed validation\n");
        return false;
    }

    m_shader_materials = std::move(*parsed.project);
    m_renderer.set_shader_material_project(&m_shader_materials);
    SDL_Log("[engine] loaded project shader-materials.json");
    return true;
}

core::Result<void, core::Diagnostics> Engine::Impl::apply_authored_preview_environment(
    const core::editor::TypedEditorAuthoredPreviewEnvironment& environment)
{
    auto display = environment.project_display;
    display.reference_resolution = environment.native_resolution;
    const auto candidate_settings = presentation_settings_from(display);
    auto candidate_presentation =
        make_presentation_metrics(m_platform.surface(), candidate_settings);
    if (!candidate_presentation) {
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "preview.authored_environment.presentation_invalid",
              .message = candidate_presentation.error(),
              .source_path = "/environment/profile/nativeResolution"}});
    }

    const auto current_user_settings = m_authored_preview_baseline
                                           ? m_authored_preview_baseline->user_settings
                                           : m_game_host.runtime_user_settings();
    auto candidate_user_settings = core::RuntimeUserSettings::load(
        current_user_settings.ui_scale(), current_user_settings.text_scale(),
        environment.accessibility);
    if (!candidate_user_settings)
        return core::Result<void, core::Diagnostics>::failure(
            std::move(candidate_user_settings).error());

    auto reconfigured = m_runtime_ui.reconfigure_environment(*candidate_presentation.value_if(),
                                                             *candidate_user_settings.value_if());
    if (!reconfigured)
        return reconfigured;

    if (!m_authored_preview_baseline) {
        m_authored_preview_baseline = AuthoredPreviewBaseline{
            .presentation_settings = m_presentation_settings,
            .user_settings = m_game_host.runtime_user_settings(),
        };
    }
    m_presentation_settings = candidate_settings;
    m_presentation = std::move(*candidate_presentation.value_if());
    m_renderer.resize(m_presentation);
    m_renderer.set_bar_color(m_presentation_settings.bar_color_rgba);
    m_game_host.set_runtime_user_settings(*candidate_user_settings.value_if());
    m_authored_preview_environment = environment;
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> Engine::Impl::clear_authored_preview_environment()
{
    if (!m_authored_preview_baseline) {
        m_authored_preview_environment.reset();
        return core::Result<void, core::Diagnostics>::success();
    }

    auto candidate_presentation = make_presentation_metrics(
        m_platform.surface(), m_authored_preview_baseline->presentation_settings);
    if (!candidate_presentation) {
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "preview.authored_environment.restore_presentation_invalid",
              .message = candidate_presentation.error(),
              .source_path = "/environment"}});
    }

    auto reconfigured = m_runtime_ui.reconfigure_environment(
        *candidate_presentation.value_if(), m_authored_preview_baseline->user_settings);
    if (!reconfigured)
        return reconfigured;

    m_presentation_settings = m_authored_preview_baseline->presentation_settings;
    m_presentation = std::move(*candidate_presentation.value_if());
    m_renderer.resize(m_presentation);
    m_renderer.set_bar_color(m_presentation_settings.bar_color_rgba);
    m_game_host.set_runtime_user_settings(m_authored_preview_baseline->user_settings);
    m_authored_preview_baseline.reset();
    m_authored_preview_environment.reset();
    return core::Result<void, core::Diagnostics>::success();
}

void Engine::Impl::configure_assets(const EngineConfig& engine_config)
{
    m_runtime_package_source = engine_config.runtime_package_source;
    m_runtime_package_logical_path = engine_config.compiled_project;
    const auto system_root = engine_config.system_asset_root.empty()
                                 ? default_system_asset_root()
                                 : engine_config.system_asset_root;
    const auto project_root = engine_config.project_asset_root.empty()
                                  ? default_project_asset_root()
                                  : engine_config.project_asset_root;
    const auto cache_root = engine_config.cache_asset_root.empty() ? default_cache_asset_root()
                                                                   : engine_config.cache_asset_root;

    mount_default_source(m_assets, "system", engine_config.system_asset_root, system_root, false);
    mount_default_source(m_assets, "project", engine_config.project_asset_root, project_root,
                         false);
    m_assets.mount_directory("cache", cache_root, true);

    for (const auto& mount : m_assets.describe_mounts()) {
        SDL_Log("[assets] %s", mount.c_str());
    }

#if defined(NOVELTEA_PLATFORM_ANDROID)
    auto smoke = m_assets.read_binary("system:/shaders/bgfx/essl-300/triangle.vs.bin");
    if (smoke) {
        SDL_Log(
            "[assets] Android smoke read system:/shaders/bgfx/essl-300/triangle.vs.bin: %zu bytes",
            smoke.value->bytes.size());
    } else {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[assets] Android smoke read failed [%s]: %s",
                     smoke.error.code.c_str(), smoke.error.message.c_str());
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                     "[assets] continuing without Android shader smoke asset");
    }
#endif
}

bool Engine::Impl::load_compiled_project(const std::string& logical_path, bool load_title_screen,
                                         bool stop_runtime_after_load)
{
    // Detach the previous session's gate while the candidate is prepared. The candidate gate is
    // rebound inside the commit hook before GameHost activates the candidate presentation port, so
    // its initial snapshot cannot reach production backends before mandatory leases are ready.
    m_game_host.runtime_presentation().bind_mandatory_asset_gate(nullptr);
    service_loading_frame_jobs();
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    const auto source_generation_before_load = m_assets.source_generation_on_owner();
    bool profiler_rotated_for_restore = false;
#endif

    struct PreparedResources {
        ShaderMaterialProject shader_materials;
        PresentationSettings presentation_settings;
        assets::FontAssetConfig fonts;
    };
    const auto prepare_resources = [](const runtime::RunningGame& game) {
        PreparedResources prepared;
        const auto& project = game.package().project();
        prepared.shader_materials =
            game.package().shader_materials().value_or(ShaderMaterialProject{});
        const auto& display = project.settings().display;
        prepared.presentation_settings = presentation_settings_from(display);
        if (project.settings().text.default_font) {
            if (const auto* font = project.find_asset(*project.settings().text.default_font)) {
                prepared.fonts.default_alias = font->id.text();
                prepared.fonts.families.push_back(assets::FontFamilyAssetDesc{
                    .alias = font->id.text(),
                    .regular = FontDesc{.asset_path = "project:/" + font->path},
                    .bold = std::nullopt,
                    .italic = std::nullopt,
                    .bold_italic = std::nullopt,
                    .synthetic_styles = true});
            }
        }
        return prepared;
    };
    const auto apply_resources = [this](const runtime::RunningGame& game,
                                        PreparedResources prepared,
                                        host::HostGeneration generation) {
        const auto& project = game.package().project();
        m_authored_preview_baseline.reset();
        m_authored_preview_environment.reset();
        m_layout_realizer.clear_authored_preview();
        m_shader_materials = std::move(prepared.shader_materials);
        m_renderer.set_shader_material_project(&m_shader_materials);
        m_world_presentation_resources.bind_project(project);
        m_presentation_settings = prepared.presentation_settings;
        auto presentation =
            make_presentation_metrics(m_platform.surface(), m_presentation_settings);
        if (!presentation) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[presentation] %s",
                         presentation.error().c_str());
            return;
        }
        m_presentation = std::move(*presentation.value_if());
        m_renderer.resize(m_presentation);
        m_runtime_ui.resize(m_presentation);
        const auto current_settings = m_game_host.runtime_user_settings();
        auto effective_settings = core::RuntimeUserSettings::load(current_settings.ui_scale(),
                                                                  current_settings.text_scale(),
                                                                  project.settings().accessibility);
        if (!effective_settings) {
            for (const auto& diagnostic : effective_settings.error())
                SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[runtime-settings] %s: %s",
                             diagnostic.code.c_str(), diagnostic.message.c_str());
        } else {
            auto reconfigured =
                m_runtime_ui.reconfigure_user_settings(*effective_settings.value_if());
            if (!reconfigured) {
                for (const auto& diagnostic : reconfigured.error())
                    SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[runtime-settings] %s: %s",
                                 diagnostic.code.c_str(), diagnostic.message.c_str());
            } else {
                m_game_host.set_runtime_user_settings(*effective_settings.value_if());
            }
        }
        m_renderer.set_bar_color(m_presentation_settings.bar_color_rgba);
        m_assets.configure_fonts(std::move(prepared.fonts));
        m_mandatory_assets.bind_package_on_owner(game.package(), m_renderer.active_shader_variant(),
                                                 m_assets.source_generation_on_owner());
        auto bound = m_layout_realizer.bind_session(project, generation);
        if (!bound) {
            for (const auto& diagnostic : bound.error())
                SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[layout-realizer] %s: %s",
                             diagnostic.code.c_str(), diagnostic.message.c_str());
        } else {
            m_presentation_layouts.bind_project(project);
        }
        m_game_host.runtime_presentation().bind_snapshot_backend(
            [this](const core::RuntimePresentationSnapshot& snapshot) {
                const auto previous_revision = m_presentation_layouts.current_revision();
                auto world = m_world_presentation.reconcile(
                    snapshot, {static_cast<float>(m_renderer.reference_width()),
                               static_cast<float>(m_renderer.reference_height())});
                if (!world)
                    return core::Result<void, core::Diagnostics>::failure(std::move(world).error());

                auto layouts = m_presentation_layouts.reconcile(snapshot);
                if (layouts)
                    return layouts;

                m_world_presentation.discard_revision(snapshot.revision);
                if (previous_revision) {
                    (void)m_world_presentation.restore_revision(*previous_revision);
                } else {
                    m_world_presentation.reset();
                }
                return layouts;
            });
    };

    std::optional<PreparedResources> prepared_resources;
    std::optional<PreparedResources> previous_resources;
    if (m_game_host.running_game())
        previous_resources = prepare_resources(*m_game_host.running_game());

    host::GameHostLoadHooks hooks;
    hooks.prepare_candidate =
        [this, &prepare_resources, &prepared_resources](
            const runtime::RunningGame& candidate, const runtime::RuntimePublication& publication,
            const assets::AssetManager& candidate_assets) -> core::Result<void, core::Diagnostics> {
        const auto& project = candidate.package().project();
        core::Diagnostics diagnostics;
        for (const auto& mounted : publication.presentation.layouts) {
            if (!project.find_layout(mounted.layout)) {
                diagnostics.push_back({.code = "host.game_load_presentation_layout_missing",
                                       .message = "Initial publication references missing Layout " +
                                                  mounted.layout.text()});
            }
        }
        if (publication.presentation.map && publication.presentation.map->layout &&
            !project.find_layout(*publication.presentation.map->layout)) {
            diagnostics.push_back(
                {.code = "host.game_load_map_layout_missing",
                 .message = "Initial map presentation references missing Layout " +
                            publication.presentation.map->layout->text()});
        }
        auto validated_layouts = m_layout_realizer.validate_project(project, candidate_assets);
        if (!validated_layouts)
            core::append_diagnostics(diagnostics, std::move(validated_layouts).error());
        const auto candidate_presentation = make_presentation_metrics(
            m_platform.surface(), presentation_settings_from(project.settings().display));
        if (!candidate_presentation) {
            diagnostics.push_back({.code = "host.game_load_presentation_metrics_invalid",
                                   .message = candidate_presentation.error(),
                                   .source_path = "project.settings.display.reference_resolution"});
        }
        if (!diagnostics.empty())
            return core::Result<void, core::Diagnostics>::failure(std::move(diagnostics));

        prepared_resources = prepare_resources(candidate);
        return core::Result<void, core::Diagnostics>::success();
    };
    const auto detach_resources = [this]() {
        m_game_host.runtime_presentation().bind_snapshot_backend({});
        m_game_host.runtime_presentation().bind_presentation_id_allocator({});
        m_mandatory_assets.clear_package_on_owner();
        m_world_presentation.reset();
        m_world_presentation_resources.clear();
        m_presentation_layouts.clear_session();
        m_layout_realizer.clear_session();
    };
    hooks.detach_current_resources = detach_resources;
    hooks.commit_candidate_resources = [this, &apply_resources,
                                        &prepared_resources](const runtime::RunningGame& candidate,
                                                             const runtime::RuntimePublication&) {
        if (!prepared_resources)
            return;
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
        if (m_editor_asset_profiler)
            m_editor_asset_profiler->rotate_session_on_owner();
#endif
        const auto generation =
            m_game_host.session_generation().next().value_or(m_game_host.session_generation());
        apply_resources(candidate, std::move(*prepared_resources), host_generation(generation));
        m_game_host.runtime_presentation().bind_mandatory_asset_gate(&m_mandatory_assets);
    };
    hooks.restore_previous_resources = [this, &apply_resources, &detach_resources,
                                        &previous_resources
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
                                        ,
                                        &profiler_rotated_for_restore
#endif
    ](const runtime::RunningGame& previous) {
        detach_resources();
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
        if (m_editor_asset_profiler) {
            m_editor_asset_profiler->rotate_session_on_owner();
            profiler_rotated_for_restore = true;
        }
#endif
        if (previous_resources) {
            apply_resources(previous, std::move(*previous_resources),
                            host_generation(m_game_host.session_generation()));
            m_game_host.runtime_presentation().bind_mandatory_asset_gate(&m_mandatory_assets);
        }
    };

    host::GameHostLoadRequest load_request{.logical_path = logical_path,
                                           .runtime_locale = "en",
                                           .load_title_screen = load_title_screen,
                                           .stop_runtime_after_load = stop_runtime_after_load};
    auto loaded = logical_path == m_runtime_package_logical_path && m_runtime_package_source
                      ? m_game_host.load_compiled_project(std::move(load_request),
                                                          m_runtime_package_source, hooks)
                      : m_game_host.load_compiled_project(std::move(load_request), hooks);
    if (!loaded) {
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
        if (m_editor_asset_profiler && !profiler_rotated_for_restore &&
            m_assets.source_generation_on_owner() != source_generation_before_load) {
            // A first-project candidate can fail after replacing the live namespace without a
            // previous RunningGame to drive restore_previous_resources. Detach its resources and
            // establish a clean restored-generation profiler session here.
            detach_resources();
            m_editor_asset_profiler->rotate_session_on_owner();
        }
#endif
        if (m_game_host.running_game())
            m_game_host.runtime_presentation().bind_mandatory_asset_gate(&m_mandatory_assets);
        for (const auto& diagnostic : loaded.error()) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[runtime] %s %s %s",
                         diagnostic.code.c_str(), diagnostic.source_path.c_str(),
                         diagnostic.message.c_str());
            emit_preview_diagnostic(diagnostic);
        }
        service_loading_frame_jobs();
        return false;
    }
    m_game_host.runtime_presentation().bind_mandatory_asset_gate(&m_mandatory_assets);
    service_loading_frame_jobs();
    SDL_Log("[engine] loaded compiled project: %s", logical_path.c_str());
    return true;
}

core::Result<core::MountedLayoutInstanceId, core::Diagnostics>
Engine::Impl::mount_system_layout(core::compiled::SystemLayoutRole role,
                                  core::MountedLayoutPolicy policy)
{
    const auto* running_game = m_game_host.running_game();
    if (!running_game)
        return core::Result<core::MountedLayoutInstanceId, core::Diagnostics>::failure(
            {{.code = "runtime_shell.runtime_unavailable",
              .message = "System Layout mounting requires a running game"}});

    const auto& project = running_game->package().project();
    const auto configured = std::find_if(project.settings().system_layouts.begin(),
                                         project.settings().system_layouts.end(),
                                         [&](const auto& entry) { return entry.role == role; });
    const std::optional<core::LayoutId> authored =
        configured != project.settings().system_layouts.end() ? configured->layout : std::nullopt;

    RuntimeLayoutMountRequest request;
    request.layout_id = std::string("system-") + system_layout_role_key(role);
    request.owner = role == core::compiled::SystemLayoutRole::GameHud
                        ? core::MountedLayoutOwner::Gameplay
                        : core::MountedLayoutOwner::Shell;
    request.policy = policy;
    request.composition_group = role == core::compiled::SystemLayoutRole::GameHud
                                    ? core::PresentationCompositionGroup::Interface
                                    : core::PresentationCompositionGroup::Shell;
    if (m_game_host.runtime_publication())
        request.publication_revision = m_game_host.runtime_publication()->presentation.revision;

    if (authored) {
        request.layout_id = authored->text();
        request.source = RuntimeLayoutProjectSource{};
    } else {
        const auto builtin = system_layout_builtin(role);
        if (!builtin)
            return core::Result<core::MountedLayoutInstanceId, core::Diagnostics>::failure(
                {{.code = "runtime_shell.system_layout_unconfigured",
                  .message = "System Layout role has no authored Layout or built-in fallback: " +
                             std::string(system_layout_role_key(role))}});
        request.source = RuntimeLayoutBuiltinSource{*builtin};
    }
    return m_game_host.runtime_layouts().mount(std::move(request));
}

core::Result<void, core::Diagnostics>
Engine::Impl::set_system_layout_visible(core::MountedLayoutInstanceId instance, bool visible)
{
    auto& layouts = m_game_host.runtime_layouts();
    if (visible ? layouts.show(instance) : layouts.hide(instance))
        return core::Result<void, core::Diagnostics>::success();
    return core::Result<void, core::Diagnostics>::failure(
        {{.code = "runtime_shell.layout_visibility_failed",
          .message = "Failed to change system Layout visibility"}});
}

core::Result<void, core::Diagnostics>
Engine::Impl::unmount_system_layout(core::MountedLayoutInstanceId instance)
{
    if (m_game_host.runtime_layouts().unmount(instance))
        return core::Result<void, core::Diagnostics>::success();
    return core::Result<void, core::Diagnostics>::failure(
        {{.code = "runtime_shell.layout_unmount_failed",
          .message = "Failed to unmount system Layout"}});
}

bool Engine::Impl::dispatch_shell_runtime_input(core::RuntimeInputMessage input)
{
    return dispatch_runtime_input(input);
}

core::Result<void, core::Diagnostics> Engine::Impl::set_runtime_ui_scale(double scale)
{
    const auto* running_game = m_game_host.running_game();
    if (!running_game) {
        return core::Result<void, core::Diagnostics>::failure({{
            .code = "runtime_shell.runtime_unavailable",
            .message = "Runtime UI scale requires a loaded compiled project.",
        }});
    }
    auto settings = m_game_host.runtime_user_settings().with_ui_scale(
        scale, running_game->package().project().settings().accessibility);
    if (!settings)
        return core::Result<void, core::Diagnostics>::failure(std::move(settings).error());
    auto reconfigured = m_runtime_ui.reconfigure_user_settings(*settings.value_if());
    if (!reconfigured)
        return reconfigured;
    m_game_host.set_runtime_user_settings(*settings.value_if());
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> Engine::Impl::set_runtime_text_scale(double scale)
{
    const auto* running_game = m_game_host.running_game();
    if (!running_game) {
        return core::Result<void, core::Diagnostics>::failure({{
            .code = "runtime_shell.runtime_unavailable",
            .message = "Runtime text scale requires a loaded compiled project.",
        }});
    }
    auto settings = m_game_host.runtime_user_settings().with_text_scale(
        scale, running_game->package().project().settings().accessibility);
    if (!settings)
        return core::Result<void, core::Diagnostics>::failure(std::move(settings).error());
    auto reconfigured = m_runtime_ui.reconfigure_user_settings(*settings.value_if());
    if (!reconfigured)
        return reconfigured;
    m_game_host.set_runtime_user_settings(*settings.value_if());
    return core::Result<void, core::Diagnostics>::success();
}

core::RuntimeShellViewState Engine::Impl::build_runtime_shell_view(
    core::RuntimeShellScreen screen,
    const std::optional<core::RuntimeShellConfirmation>& confirmation, bool game_active)
{
    core::RuntimeShellViewState view;
    view.screen = screen;
    view.settings = m_game_host.runtime_user_settings();
    view.confirmation = confirmation;
    view.game_active = game_active;
    if (!m_game_host.running_game())
        return view;

    view.accessibility = m_game_host.running_game()->package().project().settings().accessibility;

    const auto& publication = m_game_host.runtime_publication();
    if (publication) {
        view.text_log = publication->gameplay_ui.text_log;
        for (auto it = publication->observations.values.rbegin();
             it != publication->observations.values.rend(); ++it) {
            if (const auto* checkpoint = std::get_if<core::CheckpointRuntimeObservation>(&*it)) {
                view.checkpoint = *checkpoint;
                break;
            }
        }
    }

    const auto append_slot = [&](core::TypedSaveSlotId slot) {
        core::RuntimeShellSaveSlotView slot_view{
            .slot = slot, .occupied = false, .metadata = std::nullopt, .thumbnail = std::nullopt};
        auto occupied = m_game_host.save_slots().has_slot(slot);
        if (occupied && *occupied.value_if()) {
            slot_view.occupied = true;
            auto checkpoint = m_game_host.save_slots().read_checkpoint(slot);
            if (checkpoint) {
                slot_view.metadata = checkpoint.value_if()->metadata;
                slot_view.thumbnail = checkpoint.value_if()->thumbnail;
            }
        }
        view.slots.push_back(std::move(slot_view));
    };
    append_slot(core::TypedSaveSlotId::autosave());
    for (std::uint32_t slot = 1; slot <= 8; ++slot)
        append_slot(core::TypedSaveSlotId::manual(slot));
    return view;
}

void Engine::Impl::publish_runtime_shell_view(core::RuntimeShellViewState view)
{
    m_runtime_ui.apply_runtime_shell_view(std::move(view));
}

void Engine::Impl::request_shell_quit() { m_platform.request_quit(); }

bool Engine::Impl::initialize(const PlatformConfig& config, const EngineConfig& engine_config,
                              const EngineToolingConfig& tooling_config)
{
    SDL_Log("[engine] initializing...");
    if (m_job_execution.startup_failure) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[jobs] %s: %s",
                     m_job_execution.startup_failure->code.c_str(),
                     m_job_execution.startup_failure->message.c_str());
        return false;
    }
    m_runtime_clock.reset();
    m_game_host_values.frame_clock = {};
    (void)m_game_host.resume_host();
    m_frame_limit = tooling_config.frame_limit;
    m_fixed_delta_seconds = tooling_config.fixed_delta_seconds;
    m_fps_cap = sanitize_fps_cap(tooling_config.fps_cap);
    m_next_frame_counter = 0;
    m_audio_enabled = engine_config.enable_audio;
    m_debug_ui_enabled = tooling_config.enable_debug_ui;
    m_render_perf_logging = tooling_config.render_perf_logging;
    m_preview_widget = tooling_config.preview_widget;
    m_show_fps_counter = tooling_config.show_fps_counter;
    m_fps_sample_frames = 0;
    m_fps_sample_start_counter = 0;
    m_pending_debug_ui_commands.clear();
    m_checkpoint_thumbnail_captures.reset();
    bool platform_initialized = false;
    bool renderer_initialized = false;
    bool audio_bound = false;
    bool scripts_initialized = false;
    bool runtime_ui_initialized = false;
    bool debug_ui_initialized = false;

    auto rollback = [&]() {
        m_game_host.shutdown();
        if (debug_ui_initialized) {
            m_debug_ui.shutdown();
            debug_ui_initialized = false;
        }
        if (runtime_ui_initialized) {
            m_game_host.runtime_layouts().bind_document_host(nullptr);
            m_runtime_ui.shutdown();
            runtime_ui_initialized = false;
        }
        if (scripts_initialized) {
            m_scripts.shutdown();
            scripts_initialized = false;
        }
        if (audio_bound) {
            m_preview_host.stop_all_preview_audio();
            m_assets.bind_audio_loader(nullptr);
            m_audio.shutdown();
            audio_bound = false;
        }
        if (renderer_initialized) {
            m_renderer.shutdown();
            renderer_initialized = false;
        }
        if (platform_initialized) {
            m_platform.shutdown();
            platform_initialized = false;
        }
        m_running = false;
        m_initialized = false;
        m_pending_debug_ui_commands.clear();
        std::printf("[engine] initialization rollback complete\n");
    };

    if (!m_platform.initialize(config)) {
        std::fprintf(stderr, "[engine] platform init failed\n");
        return false;
    }
    platform_initialized = true;

    configure_assets(engine_config);

    auto memory_policy = engine_config.asset_memory_policy;
    if (!memory_policy) {
        auto resolved = assets::resolve_asset_memory_policy(runtime_asset_memory_target(),
                                                            assets::AssetMemoryPreset::Balanced);
        if (!resolved) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                         "[assets] failed to resolve the default memory policy");
            rollback();
            return false;
        }
        memory_policy = std::move(*resolved.value_if());
    }
    core::AssetTelemetrySink* asset_telemetry = nullptr;
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    m_editor_asset_profiler = core::make_editor_asset_profiler_service(m_preview_widget);
    asset_telemetry = m_editor_asset_profiler.get();
#endif
    m_asset_residency = std::make_shared<assets::AssetResidencyManager>(
        *memory_policy, asset_telemetry, m_job_execution.executor->mode());
    auto async_assets = m_assets.configure_async_requests(*m_job_execution.executor,
                                                          m_asset_residency, asset_telemetry);
    if (!async_assets) {
        const auto& diagnostic = async_assets.error();
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[assets] %s: %s", diagnostic.code.c_str(),
                     diagnostic.message.c_str());
        rollback();
        return false;
    }
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    if (m_editor_asset_profiler != nullptr) {
        m_editor_asset_profiler->set_inventory_provider(m_assets);
        m_editor_asset_profiler->set_memory_provider(m_assets, *memory_policy);
    }
#endif
    const auto& budget = memory_policy->budget;
    SDL_Log("[assets] memory policy target=%s preset=%s source=%llu prepared_cpu=%llu gpu=%llu "
            "audio=%llu temporary=%llu prefetch=%u%%",
            assets::asset_memory_target_name(memory_policy->target),
            assets::asset_memory_preset_name(memory_policy->preset),
            static_cast<unsigned long long>(budget.source_bytes),
            static_cast<unsigned long long>(budget.prepared_cpu_bytes),
            static_cast<unsigned long long>(budget.gpu_bytes),
            static_cast<unsigned long long>(budget.audio_bytes),
            static_cast<unsigned long long>(budget.temporary_bytes),
            budget.prefetch_allowance_percent);

    const NativeWindowHandles handles = m_platform.native_window_handles();
    auto initial_presentation =
        make_presentation_metrics(m_platform.surface(), m_presentation_settings);
    if (!initial_presentation) {
        std::fprintf(stderr, "[engine] presentation metrics failed: %s\n",
                     initial_presentation.error().c_str());
        rollback();
        return false;
    }
    m_presentation = std::move(*initial_presentation.value_if());

    RendererConfig rcfg;
    rcfg.native_display = handles.display;
    rcfg.native_window = handles.window;
    rcfg.presentation = m_presentation;
    rcfg.bar_color_rgba = m_presentation_settings.bar_color_rgba;
    rcfg.vsync = config.vsync;
    rcfg.assets = &m_assets;

    if (!m_renderer.initialize(rcfg)) {
        std::fprintf(stderr, "[engine] renderer init failed\n");
        rollback();
        return false;
    }
    renderer_initialized = true;
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    if (m_editor_asset_profiler != nullptr) {
        m_editor_asset_profiler->set_renderer_statistics_provider(
            [] { return bgfx_backend::sample_editor_asset_profiler_renderer_memory(); });
    }
#endif

    if (auto aliases = m_assets.load_resource_aliases("project:/resources/aliases.json")) {
        std::printf("[assets] loaded resource aliases from project:/resources/aliases.json\n");
    } else {
        std::printf("[assets] resource aliases not loaded: %s\n", aliases.error.c_str());
    }

    if (m_audio_enabled) {
        auto audio_initialization = m_audio.initialize(m_assets, m_job_execution.config);
        if (!audio_initialization) {
            const auto& diagnostic = audio_initialization.error();
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[audio] %s: %s", diagnostic.code.c_str(),
                         diagnostic.message.c_str());
            emit_preview_diagnostic(diagnostic);
            m_assets.bind_audio_loader(nullptr);
            rollback();
            return false;
        }
        m_assets.bind_audio_loader(&m_audio);
        audio_bound = true;
    } else {
        std::printf("[audio] disabled by run configuration\n");
        m_assets.bind_audio_loader(nullptr);
    }
    m_shader_materials = make_demo_shader_materials();
    m_renderer.set_shader_material_project(&m_shader_materials);
    if (!load_project_shader_materials()) {
        rollback();
        return false;
    }

    {
        auto script_init = m_scripts.initialize({&m_assets});
        if (!script_init) {
            std::fprintf(stderr, "[engine] script runtime init failed: %s\n",
                         script_init.error().message.c_str());
            rollback();
            return false;
        }
        scripts_initialized = true;
    }

    m_runtime_ui.resize(m_presentation);
    if (!m_runtime_ui.initialize(&m_assets, sdl_platform::native_window(m_platform), &m_scripts,
                                 &m_shader_materials)) {
        std::fprintf(stderr, "[engine] runtime UI init failed; continuing without runtime UI\n");
    } else {
        m_game_host.runtime_layouts().bind_document_host(&m_layout_realizer);
        m_runtime_ui.bind_layout_gameplay_admission([this]() {
            return m_game_host.runtime_layouts().evaluate_input_policy().gameplay ==
                   presentation::GameplayInputDisposition::Eligible;
        });
        ui::rmlui::RuntimeUiFacadeAccess::bind_game_started_handler(m_runtime_ui, {});
        ui::rmlui::RuntimeUiFacadeAccess::set_base_direct_compatibility(
            m_runtime_ui, tooling_config.rmlui_base_direct_compat);
        if (m_render_perf_logging) {
            m_runtime_ui.enable_render_perf_logging(true);
            SDL_Log("[engine] renderer perf logging enabled");
        }
        if (!tooling_config.runtime_ui_document.empty()) {
            runtime_ui_initialized = true;
            if (ui::rmlui::RuntimeUiFacadeAccess::load_document(
                    m_runtime_ui, "runtime-acceptance", tooling_config.runtime_ui_document, true)) {
                SDL_Log("[engine] loaded RmlUi document: %s",
                        tooling_config.runtime_ui_document.c_str());
            } else {
                std::fprintf(stderr, "[engine] failed to load RmlUi document: %s\n",
                             tooling_config.runtime_ui_document.c_str());
                rollback();
                return false;
            }
        } else {
            runtime_ui_initialized = true;
        }
    }
    if (m_debug_ui_enabled) {
        SDL_Log("[engine] initializing debug UI...");
        if (!m_debug_ui.initialize(sdl_platform::native_window(m_platform), &m_assets)) {
            std::fprintf(stderr, "[engine] debug UI init failed (non-fatal)\n");
        } else {
            debug_ui_initialized = true;
            SDL_Log("[engine] debug UI initialized");
        }
    }

    m_game_host.bind_save_slots(engine_config.save_slot_store ? *engine_config.save_slot_store
                                                              : m_typed_saves);
    const std::string compiled_project = engine_config.compiled_project;
    const bool load_title_screen = engine_config.load_title_screen;
    if (!compiled_project.empty() && !load_compiled_project(compiled_project, load_title_screen,
                                                            !tooling_config.keep_runtime_running)) {
        rollback();
        return false;
    }

    m_running = true;
    m_initialized = true;
    SDL_Log("[engine] initialized (renderer: %s, logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f)",
            m_renderer.renderer_name(), m_platform.host_logical_width(),
            m_platform.host_logical_height(), m_platform.host_framebuffer_width(),
            m_platform.host_framebuffer_height(), m_platform.host_logical_to_framebuffer_scale_x(),
            m_platform.host_logical_to_framebuffer_scale_y());
    if (m_frame_limit > 0) {
        SDL_Log("[engine] frame-limited smoke run: %u frames", m_frame_limit);
    }
    std::printf("[engine] ready\n");

    return true;
}

int Engine::Impl::run()
{
    if (!m_running) {
        std::fprintf(stderr, "[engine] run() called but not initialized\n");
        return 1;
    }

    SDL_Log("[engine] entering main loop");

    while (m_running) {
        tick();
    }

    std::printf("[engine] exited main loop\n");
    return 0;
}

bool Engine::Impl::tick()
{
    if (!m_running)
        return false;

    if (m_job_shutdown_started) {
        handle_events();
        if (service_job_shutdown()) {
            m_running = false;
            return false;
        }
        return true;
    }

    if (throttle_frame_start()) {
        return true;
    }

    handle_events();
    const bool mandatory_loading = m_game_host.mandatory_assets_pending();
    if (mandatory_loading) {
        service_loading_frame_jobs();
        (void)m_assets.retry_deferred_asset_requests_on_owner();
    } else {
        service_normal_frame_jobs();
    }
    apply_pending_debug_ui_commands();
    const bool runtime_input_admitted = m_preview_running && !mandatory_loading;
    m_game_host_values.runtime_input_admitted = runtime_input_admitted;
    if (auto effective_pause = update_host_clocks(
            m_fixed_delta_seconds > 0.0 ? m_fixed_delta_seconds : m_platform.delta_time())) {
        (void)m_game_host.advance({.frame_clock = m_game_host_values.frame_clock,
                                   .effective_gameplay_pause = std::move(*effective_pause),
                                   .runtime_input_admitted = runtime_input_admitted});
        update_presentation_audio_backends(runtime_input_admitted);
    }
    realize_layouts_and_bind_ui();
    render();
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    if (m_editor_asset_profiler != nullptr)
        m_editor_asset_profiler->flush_frame_on_owner();
#endif
    finish_frame_timing_sample();

    if (m_platform.should_quit()) {
        begin_job_shutdown();
    }

    if (m_frame_limit > 0 && m_frame_count >= m_frame_limit) {
        SDL_Log("[engine] frame limit reached: %u", m_frame_count);
        begin_job_shutdown();
    }

    if (m_job_shutdown_started && service_job_shutdown()) {
        m_running = false;
        return false;
    }

    return m_running;
}

void Engine::Impl::service_normal_frame_jobs()
{
    m_job_execution.executor->pump(kNormalFrameJobBudget);
    (void)m_job_execution.executor->dispatch_owner_completions(kNormalFrameCompletionLimit);
    poll_tooling_postprocess_assets();
}

void Engine::Impl::service_loading_frame_jobs()
{
    m_job_execution.executor->pump(kLoadingFrameJobBudget);
    (void)m_job_execution.executor->dispatch_owner_completions(kLoadingFrameCompletionLimit);
    poll_tooling_postprocess_assets();
}

void Engine::Impl::poll_tooling_postprocess_assets()
{
    if (m_tooling_postprocess_assets == nullptr)
        return;

    m_tooling_postprocess_assets->poll_on_owner();
    switch (m_tooling_postprocess_assets->state_on_owner()) {
    case assets::MandatoryAssetGroupState::Pending:
        return;
    case assets::MandatoryAssetGroupState::Ready: {
        auto leases = m_tooling_postprocess_assets->take_ready_leases_on_owner();
        if (!leases) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                         "[engine] tooling postprocess material '%s' completed without leases",
                         m_tooling_postprocess_material_id.c_str());
            break;
        }
        m_assets.set_supplemental_leases_on_owner(std::move(*leases));
        m_renderer.set_postprocess_material(MaterialId(m_tooling_postprocess_material_id));
        SDL_Log("[engine] tooling postprocess material resident: %s",
                m_tooling_postprocess_material_id.c_str());
        break;
    }
    case assets::MandatoryAssetGroupState::Failed:
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                     "[engine] tooling postprocess material request failed: %s",
                     m_tooling_postprocess_material_id.c_str());
        break;
    case assets::MandatoryAssetGroupState::Canceled:
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                     "[engine] tooling postprocess material request canceled: %s",
                     m_tooling_postprocess_material_id.c_str());
        break;
    }
    m_tooling_postprocess_assets.reset();
}

void Engine::Impl::begin_job_shutdown()
{
    if (m_job_shutdown_started)
        return;
    m_job_shutdown_started = true;
    m_job_execution.executor->begin_shutdown();
}

bool Engine::Impl::service_job_shutdown()
{
    begin_job_shutdown();
    m_job_execution.executor->pump(std::chrono::nanoseconds::zero());
    (void)m_job_execution.executor->dispatch_owner_completions(
        std::numeric_limits<std::size_t>::max());
    return m_job_execution.executor->shutdown_complete();
}

bool Engine::Impl::shutdown_jobs()
{
    begin_job_shutdown();
#if defined(__EMSCRIPTEN__)
    return service_job_shutdown();
#else
    while (!service_job_shutdown())
        SDL_Delay(1);
    SDL_assert(m_job_execution.executor->shutdown_complete());
    return true;
#endif
}

bool Engine::Impl::throttle_frame_start()
{
    const uint32_t pace_cap = effective_frame_pace_cap();
    if (pace_cap == 0) {
        m_next_frame_counter = 0;
        return false;
    }

    const uint64_t frequency = SDL_GetPerformanceFrequency();
    if (frequency == 0) {
        return false;
    }

    if (m_next_frame_counter == 0) {
        m_next_frame_counter = SDL_GetPerformanceCounter();
        return false;
    }

    const uint64_t now = SDL_GetPerformanceCounter();
    const uint64_t frame_interval = std::max<uint64_t>(1u, frequency / pace_cap);
    const uint64_t slack =
        std::max<uint64_t>(1u, std::min<uint64_t>(frequency / 1000u, frame_interval / 4u));
    if (now >= m_next_frame_counter || m_next_frame_counter - now <= slack) {
        return false;
    }

#if defined(__EMSCRIPTEN__)
    // The browser owns the actual main-loop cadence. Skip update/render callbacks until the
    // next frame boundary instead of blocking the event loop. Editor preview widgets also use
    // this path for display pacing when no explicit engine FPS cap is set, since split preview
    // iframes can otherwise multiply RAF callbacks in the shared renderer process.
    return true;
#else
    const uint64_t remaining = m_next_frame_counter - now;
    const uint64_t milliseconds = remaining * 1000u / frequency;
    if (milliseconds > 0) {
        SDL_Delay(static_cast<Uint32>(std::min<uint64_t>(milliseconds, 1000u)));
    }
    return false;
#endif
}

uint32_t Engine::Impl::effective_frame_pace_cap() const
{
    if (m_fps_cap > 0) {
        return m_fps_cap;
    }
#if defined(__EMSCRIPTEN__)
    if (m_preview_widget) {
        return kPreviewDisplayPaceCap;
    }
#endif
    return 0;
}

void Engine::Impl::finish_frame_timing_sample()
{
    if (const uint32_t pace_cap = effective_frame_pace_cap(); pace_cap > 0) {
        const uint64_t frequency = SDL_GetPerformanceFrequency();
        const uint64_t now = SDL_GetPerformanceCounter();
        if (frequency > 0) {
            const uint64_t frame_interval = std::max<uint64_t>(1u, frequency / pace_cap);
            if (m_next_frame_counter == 0 || now > m_next_frame_counter + frame_interval * 4u) {
                m_next_frame_counter = now + frame_interval;
            } else {
                m_next_frame_counter += frame_interval;
            }
        }
    }

    if (!m_show_fps_counter) {
        return;
    }

    const uint64_t frequency = SDL_GetPerformanceFrequency();
    const uint64_t now = SDL_GetPerformanceCounter();
    if (frequency == 0) {
        return;
    }
    if (m_fps_sample_start_counter == 0) {
        m_fps_sample_start_counter = now;
        m_fps_sample_frames = 0;
    }

    ++m_fps_sample_frames;
    const double elapsed_seconds =
        static_cast<double>(now - m_fps_sample_start_counter) / static_cast<double>(frequency);
    if (elapsed_seconds < 0.25) {
        return;
    }

    const float fps =
        static_cast<float>(static_cast<double>(m_fps_sample_frames) / elapsed_seconds);
    const float frame_time_ms = fps > 0.0f ? 1000.0f / fps : 0.0f;
    preview_bridge::emit_fps(fps, frame_time_ms, static_cast<int>(m_fps_cap));
    m_fps_sample_frames = 0;
    m_fps_sample_start_counter = now;
}

void Engine::Impl::resize(const HostSurfaceMetrics& surface) { resize_host(surface); }

void Engine::Impl::resize_host(const HostSurfaceMetrics& surface)
{
    const HostSurfaceMetrics sanitized = sanitize_host_surface_metrics(surface);
    const HostSurfaceMetrics previous = m_presentation.host;
    if (previous == sanitized) {
        return;
    }

    // Host resize is presentation-only. The Web DPR bridge must not replace the RunningGame,
    // advance runtime generations, or reset script-owned state while committing new raster metrics.
    auto* const running_game_before_resize = m_game_host.running_game();
    const auto session_generation_before_resize = m_game_host.session_generation();
    const auto backend_generation_before_resize = m_game_host.backend_generation();
    const auto lifecycle_before_resize = m_game_host.lifecycle_state();

    m_platform.set_surface_metrics(sanitized);
    auto presentation = make_presentation_metrics(sanitized, m_presentation_settings);
    if (!presentation) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[presentation] resize rejected: %s",
                     presentation.error().c_str());
        return;
    }
    m_presentation = std::move(*presentation.value_if());
    m_renderer.resize(m_presentation);
    m_runtime_ui.resize(m_presentation);
    auto resized = m_world_presentation.resize({static_cast<float>(m_renderer.reference_width()),
                                                static_cast<float>(m_renderer.reference_height())});
    if (!resized) {
        auto diagnostics = std::move(resized).error();
        if (!diagnostics.empty())
            m_world_transitions.fail_active(diagnostics.front());
        append_runtime_diagnostics(std::move(diagnostics));
    }
    SDL_assert(m_game_host.running_game() == running_game_before_resize);
    SDL_assert(m_game_host.session_generation() == session_generation_before_resize);
    SDL_assert(m_game_host.backend_generation() == backend_generation_before_resize);
    SDL_assert(m_game_host.lifecycle_state() == lifecycle_before_resize);
    SDL_Log("[presentation] %s", format_presentation_metrics(m_presentation).c_str());
}

void Engine::Impl::handle_events()
{
    m_platform.poll_events();

    for (const SDL_Event& event : sdl_platform::events(m_platform)) {
        if (m_game_host.mandatory_assets_failed() && event.type == SDL_EVENT_KEY_DOWN &&
            !event.key.repeat &&
            (event.key.key == SDLK_R || event.key.key == SDLK_RETURN ||
             event.key.key == SDLK_KP_ENTER)) {
            (void)m_game_host.runtime_presentation().retry_mandatory_assets();
            continue;
        }
        const auto layout_input = m_game_host.runtime_layouts().evaluate_input_policy();
        const auto normalized = host::normalize_host_event(event, m_platform.surface());
        auto routed = m_input_router.route(
            normalized,
            {.presentation = &m_presentation,
             .layout_admission = layout_input,
             .effective_pause = current_effective_gameplay_pause(),
             .escape_dismissal = m_game_host.runtime_layouts().escape_dismissal_target(),
             .mode = m_preview_widget ? host::HostInputMode::Preview : host::HostInputMode::Runtime,
             .preview_visible = m_preview_running,
             .devtools_enabled = m_debug_ui_enabled},
            {.debug =
                 [this, &event] {
                     return host::DebugInputResult{
                         .consumed =
                             m_debug_ui.process_event(event, m_platform.surface()).consumed};
                 },
             .runtime_ui =
                 [this, &event] {
                     auto processed = m_runtime_ui.process_event(event);
                     return host::RuntimeUiInputResult{
                         .consumed = processed.consumed,
                         .wants_pointer = processed.wants_pointer,
                         .wants_keyboard = processed.wants_keyboard,
                         .runtime_inputs = std::move(processed.runtime_inputs),
                         .shell_commands = std::move(processed.shell_commands)};
                 }});

        for (const auto& action : routed.lifecycle_actions) {
            std::visit(
                [this](const auto& value) {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T, host::RequestQuitHostAction>) {
                        m_platform.request_quit();
                    } else if constexpr (std::is_same_v<T, host::SuspendHostAction>) {
                        if (m_game_host.suspend_host())
                            m_audio.pause();
                    } else if constexpr (std::is_same_v<T, host::ResumeHostAction>) {
                        if (m_game_host.resume_host())
                            m_audio.resume();
                    } else if constexpr (std::is_same_v<T, host::RefreshHostSurfaceAction>) {
                        m_platform.refresh_surface_metrics();
                        resize(m_platform.surface());
                    }
                },
                action);
        }

        if (routed.pointer_update) {
            m_pointer_position = routed.pointer_update->reference_position;
            m_pointer_valid = routed.pointer_update->valid;
        }

        bool escape_handled = false;
        for (const auto& action : routed.tooling_actions) {
            std::visit(
                [this, &escape_handled](const auto& value) {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T, host::RouteSystemEscapeAction>) {
                        if (!escape_handled)
                            escape_handled = m_game_host.system_layouts().handle_escape();
                    } else if constexpr (std::is_same_v<T, host::DismissLayoutEscapeAction>) {
                        if (!escape_handled) {
                            escape_handled = m_game_host.runtime_layouts().dismiss_escape_target(
                                value.dismissal);
                        }
                    } else if constexpr (std::is_same_v<T, host::RequestQuitFallbackAction>) {
                        if (!escape_handled && value.admitted) {
                            m_platform.request_quit();
                            escape_handled = true;
                        }
                    } else if constexpr (std::is_same_v<T,
                                                        host::RuntimeShellCommandToolingAction>) {
                        (void)m_game_host.submit_runtime_ui_shell_command(value.command);
                    }
                },
                action);
        }

        for (const auto& input : routed.runtime_inputs) {
            if (!dispatch_runtime_input(input)) {
                routed.diagnostics.push_back(
                    {.code = "host.input.runtime_rejected",
                     .message = "The runtime rejected a typed input emitted by HostInputRouter"});
            }
        }
        if (!routed.diagnostics.empty()) {
            m_game_host.report_runtime_diagnostics(host::HostFrameStage::RouteInput,
                                                   std::move(routed.diagnostics));
        }
    }
}

std::optional<core::EffectiveGameplayPause>
Engine::Impl::update_host_clocks(double host_delta_seconds)
{
    auto& frame_clock = m_game_host_values.frame_clock;
    auto effective_pause = current_effective_gameplay_pause();
    const auto advanced = m_runtime_clock.advance(host_delta_seconds, effective_pause.paused,
                                                  m_game_host_values.host_suspended);
    if (!advanced) {
        std::fprintf(stderr, "[engine] runtime clock failed: %s\n",
                     advanced.error().message.c_str());
        frame_clock = m_runtime_clock.current();
        frame_clock.sanitized_host_delta = std::chrono::microseconds{0};
        frame_clock.unscaled_presentation_delta = std::chrono::microseconds{0};
        frame_clock.gameplay_delta = std::chrono::microseconds{0};
        frame_clock.host_delta_clamped = false;
        return std::nullopt;
    }
    frame_clock = *advanced.value_if();
    return effective_pause;
}

core::EffectiveGameplayPause Engine::Impl::current_effective_gameplay_pause() const
{
    const auto& runtime_layouts = m_game_host.runtime_layouts();
    std::vector<core::MountedLayoutInstance> mounted_layouts;
    mounted_layouts.reserve(runtime_layouts.mounted_layouts().size());
    for (const auto& mounted : runtime_layouts.mounted_layouts())
        mounted_layouts.push_back(mounted.mounted);
    const auto* running_game = m_game_host.running_game();
    const bool explicit_pause = running_game && running_game->session().explicit_gameplay_paused();
    return core::derive_effective_gameplay_pause(
        explicit_pause, mounted_layouts, m_game_host_values.host_suspended, !m_preview_running);
}

void Engine::Impl::update_presentation_audio_backends(bool runtime_input_admitted)
{
    const auto& clocks = m_game_host_values.frame_clock;
    m_world_transitions.advance(clocks);
    (void)m_game_host.flush_runtime_presentation();
    const auto seconds = [](std::chrono::microseconds duration) {
        return std::chrono::duration<double>(duration).count();
    };
    // Backend audio currently advances on the unscaled presentation clock. Desired-audio and
    // semantic pause policy remain presentation/runtime concerns above the backend.
    m_preview_host.update_audio_requests();
    m_audio.update(static_cast<float>(seconds(clocks.unscaled_presentation_delta)));
    if (runtime_input_admitted && m_game_host.running_game())
        m_game_host.poll_runtime_presentation();
}

void Engine::Impl::realize_layouts_and_bind_ui()
{
    const auto& clocks = m_game_host_values.frame_clock;
    m_world_presentation.realize(clocks);
    m_presentation_layouts.apply_transition_state(m_world_transitions, m_world_presentation);
}

void Engine::Impl::apply_pending_debug_ui_commands()
{
    if (m_pending_debug_ui_commands.empty())
        return;

    auto commands = std::move(m_pending_debug_ui_commands);
    m_pending_debug_ui_commands.clear();
    bool runtime_state_changed = false;
    core::Diagnostics diagnostics;

    for (const auto& command : commands) {
        runtime::RuntimeCommandGateway* gateway = nullptr;
        if (auto* running_game = m_game_host.running_game())
            gateway = &running_game->session().gateway();

        auto executed = m_debug_ui_command_executor.execute(command, gateway);
        if (!executed) {
            core::append_diagnostics(diagnostics, std::move(executed).error());
            continue;
        }

        const auto& effect = *executed.value_if();
        if (effect.render_perf_logging) {
            m_render_perf_logging = *effect.render_perf_logging;
            m_runtime_ui.enable_render_perf_logging(m_render_perf_logging);
            SDL_Log("[engine] renderer perf logging %s",
                    m_render_perf_logging ? "enabled" : "disabled");
        }
        runtime_state_changed = runtime_state_changed || effect.runtime_state_changed;
    }

    if (runtime_state_changed &&
        !dispatch_runtime_input(core::RuntimeInputMessage{core::AdvanceTimeInput{}})) {
        diagnostics.push_back(
            {.code = "debug_ui.runtime_publication_failed",
             .message = "Runtime rejected publication after a Debug UI Tooling command."});
    }
    if (!diagnostics.empty()) {
        m_game_host.report_runtime_diagnostics(host::HostFrameStage::RenderDevtools,
                                               std::move(diagnostics));
    }
}

host::DebugUiObservationSnapshot Engine::Impl::debug_ui_observations() const
{
    const auto* running_game = m_game_host.running_game();
    return {
        .surface = m_presentation.host,
        .platform_name = "SDL3",
        .renderer_name = m_renderer.renderer_name(),
        .host_generation = running_game ? std::optional<host::HostGeneration>{host_generation(
                                              m_game_host.session_generation())}
                                        : std::nullopt,
        .runtime_loaded = running_game != nullptr,
        .gameplay_paused =
            running_game != nullptr && running_game->session().explicit_gameplay_paused(),
        .render_perf_logging = m_render_perf_logging,
        .runtime_observations = m_game_host.runtime_observations().values,
        .runtime_events = m_game_host.runtime_events(),
        .runtime_diagnostics = m_game_host.runtime_diagnostics(),
    };
}

host::CheckpointThumbnailCaptureContext Engine::Impl::checkpoint_thumbnail_capture_context() const
{
    const auto* running_game = m_game_host.running_game();
    return {
        .host_generation = running_game ? std::optional<host::HostGeneration>{host_generation(
                                              m_game_host.session_generation())}
                                        : std::nullopt,
        .pending_request = m_game_host.pending_checkpoint_thumbnail_capture(),
        .displayed_presentation = m_presentation_layouts.current_revision(),
        .visual_operation_active = m_game_host.runtime_presentation().has_active_visual_operation(),
    };
}

bool Engine::Impl::dispatch_runtime_input(const core::RuntimeInputMessage& input)
{
    auto result = m_game_host.submit_runtime_input(input);
    return result.accepted();
}

void Engine::Impl::append_runtime_diagnostics(core::Diagnostics diagnostics)
{
    if (diagnostics.empty())
        return;
    m_game_host.report_runtime_diagnostics(host::HostFrameStage::UpdatePresentation,
                                           std::move(diagnostics));
}

void Engine::Impl::render()
{
    if (auto capture = m_checkpoint_thumbnail_captures.take_completed(
            checkpoint_thumbnail_capture_context())) {
        auto attached = m_game_host.attach_checkpoint_thumbnail(capture->request,
                                                                std::move(capture->thumbnail));
        if (!attached) {
            for (const auto& diagnostic : attached.error()) {
                SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION, "[checkpoint-thumbnail] %s %s",
                            diagnostic.code.c_str(), diagnostic.message.c_str());
            }
        }
    }

    if (m_debug_ui_enabled) {
        m_debug_ui.begin_frame(m_presentation.host);
    }
    const auto& clocks = m_game_host_values.frame_clock;
    const float unscaled_time_seconds =
        std::chrono::duration<float>(clocks.unscaled_presentation_time).count();
    ShaderStandardInputs shader_inputs;
    shader_inputs.time_seconds = unscaled_time_seconds;
    shader_inputs.paint_dimensions = {static_cast<float>(m_renderer.reference_width()),
                                      static_cast<float>(m_renderer.reference_height())};
    const PresentationTransform transform(m_presentation);
    const AxisScale world_scale = transform.reference_to_world_raster_scale();
    shader_inputs.reference_to_world_raster_scale = {world_scale.x, world_scale.y};
    const AxisScale ui_scale = transform.reference_to_native_ui_raster_scale();
    shader_inputs.context_logical_to_ui_raster_scale = {ui_scale.x, ui_scale.y};
    shader_inputs.ui_media_query_resolution = shader_inputs.context_logical_to_ui_raster_scale.x;
    shader_inputs.viewport_pixel_dimensions = {
        static_cast<float>(m_presentation.ui_raster.size.width),
        static_cast<float>(m_presentation.ui_raster.size.height)};
    shader_inputs.pointer_position = m_pointer_position;
    shader_inputs.pointer_valid = m_pointer_valid;
    m_renderer.set_shader_standard_inputs(shader_inputs);

    m_renderer.begin_frame();
    bool transition_surfaces_ready = false;
    std::optional<WorldTransitionScenePlan> transition_scene_plan;
    if (const auto& pending_transition = m_world_transitions.render_state()) {
        transition_scene_plan = make_world_transition_scene_plan(*pending_transition);
        const WorldTransitionSceneMode scene_mode =
            transition_scene_plan->render_source && transition_scene_plan->render_target
                ? WorldTransitionSceneMode::Dual
                : (transition_scene_plan->render_source ? WorldTransitionSceneMode::SourceOnly
                                                        : WorldTransitionSceneMode::TargetOnly);
        transition_surfaces_ready = m_renderer.prepare_world_transition_surfaces(scene_mode);
        if (!transition_surfaces_ready) {
            m_world_transitions.fail_active(
                {.code = "presentation.world_transition_surface_failed",
                 .message = "Failed to create world-raster and native-scene transition surfaces"});
            m_renderer.retire_world_transition_surfaces();
        }
    } else {
        m_renderer.retire_world_transition_surfaces();
    }
    const auto& transition = m_world_transitions.render_state();
    if (!transition)
        transition_scene_plan.reset();
    const bool rendering_full_world_transition = transition && transition_surfaces_ready;
    const bool postprocess_surface_ready =
        m_renderer.prepare_postprocess_surface(rendering_full_world_transition);
    if (!postprocess_surface_ready)
        m_renderer.retire_postprocess_surface();
    const auto postprocess_scope = m_renderer.active_postprocess_scope();
    const std::uint16_t postprocess_framebuffer = m_renderer.postprocess_framebuffer();
    m_runtime_ui.set_postprocess_framebuffers(
        postprocess_scope == PostprocessScope::World ? postprocess_framebuffer : UINT16_MAX,
        postprocess_scope == PostprocessScope::FullGameViewport ? postprocess_framebuffer
                                                                : UINT16_MAX);
    m_runtime_ui.set_world_overlay_framebuffers(
        m_renderer.world_transition_framebuffer(WorldCompositionPass::Source),
        m_renderer.world_transition_framebuffer(WorldCompositionPass::Target),
        transition.has_value() && transition_surfaces_ready);
    m_runtime_ui.begin_frame(clocks);
    (void)m_game_host.flush_runtime_presentation();

    if (rendering_full_world_transition) {
        const auto* source = m_world_presentation.frame(transition->source);
        const auto* target = m_world_presentation.frame(transition->target);
        if (transition_scene_plan->render_source) {
            if (source) {
                m_renderer.draw_world_2d(source->world_composition_batch,
                                         WorldCompositionPass::Source);
            }
            m_renderer.composite_world_surface_to_transition_scene(WorldCompositionPass::Source);
            m_runtime_ui.render_world_overlay_source();
        }
        if (transition_scene_plan->render_target) {
            const auto targeted_states = m_world_transitions.targeted_render_states();
            auto targeted = m_world_transitions.compose_targeted_world_batch();
            if (!targeted_states.empty() && targeted) {
                m_renderer.draw_world_2d(*targeted.value_if(), WorldCompositionPass::Target);
            } else if (!targeted_states.empty()) {
                for (const auto& diagnostic : targeted.error()) {
                    SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[runtime-presentation] %s %s %s",
                                 diagnostic.code.c_str(), diagnostic.source_path.c_str(),
                                 diagnostic.message.c_str());
                    for (const auto& state : targeted_states)
                        m_world_transitions.fail_operation(state.operation, diagnostic);
                }
                append_runtime_diagnostics(std::move(targeted).error());
                if (target) {
                    m_renderer.draw_world_2d(target->world_composition_batch,
                                             WorldCompositionPass::Target);
                }
            } else if (target) {
                m_renderer.draw_world_2d(target->world_composition_batch,
                                         WorldCompositionPass::Target);
            }
            m_renderer.composite_world_surface_to_transition_scene(WorldCompositionPass::Target);
            m_runtime_ui.render_world_overlay_target();
        }

        if (transition_scene_plan->blend_completed_scenes) {
            m_renderer.composite_world_transition_scene(WorldCompositionPass::Source);
            m_renderer.composite_world_transition_scene(WorldCompositionPass::Target,
                                                        transition->progress);
        } else if (transition_scene_plan->render_source) {
            m_renderer.composite_world_transition_scene(WorldCompositionPass::Source);
        } else if (transition_scene_plan->render_target) {
            m_renderer.composite_world_transition_scene(WorldCompositionPass::Target);
        }
    } else if (!m_world_transitions.targeted_render_states().empty()) {
        auto targeted = m_world_transitions.compose_targeted_world_batch();
        if (targeted) {
            m_renderer.draw_world_2d(*targeted.value_if(), WorldCompositionPass::Ordinary);
        } else {
            const auto states = m_world_transitions.targeted_render_states();
            for (const auto& diagnostic : targeted.error()) {
                SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[runtime-presentation] %s %s %s",
                             diagnostic.code.c_str(), diagnostic.source_path.c_str(),
                             diagnostic.message.c_str());
                for (const auto& state : states)
                    m_world_transitions.fail_operation(state.operation, diagnostic);
            }
            append_runtime_diagnostics(std::move(targeted).error());
            if (const auto* frame = m_world_presentation.frame())
                m_renderer.draw_world_2d(frame->world_composition_batch,
                                         WorldCompositionPass::Ordinary);
        }
    } else if (const auto* frame = m_world_presentation.frame()) {
        m_renderer.draw_world_2d(frame->world_composition_batch, WorldCompositionPass::Ordinary);
    }
    if (!rendering_full_world_transition) {
        m_renderer.composite_ordinary_world_surface();
        m_runtime_ui.render_world_overlay_target();
    }
    ++m_frame_count;

    float transition_opacity = 0.0f;
    Color transition_color{};
    if (transition && transition->kind == WorldTransitionVisualKind::Fade) {
        transition_opacity = transition->progress < 0.5f ? transition->progress * 2.0f
                                                         : (1.0f - transition->progress) * 2.0f;
        transition_color = transition->color;
        transition_color.a *= transition_opacity;
        m_renderer.draw_fullscreen_color(transition_color);
    }
    if (postprocess_scope == PostprocessScope::World)
        m_renderer.composite_postprocess_surface();
    if (const auto* frame = m_world_presentation.frame()) {
        m_renderer.draw_world_2d(frame->game_ui_underlay_batch,
                                 WorldCompositionPass::GameUiUnderlay);
    }
    (void)m_checkpoint_thumbnail_captures.request_if_ready(checkpoint_thumbnail_capture_context());
    const bool game_viewport_capture_pending = m_renderer.game_viewport_capture_pending();
    m_runtime_ui.end_frame(!game_viewport_capture_pending);
    if (m_runtime_ui.active_text_direct_render_enabled()) {
        m_renderer.draw_active_text(m_runtime_ui.active_text_render_snapshot());
    }
    if (postprocess_scope == PostprocessScope::FullGameViewport)
        m_renderer.composite_postprocess_surface();
    if (m_game_host.runtime_presentation().mandatory_asset_overlay_visible()) {
        m_renderer.draw_fullscreen_color(Color{0.0f, 0.0f, 0.0f, 0.78f});
        if (const auto* progress = m_game_host.runtime_presentation().mandatory_asset_progress()) {
            const auto phase = core::loading_phase_name(progress->phase);
            if (progress->total_units) {
                m_renderer.debug_printf(4, 4, 0x0f, "Loading %.*s: %llu / %llu",
                                        static_cast<int>(phase.size()), phase.data(),
                                        static_cast<unsigned long long>(progress->completed_units),
                                        static_cast<unsigned long long>(*progress->total_units));
            } else {
                m_renderer.debug_printf(4, 4, 0x0f, "Loading %.*s...",
                                        static_cast<int>(phase.size()), phase.data());
            }
            if (progress->state == core::LoadingState::Failed) {
                const char* message = progress->diagnostics.empty()
                                          ? "Mandatory asset preparation failed"
                                          : progress->diagnostics.front().message.c_str();
                m_renderer.debug_printf(4, 6, 0x0f, "%s", message);
                if (progress->retryable)
                    m_renderer.debug_printf(4, 8, 0x0f, "Press R or Enter to retry");
            }
        }
    }
    if (m_debug_ui_enabled) {
        auto output = m_debug_ui.end_frame(debug_ui_observations(), !game_viewport_capture_pending);
        for (auto& command : output.commands)
            m_pending_debug_ui_commands.push_back(std::move(command));
    }
    m_renderer.end_frame();
}

bool Engine::Impl::shutdown()
{
    if (m_shutdown_finalized)
        return true;

    const auto release_tooling_assets = [this] {
        m_tooling_postprocess_assets.reset();
        m_assets.clear_supplemental_leases_on_owner();
        m_tooling_postprocess_material_id.clear();
    };
    if (!m_shutdown_release_started) {
        release_tooling_assets();
        m_shutdown_release_started = true;
    }
    if (!shutdown_jobs())
        return false;

    m_running = false;
    if (!m_initialized) {
        m_checkpoint_thumbnail_captures.reset();
        m_input_router.reset();
        m_pointer_position = {};
        m_pointer_valid = false;
        m_pending_debug_ui_commands.clear();
        m_preview_host.stop_all_preview_audio();
        m_game_host.shutdown();
        m_shutdown_finalized = true;
        return true;
    }

    if (m_debug_ui_enabled) {
        m_debug_ui.shutdown();
    }
    m_checkpoint_thumbnail_captures.reset();
    m_game_host.shutdown();
    m_game_host.runtime_layouts().bind_document_host(nullptr);
    m_layout_realizer.clear_session();
    m_world_presentation.reset();
    m_world_presentation_resources.clear();
    m_runtime_ui.shutdown();
    m_runtime_clock.reset();
    m_input_router.reset();
    m_pointer_position = {};
    m_pointer_valid = false;
    m_pending_debug_ui_commands.clear();
    m_game_host_values.frame_clock = {};
    m_preview_host.stop_all_preview_audio();
    m_assets.bind_audio_loader(nullptr);
    m_audio.shutdown();
    m_scripts.shutdown();
    m_renderer.shutdown();
    m_platform.shutdown();

    m_initialized = false;
    m_shutdown_finalized = true;
    std::printf("[engine] shutdown complete\n");
    return true;
}

#if defined(__EMSCRIPTEN__)
void Engine::Impl::deferred_shutdown_callback(void* opaque)
{
    auto* impl = static_cast<Impl*>(opaque);
    if (impl == nullptr)
        return;
    if (impl->shutdown()) {
        delete impl;
        return;
    }
    emscripten_async_call(&Impl::deferred_shutdown_callback, impl, 0);
}
#endif

void Engine::Impl::request_stop()
{
    begin_job_shutdown();
    m_platform.request_quit();
}

bool Engine::Impl::request_screenshot(std::string path)
{
    if (!m_initialized || path.empty() || !m_renderer.is_initialized())
        return false;
    m_renderer.request_screenshot(path);
    return true;
}

void Engine::Impl::set_preview_running(bool running)
{
    m_preview_running = running;
    if (!m_preview_running) {
        m_input_router.reset();
        m_pointer_valid = false;
    }
}

void Engine::Impl::set_show_fps_counter(bool show)
{
    m_show_fps_counter = show;
    m_fps_sample_frames = 0;
    m_fps_sample_start_counter = 0;
    if (!m_show_fps_counter) {
        preview_bridge::emit_fps(0.0f, 0.0f, static_cast<int>(m_fps_cap));
    }
}

void Engine::Impl::set_fps_cap(uint32_t frames_per_second)
{
    m_fps_cap = sanitize_fps_cap(frames_per_second);
    m_next_frame_counter = 0;
    m_fps_sample_frames = 0;
    m_fps_sample_start_counter = 0;
}

Engine::Engine() : m_impl(std::make_unique<Impl>()) {}

Engine::~Engine() { shutdown(); }

bool Engine::initialize(const PlatformConfig& config, const EngineConfig& engine_config)
{
    return m_impl->initialize(config, engine_config, {});
}

bool EngineTooling::initialize(Engine& engine, const PlatformConfig& platform_config,
                               const EngineConfig& engine_config,
                               const EngineToolingConfig& tooling_config)
{
    return engine.m_impl->initialize(platform_config, engine_config, tooling_config);
}

int Engine::run() { return m_impl->run(); }

bool Engine::tick() { return m_impl->tick(); }

void Engine::resize(const HostSurfaceMetrics& surface) { m_impl->resize(surface); }

const PresentationMetrics& Engine::presentation() const { return m_impl->m_presentation; }

void Engine::shutdown()
{
    if (!m_impl)
        return;
#if defined(__EMSCRIPTEN__)
    if (!m_impl->shutdown()) {
        auto* pending = m_impl.release();
        emscripten_async_call(&Impl::deferred_shutdown_callback, pending, 0);
    }
#else
    (void)m_impl->shutdown();
#endif
}

void Engine::request_stop() { m_impl->request_stop(); }

bool EngineTooling::request_screenshot(Engine& engine, std::string path)
{
    return engine.m_impl->request_screenshot(std::move(path));
}

void EngineTooling::set_preview_running(Engine& engine, bool running)
{
    engine.m_impl->set_preview_running(running);
}

void EngineTooling::set_show_fps_counter(Engine& engine, bool show)
{
    engine.m_impl->set_show_fps_counter(show);
}

void EngineTooling::set_fps_cap(Engine& engine, uint32_t frames_per_second)
{
    engine.m_impl->set_fps_cap(frames_per_second);
}

bool EngineTooling::set_runtime_ui_scale(Engine& engine, double scale)
{
    return bool(engine.m_impl->set_runtime_ui_scale(scale));
}

bool EngineTooling::set_postprocess_material(Engine& engine, std::string material_id)
{
    auto& impl = *engine.m_impl;
    if (!impl.m_initialized || material_id.empty())
        return false;

    const MaterialId id(material_id);
    const auto* material = find_material(impl.m_shader_materials, id);
    if (material == nullptr || material->role != ShaderRole::Postprocess) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                     "[engine] tooling postprocess material is missing or invalid: %s",
                     material_id.c_str());
        return false;
    }

    auto resolution = resolve_material_shader_program(impl.m_shader_materials, id,
                                                      impl.m_renderer.active_shader_variant());
    if (!resolution.program) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                     "[engine] tooling postprocess shader resolution failed: %s",
                     material_id.c_str());
        return false;
    }

    const auto generation = impl.m_assets.source_generation_on_owner();
    assets::MaterialAssetRequest material_request{.id = material_id};
    assets::ShaderProgramAssetRequest shader_request{.resolution = *resolution.program};
    std::vector<assets::StructuredAssetRequestDescriptor> requests;
    requests.reserve(2);
    requests.push_back(
        {.request = material_request,
         .cache_key = assets::make_material_cache_key(material_request, generation)});
    requests.push_back(
        {.request = shader_request,
         .cache_key = assets::make_shader_program_cache_key(shader_request, generation)});

    impl.m_tooling_postprocess_assets = std::make_unique<assets::MandatoryAssetRequestGroup>(
        impl.m_assets, std::move(requests),
        assets::MandatoryAssetGroupOptions{.phase = core::LoadingPhase::LoadingRuntimeDemand,
                                           .reason = assets::AssetRequestReason::Demand,
                                           .overlay_grace = std::chrono::milliseconds{0},
                                           .show_overlay_immediately = false,
                                           .retryable = false});
    impl.m_tooling_postprocess_material_id = material_id;
    impl.m_assets.clear_supplemental_leases_on_owner();
    return true;
}

RuntimePreviewController& EngineTooling::preview(Engine& engine) noexcept
{
    return engine.m_impl->m_runtime_preview;
}

const RuntimePreviewController& EngineTooling::preview(const Engine& engine) noexcept
{
    return engine.m_impl->m_runtime_preview;
}

bool EngineTooling::preview_running(const Engine& engine) noexcept
{
    return engine.m_impl->m_preview_running;
}

Renderer& EngineTooling::renderer(Engine& engine) noexcept { return engine.m_impl->m_renderer; }

assets::AssetManager& EngineTooling::assets(Engine& engine) noexcept
{
    return engine.m_impl->m_assets;
}

core::Result<core::AssetProfilerSnapshot, core::Diagnostic>
EngineTooling::asset_profiler_snapshot(const Engine& engine)
{
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    if (engine.m_impl->m_editor_asset_profiler != nullptr) {
        return core::Result<core::AssetProfilerSnapshot, core::Diagnostic>::success(
            engine.m_impl->m_editor_asset_profiler->capture_on_owner());
    }
#endif
    return core::Result<core::AssetProfilerSnapshot, core::Diagnostic>::failure(
        {.code = "assets.editor_profiler_unavailable",
         .message = "Asset profiler is unavailable in this engine composition"});
}

core::Result<core::AssetProfilerDelta, core::Diagnostic>
EngineTooling::asset_profiler_delta(const Engine& engine,
                                    core::AssetProfilerSessionId expected_session,
                                    core::AssetProfilerSequence after_sequence)
{
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    if (engine.m_impl->m_editor_asset_profiler != nullptr) {
        return engine.m_impl->m_editor_asset_profiler->capture_delta_on_owner(expected_session,
                                                                              after_sequence);
    }
#endif
    return core::Result<core::AssetProfilerDelta, core::Diagnostic>::failure(
        {.code = "assets.editor_profiler_unavailable",
         .message = "Asset profiler is unavailable in this engine composition"});
}

AudioBackendInfo EngineTooling::audio_backend_info(const Engine& engine) noexcept
{
    return engine.m_impl->m_audio.backend_info();
}

AudioBackendStats EngineTooling::audio_backend_stats(const Engine& engine) noexcept
{
    return engine.m_impl->m_audio.backend_stats();
}

bool Engine::is_running() const { return m_impl->m_running; }

} // namespace noveltea
