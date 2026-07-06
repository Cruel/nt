#include "noveltea/engine.hpp"

#include "noveltea/audio/audio_backend.hpp"
#include "noveltea/core/legacy/project_package_reader.hpp"
#include "noveltea/core/project_ids.hpp"
#include "noveltea/math/geometry.hpp"
#include "noveltea/render/material.hpp"
#include "noveltea/preview_bridge.hpp"
#include "platform/sdl/sdl_platform.hpp"

#include <SDL3/SDL.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <stdexcept>
#include <vector>

#include <nlohmann/json.hpp>

namespace noveltea {

Engine::Engine() : m_audio(make_miniaudio_backend()) {}
Engine::~Engine() { shutdown(); }

namespace {

bool demo_enabled(DemoMode selected, DemoMode queried)
{
    if (selected == DemoMode::None)
        return false;
    return selected == DemoMode::All || selected == queried;
}

constexpr uint32_t kMaxFpsCap = 1000;
constexpr uint32_t kPreviewDisplayPaceCap = 60;

uint32_t sanitize_fps_cap(uint32_t frames_per_second)
{
    return std::min(frames_per_second, kMaxFpsCap);
}

constexpr const char* kEditorPreviewDocumentId = "editor_preview";

constexpr const char* kPreviewLayoutCurrentRml = "preview://layout/current.rml";
constexpr const char* kPreviewLayoutCurrentRcss = "preview://layout/current.rcss";
constexpr const char* kPreviewLayoutCurrentLua = "preview://layout/current.lua";
constexpr const char* kPreviewLayoutFragmentHostRcss =
    "preview://templates/layout-fragment-host.rcss";
constexpr const char* kPreviewShaderSquareRml = "preview://templates/shader-square-preview.rml";
constexpr const char* kPreviewShaderSquareRcss = "preview://templates/shader-square-preview.rcss";

constexpr const char* kPreviewBaseStyle = R"rcss(body, div,
h1, h2, h3, h4,
h5, h6, p,
hr, pre,
tabset tabs {
  display: block;
}

body {
  width: 100%;
  height: 100%;
  color: #f8fafc;
  font-family: Liberation Sans;
}

h1 { font-size: 2em; margin: .67em 0; }
h2 { font-size: 1.5em; margin: .75em 0; }
h3 { font-size: 1.17em; margin: .83em 0; }
h4, p { margin: 1.12em 0; }
h5 { font-size: .83em; margin: 1.5em 0; }
h6 { font-size: .75em; margin: 1.67em 0; }
h1, h2, h3, h4, h5, h6, strong { font-weight: bold; }
em { font-style: italic; }
pre { white-space: pre; }
hr { border-width: 1px; }

button {
  display: inline-block;
  margin: 4px 0;
  padding: 8px 12px;
  min-width: 96px;
  color: #f8fafc;
  background-color: #334155;
  border-width: 1px;
  border-color: #64748b;
  border-radius: 4px;
  font-family: Liberation Sans;
  font-size: 14px;
  text-align: center;
}

button:hover { background-color: #475569; border-color: #94a3b8; }
button:active { background-color: #1e293b; }
table { box-sizing: border-box; display: table; }
tr { box-sizing: border-box; display: table-row; }
td { box-sizing: border-box; display: table-cell; }
col { box-sizing: border-box; display: table-column; }
colgroup { display: table-column-group; }
thead, tbody, tfoot { display: table-row-group; }
)rcss";

constexpr const char* kLayoutFragmentHostRml = R"rml(<rml>
<head>
    <title>NovelTea Layout Fragment Preview</title>
    <link type="text/rcss" href="layout-fragment-host.rcss" />
</head>
<body>
    <div id="nt-layout-preview-root">
        <div id="nt-layout-preview-mount"></div>
    </div>
</body>
</rml>
)rml";

constexpr const char* kLayoutFragmentHostRcss = R"rcss(body {
    margin: 0;
    width: 100%;
    height: 100%;
    background-color: transparent;
    font-family: Liberation Sans;
}

#nt-layout-preview-root {
    position: absolute;
    left: 0;
    top: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
}

#nt-layout-preview-mount {
    position: absolute;
    left: 0;
    top: 0;
    right: 0;
    bottom: 0;
}
)rcss";

constexpr const char* kShaderSquareRml = R"rml(<rml>
<head>
    <title>NovelTea Shader Preview</title>
    <link type="text/rcss" href="preview://templates/shader-square-preview.rcss" />
</head>
<body>
    <div id="nt-shader-preview-stage">
        <div id="nt-shader-preview-square" data-preview-material="__NT_PREVIEW_MATERIAL_ID__"></div>
    </div>
</body>
</rml>
)rml";

constexpr const char* kShaderSquareRcss = R"rcss(body {
    margin: 0;
    width: 100%;
    height: 100%;
    background-color: #0f172a;
    font-family: Liberation Sans;
}

#nt-shader-preview-stage {
    position: absolute;
    left: 0;
    top: 0;
    right: 0;
    bottom: 0;
    background-color: #0f172a;
}

#nt-shader-preview-square {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 256px;
    height: 256px;
    margin-left: -128px;
    margin-top: -128px;
    background-color: #1e293b;
    border: 1px #94a3b8;
    decorator: shader("__NT_PREVIEW_MATERIAL_ID__");
}
)rcss";

std::string lower_ascii(std::string value)
{
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    return value;
}

