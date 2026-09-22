#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include "noveltea/render/material.hpp"
#include "noveltea/render/material_codec.hpp"
#include "noveltea/render/material_contract.hpp"

#include <array>
#include <string_view>
#include <utility>
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
      "schema":"noveltea.shader-materials",
      "shaders":{
        "soft_noise":{
          "display_name":"Soft Noise",
          "interface_contract":"noveltea.material-preset:rmlui-decorator:1",
          "interface_fingerprint":"sha256:4d6fa3ddc7c34a2d7ca9fa8102e0881305a1ea684693b47eff6ebebdddaf4a27",
          "stages":{
            "fragment":{
              "source":"project:/shaders/ui/soft_noise.fs.sc",
              "compiled":{
                "glsl-330":{"runtimePath":"project:/shaders/bgfx/glsl-330/soft_noise.fs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1},
                "essl-300":{"runtimePath":"project:/shaders/bgfx/essl-300/soft_noise.fs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}
              }
            }
          },
          "uniforms":{
            "u_amount":{"type":"float","default":0.25,"range":[0.0,1.0]},
            "u_tint":{"type":"color","default":"#66ccffff"},
            "u_time":{"type":"float","binding":"engine.time"},
            "u_dims":{"type":"vec2","binding":"engine.paint_dimensions"},
            "u_world_scale":{"type":"vec2","binding":"engine.reference_to_world_raster_scale"},
            "u_raster_scale":{"type":"vec2","binding":"engine.context_logical_to_raster_scale"},
            "u_viewport_pixels":{"type":"vec2","binding":"engine.viewport_pixel_dimensions"},
            "u_rmlui_resolution":{"type":"float","binding":"rmlui.media_query_resolution"},
            "u_pointer":{"type":"vec2","binding":"engine.pointer_position"},
            "u_pointer_valid":{"type":"bool","binding":"engine.pointer_valid"}
          },
          "samplers":{"s_noise":{"type":"texture2d","stage":3,"binding":null}},
          "roles":["rmlui-decorator","engine-2d"],
          "role_bindings":{}
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
    REQUIRE(find_uniform(*shader, "u_dims")->binding);
    CHECK(*find_uniform(*shader, "u_dims")->binding ==
          noveltea::ShaderInputSemantic::EnginePaintDimensions);
    REQUIRE(find_uniform(*shader, "u_world_scale")->binding);
    CHECK(*find_uniform(*shader, "u_world_scale")->binding ==
          noveltea::ShaderInputSemantic::EngineReferenceToWorldRasterScale);
    REQUIRE(find_uniform(*shader, "u_raster_scale")->binding);
    CHECK(*find_uniform(*shader, "u_raster_scale")->binding ==
          noveltea::ShaderInputSemantic::EngineContextLogicalToRasterScale);
    REQUIRE(find_uniform(*shader, "u_viewport_pixels")->binding);
    CHECK(*find_uniform(*shader, "u_viewport_pixels")->binding ==
          noveltea::ShaderInputSemantic::EngineViewportPixelDimensions);
    REQUIRE(find_uniform(*shader, "u_rmlui_resolution")->binding);
    CHECK(*find_uniform(*shader, "u_rmlui_resolution")->binding ==
          noveltea::ShaderInputSemantic::RmlUiMediaQueryResolution);
    REQUIRE(find_uniform(*shader, "u_pointer")->binding);
    CHECK(*find_uniform(*shader, "u_pointer")->binding ==
          noveltea::ShaderInputSemantic::EnginePointerPosition);
    REQUIRE(find_uniform(*shader, "u_pointer_valid")->binding);
    CHECK(*find_uniform(*shader, "u_pointer_valid")->binding ==
          noveltea::ShaderInputSemantic::EnginePointerValid);

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

TEST_CASE("duplicate RmlUi standard semantic aliases are rejected")
{
    const std::array<std::pair<std::string_view, std::string_view>, 5> aliases{{
        {"engine.context_logical_to_ui_raster_scale", "vec2"},
        {"engine.ui_media_query_resolution", "float"},
        {"rmlui.paint_dimensions", "vec2"},
        {"rmlui.context_logical_to_ui_raster_scale", "vec2"},
        {"rmlui.viewport_pixel_dimensions", "vec2"},
    }};

    for (const auto& [binding, type] : aliases) {
        const nlohmann::json document = {
            {"schema", "noveltea.shader-materials"},
            {"shaders",
             {{"legacy_alias",
               {{"stages", {{"fragment", {{"source", "project:/ok.fs.sc"}}}}},
                {"uniforms", {{"u_value", {{"type", type}, {"binding", binding}}}}},
                {"roles", {"rmlui-decorator"}},
                {"role_bindings", nlohmann::json::object()}}}}},
            {"materials", nlohmann::json::object()},
        };
        CHECK(has_code(noveltea::parse_shader_material_project_json(document.dump()),
                       MaterialDiagnosticCode::UnknownInputBinding));
    }
}

TEST_CASE("ambiguous shader dpi bindings are rejected")
{
    const auto result = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "legacy_dpi":{
          "stages":{},
          "uniforms":{
            "u_engine_dpi":{"type":"float","binding":"engine.dpi_scale"},
            "u_rmlui_dpi":{"type":"float","binding":"rmlui.dpi_scale"}
          },
          "roles":["engine-2d"],
          "role_bindings":{}
        }
      },
      "materials":{}
    })json");

    CHECK_FALSE(result.ok());
    CHECK(has_code(result, MaterialDiagnosticCode::UnknownInputBinding));
}

TEST_CASE("role bindings parse")
{
    const auto result = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "soft_noise":{
          "interface_contract":"noveltea.material-preset:rmlui-decorator:1",
          "interface_fingerprint":"sha256:4d6fa3ddc7c34a2d7ca9fa8102e0881305a1ea684693b47eff6ebebdddaf4a27",
          "stages":{"fragment":{"source":"project:/shaders/ui/soft_noise.fs.sc"}},
          "roles":["rmlui-decorator","engine-2d"],
          "role_bindings":{
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

TEST_CASE("runtime shader roles reject noncanonical membership and binding shapes")
{
    const auto rejects = [](nlohmann::json roles, std::optional<nlohmann::json> bindings) {
        nlohmann::json shader = {
            {"stages", {{"fragment", {{"source", "project:/ok.fs.sc"}}}}},
            {"roles", std::move(roles)},
        };
        if (bindings)
            shader["role_bindings"] = std::move(*bindings);
        const nlohmann::json document = {
            {"schema", "noveltea.shader-materials"},
            {"shaders", {{"soft_noise", std::move(shader)}}},
            {"materials", nlohmann::json::object()},
        };
        return !noveltea::parse_shader_material_project_json(document.dump()).ok();
    };

    CHECK(rejects({{"engine-2d", nlohmann::json::object()}}, nlohmann::json::object()));
    CHECK(rejects({"engine-2d"}, std::nullopt));
    CHECK(rejects({"engine-2d", "engine-2d"}, nlohmann::json::object()));
    CHECK(rejects({"engine-2d"}, {{"active-text", {{"vertex", "soft_noise"}}}}));
    CHECK(rejects({"engine-2d"}, {{"engine-2d", nlohmann::json::object()}}));
    CHECK(rejects({"engine-2d"}, {{"engine-2d", {{"vertex", "bad.shader"}}}}));
    CHECK(rejects({"engine-2d"}, {{"engine-2d", {{"geometry", "soft_noise"}}}}));
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
      "schema":"noveltea.shader-materials",
      "shaders":{
        "bad.shader":{"stages":{"fragment":{"source":"project:/ok.fs.sc"}},"roles":["engine-2d"],"role_bindings":{}}
      }
    })json"),
                   MaterialDiagnosticCode::InvalidShaderId));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "soft_noise":{"stages":{"fragment":{"source":"project://bad.fs.sc"}},"roles":["engine-2d"],"role_bindings":{}}
      }
    })json"),
                   MaterialDiagnosticCode::InvalidShaderSourceRef));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "soft_noise":{
          "stages":{"fragment":{"compiled":{"glsl-330":{"runtimePath":"project:/shaders/bgfx/glsl-330/soft_noise.vs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}}},
          "roles":["engine-2d"],
          "role_bindings":{}
        }
      }
    })json"),
                   MaterialDiagnosticCode::InvalidCompiledBinaryRef));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "soft_noise":{
          "stages":{"fragment":{"source":"project:/ok.fs.sc"}},
          "uniforms":{"amount":{"type":"float"}},
          "roles":["engine-2d"],
          "role_bindings":{}
        }
      }
    })json"),
                   MaterialDiagnosticCode::InvalidUniformDeclaration));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "soft_noise":{
          "stages":{"fragment":{"source":"project:/ok.fs.sc"}},
          "uniforms":{"u_time":{"type":"float","binding":"runtime.clock"}},
          "roles":["engine-2d"],
          "role_bindings":{}
        }
      }
    })json"),
                   MaterialDiagnosticCode::UnknownInputBinding));
}

