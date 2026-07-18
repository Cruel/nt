#include "host/engine_impl.hpp"

#include "noveltea/audio/audio_backend.hpp"
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

#include <SDL3/SDL.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <charconv>
#include <map>
#include <memory>
#include <optional>
#include <span>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace noveltea {

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
      m_preview_host(host::PreviewHost::Dependencies{
          .game_host = m_game_host,
          .runtime_ui = m_runtime_ui,
          .scripts = m_scripts,
          .renderer = m_renderer,
          .shader_materials = m_shader_materials,
          .audio_backend = m_audio,
          .load_game =
              [this](host::GameHostLoadRequest request) {
                  return load_compiled_project(request.logical_path, request.load_title_screen,
                                               request.stop_runtime_after_load);
              },
          .apply_display_override =
              [this](std::optional<DisplayProfile> profile) {
                  apply_preview_display_override(std::move(profile));
              },
          .preview_running = m_preview_running,
      }),
      m_runtime_preview(m_preview_host)
{
}
namespace {

constexpr uint32_t kMaxFpsCap = 1000;
#if defined(__EMSCRIPTEN__)
constexpr uint32_t kPreviewDisplayPaceCap = 60;
#endif
constexpr std::uint32_t kMaxAspectRatioComponent = 10'000;

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

std::string presentation_layout_key_text(const core::MountedLayoutPresentationKey& key)
{
    return std::visit(
        [](const auto& value) -> std::string {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::ReservedLayoutMountKey>)
                return "reserved/" + std::to_string(static_cast<unsigned>(value.slot));
            else if constexpr (std::is_same_v<T, core::RoomOverlayLayoutMountKey>)
                return "room-overlay/" + value.room.text() + "/" + value.overlay.text();
            else
                return "scoped/" + value.instance.text();
        },
        key);
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

[[maybe_unused]] std::optional<DisplayProfile>
display_profile_from_project(const nlohmann::json& root)
{
    const auto display = root.find("display");
    if (display == root.end()) {
        return DisplayProfile{};
    }
    if (!display->is_object()) {
        return std::nullopt;
    }
    const auto ratio = display->find("aspect_ratio");
    const auto orientation = display->find("orientation");
    const auto color = display->find("bar_color");
    if (ratio == display->end() || !ratio->is_object() || orientation == display->end() ||
        !orientation->is_string() || color == display->end() || !color->is_string()) {
        return std::nullopt;
    }
    const auto width = ratio->value("width", 0u);
    const auto height = ratio->value("height", 0u);
    const auto orientation_value = orientation->get<std::string>();
    const auto color_value = color->get<std::string>();
    if (width == 0 || height == 0 || width > kMaxAspectRatioComponent ||
        height > kMaxAspectRatioComponent ||
        (orientation_value != "landscape" && orientation_value != "portrait") ||
        color_value.size() != 7 || color_value.front() != '#' ||
        !std::all_of(color_value.begin() + 1, color_value.end(),
                     [](unsigned char value) { return std::isxdigit(value) != 0; })) {
        return std::nullopt;
    }
    std::uint32_t rgb = 0;
    const auto* first = color_value.data() + 1;
    const auto* last = color_value.data() + color_value.size();
    const auto conversion = std::from_chars(first, last, rgb, 16);
    if (conversion.ec != std::errc{} || conversion.ptr != last) {
        return std::nullopt;
    }
    DisplayProfile profile;
    profile.aspect_ratio = normalize_aspect_ratio({width, height});
    profile.orientation = orientation_value == "portrait" ? ScreenOrientation::Portrait
                                                          : ScreenOrientation::Landscape;
    profile.bar_color_rgba = (rgb << 8u) | 0xffu;
    return profile;
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
    project.shaders.push_back(std::move(rmlui_noise_shader));
    project.shaders.push_back(std::move(active_text_shader));
    project.shaders.push_back(std::move(active_text_glow_shader));
    project.materials.push_back(std::move(material));
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
                     metadata.error.c_str());
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

void Engine::Impl::configure_assets(const EngineConfig& engine_config)
{
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
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[assets] Android smoke read failed: %s",
                     smoke.error.c_str());
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                     "[assets] continuing without Android shader smoke asset");
    }
