#include "noveltea/engine.hpp"

#include "noveltea/audio/audio_backend.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/core/editor_runtime_protocol.hpp"
#include "noveltea/core/json_access.hpp"
#include "noveltea/math/geometry.hpp"
#include "noveltea/render/material.hpp"
#include "noveltea/render/material_codec.hpp"
#include "noveltea/preview_bridge.hpp"
#include "noveltea/boundary/running_game_loader.hpp"
#include "platform/sdl/sdl_platform.hpp"

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
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#define MINIZ_NO_ZLIB_APIS
#if __has_include(<miniz/miniz.h>)
#include <miniz/miniz.h>
#else
#include <miniz.h>
#endif

namespace noveltea {

std::optional<std::string> RuntimeUiAssetResolver::resolve(const core::AssetId& asset) const
{
    if (!m_project)
        return std::nullopt;
    const auto* resource = m_project->find_asset(asset);
    if (!resource)
        return std::nullopt;
    return "project:/" + resource->path;
}

void RuntimeUiAssetResolver::bind(const runtime::RunningGame* runtime) noexcept
{
    m_project = runtime ? &runtime->package().project() : nullptr;
}

Engine::Engine()
    : m_audio(make_miniaudio_backend()),
      m_runtime_audio_adapter(m_audio, m_runtime_ui_asset_resolver),
      m_runtime_presentation(m_runtime_audio_adapter), m_runtime_preview(*this)
{
}
Engine::~Engine() { shutdown(); }

namespace {

bool demo_enabled(DemoMode selected, DemoMode queried)
{
    if (selected == DemoMode::None)
        return false;
    return selected == DemoMode::All || selected == queried;
}

constexpr uint32_t kMaxFpsCap = 1000;
#if defined(__EMSCRIPTEN__)
constexpr uint32_t kPreviewDisplayPaceCap = 60;
#endif
constexpr std::uint32_t kMaxAspectRatioComponent = 10'000;

core::PresentationPlane layout_plane(core::compiled::LayoutTarget target)
{
    switch (target) {
    case core::compiled::LayoutTarget::DefaultUi:
    case core::compiled::LayoutTarget::DialogueUi:
        return core::PresentationPlane::GameUi;
    case core::compiled::LayoutTarget::MenuUi:
        return core::PresentationPlane::MenuOverlay;
    case core::compiled::LayoutTarget::SceneOverlay:
    case core::compiled::LayoutTarget::RoomOverlay:
    case core::compiled::LayoutTarget::CustomOverlay:
        return core::PresentationPlane::WorldOverlay;
    }
    return core::PresentationPlane::GameUi;
}

std::string runtime_layout_document_id(std::string_view key, const core::LayoutId& layout)
{
    std::string result = "presentation_" + std::string(key) + "_" + layout.text();
    for (char& ch : result) {
        if (!std::isalnum(static_cast<unsigned char>(ch)) && ch != '-' && ch != '_')
            ch = '_';
    }
    return result;
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

struct ExtractedCompiledPackage {
    nlohmann::json gameplay;
    nlohmann::json manifest;
    std::optional<nlohmann::json> shader_materials;
    std::vector<core::RuntimePackageFile> files;
    std::shared_ptr<assets::MemoryAssetSource> assets;
};

bool safe_package_path(std::string_view path)
{
    if (path.empty() || path.front() == '/' || path.find('\\') != path.npos ||
        path.find(':') != path.npos)
        return false;
    std::size_t begin = 0;
    while (begin <= path.size()) {
        const auto end = path.find('/', begin);
        const auto part = path.substr(begin, end == path.npos ? path.size() - begin : end - begin);
        if (part.empty() || part == "." || part == "..")
            return false;
        if (end == path.npos)
            return true;
        begin = end + 1;
    }
    return true;
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

std::optional<ExtractedCompiledPackage>
extract_compiled_package(std::span<const std::uint8_t> bytes, std::string& error)
{
    mz_zip_archive archive{};
    if (!mz_zip_reader_init_mem(&archive, bytes.data(), bytes.size(), 0)) {
        error = "runtime package is not a valid ZIP archive";
        return std::nullopt;
    }
    ExtractedCompiledPackage result;
    result.assets = std::make_shared<assets::MemoryAssetSource>();
    const auto count = mz_zip_reader_get_num_files(&archive);
    for (mz_uint index = 0; index < count; ++index) {
        mz_zip_archive_file_stat stat{};
        if (!mz_zip_reader_file_stat(&archive, index, &stat)) {
            error = "runtime package entry metadata cannot be read";
            mz_zip_reader_end(&archive);
            return std::nullopt;
        }
        const std::string path = stat.m_filename;
        if (path.empty() || path.back() == '/')
            continue;
        if (!safe_package_path(path)) {
            error = "runtime package contains an unsafe entry path: " + path;
            mz_zip_reader_end(&archive);
            return std::nullopt;
        }
        size_t size = 0;
        void* extracted = mz_zip_reader_extract_to_heap(&archive, index, &size, 0);
        if (!extracted) {
            error = "runtime package entry cannot be read: " + path;
            mz_zip_reader_end(&archive);
            return std::nullopt;
        }
        const auto* first = static_cast<const std::uint8_t*>(extracted);
        assets::AssetBytes asset_bytes(first, first + size);
        if (path == "game" || path == "manifest.json" || path == "shader-materials.json") {
            auto document = nlohmann::json::parse(first, first + size, nullptr, false);
            if (document.is_discarded()) {
                mz_free(extracted);
                mz_zip_reader_end(&archive);
                error = "runtime package JSON entry is malformed: " + path;
                return std::nullopt;
            }
            if (path == "game")
                result.gameplay = std::move(document);
            else if (path == "manifest.json")
                result.manifest = std::move(document);
            else
                result.shader_materials = std::move(document);
        } else {
            result.assets->add(path, asset_bytes, "runtime package");
        }
        result.files.push_back({path, static_cast<std::uint64_t>(size), std::nullopt});
        mz_free(extracted);
    }
    mz_zip_reader_end(&archive);
    if (result.gameplay.is_null() || result.manifest.is_null()) {
        error = "runtime package is missing game or manifest.json";
        return std::nullopt;
    }
    return result;
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

[[maybe_unused]] std::string title_start_label(const nlohmann::json& root)
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
                                               return material.id.string() == material_id;
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
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                     "[assets] continuing without Android shader smoke asset");
    }
#endif
}

bool Engine::load_compiled_project(const std::string& logical_path, bool load_title_screen)
{
    m_tweens.reset();
    auto blob = m_assets.read_binary(logical_path);
    if (!blob) {
        std::fprintf(stderr, "[engine] failed to read compiled project %s: %s\n",
                     logical_path.c_str(), blob.error.c_str());
        return false;
    }

    const auto& bytes = blob.value->bytes;
    const std::string text(bytes.begin(), bytes.end());
    auto gameplay = nlohmann::json::parse(text, nullptr, false);
    core::Result<std::unique_ptr<runtime::RunningGame>, core::Diagnostics> loaded =
        core::Result<std::unique_ptr<runtime::RunningGame>, core::Diagnostics>::failure({});
    if (!gameplay.is_discarded()) {
        std::optional<nlohmann::json> shader_materials;
        auto shader_text = m_assets.read_text("project:/shader-materials.json");
        if (shader_text) {
            auto parsed = nlohmann::json::parse(*shader_text.value, nullptr, false);
            if (parsed.is_discarded()) {
                std::fprintf(stderr, "[engine] malformed project:/shader-materials.json\n");
                return false;
            }
            shader_materials = std::move(parsed);
        }
        loaded = runtime::load_running_game_preview(std::move(gameplay),
                                                    std::move(shader_materials), m_scripts,
                                                    m_runtime_presentation, *m_save_slots, "en");
    } else {
        std::string package_error;
        auto package = extract_compiled_package(
            std::span<const std::uint8_t>(bytes.data(), bytes.size()), package_error);
        if (!package) {
            std::fprintf(stderr, "[engine] compiled package load failed: %s\n",
                         package_error.c_str());
            return false;
        }
        m_assets.clear_namespace("project");
        m_assets.mount("project", package->assets);
        loaded = runtime::load_running_game(
            runtime::RunningGameLoadInput{.gameplay = std::move(package->gameplay),
                                          .manifest = std::move(package->manifest),
                                          .shader_materials = std::move(package->shader_materials),
                                          .files = std::move(package->files),
                                          .runtime_locale = "en"},
            m_scripts, m_runtime_presentation, *m_save_slots);
    }

    if (!loaded) {
        for (const auto& diagnostic : loaded.error()) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[runtime] %s %s %s",
                         diagnostic.code.c_str(), diagnostic.source_path.c_str(),
                         diagnostic.message.c_str());
            emit_preview_diagnostic(diagnostic);
        }
        return false;
    }