TEST_CASE("runtime shader compiled outputs reject every noncanonical shape")
{
    const auto rejects = [](nlohmann::json output) {
        nlohmann::json document = {
            {"schema", "noveltea.shader-materials"},
            {"shaders",
             {{"soft_noise",
               {
                   {"stages", {{"fragment", {{"compiled", {{"glsl-330", std::move(output)}}}}}}},
                   {"roles", {"engine-2d"}},
                   {"role_bindings", nlohmann::json::object()},
               }}}},
            {"materials", nlohmann::json::object()},
        };
        return has_code(noveltea::parse_shader_material_project_json(document.dump()),
                        MaterialDiagnosticCode::InvalidCompiledBinaryRef);
    };

    const auto valid = nlohmann::json{
        {"runtimePath", "project:/shaders/bgfx/glsl-330/soft_noise.fs.bin"},
        {"byteHash", "sha256:0000000000000000000000000000000000000000000000000000000000000000"},
        {"byteSize", 1},
    };
    CHECK(rejects("project:/shaders/bgfx/glsl-330/soft_noise.fs.bin"));
    auto partial = valid;
    partial.erase("byteHash");
    CHECK(rejects(partial));
    auto extra = valid;
    extra["compileInputFingerprint"] =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    CHECK(rejects(extra));
    auto namespace_less = valid;
    namespace_less["runtimePath"] = "shaders/bgfx/glsl-330/soft_noise.fs.bin";
    CHECK(rejects(namespace_less));
    auto invalid_hash = valid;
    invalid_hash["byteHash"] = "sha256:not-a-hash";
    CHECK(rejects(invalid_hash));
    auto invalid_size = valid;
    invalid_size["byteSize"] = -1;
    CHECK(rejects(invalid_size));
}