#endif
}

bool Engine::Impl::load_compiled_project(const std::string& logical_path, bool load_title_screen,
                                         bool stop_runtime_after_load)
{
    struct PreparedResources {
        ShaderMaterialProject shader_materials;
        DisplayProfile display_profile;
        assets::FontAssetConfig fonts;
    };
    const auto prepare_resources = [](const runtime::RunningGame& game) {
        PreparedResources prepared;
        const auto& project = game.package().project();
        prepared.shader_materials =
            game.package().shader_materials().value_or(ShaderMaterialProject{});
        const auto& display = project.settings().display;
        prepared.display_profile.aspect_ratio =
            normalize_aspect_ratio({display.aspect_ratio.width, display.aspect_ratio.height});
        prepared.display_profile.orientation =
            display.orientation == core::compiled::DisplayOrientation::Portrait
                ? ScreenOrientation::Portrait
                : ScreenOrientation::Landscape;
        if (const auto parsed_color = parse_bar_color_rgba(display.bar_color))
            prepared.display_profile.bar_color_rgba = *parsed_color;
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
        m_shader_materials = std::move(prepared.shader_materials);
        m_renderer.set_shader_material_project(&m_shader_materials);
        m_world_presentation_resources.bind_project(game.package().project());
        m_display_profile = prepared.display_profile;
        m_presentation = make_presentation_metrics(
            m_platform.surface(), m_preview_display_override.value_or(m_display_profile));
        m_renderer.resize(m_presentation);
        m_runtime_ui.resize(m_presentation);
        m_assets.configure_fonts(std::move(prepared.fonts));
        auto bound = m_layout_realizer.bind_session(game.package().project(), generation);
        if (!bound) {
            for (const auto& diagnostic : bound.error())
                SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[layout-realizer] %s: %s",
                             diagnostic.code.c_str(), diagnostic.message.c_str());
        }
        m_game_host.runtime_presentation().bind_snapshot_backend(
            [this](const core::RuntimePresentationSnapshot& snapshot) {
                return reconcile_presentation_snapshot(snapshot);
            });
    };

    std::optional<PreparedResources> prepared_resources;
    std::optional<PreparedResources> previous_resources;
    if (m_game_host.running_game())
        previous_resources = prepare_resources(*m_game_host.running_game());

    host::GameHostLoadHooks hooks;
    hooks.prepare_candidate = [this, &prepare_resources,
                               &prepared_resources](const runtime::RunningGame& candidate,
                                                    const runtime::RuntimePublication& publication)
        -> core::Result<void, core::Diagnostics> {
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
        auto validated_layouts = m_layout_realizer.validate_project(project);
        if (!validated_layouts)
            core::append_diagnostics(diagnostics, std::move(validated_layouts).error());
        if (!diagnostics.empty())
            return core::Result<void, core::Diagnostics>::failure(std::move(diagnostics));

        prepared_resources = prepare_resources(candidate);
        return core::Result<void, core::Diagnostics>::success();
    };
    hooks.detach_current_resources = [this]() {
        m_game_host.runtime_presentation().bind_snapshot_backend({});
        m_game_host.runtime_presentation().bind_presentation_id_allocator({});
        m_world_presentation.reset();
        m_world_presentation_resources.clear();
        m_layout_realizer.clear_session();
    };
    hooks.commit_candidate_resources = [this, &apply_resources,
                                        &prepared_resources](const runtime::RunningGame& candidate,
                                                             const runtime::RuntimePublication&) {
        if (!prepared_resources)
            return;
        const auto generation =
            m_game_host.session_generation().next().value_or(m_game_host.session_generation());
        apply_resources(candidate, std::move(*prepared_resources), host_generation(generation));
    };
    hooks.restore_previous_resources = [this, &apply_resources,
                                        &previous_resources](const runtime::RunningGame& previous) {
        if (previous_resources)
            apply_resources(previous, std::move(*previous_resources),
                            host_generation(m_game_host.session_generation()));
    };

    auto loaded =
        m_game_host.load_compiled_project({.logical_path = logical_path,
                                           .runtime_locale = "en",
                                           .load_title_screen = load_title_screen,
                                           .stop_runtime_after_load = stop_runtime_after_load},
                                          hooks);
    if (!loaded) {
        for (const auto& diagnostic : loaded.error()) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[runtime] %s %s %s",
                         diagnostic.code.c_str(), diagnostic.source_path.c_str(),
                         diagnostic.message.c_str());
            emit_preview_diagnostic(diagnostic);
        }
        return false;
    }
    SDL_Log("[engine] loaded compiled project: %s", logical_path.c_str());
    return true;
}

