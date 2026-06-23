#include <catch2/catch_test_macros.hpp>

#include "noveltea/render/material.hpp"

#include <array>
#include <string>
#include <string_view>
#include <variant>

namespace {

using noveltea::MaterialDiagnosticCode;
using noveltea::MaterialParseResult;

[[nodiscard]] std::string valid_engine_material_json(std::string_view type = "engine-2d")
{
    return std::string(R"json({
  "schema": "noveltea.material.v1",
  "type": ")json") +
           std::string(type) + R"json(",
  "display_name": "Water Sprite",
  "shader": {
    "vertex": "system:/shaders/materials/engine_2d.vs.sc",
    "fragment": "project:/shaders/world/water.fs.sc"
  },
  "uniforms": {
    "u_wave_strength": { "type": "float", "default": 0.15, "range": [0.0, 1.0] },
    "u_offset": { "type": "vec2", "default": [1.0, 2.0] },
    "u_tint": { "type": "color", "default": "#66ccffff", "editor": { "label": "Tint" } },
    "u_enabled": { "type": "bool", "default": true },
    "u_mode": { "type": "int", "default": 2 }
  },
  "textures": {
    "s_albedo": { "source": "$draw.texture", "sampler": "clamp-linear" },
    "s_noise": { "source": "project:/textures/water_noise.png", "sampler": "repeat-linear" }
  },
  "inputs": {
    "u_time": "engine.time"
  },
  "blend": "premultiplied-alpha"
})json";
}

[[nodiscard]] std::string valid_rmlui_material_json()
{
    return R"json({
  "schema": "noveltea.material.v1",
  "type": "rmlui-decorator",
  "display_name": "Noise Panel",
  "shader": {
    "vertex": "system:/shaders/materials/rmlui_decorator.vs.sc",
    "fragment": "project:/shaders/ui/noise_panel.fs.sc"
  },
  "uniforms": {
    "u_amount": { "type": "float", "default": 0.25 },
    "u_dimensions_scale": { "type": "vec4", "default": [1.0, 2.0, 3.0, 4.0] }
  },
  "textures": {
    "s_noise": { "source": "project:/textures/noise.png", "sampler": "clamp-linear" }
  },
  "inputs": {
    "u_time": "engine.time",
    "u_dimensions": "rmlui.paint_dimensions",
    "u_dpi_scale": "rmlui.dpi_scale"
  },
  "blend": "premultiplied-alpha"
})json";
}

[[nodiscard]] bool has_code(const MaterialParseResult& result, MaterialDiagnosticCode code)
{
    for (const auto& diagnostic : result.diagnostics) {
        if (diagnostic.code == code)
            return true;
    }
    return false;
}

[[nodiscard]] bool has_id_code(const noveltea::MaterialIdParseResult& result,
                               MaterialDiagnosticCode code)
{
    for (const auto& diagnostic : result.diagnostics) {
        if (diagnostic.code == code)
            return true;
    }
    return false;
}

[[nodiscard]] const noveltea::MaterialUniform* find_uniform(const noveltea::MaterialAsset& material,
                                                            std::string_view name)
{
    for (const auto& uniform : material.uniforms) {
        if (uniform.name == name)
            return &uniform;
    }
    return nullptr;
}

[[nodiscard]] const noveltea::MaterialInputBinding*
find_input(const noveltea::MaterialAsset& material, std::string_view name)
{
    for (const auto& input : material.inputs) {
        if (input.uniform == name)
            return &input;
    }
    return nullptr;
}

} // namespace

TEST_CASE("material ids normalize aliases and project paths")
{
    CHECK(noveltea::parse_material_id("ui/noise_panel").id->value() ==
          "project:/materials/ui/noise_panel.ntmat");
    CHECK(noveltea::parse_material_id("ui/noise_panel.ntmat").id->value() ==
          "project:/materials/ui/noise_panel.ntmat");
    CHECK(noveltea::parse_material_id("materials/ui/noise_panel.ntmat").id->value() ==
          "project:/materials/ui/noise_panel.ntmat");
    CHECK(noveltea::parse_material_id("project:/materials/ui/noise_panel.ntmat").id->value() ==
          "project:/materials/ui/noise_panel.ntmat");
    CHECK(
        noveltea::parse_material_id("system:/materials/rmlui/default_checker.ntmat").id->value() ==
        "system:/materials/rmlui/default_checker.ntmat");
}

TEST_CASE("material ids reject unsafe or ambiguous references")
{
    for (const std::string_view id :
         {"", "/materials/foo.ntmat", "../foo", "ui/../foo", "ui//foo", "C:/foo", "ui/foo.json",
          "project:/textures/foo.png", "project:/materials/foo.json"}) {
        const auto result = noveltea::parse_material_id(id);
        CHECK_FALSE(result.ok());
        CHECK(has_id_code(result, MaterialDiagnosticCode::InvalidMaterialId));
    }
}