TEST_CASE("material validation reports refs values and roles")
{
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{"soft_noise":{"stages":{"fragment":{"source":"project:/ok.fs.sc"}},"roles":["engine-2d"],"role_bindings":{}}},
      "materials":{"bad":{"role":"engine-2d","shader":"missing"}}
    })json"),
                   MaterialDiagnosticCode::UnknownShaderRef));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{"soft_noise":{"stages":{"fragment":{"source":"project:/ok.fs.sc"}},"roles":["engine-2d"],"role_bindings":{}}},
      "materials":{"bad":{"role":"rmlui-decorator","shader":"soft_noise"}}
    })json"),
                   MaterialDiagnosticCode::IncompatibleShaderRole));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "soft_noise":{
          "stages":{"fragment":{"source":"project:/ok.fs.sc"}},
          "uniforms":{"u_amount":{"type":"float"}},
          "roles":["engine-2d"],
          "role_bindings":{}
        }
      },
      "materials":{
        "bad":{"role":"engine-2d","shader":"soft_noise","uniforms":{"u_amount":"bad"}}
      }
    })json"),
                   MaterialDiagnosticCode::InvalidUniformValue));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "soft_noise":{
          "stages":{"fragment":{"source":"project:/ok.fs.sc"}},
          "uniforms":{"u_amount":{"type":"float"}},
          "roles":["engine-2d"],
          "role_bindings":{}
        }
      },
      "materials":{
        "bad":{"role":"engine-2d","shader":"soft_noise","uniforms":{"u_missing":1.0}}
      }
    })json"),
                   MaterialDiagnosticCode::UndeclaredUniform));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "soft_noise":{
          "interface_contract":"noveltea.material-preset:engine-2d:1",
          "interface_fingerprint":"sha256:0e4e262891e0e3895803481b735e0747bb62bc49599e4b8de76586139b2e292a",
          "stages":{"fragment":{"source":"project:/ok.fs.sc"}},
          "samplers":{"s_noise":{"type":"texture2d","stage":3,"binding":null}},
          "roles":["engine-2d"],
          "role_bindings":{}
        }
      },
      "materials":{
        "bad":{"role":"engine-2d","shader":"soft_noise","textures":{"s_noise":"project://bad.png"}}
      }
    })json"),
                   MaterialDiagnosticCode::InvalidTextureSource));
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "soft_noise":{
          "interface_contract":"noveltea.material-preset:engine-2d:1",
          "interface_fingerprint":"sha256:0e4e262891e0e3895803481b735e0747bb62bc49599e4b8de76586139b2e292a",
          "stages":{"fragment":{"source":"project:/ok.fs.sc"}},
          "samplers":{"s_noise":{"type":"texture2d","stage":3,"binding":null}},
          "roles":["engine-2d"],
          "role_bindings":{}
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

TEST_CASE("postprocess scope belongs to the effect occurrence and source texture is renderer-owned")
{
    const auto parsed = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "fx":{
          "interface_contract":"noveltea.material-preset:postprocess-tint:1",
          "interface_fingerprint":"sha256:07983cdd0065e8e8acf3aaf53c6e2c0bb443f8c557561403b0dd4917f4040b10",
          "stages":{"fragment":{"source":"project:/ok.fs.sc"}},
          "samplers":{"s_texColor":{"type":"texture2d","stage":0,"binding":null}},
          "roles":["postprocess"],
          "role_bindings":{}
        }
      },
      "materials":{
        "grade":{"role":"postprocess","shader":"fx"}
      }
    })json");
    REQUIRE(parsed.ok());
    REQUIRE(parsed.project);
    const auto grade_id = noveltea::parse_material_id("grade");
    REQUIRE(grade_id.id);
    const auto* grade = noveltea::find_material(*parsed.project, *grade_id.id);
    REQUIRE(grade != nullptr);
    CHECK(grade->textures.empty());

    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "fx":{"stages":{"fragment":{"source":"project:/ok.fs.sc"}},"roles":["postprocess"],"role_bindings":{}}
      },
      "materials":{
        "bad":{"role":"postprocess","postprocess_scope":"world","shader":"fx"}
      }
    })json"),
                   MaterialDiagnosticCode::InvalidPostprocessScope));

    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "fx":{
          "interface_contract":"noveltea.material-preset:postprocess-tint:1",
          "interface_fingerprint":"sha256:07983cdd0065e8e8acf3aaf53c6e2c0bb443f8c557561403b0dd4917f4040b10",
          "stages":{"fragment":{"source":"project:/ok.fs.sc"}},
          "samplers":{"s_texColor":{"type":"texture2d","stage":0,"binding":null}},
          "roles":["postprocess"],
          "role_bindings":{}
        }
      },
      "materials":{
        "bad":{
          "role":"postprocess",
          "shader":"fx",
          "textures":{"s_texColor":"project:/textures/source.png"}
        }
      }
    })json"),
                   MaterialDiagnosticCode::InvalidTextureSource));

    const auto* role = noveltea::material_role_contract("postprocess");
    REQUIRE(role != nullptr);
    REQUIRE(role->samplers.size() == 1);
    CHECK(role->samplers[0].name == "s_texColor");
    CHECK(role->samplers[0].semantic == "engine.postprocess_source");
    CHECK(role->samplers[0].stage == 0);
    CHECK(role->samplers[0].source_ownership == "renderer");
    CHECK(role->pipeline_state.blend == "replace");
    CHECK(role->pipeline_state.output_alpha == "premultiplied");
}