core::Result<void, core::Diagnostics>
Engine::Impl::reconcile_presentation_snapshot(const core::RuntimePresentationSnapshot& snapshot)
{
    const auto previous_revision = m_game_host.presentation_layout_state().current_revision;
    auto world =
        m_world_presentation.reconcile(snapshot, {static_cast<float>(m_renderer.logical_width()),
                                                  static_cast<float>(m_renderer.logical_height())});
    if (!world)
        return core::Result<void, core::Diagnostics>::failure(std::move(world.error()));
    auto layouts = reconcile_presentation_layouts(snapshot);
    if (layouts)
        return layouts;

    m_world_presentation.discard_revision(snapshot.revision);
    if (previous_revision) {
        (void)m_world_presentation.restore_revision(*previous_revision);
    } else {
        m_world_presentation.reset();
    }
    return layouts;
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

core::Result<void, core::Diagnostics>
Engine::Impl::set_runtime_user_settings(core::RuntimeUserSettings settings)
{
    m_game_host.set_runtime_user_settings(std::move(settings));
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

core::Result<void, core::Diagnostics>
Engine::Impl::reconcile_presentation_layouts(const core::RuntimePresentationSnapshot& snapshot)
{
    const auto* running_game = m_game_host.running_game();
    if (!running_game)
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "presentation.layout_runtime_unavailable",
              .message = "Presentation Layout reconciliation requires a running game"}});
    const auto& project = running_game->package().project();
    auto bound =
        m_layout_realizer.bind_session(project, host_generation(m_game_host.session_generation()));
    if (!bound)
        return core::Result<void, core::Diagnostics>::failure(std::move(bound).error());
    auto& layout_state = m_game_host.presentation_layout_state();
    auto& runtime_layouts = m_game_host.runtime_layouts();

    struct Desired {
        std::string identity;
        std::optional<core::MountedLayoutPresentationKey> key;
        core::LayoutId layout;
        core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay;
        core::MountedLayoutPolicy policy;
        core::PresentationCompositionGroup composition_group =
            core::PresentationCompositionGroup::Interface;
    };
    std::vector<Desired> desired;
    for (const auto& mount : snapshot.layouts) {
        desired.push_back(
            {presentation_layout_key_text(mount.key), mount.key, mount.layout,
             core::presentation_authority(mount.owner) == core::PresentationAuthority::Gameplay
                 ? core::MountedLayoutOwner::Gameplay
                 : core::MountedLayoutOwner::Shell,
             mount.policy, mount.composition_group});
    }
    if (snapshot.map && snapshot.map->layout) {
        desired.push_back({"map/" + snapshot.map->map.text(),
                           std::nullopt,
                           *snapshot.map->layout,
                           core::MountedLayoutOwner::Gameplay,
                           {.plane = core::PresentationPlane::GameUi,
                            .local_order = 300,
                            .clock = core::LayoutClockDomain::Gameplay,
                            .input = core::LayoutInputMode::Normal,
                            .gameplay_pause = core::GameplayPausePolicy::Continue,
                            .visibility = snapshot.map->visible ? core::LayoutVisibility::Visible
                                                                : core::LayoutVisibility::Hidden,
                            .escape_dismissal = core::EscapeDismissalPolicy::Ignore,
                            .entrance_operation = std::nullopt,
                            .exit_operation = std::nullopt},
                           core::PresentationCompositionGroup::Interface});
    }
    std::sort(desired.begin(), desired.end(),
              [](const auto& lhs, const auto& rhs) { return lhs.identity < rhs.identity; });

    std::unordered_map<std::string, RealizedPresentationLayout> next_instances;
    std::vector<core::MountedLayoutInstanceId> newly_mounted;
    const auto rollback_new_mounts = [&]() {
        for (auto it = newly_mounted.rbegin(); it != newly_mounted.rend(); ++it)
            (void)runtime_layouts.unmount(*it);
    };
    const auto retain_layout = [&](const RealizedPresentationLayout& layout) {
        auto source_policy = layout.policy;
        source_policy.input = core::LayoutInputMode::None;
        source_policy.gameplay_pause = core::GameplayPausePolicy::Continue;
        source_policy.visibility = core::LayoutVisibility::Hidden;
        source_policy.escape_dismissal = core::EscapeDismissalPolicy::Ignore;
        source_policy.entrance_operation.reset();
        source_policy.exit_operation.reset();
        (void)runtime_layouts.replace_policy(layout.instance, source_policy);
        (void)m_layout_realizer.apply_policy(layout.instance, source_policy,
                                             static_cast<std::uint32_t>(layout.composition_group));
        (void)m_layout_realizer.set_opacity(layout.instance, 1.0f);
        (void)m_layout_realizer.set_visible(layout.instance, false);
        layout_state.retained[layout.revision.number()].push_back(layout);
    };
    for (const auto& item : desired) {
        const auto* definition = project.find_layout(item.layout);
        if (!definition) {
            rollback_new_mounts();
            return core::Result<void, core::Diagnostics>::failure(
                {{.code = "presentation.layout_missing",
                  .message = "Presentation Layout is missing: " + item.layout.text()}});
        }

        const bool world_overlay = item.policy.plane == core::PresentationPlane::WorldOverlay;
        if (const auto existing = layout_state.current.find(item.identity);
            existing != layout_state.current.end() && existing->second.layout == item.layout &&
            existing->second.owner == item.owner && existing->second.policy == item.policy &&
            existing->second.composition_group == item.composition_group &&
            (!world_overlay || existing->second.revision == snapshot.revision)) {
            auto reused = existing->second;
            reused.key = item.key;
            reused.revision = snapshot.revision;
            next_instances.emplace(item.identity, std::move(reused));
            continue;
        }

        RuntimeLayoutMountRequest request;
        request.layout_id = item.layout.text();
        request.owner = item.owner;
        request.policy = item.policy;
        request.source = RuntimeLayoutProjectSource{};
        request.composition_group = item.composition_group;
        request.publication_revision = snapshot.revision;
        auto mounted = runtime_layouts.mount(std::move(request));
        if (!mounted) {
            rollback_new_mounts();
            return core::Result<void, core::Diagnostics>::failure(std::move(mounted).error());
        }
        newly_mounted.push_back(*mounted.value_if());
        next_instances.insert_or_assign(
            item.identity,
            RealizedPresentationLayout{item.key, *mounted.value_if(), item.layout, item.owner,
                                       item.policy, item.composition_group, snapshot.revision});
    }

    for (const auto& [key, previous] : layout_state.current) {
        const auto next = next_instances.find(key);
        if (next != next_instances.end() && next->second.instance == previous.instance)
            continue;
        retain_layout(previous);
    }
    layout_state.current = std::move(next_instances);
    layout_state.current_revision = snapshot.revision;
    return core::Result<void, core::Diagnostics>::success();
}