    m_runtime_ui.bind_runtime_input_handler({});
    m_pending_runtime_inputs.clear();
    m_runtime_layouts.reset();
    m_presentation_layout_instances.clear();
    m_title_layout_instance.reset();
    m_game_hud_layout_instance.reset();
    m_runtime_presentation.terminate(core::PresentationCancellationReason::ProjectReload);
    m_running_game = std::move(*loaded.value_if());
    m_runtime_ui_asset_resolver.bind(m_running_game.get());
    const auto& project = m_running_game->package().project();
    m_shader_materials =
        m_running_game->package().shader_materials().value_or(ShaderMaterialProject{});
    const auto& display = project.settings().display;
    m_display_profile.aspect_ratio =
        normalize_aspect_ratio({display.aspect_ratio.width, display.aspect_ratio.height});
    m_display_profile.orientation =
        display.orientation == core::compiled::DisplayOrientation::Portrait
            ? ScreenOrientation::Portrait
            : ScreenOrientation::Landscape;
    if (const auto parsed_color = parse_bar_color_rgba(display.bar_color))
        m_display_profile.bar_color_rgba = *parsed_color;
    m_presentation = make_presentation_metrics(
        m_platform.surface(), m_preview_display_override.value_or(m_display_profile));
    m_renderer.resize(m_presentation);
    m_runtime_ui.resize(m_presentation);

