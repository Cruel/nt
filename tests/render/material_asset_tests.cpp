#include <catch2/catch_test_macros.hpp>

#include "noveltea/render/material.hpp"

#include <string_view>
#include <variant>

namespace {
using noveltea::MaterialDiagnosticCode;
using noveltea::ShaderMaterialProjectParseResult;

bool has_code(const ShaderMaterialProjectParseResult& result, MaterialDiagnosticCode code)
{
    for (const auto& diagnostic : result.diagnostics) {
        if (diagnostic.code == code)
            return true;
    }
    return false;
}

bool has_code(const noveltea::MaterialIdParseResult& result, MaterialDiagnosticCode code)
{
    for (const auto& diagnostic : result.diagnostics) {
        if (diagnostic.code == code)
            return true;
    }
    return false;
}

bool has_code(const noveltea::ShaderIdParseResult& result, MaterialDiagnosticCode code)
{
    for (const auto& diagnostic : result.diagnostics) {
        if (diagnostic.code == code)
            return true;
    }
    return false;
}

const noveltea::ShaderUniformDeclaration* find_uniform(const noveltea::ShaderDefinition& shader,
                                                       std::string_view name)
{
    for (const auto& uniform : shader.uniforms) {
        if (uniform.name == name)
            return &uniform;
    }
    return nullptr;
}

const noveltea::MaterialUniformAssignment*
find_assignment(const noveltea::MaterialDefinition& material, std::string_view name)
{
    for (const auto& uniform : material.uniforms) {
        if (uniform.name == name)
            return &uniform;
    }
    return nullptr;
}
} // namespace

TEST_CASE("shader and material ids are schema ids")
{
    CHECK(noveltea::parse_shader_id("soft_noise").id->value() == "soft_noise");
    CHECK(noveltea::parse_shader_id("text/default").id->value() == "text/default");
    CHECK(noveltea::parse_material_id("ui/noise_panel").id->value() == "ui/noise_panel");

    for (const std::string_view id :
         {"", "/foo", "ui//foo", "project:/materials/foo", "ui/noise_panel.ntmat"}) {
        const auto material_id = noveltea::parse_material_id(id);
        CHECK_FALSE(material_id.ok());
        CHECK(has_code(material_id, MaterialDiagnosticCode::InvalidMaterialId));

        const auto shader_id = noveltea::parse_shader_id(id);
        CHECK_FALSE(shader_id.ok());
        CHECK(has_code(shader_id, MaterialDiagnosticCode::InvalidShaderId));
    }
}

TEST_CASE("project shader and material records parse")
{
    const auto result = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "soft_noise":{
          "display_name":"Soft Noise",
          "stages":{
            "fragment":{
              "source":"project:/shaders/ui/soft_noise.fs.sc",
              "compiled":{
                "glsl-120":"shaders/bgfx/glsl-120/soft_noise.fs.bin",
                "essl-100":"shaders/bgfx/essl-100/soft_noise.fs.bin"
              }
            }
          },
          "uniforms":{
            "u_amount":{"type":"float","default":0.25,"range":[0.0,1.0]},
            "u_tint":{"type":"color","default":"#66ccffff"},
            "u_time":{"type":"float","binding":"engine.time"}
          },
          "samplers":{"s_noise":{"type":"texture2d"}},
          "roles":["rmlui-decorator","engine-2d"]
        }
      },
      "materials":{
        "ui/noise_panel":{
          "display_name":"Noise Panel",
          "role":"rmlui-decorator",
          "shader":"soft_noise",
          "uniforms":{"u_amount":0.5,"u_tint":"#ffffffff"},
          "textures":{"s_noise":{"source":"project:/textures/noise.png","sampler":"clamp-linear"}},
          "blend":"premultiplied-alpha"
        },
        "world/water":{
          "role":"engine-2d",
          "shader":"soft_noise",
          "textures":{"s_noise":"$draw.texture"}
        }
      }
    })json");

    REQUIRE(result.ok());
    REQUIRE(result.project);

    const auto* shader =
        noveltea::find_shader(*result.project, *noveltea::parse_shader_id("soft_noise").id);
    REQUIRE(shader != nullptr);
    CHECK(shader->display_name == "Soft Noise");
    REQUIRE(shader->stages.size() == 1);
    CHECK(shader->stages[0].stage == noveltea::ShaderStage::Fragment);
    CHECK(shader->stages[0].compiled.size() == 2);
    CHECK(shader->roles.size() == 2);
    REQUIRE(find_uniform(*shader, "u_time") != nullptr);
    REQUIRE(find_uniform(*shader, "u_time")->binding);
    CHECK(*find_uniform(*shader, "u_time")->binding == noveltea::ShaderInputSemantic::EngineTime);

    const auto* material =
        noveltea::find_material(*result.project, *noveltea::parse_material_id("ui/noise_panel").id);
    REQUIRE(material != nullptr);
    CHECK(material->role == noveltea::ShaderRole::RmlUiDecorator);
    CHECK(material->shader.value() == "soft_noise");
    REQUIRE(find_assignment(*material, "u_amount") != nullptr);
    CHECK(std::holds_alternative<float>(find_assignment(*material, "u_amount")->value));

    const auto* world_material =
        noveltea::find_material(*result.project, *noveltea::parse_material_id("world/water").id);
    REQUIRE(world_material != nullptr);
    REQUIRE(world_material->textures.size() == 1);
    CHECK(world_material->textures[0].source == "$draw.texture");
}