void Engine::Impl::release_retained_presentation_layouts()
{
    auto& layout_state = m_game_host.presentation_layout_state();
    auto& runtime_layouts = m_game_host.runtime_layouts();
    std::vector<core::PresentationSnapshotRevision> retained =
        m_world_transitions.active_revisions();
    if (layout_state.current_revision &&
        std::find(retained.begin(), retained.end(), *layout_state.current_revision) ==
            retained.end())
        retained.push_back(*layout_state.current_revision);

    const auto keep_revision = [&](std::uint64_t revision) {
        return std::any_of(retained.begin(), retained.end(),
                           [&](const auto value) { return value.number() == revision; });
    };
    for (auto it = layout_state.retained.begin(); it != layout_state.retained.end();) {
        if (keep_revision(it->first)) {
            ++it;
            continue;
        }
        for (const auto& layout : it->second)
            (void)runtime_layouts.unmount(layout.instance);
        it = layout_state.retained.erase(it);
    }
    m_world_presentation.retain_only(retained);
}

void Engine::Impl::apply_world_transition_layout_state()
{
    auto& layout_state = m_game_host.presentation_layout_state();
    auto& runtime_layouts = m_game_host.runtime_layouts();
    const auto apply = [&](const RealizedPresentationLayout& layout, bool transition_visible,
                           float opacity) {
        const bool visible =
            transition_visible && layout.policy.visibility == core::LayoutVisibility::Visible;
        (void)m_layout_realizer.set_opacity(layout.instance, std::clamp(opacity, 0.0f, 1.0f));
        (void)m_layout_realizer.set_visible(layout.instance, visible);
    };
    const auto set_source_policy = [&](const RealizedPresentationLayout& layout) {
        auto source_policy = layout.policy;
        source_policy.input = core::LayoutInputMode::None;
        source_policy.gameplay_pause = core::GameplayPausePolicy::Continue;
        source_policy.visibility = core::LayoutVisibility::Hidden;
        source_policy.escape_dismissal = core::EscapeDismissalPolicy::Ignore;
        source_policy.entrance_operation.reset();
        source_policy.exit_operation.reset();
        (void)runtime_layouts.replace_policy(layout.instance, source_policy);
        (void)m_layout_realizer.apply_policy(
            layout.instance, source_policy,
            layout.policy.plane == core::PresentationPlane::WorldOverlay
                ? kWorldTransitionSourceCompositionGroup
                : static_cast<std::uint32_t>(layout.composition_group));
    };
    const auto find_current =
        [&](const core::MountedLayoutPresentationKey& key) -> const RealizedPresentationLayout* {
        const auto found = layout_state.current.find(presentation_layout_key_text(key));
        return found == layout_state.current.end() ? nullptr : &found->second;
    };
    const auto find_retained =
        [&](core::PresentationSnapshotRevision revision,
            const core::MountedLayoutPresentationKey& key) -> const RealizedPresentationLayout* {
        const auto found = layout_state.retained.find(revision.number());
        if (found == layout_state.retained.end())
            return nullptr;
        const auto layout = std::find_if(found->second.begin(), found->second.end(),
                                         [&](const auto& v) { return v.key && *v.key == key; });
        return layout == found->second.end() ? nullptr : &*layout;
    };
    const auto snapshot_layout = [&](core::PresentationSnapshotRevision revision,
                                     const core::MountedLayoutPresentationKey& key)
        -> const core::PresentationMountedLayout* {
        const auto* snapshot = m_world_presentation.snapshot(revision);
        if (!snapshot)
            return nullptr;
        const auto found = std::find_if(snapshot->layouts.begin(), snapshot->layouts.end(),
                                        [&](const auto& layout) { return layout.key == key; });
        return found == snapshot->layouts.end() ? nullptr : &*found;
    };

    for (const auto& [_, layout] : layout_state.current)
        apply(layout, true, 1.0f);
    for (const auto& [_, layouts] : layout_state.retained)
        for (const auto& layout : layouts)
            apply(layout, false, 1.0f);

    const auto& transition = m_world_transitions.render_state();
    if (transition) {
        if (const auto source = layout_state.retained.find(transition->source.number());
            source != layout_state.retained.end()) {
            for (const auto& layout : source->second) {
                if (layout.policy.plane != core::PresentationPlane::WorldOverlay)
                    continue;
                set_source_policy(layout);
                apply(layout, true, 1.0f);
            }
        }
        for (const auto& [_, layout] : layout_state.current)
            if (layout.policy.plane == core::PresentationPlane::WorldOverlay)
                apply(layout, true, 1.0f);
    }

    for (const auto& state : m_world_transitions.layout_render_states()) {
        const auto& key = state.target.layout;
        const auto* source_record = snapshot_layout(state.revisions.source, key);
        const auto* target_record = snapshot_layout(state.revisions.target, key);
        const auto* source = find_retained(state.revisions.source, key);
        if (!source && layout_state.current_revision &&
            *layout_state.current_revision == state.revisions.source)
            source = find_current(key);
        const auto* target = find_current(key);
        if (!target)
            target = find_retained(state.revisions.target, key);

        if (source && source_record) {
            set_source_policy(*source);
            apply(*source, true, 1.0f - state.progress);
        }
        if (target && target_record)
            apply(*target, true, state.progress);
    }

    release_retained_presentation_layouts();
}