TEST_CASE("valid engine 2d material parses into runtime model")
{
    const auto result = noveltea::parse_material_json(valid_engine_material_json(), "world/water");
    REQUIRE(result.ok());
    REQUIRE(result.material);

    const auto& material = *result.material;
    CHECK(material.id.value() == "project:/materials/world/water.ntmat");
    CHECK(material.type == noveltea::MaterialType::Engine2D);
    CHECK(material.display_name == "Water Sprite");
    CHECK(material.shader.vertex.path == "system:/shaders/materials/engine_2d.vs.sc");
    CHECK(material.shader.fragment.path == "project:/shaders/world/water.fs.sc");
    CHECK(material.uniforms.size() == 5);
    CHECK(material.textures.size() == 2);
    CHECK(material.inputs.size() == 1);
    CHECK(material.blend == noveltea::MaterialBlendMode::PremultipliedAlpha);

    const auto* tint = find_uniform(material, "u_tint");
    REQUIRE(tint != nullptr);
    REQUIRE(std::holds_alternative<noveltea::MaterialColor>(tint->default_value));
    const auto color = std::get<noveltea::MaterialColor>(tint->default_value);
    CHECK(color.r > 0.39f);
    CHECK(color.g > 0.79f);
    CHECK(color.b == 1.0f);
    CHECK(color.a == 1.0f);
}

TEST_CASE("valid rmlui decorator material parses into runtime model")
{
    const auto result =
        noveltea::parse_material_json(valid_rmlui_material_json(), "ui/noise_panel");
    REQUIRE(result.ok());
    REQUIRE(result.material);

    const auto& material = *result.material;
    CHECK(material.type == noveltea::MaterialType::RmlUiDecorator);
    CHECK(material.id.value() == "project:/materials/ui/noise_panel.ntmat");
    CHECK(material.inputs.size() == 3);
    const auto* dimensions = find_input(material, "u_dimensions");
    const auto* dpi_scale = find_input(material, "u_dpi_scale");
    REQUIRE(dimensions != nullptr);
    REQUIRE(dpi_scale != nullptr);
    CHECK(dimensions->semantic == noveltea::MaterialInputSemantic::RmlUiPaintDimensions);
    CHECK(dpi_scale->semantic == noveltea::MaterialInputSemantic::RmlUiDpiScale);
}

TEST_CASE("deferred material types are recognized but rejected for action 2")
{
    for (const std::string_view type : {"rmlui-filter", "postprocess"}) {
        const auto result =
            noveltea::parse_material_json(valid_engine_material_json(type), "fx/deferred");
        CHECK_FALSE(result.ok());
        CHECK(has_code(result, MaterialDiagnosticCode::DeferredMaterialType));
    }
}

TEST_CASE("material parser reports representative schema diagnostics")
{
    CHECK(has_code(noveltea::parse_material_json("{}", "bad/schema"),
                   MaterialDiagnosticCode::MissingRequiredField));

    CHECK(has_code(noveltea::parse_material_json(R"json({"schema":"wrong"})json", "bad/schema"),
                   MaterialDiagnosticCode::InvalidSchema));

    CHECK(has_code(noveltea::parse_material_json(R"json({)json", "bad/json"),
                   MaterialDiagnosticCode::InvalidJson));

    CHECK(has_code(noveltea::parse_material_json(R"json({
        "schema":"noveltea.material.v1",
        "type":"mystery",
        "shader":{"vertex":"system:/a.vs.sc","fragment":"system:/a.fs.sc"},
        "blend":"premultiplied-alpha"
    })json",
                                                 "bad/type"),
                   MaterialDiagnosticCode::UnknownMaterialType));
}

TEST_CASE("material parser reports invalid shader and blend diagnostics")
{
    CHECK(has_code(noveltea::parse_material_json(R"json({
        "schema":"noveltea.material.v1",
        "type":"engine-2d",
        "blend":"premultiplied-alpha"
    })json",
                                                 "bad/missing-shader"),
                   MaterialDiagnosticCode::MissingRequiredField));

    CHECK(has_code(noveltea::parse_material_json(R"json({
        "schema":"noveltea.material.v1",
        "type":"engine-2d",
        "shader":{"vertex":"../bad.vs.sc","fragment":"system:/ok.fs.sc"},
        "blend":"premultiplied-alpha"
    })json",
                                                 "bad/shader"),
                   MaterialDiagnosticCode::InvalidShaderRef));

    CHECK(has_code(noveltea::parse_material_json(R"json({
        "schema":"noveltea.material.v1",
        "type":"engine-2d",
        "shader":{"vertex":"system:/ok.vs.sc","fragment":"system:/ok.fs.sc"},
        "blend":"additive"
    })json",
                                                 "bad/blend"),
                   MaterialDiagnosticCode::UnsupportedBlendPolicy));
}