TEST_CASE("remaining deferred roles and fallback records are explicit")
{
    CHECK(has_code(noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "fx":{"stages":{"fragment":{"source":"project:/ok.fs.sc"}},"roles":["rmlui-filter"],"role_bindings":{}}
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

TEST_CASE("RmlUi decorator contract owns transforms texture sampling and premultiplied composition")
{
    const auto* role = noveltea::material_role_contract("rmlui-decorator");
    REQUIRE(role != nullptr);
    REQUIRE(role->renderer_uniforms.size() == 3);
    CHECK(role->renderer_uniforms[0].name == "u_projection");
    CHECK(role->renderer_uniforms[0].semantic == "rmlui.projection");
    CHECK(role->renderer_uniforms[1].name == "u_transform");
    CHECK(role->renderer_uniforms[1].semantic == "rmlui.transform");
    CHECK(role->renderer_uniforms[2].name == "u_translate");
    CHECK(role->renderer_uniforms[2].semantic == "rmlui.translation");
    REQUIRE(role->samplers.size() == 1);
    CHECK(role->samplers[0].name == "s_texColor");
    CHECK(role->samplers[0].semantic == "rmlui.decorator_texture");
    CHECK(role->samplers[0].stage == 0);
    CHECK(role->samplers[0].source_ownership == "renderer");
    REQUIRE(role->samplers[0].address_policy.count == 1);
    CHECK(role->samplers[0].address_policy.values[0] == "clamp");
    REQUIRE(role->samplers[0].filter_policy.count == 1);
    CHECK(role->samplers[0].filter_policy.values[0] == "linear");
    CHECK(role->pipeline_state.blend == "premultiplied-alpha");
    CHECK(role->pipeline_state.output_alpha == "premultiplied");
}

TEST_CASE("RmlUi decorator renderer texture cannot be authored")
{
    const auto parsed = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "ui/decorator":{
          "interface_contract":"noveltea.material-preset:rmlui-decorator:1",
          "interface_fingerprint":"sha256:4d6fa3ddc7c34a2d7ca9fa8102e0881305a1ea684693b47eff6ebebdddaf4a27",
          "stages":{"fragment":{"source":"project:/decorator.fs.sc"}},
          "samplers":{"s_texColor":{"type":"texture2d","stage":0,"binding":null}},
          "roles":["rmlui-decorator"],
          "role_bindings":{}
        }
      },
      "materials":{
        "ui/panel":{
          "role":"rmlui-decorator",
          "shader":"ui/decorator",
          "textures":{"s_texColor":"project:/textures/panel.png"}
        }
      }
    })json");

    CHECK_FALSE(parsed.ok());
    CHECK(has_code(parsed, MaterialDiagnosticCode::InvalidTextureSource));
}