bool Engine::Impl::initialize(const PlatformConfig& config, const EngineConfig& engine_config,
                              const EngineToolingConfig& tooling_config)
{
    SDL_Log("[engine] initializing...");
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

    const NativeWindowHandles handles = m_platform.native_window_handles();
    m_presentation = make_presentation_metrics(m_platform.surface(), m_display_profile);

    RendererConfig rcfg;
    rcfg.native_display = handles.display;
    rcfg.native_window = handles.window;
    rcfg.presentation = m_presentation;
    rcfg.bar_color_rgba = m_display_profile.bar_color_rgba;
    rcfg.vsync = config.vsync;
    rcfg.assets = &m_assets;

    if (!m_renderer.initialize(rcfg)) {
        std::fprintf(stderr, "[engine] renderer init failed\n");
        rollback();
        return false;
    }
    renderer_initialized = true;

    if (auto aliases = m_assets.load_resource_aliases("project:/resources/aliases.json")) {
        std::printf("[assets] loaded resource aliases from project:/resources/aliases.json\n");
    } else {
        std::printf("[assets] resource aliases not loaded: %s\n", aliases.error.c_str());
    }

    if (m_audio_enabled) {
        if (m_audio.initialize(m_assets)) {
            m_assets.bind_audio_loader(&m_audio);
            audio_bound = true;
        } else {
            m_assets.bind_audio_loader(nullptr);
        }
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
                   GameplayInputDisposition::Eligible;
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
            m_renderer.renderer_name(), m_platform.logical_width(), m_platform.logical_height(),
            m_platform.framebuffer_width(), m_platform.framebuffer_height(), m_platform.scale_x(),
            m_platform.scale_y());
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

    if (throttle_frame_start()) {
        return true;
    }

    handle_events();
    apply_pending_debug_ui_commands();
    const bool runtime_input_admitted = m_preview_running;
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
    finish_frame_timing_sample();

    if (m_platform.should_quit()) {
        m_running = false;
    }

    if (m_frame_limit > 0 && m_frame_count >= m_frame_limit) {
        SDL_Log("[engine] frame limit reached: %u", m_frame_count);
        m_running = false;
    }

    return m_running;
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

void Engine::Impl::resize(const SurfaceMetrics& surface) { resize_host(surface); }

void Engine::Impl::apply_preview_display_override(std::optional<DisplayProfile> profile)
{
    m_preview_display_override = std::move(profile);
    m_presentation = make_presentation_metrics(
        m_platform.surface(), m_preview_display_override.value_or(m_display_profile));
    m_renderer.resize(m_presentation);
    m_runtime_ui.resize(m_presentation);
    auto resized = m_world_presentation.resize({static_cast<float>(m_renderer.logical_width()),
                                                static_cast<float>(m_renderer.logical_height())});
    if (!resized) {
        auto diagnostics = std::move(resized).error();
        if (!diagnostics.empty())
            m_world_transitions.fail_active(diagnostics.front());
        append_runtime_diagnostics(std::move(diagnostics));
    }
}

void Engine::Impl::resize_host(const SurfaceMetrics& surface)
{
    const SurfaceMetrics sanitized = sanitize_surface_metrics(surface);
    const SurfaceMetrics previous = m_presentation.host_surface;
    if (previous.logical_width == sanitized.logical_width &&
        previous.logical_height == sanitized.logical_height &&
        previous.framebuffer_width == sanitized.framebuffer_width &&
        previous.framebuffer_height == sanitized.framebuffer_height &&
        previous.scale_x == sanitized.scale_x && previous.scale_y == sanitized.scale_y) {
        return;
    }

    m_platform.set_surface_metrics(sanitized);
    m_presentation = make_presentation_metrics(
        sanitized, m_preview_display_override.value_or(m_display_profile));
    m_renderer.resize(m_presentation);
    m_runtime_ui.resize(m_presentation);
    auto resized = m_world_presentation.resize({static_cast<float>(m_renderer.logical_width()),
                                                static_cast<float>(m_renderer.logical_height())});
    if (!resized) {
        auto diagnostics = std::move(resized).error();
        if (!diagnostics.empty())
            m_world_transitions.fail_active(diagnostics.front());
        append_runtime_diagnostics(std::move(diagnostics));
    }
    const IntegerRect& viewport = m_presentation.host_logical_viewport;
    SDL_Log("[surface] host=%dx%d framebuffer=%dx%d game=(%d,%d %dx%d)", sanitized.logical_width,
            sanitized.logical_height, sanitized.framebuffer_width, sanitized.framebuffer_height,
            viewport.x, viewport.y, viewport.width, viewport.height);
}

void Engine::Impl::handle_events()
{
    m_platform.poll_events();

    for (const SDL_Event& event : sdl_platform::events(m_platform)) {
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
                     auto processed = m_runtime_ui.process_event(event, m_presentation);
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
            m_pointer_position = routed.pointer_update->game_position;
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
    m_audio.update(static_cast<float>(seconds(clocks.unscaled_presentation_delta)));
    if (runtime_input_admitted && m_game_host.running_game())
        m_game_host.poll_runtime_presentation();
}

void Engine::Impl::realize_layouts_and_bind_ui()
{
    const auto& clocks = m_game_host_values.frame_clock;
    m_world_presentation.realize(clocks);
    apply_world_transition_layout_state();
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
        .surface = m_presentation.host_surface,
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
        .displayed_presentation = m_game_host.presentation_layout_state().current_revision,
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
        m_debug_ui.begin_frame(m_presentation.host_surface);
    }
    const auto& clocks = m_game_host_values.frame_clock;
    const float unscaled_time_seconds =
        std::chrono::duration<float>(clocks.unscaled_presentation_time).count();
    ShaderStandardInputs shader_inputs;
    shader_inputs.time_seconds = unscaled_time_seconds;
    shader_inputs.paint_dimensions = {static_cast<float>(m_renderer.logical_width()),
                                      static_cast<float>(m_renderer.logical_height())};
    shader_inputs.dpi_scale = std::max(m_renderer.scale_x(), m_renderer.scale_y());
    shader_inputs.pointer_position = m_pointer_position;
    shader_inputs.pointer_valid = m_pointer_valid;
    m_renderer.set_shader_standard_inputs(shader_inputs);

    m_renderer.begin_frame();
    bool transition_surfaces_ready = false;
    if (m_world_transitions.render_state()) {
        transition_surfaces_ready = m_renderer.prepare_world_transition_surfaces();
        if (!transition_surfaces_ready) {
            m_world_transitions.fail_active(
                {.code = "presentation.world_transition_surface_failed",
                 .message = "Failed to create source/target world transition surfaces"});
        }
    }
    const auto& transition = m_world_transitions.render_state();
    m_runtime_ui.set_world_overlay_framebuffers(
        m_renderer.world_transition_framebuffer(WorldCompositionPass::Source),
        m_renderer.world_transition_framebuffer(WorldCompositionPass::Target),
        transition.has_value() && transition_surfaces_ready);
    m_runtime_ui.begin_frame(clocks);
    (void)m_game_host.flush_runtime_presentation();

    if (transition && transition_surfaces_ready) {
        const auto* source = m_world_presentation.frame(transition->source);
        const auto* target = m_world_presentation.frame(transition->target);
        if (source)
            m_renderer.draw_world_2d(source->world_composition_batch, WorldCompositionPass::Source);
        m_runtime_ui.render_world_overlay_source();
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
            if (target)
                m_renderer.draw_world_2d(target->world_composition_batch,
                                         WorldCompositionPass::Target);
        } else if (target) {
            m_renderer.draw_world_2d(target->world_composition_batch, WorldCompositionPass::Target);
        }
        m_runtime_ui.render_world_overlay_target();

        if (transition->kind == WorldTransitionVisualKind::Dissolve) {
            m_renderer.composite_world_surface(WorldCompositionPass::Source);
            m_renderer.composite_world_surface(WorldCompositionPass::Target, transition->progress);
        } else if (transition->progress < 0.5f) {
            m_renderer.composite_world_surface(WorldCompositionPass::Source);
        } else {
            m_renderer.composite_world_surface(WorldCompositionPass::Target);
        }
    } else if (!m_world_transitions.targeted_render_states().empty()) {
        auto targeted = m_world_transitions.compose_targeted_world_batch();
        if (targeted) {
            m_renderer.draw_world_2d(*targeted.value_if(), WorldCompositionPass::Target);
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
                                         WorldCompositionPass::Target);
        }
        m_runtime_ui.render_world_overlay_target();
    } else if (const auto* frame = m_world_presentation.frame()) {
        m_renderer.draw_world_2d(frame->world_composition_batch, WorldCompositionPass::Target);
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
    if (const auto* frame = m_world_presentation.frame()) {
        m_renderer.draw_world_2d(frame->game_ui_underlay_batch,
                                 WorldCompositionPass::GameUiUnderlay);
    }
    m_runtime_ui.end_frame();
    if (m_runtime_ui.active_text_direct_render_enabled()) {
        m_renderer.draw_active_text(m_runtime_ui.active_text_render_snapshot());
    }
    if (m_debug_ui_enabled) {
        auto output = m_debug_ui.end_frame(debug_ui_observations());
        for (auto& command : output.commands)
            m_pending_debug_ui_commands.push_back(std::move(command));
    }
    (void)m_checkpoint_thumbnail_captures.request_if_ready(checkpoint_thumbnail_capture_context());
    m_renderer.end_frame();
}