TEST_CASE("material parser reports uniform diagnostics")
{
    CHECK(has_code(noveltea::parse_material_json(R"json({
        "schema":"noveltea.material.v1",
        "type":"engine-2d",
        "shader":{"vertex":"system:/ok.vs.sc","fragment":"system:/ok.fs.sc"},
        "uniforms":{"amount":{"type":"float","default":0.5}},
        "blend":"premultiplied-alpha"
    })json",
                                                 "bad/uniform-name"),
                   MaterialDiagnosticCode::InvalidUniformDeclaration));

    CHECK(has_code(noveltea::parse_material_json(R"json({
        "schema":"noveltea.material.v1",
        "type":"engine-2d",
        "shader":{"vertex":"system:/ok.vs.sc","fragment":"system:/ok.fs.sc"},
        "uniforms":{"u_amount":{"type":"float","default":"not a float"}},
        "blend":"premultiplied-alpha"
    })json",
                                                 "bad/uniform-default"),
                   MaterialDiagnosticCode::InvalidUniformDefault));

    CHECK(has_code(noveltea::parse_material_json(R"json({
        "schema":"noveltea.material.v1",
        "type":"engine-2d",
        "shader":{"vertex":"system:/ok.vs.sc","fragment":"system:/ok.fs.sc"},
        "uniforms":{"u_tint":{"type":"color","default":"#zzzzzz"}},
        "blend":"premultiplied-alpha"
    })json",
                                                 "bad/color"),
                   MaterialDiagnosticCode::InvalidUniformDefault));
}

TEST_CASE("material parser reports texture and input diagnostics")
{
    CHECK(has_code(noveltea::parse_material_json(R"json({
        "schema":"noveltea.material.v1",
        "type":"engine-2d",
        "shader":{"vertex":"system:/ok.vs.sc","fragment":"system:/ok.fs.sc"},
        "textures":{"albedo":{"source":"project:/textures/a.png","sampler":"clamp-linear"}},
        "blend":"premultiplied-alpha"
    })json",
                                                 "bad/texture-name"),
                   MaterialDiagnosticCode::InvalidTextureSlotName));

    CHECK(has_code(noveltea::parse_material_json(R"json({
        "schema":"noveltea.material.v1",
        "type":"engine-2d",
        "shader":{"vertex":"system:/ok.vs.sc","fragment":"system:/ok.fs.sc"},
        "textures":{"s_albedo":{"source":"../a.png","sampler":"clamp-linear"}},
        "blend":"premultiplied-alpha"
    })json",
                                                 "bad/texture-source"),
                   MaterialDiagnosticCode::InvalidTextureSource));

    CHECK(has_code(noveltea::parse_material_json(R"json({
        "schema":"noveltea.material.v1",
        "type":"engine-2d",
        "shader":{"vertex":"system:/ok.vs.sc","fragment":"system:/ok.fs.sc"},
        "textures":{"s_albedo":{"source":"project:/textures/a.png","sampler":"mirror-linear"}},
        "blend":"premultiplied-alpha"
    })json",
                                                 "bad/sampler"),
                   MaterialDiagnosticCode::UnsupportedSampler));

    CHECK(has_code(noveltea::parse_material_json(R"json({
        "schema":"noveltea.material.v1",
        "type":"engine-2d",
        "shader":{"vertex":"system:/ok.vs.sc","fragment":"system:/ok.fs.sc"},
        "inputs":{"u_time":"runtime.state.clock"},
        "blend":"premultiplied-alpha"
    })json",
                                                 "bad/input"),
                   MaterialDiagnosticCode::UnknownInputBinding));
}

TEST_CASE("fallback material records are valid backend-neutral assets")
{
    const auto engine_fallback = noveltea::make_engine_2d_fallback_material();
    CHECK(engine_fallback.fallback);
    CHECK(engine_fallback.id.value() == "system:/materials/fallback/engine_2d_error.ntmat");
    CHECK(engine_fallback.type == noveltea::MaterialType::Engine2D);
    CHECK_FALSE(engine_fallback.shader.vertex.empty());
    CHECK_FALSE(engine_fallback.shader.fragment.empty());

    const auto rmlui_fallback = noveltea::make_rmlui_decorator_fallback_material();
    CHECK(rmlui_fallback.fallback);
    CHECK(rmlui_fallback.id.value() == "system:/materials/fallback/rmlui_decorator_error.ntmat");
    CHECK(rmlui_fallback.type == noveltea::MaterialType::RmlUiDecorator);
    CHECK_FALSE(rmlui_fallback.inputs.empty());
}