    assets::FontAssetConfig fonts;
    if (project.settings().text.default_font) {
        if (const auto* font = project.find_asset(*project.settings().text.default_font)) {
            fonts.default_alias = font->id.text();
            fonts.families.push_back(assets::FontFamilyAssetDesc{
                .alias = font->id.text(),
                .regular = FontDesc{.asset_path = "project:/" + font->path},
                .bold = std::nullopt,
                .italic = std::nullopt,
                .bold_italic = std::nullopt,
                .synthetic_styles = true});
        }
    }
    m_assets.configure_fonts(std::move(fonts));
    m_runtime_ui.bind_asset_resolver(&m_runtime_ui_asset_resolver);
    m_runtime_presentation.bind_snapshot_backend(
        [this](const core::RuntimePresentationSnapshot& snapshot) {
            return reconcile_presentation_layouts(snapshot);
        });
    m_runtime_presentation.bind_presentation_id_allocator(
        [this]() { return m_running_game->session().allocate_presentation_operation_id(); });
    m_runtime_ui.bind_runtime_input_handler(
        [this](const core::RuntimeInputMessage& input) { return dispatch_runtime_input(input); });
    if (!dispatch_runtime_input(core::RuntimeInputMessage{core::StartRuntimeInput{}})) {
        std::fprintf(stderr, "[engine] compiled-project startup transaction failed\n");
        m_runtime_ui.bind_runtime_input_handler({});
        m_runtime_presentation.terminate(core::PresentationCancellationReason::OwnerEnded);
        m_runtime_ui_asset_resolver.clear();
        m_running_game.reset();
        return false;
    }
    (void)dispatch_runtime_input(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    const auto game_hud = m_runtime_layouts.mount_builtin_game_hud(!load_title_screen);
    if (!game_hud) {
        std::fprintf(stderr, "[engine] failed to mount runtime game Layout\n");
        return false;
    }
    m_game_hud_layout_instance = *game_hud.value_if();
    if (load_title_screen) {
        const auto title = m_runtime_layouts.mount_builtin_title();
        if (!title) {
            std::fprintf(stderr, "[engine] failed to load compiled-project title document\n");
            m_runtime_layouts.reset();
            m_game_hud_layout_instance.reset();
            m_runtime_ui.bind_runtime_input_handler({});
            m_runtime_presentation.terminate(core::PresentationCancellationReason::OwnerEnded);
            m_runtime_ui_asset_resolver.clear();
            m_running_game.reset();
            return false;
        }
        m_title_layout_instance = *title.value_if();
        const auto& identity = project.identity();
        const auto& title_screen = project.settings().title_screen;
        m_runtime_ui.bind_title_document(title_screen.show_project_title ? identity.name
                                                                         : std::string{},
                                         title_screen.subtitle, title_screen.start_label);
    }
    SDL_Log("[engine] loaded compiled project: %s", logical_path.c_str());
    m_compiled_project_path = logical_path;
    return true;
}

core::Result<void, core::Diagnostics>
Engine::reconcile_presentation_layouts(const core::RuntimePresentationSnapshot& snapshot)
{
    if (!m_running_game)
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "presentation.layout_runtime_unavailable",
              .message = "Presentation Layout reconciliation requires a running game"}});
    const auto& project = m_running_game->package().project();

    struct Desired {
        std::string key;
        core::LayoutId layout;
        bool visible = true;
        std::int32_t local_order = 0;
    };
    std::vector<Desired> desired;
    for (const auto& slot : snapshot.layout_slots) {
        desired.push_back({"slot-" + std::to_string(static_cast<unsigned>(slot.slot)), slot.layout,
                           true, 100 + static_cast<std::int32_t>(slot.slot)});
    }
    for (const auto& overlay : snapshot.overlays) {
        desired.push_back({"overlay-" + overlay.room.text() + "-" + overlay.overlay.text(),
                           overlay.layout, overlay.visible, 200});
    }
    if (snapshot.map && snapshot.map->layout) {
        desired.push_back(
            {"map-" + snapshot.map->map.text(), *snapshot.map->layout, snapshot.map->visible, 300});
    }
    std::sort(desired.begin(), desired.end(),
              [](const auto& lhs, const auto& rhs) { return lhs.key < rhs.key; });

    const auto source_text = [&](const core::compiled::LayoutSource& source)
        -> core::Result<std::string, core::Diagnostics> {
        if (const auto* inline_source = std::get_if<core::compiled::InlineLayoutSource>(&source))
            return core::Result<std::string, core::Diagnostics>::success(inline_source->text);
        const auto& asset_id = std::get<core::compiled::AssetLayoutSource>(source).asset;
        const auto* asset = project.find_asset(asset_id);
        if (!asset)
            return core::Result<std::string, core::Diagnostics>::failure(
                {{.code = "presentation.layout_source_missing",
                  .message = "Layout source asset is missing: " + asset_id.text()}});
        auto text = m_assets.read_text("project:/" + asset->path);
        if (!text)
            return core::Result<std::string, core::Diagnostics>::failure(
                {{.code = "presentation.layout_source_unreadable", .message = text.error}});
        return core::Result<std::string, core::Diagnostics>::success(std::move(*text.value));
    };

    std::unordered_map<std::string, bool> retained;
    for (const auto& item : desired) {
        retained[item.key] = true;
        const auto* definition = project.find_layout(item.layout);
        if (!definition)
            return core::Result<void, core::Diagnostics>::failure(
                {{.code = "presentation.layout_missing",
                  .message = "Presentation Layout is missing: " + item.layout.text()}});

        if (const auto existing = m_presentation_layout_instances.find(item.key);
            existing != m_presentation_layout_instances.end() &&
            existing->second.layout == item.layout) {
            const bool visibility_ok = item.visible
                                           ? m_runtime_layouts.show(existing->second.instance)
                                           : m_runtime_layouts.hide(existing->second.instance);
            if (!visibility_ok)
                return core::Result<void, core::Diagnostics>::failure(
                    {{.code = "presentation.layout_visibility_failed",
                      .message = "Failed to reconcile Layout visibility: " + item.key}});
            existing->second.visible = item.visible;
            continue;
        }

        auto rml = source_text(definition->rml);
        auto rcss = source_text(definition->rcss);
        auto lua = source_text(definition->lua);
        if (!rml)
            return core::Result<void, core::Diagnostics>::failure(std::move(rml).error());
        if (!rcss)
            return core::Result<void, core::Diagnostics>::failure(std::move(rcss).error());
        if (!lua)
            return core::Result<void, core::Diagnostics>::failure(std::move(lua).error());

        std::string document;
        const std::string additions =
            "<style>" + *rcss.value_if() + "</style>" +
            (definition->script_enabled ? "<script>" + *lua.value_if() + "</script>" : "");
        if (definition->kind == core::compiled::LayoutKind::Fragment) {
            const std::string root = definition->default_parent.value_or("nt-layout-fragment-root");
            document = "<rml><head>" + additions + "</head><body><div id=\"" + root + "\">" +
                       *rml.value_if() + "</div></body></rml>";
        } else {
            document = *rml.value_if();
            const auto head_end = document.find("</head>");
            if (head_end == std::string::npos)
                return core::Result<void, core::Diagnostics>::failure(
                    {{.code = "presentation.layout_document_head_missing",
                      .message =
                          "Document Layout requires a head element: " + item.layout.text()}});
            document.insert(head_end, additions);
        }

        const std::string document_id = runtime_layout_document_id(item.key, item.layout);
        const std::string virtual_path = "project:/generated/layouts/" + document_id + ".rml";
        m_runtime_ui.set_preview_virtual_file(virtual_path, std::move(document));
        RuntimeLayoutMountRequest request;
        request.layout_id = item.layout.text();
        request.document_id = document_id;
        request.asset_path = virtual_path;
        request.owner = core::MountedLayoutOwner::Gameplay;
        request.policy = {.plane = layout_plane(definition->target),
                          .local_order = item.local_order,
                          .clock = core::LayoutClockDomain::Gameplay,
                          .input = core::LayoutInputMode::Normal,
                          .gameplay_pause = core::GameplayPausePolicy::Continue,
                          .visibility = item.visible ? core::LayoutVisibility::Visible
                                                     : core::LayoutVisibility::Hidden,
                          .escape_dismissal = core::EscapeDismissalPolicy::Ignore,
                          .entrance_operation = std::nullopt,
                          .exit_operation = std::nullopt};
        auto mounted = m_runtime_layouts.mount(std::move(request));
        if (!mounted)
            return core::Result<void, core::Diagnostics>::failure(std::move(mounted).error());
        if (const auto previous = m_presentation_layout_instances.find(item.key);
            previous != m_presentation_layout_instances.end())
            (void)m_runtime_layouts.unmount(previous->second.instance);
        m_presentation_layout_instances.insert_or_assign(
            item.key, RealizedPresentationLayout{*mounted.value_if(), item.layout, item.visible});
    }

    for (auto it = m_presentation_layout_instances.begin();
         it != m_presentation_layout_instances.end();) {
        if (!retained.contains(it->first)) {
            (void)m_runtime_layouts.unmount(it->second.instance);
            it = m_presentation_layout_instances.erase(it);
        } else {
            ++it;
        }
    }
    return core::Result<void, core::Diagnostics>::success();
}