TEST_CASE("Material contract registry exposes stable V1 identities and renderer-owned inputs")
{
    const auto roles = noveltea::material_role_contracts();
    const auto presets = noveltea::material_preset_contracts();
    REQUIRE(roles.size() == 5);
    REQUIRE(presets.size() == 6);

    const auto* engine_role = noveltea::material_role_contract("engine-2d");
    REQUIRE(engine_role != nullptr);
    REQUIRE(engine_role->samplers.size() == 1);
    CHECK(engine_role->samplers[0].name == "s_texColor");
    CHECK(engine_role->samplers[0].semantic == "engine.draw_texture");
    CHECK(engine_role->samplers[0].stage == 0);
    CHECK(engine_role->samplers[0].source_ownership == "renderer");

    const auto* engine_preset = noveltea::material_preset_contract("engine-2d");
    REQUIRE(engine_preset != nullptr);
    CHECK(engine_preset->contract_identity == "noveltea.material-preset:engine-2d:1");
    CHECK(engine_preset->contract_fingerprint.starts_with("sha256:"));
    CHECK(engine_preset->contract_fingerprint.size() == 71);
    CHECK(engine_preset->compatibility_projection_json.find("u_useTexture") ==
          std::string_view::npos);
    CHECK(engine_preset->compatibility_projection_json.find("s_texColor") ==
          std::string_view::npos);
    CHECK(engine_role->pipeline_state.blend == "premultiplied-alpha");
    CHECK(engine_role->pipeline_state.output_alpha == "premultiplied");
    CHECK(noveltea::material_contract_fingerprint_algorithm() == "sha256");
    CHECK(noveltea::material_contract_fingerprint_encoding() == "canonical-json-v1");
}

TEST_CASE("packaged shader contract fingerprints must match the runtime registry")
{
    auto document = nlohmann::json::parse(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "quad":{
          "display_name":"Quad",
          "interface_contract":"noveltea.material-preset:engine-2d:1",
          "interface_fingerprint":"sha256:0e4e262891e0e3895803481b735e0747bb62bc49599e4b8de76586139b2e292a",
          "stages":{},
          "uniforms":{},
          "samplers":{},
          "roles":["engine-2d"],
          "role_bindings":{}
        }
      },
      "materials":{}
    })json");
    REQUIRE_FALSE(document.is_discarded());
    CHECK(noveltea::parse_shader_material_project_json(document.dump()).ok());

    document["shaders"]["quad"]["interface_fingerprint"] =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const auto stale = noveltea::parse_shader_material_project_json(document.dump());
    CHECK_FALSE(stale.ok());
    CHECK(has_code(stale, MaterialDiagnosticCode::InvalidSchema));

    document["shaders"]["quad"]["interface_fingerprint"] = "";
    const auto empty_fingerprint = noveltea::parse_shader_material_project_json(document.dump());
    CHECK_FALSE(empty_fingerprint.ok());
    CHECK(has_code(empty_fingerprint, MaterialDiagnosticCode::MissingRequiredField));

    document["shaders"]["quad"]["interface_fingerprint"] =
        "sha256:0e4e262891e0e3895803481b735e0747bb62bc49599e4b8de76586139b2e292a";
    document["shaders"]["quad"]["interface_contract"] = "";
    const auto empty_contract = noveltea::parse_shader_material_project_json(document.dump());
    CHECK_FALSE(empty_contract.ok());
    CHECK(has_code(empty_contract, MaterialDiagnosticCode::MissingRequiredField));

    document["shaders"]["quad"]["interface_contract"] =
        "noveltea.material-preset:engine-2d:1";
    document["shaders"]["quad"]["interface_fingerprint"] = "sha256:ABC";
    const auto malformed_fingerprint =
        noveltea::parse_shader_material_project_json(document.dump());
    CHECK_FALSE(malformed_fingerprint.ok());
    CHECK(has_code(malformed_fingerprint, MaterialDiagnosticCode::InvalidSchema));
}