void replace_all(std::string& value, std::string_view needle, std::string_view replacement)
{
    if (needle.empty())
        return;
    std::size_t pos = 0;
    while ((pos = value.find(needle, pos)) != std::string::npos) {
        value.replace(pos, needle.size(), replacement);
        pos += replacement.size();
    }
}

std::string inject_head_content(std::string rml, std::string_view content)
{
    if (content.empty())
        return rml;
    const std::string lowered = lower_ascii(rml);
    if (const std::size_t head_end = lowered.find("</head>"); head_end != std::string::npos) {
        rml.insert(head_end, std::string(content) + "\n");
        return rml;
    }
    if (const std::size_t rml_start = lowered.find("<rml"); rml_start != std::string::npos) {
        if (const std::size_t tag_end = lowered.find('>', rml_start);
            tag_end != std::string::npos) {
            rml.insert(tag_end + 1, "\n<head>\n" + std::string(content) + "\n</head>");
            return rml;
        }
    }
    return "<rml>\n<head>\n" + std::string(content) + "\n</head>\n<body>\n" + rml +
           "\n</body>\n</rml>\n";
}

std::optional<std::string> inline_source_text(const nlohmann::json& data, std::string_view key)
{
    const auto found = data.find(std::string(key));
    if (found == data.end() || !found->is_object())
        return std::string{};
    const auto mode = found->value("sourceMode", "inline");
    if (mode != "inline")
        return std::nullopt;
    return found->value("sourceText", "");
}

std::string preview_template_text(const nlohmann::json& data, std::string_view key,
                                  std::string_view fallback)
{
    const auto templates = data.find("templateTexts");
    if (templates != data.end() && templates->is_object()) {
        const auto value = templates->find(std::string(key));
        if (value != templates->end() && value->is_string() && !value->get<std::string>().empty())
            return value->get<std::string>();
    }
    return std::string(fallback);
}

bool layout_script_enabled(const nlohmann::json& data)
{
    const auto script = data.find("script");
    if (script == data.end() || !script->is_object())
        return true;
    return script->value("enabled", true);
}

std::string json_string_or_empty(const nlohmann::json& object, std::string_view key)
{
    if (!object.is_object())
        return {};
    const auto found = object.find(std::string(key));
    if (found == object.end() || !found->is_string())
        return {};
    return found->get<std::string>();
}

std::string title_start_label(const nlohmann::json& root)
{
    if (!root.is_object())
        return {};
    const auto settings = root.find("settings");
    if (settings == root.end() || !settings->is_object())
        return {};
    const auto title_screen = settings->find("titleScreen");
    if (title_screen == settings->end() || !title_screen->is_object())
        return {};
    return json_string_or_empty(*title_screen, "startLabel");
}

std::string layout_fragment_host_rml(std::string host_template, const std::string& fragment)
{
    replace_all(host_template, "href=\"layout-fragment-host.rcss\"",
                "href=\"preview://templates/layout-fragment-host.rcss\"");
    replace_all(host_template, "href='layout-fragment-host.rcss'",
                "href='preview://templates/layout-fragment-host.rcss'");
    host_template =
        inject_head_content(std::move(host_template),
                            "<link type=\"text/rcss\" href=\"preview://layout/current.rcss\" />");

    constexpr std::string_view empty_mount = "<div id=\"nt-layout-preview-mount\"></div>";
    if (const std::size_t pos = host_template.find(empty_mount); pos != std::string::npos) {
        host_template.replace(pos, empty_mount.size(),
                              "<div id=\"nt-layout-preview-mount\">\n" + fragment + "\n</div>");
        return host_template;
    }
    constexpr std::string_view indented_empty_mount =
        "<div id=\"nt-layout-preview-mount\">\n        </div>";
    if (const std::size_t pos = host_template.find(indented_empty_mount);
        pos != std::string::npos) {
        host_template.replace(pos, indented_empty_mount.size(),
                              "<div id=\"nt-layout-preview-mount\">\n" + fragment + "\n</div>");
        return host_template;
    }
    return inject_head_content(
        "<rml>\n<head><title>NovelTea Layout Fragment Preview</title></head>\n<body>\n"
        "<div id=\"nt-layout-preview-root\"><div id=\"nt-layout-preview-mount\">\n" +
            fragment + "\n</div></div>\n</body>\n</rml>\n",
        "<link type=\"text/rcss\" href=\"preview://templates/layout-fragment-host.rcss\" />\n"
        "<link type=\"text/rcss\" href=\"preview://layout/current.rcss\" />");
}