bool Engine::initialize(const PlatformConfig& config, const EngineRunConfig& run_config)
{
    SDL_Log("[engine] initializing...");
    m_runtime_clock.reset();
    m_frame_clock = {};
    m_host_suspended = false;
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
            m_runtime_ui.bind_runtime_input_handler({});
            m_runtime_presentation.terminate(core::PresentationCancellationReason::OwnerEnded);
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

    configure_assets(run_config);

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

    const bool load_demo = demo_enabled(run_config.demo_mode, DemoMode::RmlUi);
    m_runtime_ui.resize(m_presentation);
    if (!m_runtime_ui.initialize(&m_assets, sdl_platform::native_window(m_platform), load_demo,
                                 &m_scripts, &m_shader_materials)) {
        std::fprintf(stderr, "[engine] runtime UI init failed; continuing without runtime UI\n");
    } else {
        m_runtime_layouts.bind_runtime_ui(&m_runtime_ui);
        m_runtime_ui.bind_layout_gameplay_admission([this]() {
            return m_runtime_layouts.evaluate_input_policy().gameplay ==
                   GameplayInputDisposition::Eligible;
        });
        m_runtime_ui.bind_game_started_handler([this]() {
            if (m_title_layout_instance)
                (void)m_runtime_layouts.hide(*m_title_layout_instance);
            if (m_game_hud_layout_instance)
                (void)m_runtime_layouts.show(*m_game_hud_layout_instance);
        });
        m_runtime_ui.set_rmlui_base_direct_compatibility(run_config.rmlui_base_direct_compat);
        if (m_render_perf_logging) {
            m_runtime_ui.enable_render_perf_logging(true);
            SDL_Log("[engine] renderer perf logging enabled");
        }
        if (!run_config.runtime_ui_document.empty()) {
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

    m_save_slots = run_config.save_slot_store ? run_config.save_slot_store : &m_typed_saves;
    const bool using_automatic_demo_project = run_config.compiled_project.empty() && load_demo;
    const std::string compiled_project =
        !run_config.compiled_project.empty()
            ? run_config.compiled_project
            : (load_demo ? "project:/projects/runtime_phase9_package.ntpkg" : std::string{});
    if (!compiled_project.empty() &&
        !load_compiled_project(compiled_project, !using_automatic_demo_project)) {
        rollback();
        return false;
    }
    if (using_automatic_demo_project) {
        // The automatically loaded fixture exists only to provide a real typed runtime session to
        // the standalone RmlUi demo. Keep the sandbox demo's built-in renderer materials; an
        // explicitly requested compiled project still replaces the material registry normally.
        m_shader_materials = make_demo_shader_materials();
        m_renderer.set_shader_material_project(&m_shader_materials);
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

void Engine::resize(const SurfaceMetrics& surface) { resize_host(surface); }

void Engine::set_preview_display_override(std::optional<DisplayProfile> profile)
{
    m_preview_display_override = std::move(profile);
    m_presentation = make_presentation_metrics(
        m_platform.surface(), m_preview_display_override.value_or(m_display_profile));
    m_renderer.resize(m_presentation);
    m_runtime_ui.resize(m_presentation);
}

void Engine::resize_host(const SurfaceMetrics& surface)
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
    const IntegerRect& viewport = m_presentation.host_logical_viewport;
    SDL_Log("[surface] host=%dx%d framebuffer=%dx%d game=(%d,%d %dx%d)", sanitized.logical_width,
            sanitized.logical_height, sanitized.framebuffer_width, sanitized.framebuffer_height,
            viewport.x, viewport.y, viewport.width, viewport.height);
}

void Engine::handle_events()
{
    m_platform.poll_events();

    for (const SDL_Event& event : sdl_platform::events(m_platform)) {
        // SDL event -> devtools -> runtime UI -> game/platform handling.
        if (m_debug_ui_enabled) {
            m_debug_ui.process_event(event, m_platform.surface());
        }
        const bool ui_consumed = m_runtime_ui.process_event(event, m_presentation);
        const auto layout_input = m_runtime_layouts.evaluate_input_policy();
        const bool gameplay_blocked =
            layout_input.gameplay == GameplayInputDisposition::BlockedByLayout;

        switch (event.type) {
        case SDL_EVENT_QUIT:
            m_platform.request_quit();
            break;

        case SDL_EVENT_WINDOW_MINIMIZED:
        case SDL_EVENT_WINDOW_FOCUS_LOST:
        case SDL_EVENT_DID_ENTER_BACKGROUND:
            m_host_suspended = true;
            m_audio.pause();
            break;

        case SDL_EVENT_WINDOW_RESTORED:
        case SDL_EVENT_WINDOW_FOCUS_GAINED:
        case SDL_EVENT_DID_ENTER_FOREGROUND:
            m_host_suspended = false;
            m_audio.resume();
            break;

        case SDL_EVENT_KEY_DOWN:
            if (event.key.key == SDLK_ESCAPE) {
                if (const auto dismissal = m_runtime_layouts.escape_dismissal_target()) {
                    (void)m_runtime_layouts.dismiss_escape_target(*dismissal);
                    break;
                }
                if (ui_consumed || gameplay_blocked)
                    break;
                m_platform.request_quit();
                break;
            }
            if (ui_consumed || gameplay_blocked)
                break;
            std::printf("[input] key_down: scancode=%d\n", event.key.scancode);
            break;

        case SDL_EVENT_MOUSE_BUTTON_DOWN:
            if (const auto point =
                    host_to_game_logical({event.button.x, event.button.y}, m_presentation)) {
                m_pointer_position = *point;
                m_pointer_valid = true;
            } else {
                m_pointer_valid = false;
                break;
            }
            if (ui_consumed || gameplay_blocked)
                break;
            std::printf(
                "[input] mouse_down: button=%d logical=(%.2f,%.2f) surface=%dx%d scale=%.3fx%.3f\n",
                event.button.button, event.button.x, event.button.y, m_platform.logical_width(),
                m_platform.logical_height(), m_platform.scale_x(), m_platform.scale_y());
            handle_mouse_down(m_pointer_position.x, m_pointer_position.y, event.button.button);
            break;

        case SDL_EVENT_MOUSE_BUTTON_UP:
            if (const auto point =
                    host_to_game_logical({event.button.x, event.button.y}, m_presentation)) {
                m_pointer_position = *point;
                m_pointer_valid = true;
            } else {
                m_pointer_valid = false;
            }
            if (ui_consumed || gameplay_blocked)
                break;
            break;
        case SDL_EVENT_MOUSE_MOTION:
            if (const auto point =
                    host_to_game_logical({event.motion.x, event.motion.y}, m_presentation)) {
                m_pointer_position = *point;
                m_pointer_valid = true;
            } else {
                m_pointer_valid = false;
            }
            if (ui_consumed || gameplay_blocked)
                break;
            break;
        case SDL_EVENT_MOUSE_WHEEL:
        case SDL_EVENT_TEXT_INPUT:
        case SDL_EVENT_KEY_UP:
        case SDL_EVENT_FINGER_DOWN:
        case SDL_EVENT_FINGER_UP:
        case SDL_EVENT_FINGER_MOTION:
        case SDL_EVENT_FINGER_CANCELED:
            if (ui_consumed || gameplay_blocked)
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

void Engine::update(double host_delta_seconds)
{
    std::vector<core::MountedLayoutInstance> mounted_layouts;
    mounted_layouts.reserve(m_runtime_layouts.mounted_layouts().size());
    for (const auto& mounted : m_runtime_layouts.mounted_layouts())
        mounted_layouts.push_back(mounted.mounted);
    const bool explicit_pause =
        m_running_game && m_running_game->session().explicit_gameplay_paused();
    auto effective_pause = core::derive_effective_gameplay_pause(
        explicit_pause, mounted_layouts, m_host_suspended, !m_preview_running);
    if (m_running_game)
        m_running_game->session().set_effective_gameplay_pause(effective_pause);
    const auto advanced =
        m_runtime_clock.advance(host_delta_seconds, effective_pause.paused, m_host_suspended);
    if (!advanced) {
        std::fprintf(stderr, "[engine] runtime clock failed: %s\n",
                     advanced.error().message.c_str());
        m_frame_clock = m_runtime_clock.current();
        m_frame_clock.sanitized_host_delta = std::chrono::microseconds{0};
        m_frame_clock.unscaled_presentation_delta = std::chrono::microseconds{0};
        m_frame_clock.gameplay_delta = std::chrono::microseconds{0};
        m_frame_clock.host_delta_clamped = false;
        return;
    }
    m_frame_clock = *advanced.value_if();
    const auto& clocks = m_frame_clock;
    const auto seconds = [](std::chrono::microseconds duration) {
        return std::chrono::duration<double>(duration).count();
    };
    // Backend audio currently advances on the unscaled presentation clock. Desired-audio and
    // semantic pause policy remain presentation/runtime concerns above the backend.
    m_audio.update(static_cast<float>(seconds(clocks.unscaled_presentation_delta)));
    if (!m_preview_running)
        return;
    if (m_running_game) {
        auto presentation = m_runtime_presentation.poll_audio();
        m_runtime_ui.append_typed_runtime_diagnostics(std::move(presentation.diagnostics));
        for (const auto& next : presentation.inputs)
            (void)dispatch_runtime_input(next);
    }
    if (m_running_game) {
        (void)dispatch_runtime_input(
            core::RuntimeInputMessage{core::AdvanceTimeInput{clocks.gameplay_delta}});
    }
}

bool Engine::dispatch_runtime_input(const core::RuntimeInputMessage& input)
{
    if (!m_running_game)
        return false;

    bool accepted = true;
    auto pending = std::move(m_pending_runtime_inputs);
    m_pending_runtime_inputs.clear();
    for (const auto& pending_input : pending)
        accepted = dispatch_runtime_input_once(pending_input) && accepted;
    return dispatch_runtime_input_once(input) && accepted;
}

bool Engine::dispatch_runtime_input_once(const core::RuntimeInputMessage& input)
{
    if (!m_running_game)
        return false;

    auto result = m_running_game->session().dispatch(input);
    bool accepted = result.disposition != runtime::RuntimeInputDisposition::Failed;
    if (!result.diagnostics.empty()) {
        for (const auto& diagnostic : result.diagnostics) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[runtime] %s %s %s",
                         diagnostic.code.c_str(), diagnostic.source_path.c_str(),
                         diagnostic.message.c_str());
        }
        accepted = false;
        m_runtime_ui.append_typed_runtime_diagnostics(std::move(result.diagnostics));
    }

    if (result.publication) {
        auto reconciled =
            m_runtime_presentation.reconcile_publication(result.publication->presentation);
        if (!reconciled.empty()) {
            accepted = false;
            m_runtime_ui.append_typed_runtime_diagnostics(std::move(reconciled));
        }
        m_runtime_ui.apply_runtime_publication(*result.publication);
    }
    m_runtime_ui.deliver_runtime_events(result.events);
    return flush_runtime_presentation() && accepted;
}

bool Engine::flush_runtime_presentation()
{
    if (!m_running_game)
        return true;

    bool accepted = true;
    auto active_text =
        m_runtime_presentation.set_active_text_phase(m_runtime_ui.active_text_presentation_phase());
    if (!active_text.empty()) {
        for (const auto& diagnostic : active_text) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[runtime-presentation] %s %s %s",
                         diagnostic.code.c_str(), diagnostic.source_path.c_str(),
                         diagnostic.message.c_str());
        }
        accepted = false;
        m_runtime_ui.append_typed_runtime_diagnostics(std::move(active_text));
    }

    auto flushed = m_runtime_presentation.flush();
    if (!flushed.diagnostics.empty()) {
        for (const auto& diagnostic : flushed.diagnostics) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[runtime-presentation] %s %s %s",
                         diagnostic.code.c_str(), diagnostic.source_path.c_str(),
                         diagnostic.message.c_str());
        }
        accepted = false;
        m_runtime_ui.append_typed_runtime_diagnostics(std::move(flushed.diagnostics));
    }
    m_pending_runtime_inputs.insert(m_pending_runtime_inputs.end(),
                                    std::make_move_iterator(flushed.inputs.begin()),
                                    std::make_move_iterator(flushed.inputs.end()));
    return accepted;
}