TEST_CASE("role bindings parse")
{
    const auto result = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "soft_noise":{
          "stages":{"fragment":{"source":"project:/shaders/ui/soft_noise.fs.sc"}},
          "roles":{
            "rmlui-decorator":{"vertex":"rmlui_decorator_default","fragment":"soft_noise"},
            "engine-2d":{"vertex":"engine_2d_default","fragment":"soft_noise"}
          }
        }
      },
      "materials":{"ui/noise_panel":{"role":"rmlui-decorator","shader":"soft_noise"}}
    })json");

    REQUIRE(result.ok());
    REQUIRE(result.project);
    const auto* shader =
        noveltea::find_shader(*result.project, *noveltea::parse_shader_id("soft_noise").id);
    REQUIRE(shader != nullptr);
    CHECK(shader->roles.size() == 2);
    REQUIRE(shader->role_bindings.size() == 2);
    CHECK(shader->role_bindings[0].fragment_shader->value() == "soft_noise");
}

TEST_CASE("parser reports schema and shader diagnostics")
{
    CHECK(has_code(noveltea::parse_shader_material_project_json("{}"),
                   MaterialDiagnosticCode::MissingRequiredField));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({"schema":"wrong"})json"),
                   MaterialDiagnosticCode::InvalidSchema));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({)json"),
                   MaterialDiagnosticCode::InvalidJson));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "bad.shader":{"stages":{"fragment":{"source":"project:/ok.fs.sc"}},"roles":["engine-2d"]}
      }
    })json"),
                   MaterialDiagnosticCode::InvalidShaderId));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "soft_noise":{"stages":{"fragment":{"source":"project://bad.fs.sc"}},"roles":["engine-2d"]}
      }
    })json"),
                   MaterialDiagnosticCode::InvalidShaderSourceRef));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "soft_noise":{
          "stages":{"fragment":{"compiled":{"glsl-120":"shaders/bgfx/glsl-120/soft_noise.vs.bin"}}},
          "roles":["engine-2d"]
        }
      }
    })json"),
                   MaterialDiagnosticCode::InvalidCompiledBinaryRef));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "soft_noise":{
          "stages":{"fragment":{"source":"project:/ok.fs.sc"}},
          "uniforms":{"amount":{"type":"float"}},
          "roles":["engine-2d"]
        }
      }
    })json"),
                   MaterialDiagnosticCode::InvalidUniformDeclaration));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "soft_noise":{
          "stages":{"fragment":{"source":"project:/ok.fs.sc"}},
          "uniforms":{"u_time":{"type":"float","binding":"runtime.clock"}},
          "roles":["engine-2d"]
        }
      }
    })json"),
                   MaterialDiagnosticCode::UnknownInputBinding));
}

TEST_CASE("material validation reports refs values and roles")
{
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{"soft_noise":{"stages":{"fragment":{"source":"project:/ok.fs.sc"}},"roles":["engine-2d"]}},
      "materials":{"bad":{"role":"engine-2d","shader":"missing"}}
    })json"),
                   MaterialDiagnosticCode::UnknownShaderRef));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{"soft_noise":{"stages":{"fragment":{"source":"project:/ok.fs.sc"}},"roles":["engine-2d"]}},
      "materials":{"bad":{"role":"rmlui-decorator","shader":"soft_noise"}}
    })json"),
                   MaterialDiagnosticCode::IncompatibleShaderRole));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "soft_noise":{
          "stages":{"fragment":{"source":"project:/ok.fs.sc"}},
          "uniforms":{"u_amount":{"type":"float"}},
          "roles":["engine-2d"]
        }
      },
      "materials":{
        "bad":{"role":"engine-2d","shader":"soft_noise","uniforms":{"u_amount":"bad"}}
      }
    })json"),
                   MaterialDiagnosticCode::InvalidUniformValue));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "soft_noise":{
          "stages":{"fragment":{"source":"project:/ok.fs.sc"}},
          "uniforms":{"u_amount":{"type":"float"}},
          "roles":["engine-2d"]
        }
      },
      "materials":{
        "bad":{"role":"engine-2d","shader":"soft_noise","uniforms":{"u_missing":1.0}}
      }
    })json"),
                   MaterialDiagnosticCode::UndeclaredUniform));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "soft_noise":{
          "stages":{"fragment":{"source":"project:/ok.fs.sc"}},
          "samplers":{"s_noise":{"type":"texture2d"}},
          "roles":["engine-2d"]
        }
      },
      "materials":{
        "bad":{"role":"engine-2d","shader":"soft_noise","textures":{"s_noise":"project://bad.png"}}
      }
    })json"),
                   MaterialDiagnosticCode::InvalidTextureSource));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "soft_noise":{
          "stages":{"fragment":{"source":"project:/ok.fs.sc"}},
          "samplers":{"s_noise":{"type":"texture2d"}},
          "roles":["engine-2d"]
        }
      },
      "materials":{
        "bad":{
          "role":"engine-2d",
          "shader":"soft_noise",
          "textures":{"s_missing":"project:/textures/noise.png"}
        }
      }
    })json"),
                   MaterialDiagnosticCode::UndeclaredSampler));
}

TEST_CASE("deferred roles and fallback records are explicit")
{
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "fx":{"stages":{"fragment":{"source":"project:/ok.fs.sc"}},"roles":["postprocess"]}
      }
    })json"),
                   MaterialDiagnosticCode::DeferredShaderRole));

    const auto engine_fallback = noveltea::make_engine_2d_fallback_material();
    CHECK(engine_fallback.fallback);
    CHECK(engine_fallback.id.value() == "system/fallback/engine_2d_error");
    CHECK(engine_fallback.role == noveltea::ShaderRole::Engine2D);

    const auto rmlui_fallback = noveltea::make_rmlui_decorator_fallback_material();
    CHECK(rmlui_fallback.fallback);
    CHECK(rmlui_fallback.id.value() == "system/fallback/rmlui_decorator_error");
    CHECK(rmlui_fallback.role == noveltea::ShaderRole::RmlUiDecorator);
}