TEST_CASE("hotspot Materials use contract-owned samplers and premultiplied composition")
{
    const auto* role = noveltea::material_role_contract("hotspot-overlay");
    const auto* alpha = noveltea::material_preset_contract("hotspot-overlay-alpha");
    const auto* custom = noveltea::material_preset_contract("hotspot-overlay-custom");
    REQUIRE(role != nullptr);
    REQUIRE(alpha != nullptr);
    REQUIRE(custom != nullptr);
    REQUIRE(role->samplers.size() == 2);
    CHECK(role->samplers[0].semantic == "engine.hotspot_image");
    CHECK(role->samplers[0].stage == 0);
    CHECK(role->samplers[0].source_ownership == "renderer");
    REQUIRE(role->samplers[0].address_policy.count == 1);
    CHECK(role->samplers[0].address_policy.values[0] == "clamp");
    REQUIRE(role->samplers[0].filter_policy.count == 1);
    CHECK(role->samplers[0].filter_policy.values[0] == "inherit");
    CHECK(role->samplers[1].semantic == "engine.hotspot_mask");
    CHECK(role->samplers[1].stage == 1);
    CHECK(role->samplers[1].source_ownership == "renderer");
    REQUIRE(role->samplers[1].address_policy.count == 1);
    CHECK(role->samplers[1].address_policy.values[0] == "clamp");
    REQUIRE(role->samplers[1].filter_policy.count == 1);
    CHECK(role->samplers[1].filter_policy.values[0] == "nearest");
    CHECK(role->pipeline_state.blend == "premultiplied-alpha");
    CHECK(role->pipeline_state.output_alpha == "premultiplied");

    REQUIRE(alpha->sampler_capabilities.size() == 2);
    CHECK(alpha->sampler_capabilities[0].slot == "s_hotspotImage");
    CHECK(alpha->sampler_capabilities[0].state == "required");
    CHECK(alpha->sampler_capabilities[1].slot == "s_hotspotMask");
    CHECK(alpha->sampler_capabilities[1].state == "disabled");
    REQUIRE(custom->sampler_capabilities.size() == 2);
    CHECK(custom->sampler_capabilities[0].state == "required");
    CHECK(custom->sampler_capabilities[1].state == "required");

    const auto project = noveltea::make_builtin_hotspot_material_project();
    REQUIRE(project.shaders.size() == 2);
    REQUIRE(project.materials.size() == 2);
    CHECK(project.materials[0].fallback);
    CHECK(project.materials[1].fallback);
    CHECK(project.materials[0].textures.empty());
    CHECK(project.materials[1].textures.empty());
}

TEST_CASE("material documents reject authored sources for contract-owned hotspot samplers")
{
    const auto parsed = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "hotspot/test":{
          "interface_contract":"noveltea.material-preset:hotspot-overlay-alpha:1",
          "interface_fingerprint":"sha256:c6676b68043dcc07e21ad86c5552a11e55784bb294a2aecb2ce0bc531fef378e",
          "stages":{"fragment":{"source":"project:/hotspot.fs.sc"}},
          "samplers":{"s_hotspotImage":{"type":"texture2d","stage":0,"binding":null}},
          "roles":["hotspot-overlay"],
          "role_bindings":{}
        }
      },
      "materials":{
        "hotspot/test":{
          "role":"hotspot-overlay",
          "shader":"hotspot/test",
          "textures":{"s_hotspotImage":{"source":"project:/image.png","sampler":"clamp-linear"}}
        }
      }
    })json");
    CHECK_FALSE(parsed.ok());
    CHECK(has_code(parsed, MaterialDiagnosticCode::InvalidTextureSource));
}