void Engine::render()
{
    if (m_debug_ui_enabled) {
        m_debug_ui.begin_frame(m_presentation.host_surface);
    }
    const auto& clocks = m_frame_clock;
    const float unscaled_time_seconds =
        std::chrono::duration<float>(clocks.unscaled_presentation_time).count();
    m_runtime_ui.begin_frame(clocks);
    (void)flush_runtime_presentation();
    ShaderStandardInputs shader_inputs;
    shader_inputs.time_seconds = unscaled_time_seconds;
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
        m_renderer.draw_demo_2d(unscaled_time_seconds);
    }
    if (demo_enabled(m_demo_mode, DemoMode::Text)) {
        m_renderer.draw_demo_text(unscaled_time_seconds);
    }

    ++m_frame_count;

    m_runtime_ui.end_frame();
    if (m_runtime_ui.active_text_direct_render_enabled()) {
        m_renderer.draw_active_text(m_runtime_ui.active_text_render_snapshot());
    }
    const float transition_opacity = 0.0f;
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
    m_runtime_ui.bind_runtime_input_handler({});
    m_pending_runtime_inputs.clear();
    m_runtime_layouts.reset();
    m_runtime_layouts.bind_runtime_ui(nullptr);
    m_runtime_presentation.terminate(core::PresentationCancellationReason::OwnerEnded);
    m_running_game.reset();
    m_runtime_ui_asset_resolver.clear();
    m_runtime_ui.shutdown();
    m_tweens.reset();
    m_runtime_clock.reset();
    m_frame_clock = {};
    m_host_suspended = false;
    m_assets.bind_audio_loader(nullptr);
    m_audio.shutdown();
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
        const auto& error = result.error();
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

    auto data = nlohmann::json::parse(data_json.empty() ? "{}" : data_json, nullptr, false);
    if (data.is_discarded()) {
        std::fprintf(stderr, "[engine] editor preview JSON failed to parse\n");
        preview_bridge::emit_diagnostic("error", "preview-json", "", "Malformed preview JSON");
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
        if (core::json_access::value_or(data, "layoutKind", std::string("document")) ==
            "fragment") {
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
                core::json_access::value_or(data, "previewMaterialId",
                                            std::string("editor/preview/shader/current")),
                core::json_access::value_or(data, "shaderId", std::string{}));
            m_renderer.set_shader_material_project(&m_shader_materials);
        }

        std::string rml = preview_template_text(data, "shaderSquareRml", kShaderSquareRml);
        std::string rcss = preview_template_text(data, "shaderSquareRcss", kShaderSquareRcss);
        const std::string material_id =
            core::json_access::value_or(data, "previewMaterialId", std::string("ui/noise_panel"));
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