void upsert_preview_material(ShaderMaterialProject& project, std::string material_id,
                             std::string shader_id)
{
    project.materials.erase(std::remove_if(project.materials.begin(), project.materials.end(),
                                           [&](const MaterialDefinition& material) {
                                               return material.id.value() == material_id;
                                           }),
                            project.materials.end());
    MaterialDefinition material;
    material.id = MaterialId(std::move(material_id));
    material.role = ShaderRole::RmlUiDecorator;
    material.shader = ShaderId(std::move(shader_id));
    material.display_name = "Editor Preview Shader Material";
    project.materials.push_back(std::move(material));
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
        if (std::filesystem::exists(packaged / "system")) {
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
        if (std::filesystem::exists(packaged / "project")) {
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

AudioBus audio_bus_from_string(const std::string& value)
{
    if (value == "master")
        return AudioBus::Master;
    if (value == "music")
        return AudioBus::Music;
    if (value == "ambience" || value == "ambient")
        return AudioBus::Ambience;
    if (value == "voice")
        return AudioBus::Voice;
    return AudioBus::Sfx;
}

AudioTrackReplaceMode audio_replace_mode_from_string(const std::string& value)
{
    return value == "layer" ? AudioTrackReplaceMode::Layer : AudioTrackReplaceMode::Replace;
}

AudioSfxDesc audio_sfx_desc_from_json(const nlohmann::json& options)
{
    AudioSfxDesc desc;
    if (options.is_object()) {
        desc.volume = options.value("volume", desc.volume);
        desc.pitch = options.value("pitch", desc.pitch);
        desc.max_simultaneous = options.value("max_simultaneous", desc.max_simultaneous);
    }
    return desc;
}

AudioTrackDesc audio_track_desc_from_json(const AudioTrackId& track_id,
                                          const nlohmann::json& options)
{
    AudioTrackDesc desc;
    desc.track_id = track_id;
    if (options.is_object()) {
        desc.bus = audio_bus_from_string(options.value("bus", std::string("music")));
        desc.volume = options.value("volume", desc.volume);
        desc.pitch = options.value("pitch", desc.pitch);
        desc.loop = options.value("loop", desc.loop);
        desc.fade_in_seconds = options.value("fade_in", desc.fade_in_seconds);
        desc.fade_out_seconds = options.value("fade_out", desc.fade_out_seconds);
        desc.replace_mode =
            audio_replace_mode_from_string(options.value("replace_mode", std::string("replace")));
    }
    return desc;
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

bool Engine::load_project_shader_materials()
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

void Engine::configure_assets(const EngineRunConfig& run_config)
{
    const auto system_root = run_config.system_asset_root.empty() ? default_system_asset_root()
                                                                  : run_config.system_asset_root;
    const auto project_root = run_config.project_asset_root.empty() ? default_project_asset_root()
                                                                    : run_config.project_asset_root;
    const auto cache_root = run_config.cache_asset_root.empty() ? default_cache_asset_root()
                                                                : run_config.cache_asset_root;

    mount_default_source(m_assets, "system", run_config.system_asset_root, system_root, false);
    mount_default_source(m_assets, "project", run_config.project_asset_root, project_root, false);
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
        throw std::runtime_error(smoke.error);
    }
#endif
}

bool Engine::load_runtime_project(const std::string& logical_path)
{
    m_tweens.reset();
    auto blob = m_assets.read_binary(logical_path);
    if (!blob) {
        std::fprintf(stderr, "[engine] failed to read runtime project %s: %s\n",
                     logical_path.c_str(), blob.error.c_str());
        return false;
    }

    std::string project_title;
    std::string start_label;
    auto load_document = [&](core::ProjectDocument document) {
        project_title = json_string_or_empty(document.root(), core::project_ids::project_name);
        start_label = title_start_label(document.root());
        assets::FontAssetConfig font_config;
        if (document.root().contains(core::project_ids::project_font_default) &&
            document.root()[core::project_ids::project_font_default].is_string()) {
            font_config.default_alias =
                document.root()[core::project_ids::project_font_default].get<std::string>();
        }
        const auto add_font_map = [&](std::string_view key) {
            if (!document.root().contains(key) || !document.root()[key].is_object()) {
                return;
            }
            for (const auto& [alias, value] : document.root()[key].items()) {
                assets::FontFamilyAssetDesc family;
                family.alias = alias;
                family.synthetic_styles = true;
                if (value.is_string()) {
                    family.regular = FontDesc{.asset_path = value.get<std::string>()};
                } else if (value.is_object()) {
                    const auto read_face = [&](std::string_view face) -> FontDesc {
                        if (value.contains(face) && value[face].is_string()) {
                            return FontDesc{.asset_path = value[face].get<std::string>()};
                        }
                        return {};
                    };
                    family.regular = read_face("regular");
                    if (auto bold = read_face("bold"); !bold.asset_path.empty()) {
                        family.bold = bold;
                    }
                    if (auto italic = read_face("italic"); !italic.asset_path.empty()) {
                        family.italic = italic;
                    }
                    if (auto bold_italic = read_face("bold_italic");
                        !bold_italic.asset_path.empty()) {
                        family.bold_italic = bold_italic;
                    } else if (auto boldItalic = read_face("boldItalic");
                               !boldItalic.asset_path.empty()) {
                        family.bold_italic = boldItalic;
                    }
                    if (value.contains("syntheticStyles") &&
                        value["syntheticStyles"].is_boolean()) {
                        family.synthetic_styles = value["syntheticStyles"].get<bool>();
                    }
                }
                if (!family.alias.empty() && !family.regular.asset_path.empty()) {
                    font_config.families.push_back(std::move(family));
                }
            }
        };
        add_font_map(core::project_ids::engine_fonts);
        add_font_map(core::project_ids::project_fonts);
        m_assets.configure_fonts(std::move(font_config));
        auto result = m_runtime_shell.load_project(std::move(document));
        for (const auto& diagnostic : result.diagnostics) {
            const char* severity = "info";
            if (diagnostic.severity == core::SessionDiagnosticSeverity::Warning)
                severity = "warning";
            if (diagnostic.severity == core::SessionDiagnosticSeverity::Error)
                severity = "error";
            SDL_Log("[runtime] %s %s %s", severity, diagnostic.path.c_str(),
                    diagnostic.message.c_str());
        }
        if (!result.success) {
            std::fprintf(stderr, "[engine] runtime project failed validation: %s\n",
                         logical_path.c_str());
            return false;
        }
        m_script_executor.initialize(&m_scripts, &m_runtime_shell.host());
        return true;
    };

    const auto& bytes = blob.value->bytes;
    const std::string text(bytes.begin(), bytes.end());
    try {
        auto json = nlohmann::json::parse(text);
        if (!load_document(core::ProjectDocument(std::move(json)))) {
            return false;
        }
    } catch (const std::exception& ex) {
        std::vector<core::legacy::PackageError> errors;
        auto package = core::legacy::ProjectPackageReader::read(
            std::span<const std::uint8_t>(bytes.data(), bytes.size()), errors);
        if (!package) {
            std::fprintf(stderr, "[engine] runtime project parse failed: %s: %s\n",
                         logical_path.c_str(), ex.what());
            for (const auto& error : errors) {
                std::fprintf(stderr, "[engine] legacy package import failed: %s\n",
                             error.message.c_str());
            }
            return false;
        }
        m_assets.mount_legacy_package("project", *package);
        if (!load_project_shader_materials()) {
            return false;
        }
        if (!load_document(std::move(package->imported_project.document))) {
            return false;
        }
        SDL_Log("[engine] mounted legacy runtime package assets: %s", logical_path.c_str());
    }

    m_runtime_ui.bind_runtime_host(m_runtime_shell.loaded() ? &m_runtime_shell.host() : nullptr);
    m_runtime_ui.bind_runtime_command_dispatcher(
        m_runtime_shell.loaded() ? &m_runtime_shell.dispatcher() : nullptr);
    m_runtime_shell.bind_runtime_ui(m_runtime_shell.loaded() ? &m_runtime_ui : nullptr);
    m_scripts.bind_runtime_command_dispatcher(
        m_runtime_shell.loaded() ? &m_runtime_shell.dispatcher() : nullptr);
    if (m_runtime_shell.loaded()) {
        if (m_runtime_shell.mount_title_layout() != 0) {
            m_runtime_ui.bind_title_document(project_title, "", start_label);
        }
    }
    SDL_Log("[engine] loaded runtime project: %s", logical_path.c_str());
    return true;
}

bool Engine::initialize(const PlatformConfig& config, const EngineRunConfig& run_config)
{
    SDL_Log("[engine] initializing...");
    m_frame_limit = run_config.frame_limit;
    m_fps_cap = sanitize_fps_cap(run_config.fps_cap);
    m_next_frame_counter = 0;
    m_demo_mode = run_config.demo_mode;
    m_screenshot_path = run_config.screenshot_path;
    m_audio_enabled = run_config.enable_audio;
    m_debug_ui_enabled = run_config.enable_debug_ui;
    m_render_perf_logging = run_config.render_perf_logging;
    m_preview_widget = run_config.preview_widget;
    m_show_fps_counter = run_config.show_fps_counter;
    m_fps_sample_frames = 0;
    m_fps_sample_start_counter = 0;
    bool platform_initialized = false;
    bool renderer_initialized = false;
    bool audio_bound = false;
    bool scripts_initialized = false;
    bool runtime_ui_initialized = false;
    bool debug_ui_initialized = false;

    auto rollback = [&]() {
        if (debug_ui_initialized) {
            m_debug_ui.shutdown();
            debug_ui_initialized = false;
        }
        if (runtime_ui_initialized) {
            m_runtime_ui.shutdown();
            runtime_ui_initialized = false;
        }
        if (scripts_initialized) {
            m_scripts.shutdown();
            scripts_initialized = false;
        }
        if (audio_bound) {
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
        std::printf("[engine] initialization rollback complete\n");
    };

    if (!m_platform.initialize(config)) {
        std::fprintf(stderr, "[engine] platform init failed\n");
        return false;
    }
    platform_initialized = true;

    try {
        configure_assets(run_config);
    } catch (const std::exception& ex) {
        std::fprintf(stderr, "[engine] asset configuration failed: %s\n", ex.what());
        rollback();
        return false;
    }

    const NativeWindowHandles handles = m_platform.native_window_handles();

    RendererConfig rcfg;
    rcfg.native_display = handles.display;
    rcfg.native_window = handles.window;
    rcfg.surface = m_platform.surface();
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
        auto script_init = m_scripts.initialize({&m_assets, &m_audio});
        if (!script_init) {
            std::fprintf(stderr, "[engine] script runtime init failed: %s\n",
                         script_init.error ? script_init.error->message.c_str() : "unknown error");
            rollback();
            return false;
        }
        scripts_initialized = true;
    }

    const bool load_demo = demo_enabled(run_config.demo_mode, DemoMode::RmlUi);
    m_runtime_ui.resize(m_platform.surface());
    if (!m_runtime_ui.initialize(&m_assets, sdl_platform::native_window(m_platform), load_demo,
                                 &m_scripts, &m_shader_materials)) {
        std::fprintf(stderr, "[engine] runtime UI init failed (non-fatal scaffold)\n");
    } else {
        m_runtime_ui.set_rmlui_base_direct_compatibility(run_config.rmlui_base_direct_compat);
        if (m_render_perf_logging) {
            m_runtime_ui.enable_render_perf_logging(true);
            SDL_Log("[engine] renderer perf logging enabled");
        }
        if (!run_config.runtime_ui_document.empty()) {
            m_runtime_ui.bind_tween_service(&m_tweens);
            runtime_ui_initialized = true;
            if (m_runtime_ui.load_document("runtime-acceptance", run_config.runtime_ui_document,
                                           true)) {
                SDL_Log("[engine] loaded RmlUi document: %s",
                        run_config.runtime_ui_document.c_str());
            } else {
                std::fprintf(stderr, "[engine] failed to load RmlUi document: %s\n",
                             run_config.runtime_ui_document.c_str());
                rollback();
                return false;
            }
        } else {
            m_runtime_ui.bind_tween_service(&m_tweens);
            runtime_ui_initialized = true;
        }
    }

    if (m_debug_ui_enabled) {
        SDL_Log("[engine] initializing debug UI...");
        if (!m_debug_ui.initialize(sdl_platform::native_window(m_platform), &m_assets)) {
            std::fprintf(stderr, "[engine] debug UI init failed (non-fatal)\n");
        } else {
            debug_ui_initialized = true;
            m_debug_ui.set_runtime_ui(&m_runtime_ui);
            m_debug_ui.set_perf_logging_enabled(m_render_perf_logging);
            SDL_Log("[engine] debug UI initialized");
        }
    }

    if (!run_config.runtime_project.empty() && !load_runtime_project(run_config.runtime_project)) {
        rollback();
        return false;
    }

    for (const std::string& path : run_config.audio_sfx_paths) {
        (void)m_audio.play_sfx(path);
    }
    for (const std::string& spec : run_config.audio_track_specs) {
        const std::string::size_type equals = spec.find('=');
        if (equals == std::string::npos || equals == 0 || equals + 1 >= spec.size()) {
            std::fprintf(stderr, "[engine] invalid --audio-track spec: %s\n", spec.c_str());
            continue;
        }
        const AudioTrackId track_id = spec.substr(0, equals);
        const std::string path = spec.substr(equals + 1);
        (void)m_audio.play_track(track_id, path);
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
    preview_bridge::emit_ready(m_demo_position, m_preview_running);

    return true;
}

int Engine::run()
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

bool Engine::tick()
{
    if (!m_running)
        return false;

    if (throttle_frame_start()) {
        return true;
    }

    handle_events();
    update(m_platform.delta_time());
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

bool Engine::throttle_frame_start()
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

uint32_t Engine::effective_frame_pace_cap() const
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

void Engine::finish_frame_timing_sample()
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

void Engine::resize(const SurfaceMetrics& surface)
{
    const SurfaceMetrics sanitized = sanitize_surface_metrics(surface);
    const SurfaceMetrics previous = m_renderer.surface();
    if (previous.logical_width == sanitized.logical_width &&
        previous.logical_height == sanitized.logical_height &&
        previous.framebuffer_width == sanitized.framebuffer_width &&
        previous.framebuffer_height == sanitized.framebuffer_height &&
        previous.scale_x == sanitized.scale_x && previous.scale_y == sanitized.scale_y) {
        return;
    }

    m_platform.set_surface_metrics(sanitized);
    m_renderer.resize(sanitized);
    m_runtime_ui.resize(sanitized);
    SDL_Log("[surface] logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f", sanitized.logical_width,
            sanitized.logical_height, sanitized.framebuffer_width, sanitized.framebuffer_height,
            sanitized.scale_x, sanitized.scale_y);
}

void Engine::handle_events()
{
    m_platform.poll_events();

    for (const SDL_Event& event : sdl_platform::events(m_platform)) {
        // SDL event -> devtools -> runtime UI -> game/platform handling.
        if (m_debug_ui_enabled) {
            m_debug_ui.process_event(event, m_platform.surface());
        }
        const bool ui_consumed = m_runtime_ui.process_event(event);

        switch (event.type) {
        case SDL_EVENT_QUIT:
            m_platform.request_quit();
            break;

        case SDL_EVENT_WINDOW_MINIMIZED:
        case SDL_EVENT_WINDOW_FOCUS_LOST:
        case SDL_EVENT_DID_ENTER_BACKGROUND:
            m_audio.pause();
            break;

        case SDL_EVENT_WINDOW_RESTORED:
        case SDL_EVENT_WINDOW_FOCUS_GAINED:
        case SDL_EVENT_DID_ENTER_FOREGROUND:
            m_audio.resume();
            break;

        case SDL_EVENT_KEY_DOWN:
            if (ui_consumed)
                break;
            if (event.key.key == SDLK_ESCAPE) {
                if (m_runtime_shell.mode() == RuntimeShellMode::Paused) {
                    RuntimeCommand command;
                    command.source = RuntimeCommandSource::Platform;
                    command.domain = RuntimeCommandDomain::Shell;
                    command.name = "menu.close";
                    auto result = m_runtime_shell.dispatch_command(std::move(command));
                    core::RuntimeInputResult input_result = std::move(result.input_result);
                    process_runtime_result(input_result);
                    break;
                }
                if (m_runtime_shell.layouts().close_top_escape_layout()) {
                    break;
                }
                if (m_runtime_shell.mode() == RuntimeShellMode::Game) {
                    RuntimeCommand command;
                    command.source = RuntimeCommandSource::Platform;
                    command.domain = RuntimeCommandDomain::Shell;
                    command.name = "game.pause";
                    auto result = m_runtime_shell.dispatch_command(std::move(command));
                    core::RuntimeInputResult input_result = std::move(result.input_result);
                    process_runtime_result(input_result);
                    break;
                }
                m_platform.request_quit();
            }
            std::printf("[input] key_down: scancode=%d\n", event.key.scancode);
            break;

        case SDL_EVENT_MOUSE_BUTTON_DOWN:
            m_pointer_position = {event.button.x, event.button.y};
            m_pointer_valid = true;
            if (ui_consumed)
                break;
            std::printf(
                "[input] mouse_down: button=%d logical=(%.2f,%.2f) surface=%dx%d scale=%.3fx%.3f\n",
                event.button.button, event.button.x, event.button.y, m_platform.logical_width(),
                m_platform.logical_height(), m_platform.scale_x(), m_platform.scale_y());
            if (!m_runtime_shell.layouts().blocks_game_input()) {
                handle_mouse_down(event.button.x, event.button.y, event.button.button);
            }
            break;

        case SDL_EVENT_MOUSE_BUTTON_UP:
            m_pointer_position = {event.button.x, event.button.y};
            m_pointer_valid = true;
            if (ui_consumed)
                break;
            break;
        case SDL_EVENT_MOUSE_MOTION:
            m_pointer_position = {event.motion.x, event.motion.y};
            m_pointer_valid = true;
            if (ui_consumed)
                break;
            break;
        case SDL_EVENT_MOUSE_WHEEL:
        case SDL_EVENT_TEXT_INPUT:
        case SDL_EVENT_KEY_UP:
        case SDL_EVENT_FINGER_DOWN:
        case SDL_EVENT_FINGER_UP:
        case SDL_EVENT_FINGER_MOTION:
        case SDL_EVENT_FINGER_CANCELED:
            if (ui_consumed)
                break;
            break;

        case SDL_EVENT_WINDOW_RESIZED:
        case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED:
        case SDL_EVENT_WINDOW_DISPLAY_SCALE_CHANGED:
            m_platform.refresh_surface_metrics();
            resize(m_platform.surface());
            break;

        default:
            break;
        }
    }
}

void Engine::process_audio_outputs(const std::vector<core::RuntimeOutput>& outputs)
{
    for (const auto& output : outputs) {
        if (output.type != core::RuntimeOutputType::AudioCommand || !output.payload.is_object()) {
            continue;
        }
        const auto& payload = output.payload;
        const std::string op = payload.value("op", std::string{});
        if (op == "play_sfx_alias") {
            const std::string alias = payload.value("alias", std::string{});
            if (!alias.empty()) {
                (void)m_audio.play_sfx_alias(alias, audio_sfx_desc_from_json(payload.value(
                                                        "options", nlohmann::json::object())));
            }
        } else if (op == "play_track_alias") {
            const AudioTrackId track_id = payload.value("track_id", std::string("bgm"));
            const std::string alias = payload.value("alias", std::string{});
            if (!alias.empty()) {
                const auto options = payload.value("options", nlohmann::json::object());
                (void)m_audio.play_track_alias(track_id, alias,
                                               audio_track_desc_from_json(track_id, options));
            }
        } else if (op == "stop_track") {
            const AudioTrackId track_id = payload.value("track_id", std::string("bgm"));
            m_audio.stop_track(track_id, payload.value("fade", 0.0f));
        } else {
            SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION, "[audio] unknown runtime audio command: %s",
                        op.c_str());
        }
    }
}

void Engine::handle_mouse_down(float x, float y, uint8_t button)
{
    if (button != SDL_BUTTON_LEFT || m_platform.logical_width() <= 0 ||
        m_platform.logical_height() <= 0) {
        return;
    }

    constexpr float half_width = 48.0f;
    constexpr float half_height = 42.0f;
    const float width = static_cast<float>(m_platform.logical_width());
    const float height = static_cast<float>(m_platform.logical_height());
    const float usable_width = width - half_width * 2.0f;
    const float usable_height = height - half_height * 2.0f;
    const float center_x =
        half_width + m_demo_position.x * (usable_width > 0.0f ? usable_width : 0.0f);
    const float center_y =
        half_height + m_demo_position.y * (usable_height > 0.0f ? usable_height : 0.0f);

    const Vec2 point{x, y};
    const Vec2 top{center_x, center_y - half_height};
    const Vec2 left{center_x - half_width, center_y + half_height};
    const Vec2 right{center_x + half_width, center_y + half_height};
    if (!point_in_triangle(point, top, left, right)) {
        return;
    }

    preview_bridge::emit_object_clicked(
        "demo-triangle", m_demo_position,
        preview_bridge::NormalizedPosition{clamp01(x / width), clamp01(y / height)});
}

void Engine::update(float dt)
{
    if (!m_preview_running)
        return;
    m_elapsed_seconds += dt;
    m_audio.update(dt);
    m_tweens.advance(dt);
    if (m_runtime_shell.loaded()) {
        auto result = m_runtime_shell.update(dt);
        process_runtime_result(result);
    }
}

void Engine::process_runtime_result(core::RuntimeInputResult& result)
{
    if (!result.handled) {
        return;
    }

    auto& runtime_host = m_runtime_shell.host();
    if (m_runtime_shell.mode() == RuntimeShellMode::Game) {
        (void)m_runtime_shell.layouts().unmount_layer(RuntimeLayoutLayer::Title);
        if (!m_runtime_shell.layouts().find_document("runtime_game")) {
            (void)m_runtime_shell.mount_gameplay_layout();
        }
    }
    m_runtime_ui.apply_controller_commands(runtime_host.last_commands());
    bool has_script_request = false;
    for (const auto& output : result.outputs) {
        if (output.type == core::RuntimeOutputType::ScriptRequest) {
            has_script_request = true;
            break;
        }
    }
    m_script_executor.process(result);
    process_audio_outputs(result.outputs);
    if (has_script_request) {
        m_runtime_ui.apply_controller_commands(runtime_host.last_commands());
    }
}

void Engine::render()
{
    if (m_debug_ui_enabled) {
        m_debug_ui.begin_frame(m_renderer.surface());
    }
    m_runtime_ui.begin_frame(m_platform.delta_time());
    ShaderStandardInputs shader_inputs;
    shader_inputs.time_seconds = m_elapsed_seconds;
    shader_inputs.paint_dimensions = {static_cast<float>(m_renderer.logical_width()),
                                      static_cast<float>(m_renderer.logical_height())};
    shader_inputs.dpi_scale = std::max(m_renderer.scale_x(), m_renderer.scale_y());
    shader_inputs.pointer_position = m_pointer_position;
    shader_inputs.pointer_valid = m_pointer_valid;
    m_renderer.set_shader_standard_inputs(shader_inputs);

    m_renderer.begin_frame();
    if (m_demo_mode != DemoMode::None) {
        m_renderer.draw_preview_triangle(m_demo_position);
    }
    if (demo_enabled(m_demo_mode, DemoMode::Render2D)) {
        m_renderer.draw_demo_2d(m_elapsed_seconds);
    }
    if (demo_enabled(m_demo_mode, DemoMode::Text)) {
        m_renderer.draw_demo_text(m_elapsed_seconds);
    }

    ++m_frame_count;

    m_runtime_ui.end_frame();
    if (m_runtime_ui.active_text_direct_render_enabled()) {
        m_renderer.draw_active_text(m_runtime_ui.active_text_render_snapshot());
    }
    const float transition_opacity = m_runtime_shell.transitions().black_opacity();
    if (transition_opacity > 0.0f) {
        m_renderer.draw_fullscreen_color(Color{0.0f, 0.0f, 0.0f, transition_opacity});
    }
    if (m_debug_ui_enabled) {
        m_debug_ui.end_frame();
    }
    if (!m_screenshot_path.empty() && (m_frame_limit == 0 || m_frame_count >= m_frame_limit)) {
        m_renderer.request_screenshot(m_screenshot_path);
        m_screenshot_path.clear();
    }
    m_renderer.end_frame();
}

void Engine::shutdown()
{
    if (!m_initialized)
        return;

    m_running = false;

    if (m_debug_ui_enabled) {
        m_debug_ui.shutdown();
    }
    m_runtime_ui.shutdown();
    m_tweens.reset();
    m_assets.bind_audio_loader(nullptr);
    m_audio.shutdown();
    m_script_executor.shutdown();
    m_scripts.shutdown();
    m_renderer.shutdown();
    m_platform.shutdown();

    m_initialized = false;
    std::printf("[engine] shutdown complete\n");
}

void Engine::request_stop()
{
    m_running = false;
    m_platform.request_quit();
}

void Engine::set_demo_position(float normalized_x, float normalized_y)
{
    m_demo_position = {clamp01(normalized_x), clamp01(normalized_y)};
    preview_bridge::emit_state_changed(m_demo_position, m_preview_running);
}

void Engine::reset_demo_position() { set_demo_position(0.5f, 0.5f); }

void Engine::set_preview_running(bool running)
{
    m_preview_running = running;
    preview_bridge::emit_state_changed(m_demo_position, m_preview_running);
}

void Engine::set_show_fps_counter(bool show)
{
    m_show_fps_counter = show;
    m_fps_sample_frames = 0;
    m_fps_sample_start_counter = 0;
    if (!m_show_fps_counter) {
        preview_bridge::emit_fps(0.0f, 0.0f, static_cast<int>(m_fps_cap));
    }
}

void Engine::set_fps_cap(uint32_t frames_per_second)
{
    m_fps_cap = sanitize_fps_cap(frames_per_second);
    m_next_frame_counter = 0;
    m_fps_sample_frames = 0;
    m_fps_sample_start_counter = 0;
}

bool Engine::load_preview_rml_document(const std::string& rml)
{
    if (rml.empty() || !m_runtime_ui.is_initialized())
        return false;
    m_runtime_ui.hide_document("demo");
    m_runtime_ui.hide_document("runtime_game");
    m_runtime_ui.hide_document("runtime-acceptance");
    return m_runtime_ui.load_document_from_memory(kEditorPreviewDocumentId, rml,
                                                  kPreviewLayoutCurrentRml, true);
}

bool Engine::execute_preview_lua_script(const std::string& source)
{
    if (source.empty() || !m_scripts.is_initialized())
        return source.empty();
    auto result = m_scripts.execute(source, "editor_preview.lua");
    if (!result) {
        const auto& error = *result.error;
        std::fprintf(stderr, "[engine] editor preview Lua failed: %s\n%s\n", error.message.c_str(),
                     error.traceback.c_str());
        const std::string message =
            error.traceback.empty() ? error.message : error.message + "\n" + error.traceback;
        preview_bridge::emit_diagnostic("error", "lua", "/lua", message.c_str(),
                                        kPreviewLayoutCurrentLua);
        return false;
    }
    return true;
}

bool Engine::apply_editor_preview_document(const std::string& kind, const std::string& data_json)
{
    if (!m_runtime_ui.is_initialized())
        return false;

    nlohmann::json data;
    try {
        data = nlohmann::json::parse(data_json.empty() ? "{}" : data_json);
    } catch (const std::exception& error) {
        std::fprintf(stderr, "[engine] editor preview JSON failed to parse: %s\n", error.what());
        preview_bridge::emit_diagnostic("error", "preview-json", "", error.what());
        return false;
    }

    if (kind == "layout-preview") {
        const auto rml_source = inline_source_text(data, "rml");
        const auto rcss_source = inline_source_text(data, "rcss");
        const auto lua_source = inline_source_text(data, "lua");
        if (!rml_source || !rcss_source || !lua_source) {
            std::fprintf(
                stderr, "[engine] editor layout preview asset-mode sources are not resolved yet\n");
            preview_bridge::emit_diagnostic(
                "error", "layout-preview-source", "/rml|/rcss|/lua",
                "Editor layout preview asset-mode sources are not resolved yet.");
            return false;
        }

        m_runtime_ui.set_preview_virtual_file(kPreviewLayoutCurrentRcss,
                                              std::string(kPreviewBaseStyle) + "\n" + *rcss_source);
        m_runtime_ui.set_preview_virtual_file(kPreviewLayoutCurrentLua, *lua_source);
        const std::string fragment_host_rml =
            preview_template_text(data, "layoutFragmentHostRml", kLayoutFragmentHostRml);
        m_runtime_ui.set_preview_virtual_file(
            kPreviewLayoutFragmentHostRcss,
            preview_template_text(data, "layoutFragmentHostRcss", kLayoutFragmentHostRcss));

        const bool enabled = layout_script_enabled(data);
        if (enabled && !lua_source->empty() && !execute_preview_lua_script(*lua_source))
            return false;

        std::string rml;
        if (data.value("layoutKind", std::string("document")) == "fragment") {
            rml = layout_fragment_host_rml(fragment_host_rml, *rml_source);
        } else {
            const std::string source =
                rml_source->empty()
                    ? "<rml><head><title>Empty Layout Preview</title></head><body></body></rml>"
                    : *rml_source;
            rml = inject_head_content(
                source, "<link type=\"text/rcss\" href=\"preview://layout/current.rcss\" />");
        }
        m_runtime_ui.set_preview_virtual_file(kPreviewLayoutCurrentRml, rml);
        if (!load_preview_rml_document(rml)) {
            preview_bridge::emit_diagnostic("error", "rmlui-document", "/rml",
                                            "RmlUi failed to load the layout preview document.",
                                            kPreviewLayoutCurrentRml);
            return false;
        }
        return true;
    }

    if (kind == "shader-preview") {
        const auto shader_materials = data.find("shaderMaterials");
        if (shader_materials != data.end() && shader_materials->is_object()) {
            auto parsed = parse_shader_material_project_json_value(*shader_materials);
            for (const auto& diagnostic : parsed.diagnostics) {
                std::fprintf(stderr, "[engine] shader preview material diagnostic: %s: %s\n",
                             diagnostic.path.c_str(), diagnostic.message.c_str());
                const std::string severity(to_string(diagnostic.severity));
                preview_bridge::emit_diagnostic(severity.c_str(), "shader-material-preview",
                                                diagnostic.path.c_str(),
                                                diagnostic.message.c_str());
            }
            if (!parsed.project || parsed.has_errors()) {
                preview_bridge::emit_diagnostic("error", "shader-material-preview",
                                                "/shaderMaterials",
                                                "Shader preview material project contains errors.");
                return false;
            }
            m_shader_materials = std::move(*parsed.project);
            upsert_preview_material(
                m_shader_materials,
                data.value("previewMaterialId", std::string("editor/preview/shader/current")),
                data.value("shaderId", std::string{}));
            m_renderer.set_shader_material_project(&m_shader_materials);
        }

        std::string rml = preview_template_text(data, "shaderSquareRml", kShaderSquareRml);
        std::string rcss = preview_template_text(data, "shaderSquareRcss", kShaderSquareRcss);
        const std::string material_id =
            data.value("previewMaterialId", std::string("ui/noise_panel"));
        replace_all(rml, "href=\"shader-square-preview.rcss\"",
                    "href=\"preview://templates/shader-square-preview.rcss\"");
        replace_all(rml, "href='shader-square-preview.rcss'",
                    "href='preview://templates/shader-square-preview.rcss'");
        replace_all(rml, "__NT_PREVIEW_MATERIAL_ID__", material_id);
        replace_all(rcss, "__NT_PREVIEW_MATERIAL_ID__", material_id);
        m_runtime_ui.set_preview_virtual_file(kPreviewShaderSquareRml, rml);
        m_runtime_ui.set_preview_virtual_file(kPreviewShaderSquareRcss, rcss);
        if (!load_preview_rml_document(rml)) {
            preview_bridge::emit_diagnostic("error", "rmlui-document", "/template",
                                            "RmlUi failed to load the shader preview document.",
                                            kPreviewShaderSquareRml);
            return false;
        }
        return true;
    }

    std::fprintf(stderr, "[engine] unsupported editor preview document kind '%s'\n", kind.c_str());
    preview_bridge::emit_diagnostic("error", "preview-kind", "",
                                    "Unsupported editor preview kind.");
    return false;
}

AudioVoiceHandle Engine::play_audio_sfx(const std::string& path, float volume, float pitch)
{
    return m_audio.play_sfx(path, AudioSfxDesc{.volume = volume, .pitch = pitch});
}

AudioTrackHandle Engine::play_audio_track(const AudioTrackId& track_id, const std::string& path,
                                          float volume, bool loop)
{
    return m_audio.play_track(track_id, path,
                              AudioTrackDesc{.track_id = track_id, .volume = volume, .loop = loop});
}

void Engine::stop_audio_track(const AudioTrackId& track_id, float fade_seconds)
{
    m_audio.stop_track(track_id, fade_seconds);
}

} // namespace noveltea