void Engine::Impl::shutdown()
{
    if (!m_initialized) {
        m_checkpoint_thumbnail_captures.reset();
        m_input_router.reset();
        m_pointer_position = {};
        m_pointer_valid = false;
        m_pending_debug_ui_commands.clear();
        m_preview_host.stop_all_preview_audio();
        m_game_host.shutdown();
        return;
    }

    m_running = false;

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
    std::printf("[engine] shutdown complete\n");
}

void Engine::Impl::request_stop()
{
    m_running = false;
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

void Engine::resize(const SurfaceMetrics& surface) { m_impl->resize(surface); }

void Engine::resize_host(const SurfaceMetrics& surface) { m_impl->resize_host(surface); }

const PresentationMetrics& Engine::presentation() const { return m_impl->m_presentation; }

void Engine::shutdown()
{
    if (m_impl)
        m_impl->shutdown();
}

void Engine::request_stop() { m_impl->request_stop(); }

bool Engine::request_screenshot(std::string path)
{
    return m_impl->request_screenshot(std::move(path));
}

void Engine::set_preview_running(bool running) { m_impl->set_preview_running(running); }

void Engine::set_show_fps_counter(bool show) { m_impl->set_show_fps_counter(show); }

void Engine::set_fps_cap(uint32_t frames_per_second) { m_impl->set_fps_cap(frames_per_second); }

bool Engine::show_fps_counter() const { return m_impl->m_show_fps_counter; }

uint32_t Engine::fps_cap() const { return m_impl->m_fps_cap; }

RuntimePreviewController& Engine::runtime_preview() noexcept { return m_impl->m_runtime_preview; }

const RuntimePreviewController& Engine::runtime_preview() const noexcept
{
    return m_impl->m_runtime_preview;
}

bool Engine::preview_running() const { return m_impl->m_preview_running; }

bool Engine::is_running() const { return m_impl->m_running; }

} // namespace noveltea
