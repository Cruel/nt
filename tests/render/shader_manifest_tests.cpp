#include <catch2/catch_test_macros.hpp>

#include "noveltea/render/shader_manifest.hpp"

#include <string>
#include <string_view>

namespace {

noveltea::ShaderMaterialProject make_project()
{
    const auto parsed = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "engine_2d_default":{
          "stages":{
            "vertex":{"compiled":{"glsl-120":"shaders/bgfx/glsl-120/engine_2d_default.vs.bin"}}
          },
          "roles":["engine-2d"]
        },
        "rmlui_decorator_default":{
          "stages":{
            "vertex":{"compiled":{"glsl-120":"shaders/bgfx/glsl-120/rmlui_decorator_default.vs.bin"}}
          },
          "roles":["rmlui-decorator"]
        },
        "soft_noise":{
          "stages":{
            "fragment":{"compiled":{"glsl-120":"shaders/bgfx/glsl-120/soft_noise.fs.bin"}}
          },
          "uniforms":{"u_amount":{"type":"float","default":0.25}},
          "samplers":{"s_noise":{"type":"texture2d"}},
          "roles":{
            "engine-2d":{"vertex":"engine_2d_default","fragment":"soft_noise"},
            "rmlui-decorator":{"vertex":"rmlui_decorator_default","fragment":"soft_noise"}
          }
        },
        "active_text_wave_vs":{
          "stages":{
            "vertex":{"compiled":{"glsl-120":"shaders/bgfx/glsl-120/active_text_wave.vs.bin"}}
          },
          "roles":["active-text"]
        },
        "active_text_wave_fs":{
          "stages":{
            "fragment":{"compiled":{"glsl-120":"shaders/bgfx/glsl-120/active_text_wave.fs.bin"}}
          },
          "uniforms":{"u_time":{"type":"float","binding":"engine.time"}},
          "roles":["active-text"]
        }
      },
      "materials":{
        "world/water":{"role":"engine-2d","shader":"soft_noise"},
        "ui/noise_panel":{"role":"rmlui-decorator","shader":"soft_noise"}
      }
    })json");
    REQUIRE(parsed.ok());
    REQUIRE(parsed.project);
    return *parsed.project;
}

bool has_code(const noveltea::ShaderProgramResolutionResult& result,
              noveltea::ShaderProgramDiagnosticCode code)
{
    for (const auto& diagnostic : result.diagnostics) {
        if (diagnostic.code == code)
            return true;
    }
    return false;
}

bool diagnostic_mentions(const noveltea::ShaderProgramResolutionResult& result,
                         std::string_view text)
{
    for (const auto& diagnostic : result.diagnostics) {
        if (diagnostic.context.find(text) != std::string::npos ||
            diagnostic.message.find(text) != std::string::npos) {
            return true;
        }
    }
    return false;
}

const noveltea::ShaderUniformDeclaration*
find_uniform(const noveltea::ShaderProgramResolution& resolution, std::string_view name)
{
    for (const auto& uniform : resolution.uniforms) {
        if (uniform.name == name)
            return &uniform;
    }
    return nullptr;
}

const noveltea::ShaderSamplerDeclaration*
find_sampler(const noveltea::ShaderProgramResolution& resolution, std::string_view name)
{
    for (const auto& sampler : resolution.samplers) {
        if (sampler.name == name)
            return &sampler;
    }
    return nullptr;
}

} // namespace

TEST_CASE("material shader programs resolve through role-specific stage bindings")
{
    const auto project = make_project();
    const auto material_id = *noveltea::parse_material_id("world/water").id;

    const auto result = noveltea::resolve_material_shader_program(project, material_id, "glsl-120");

    REQUIRE(result.ok());
    REQUIRE(result.program);
    CHECK(result.program->key.kind == noveltea::ShaderProgramRequestKind::Material);
    CHECK(result.program->key.material_id == "world/water");
    CHECK(result.program->key.role == noveltea::ShaderRole::Engine2D);
    CHECK(result.program->vertex.shader.value() == "engine_2d_default");
    CHECK(result.program->fragment.shader.value() == "soft_noise");
    CHECK(result.program->vertex.path == "shaders/bgfx/glsl-120/engine_2d_default.vs.bin");
    CHECK(result.program->fragment.path == "shaders/bgfx/glsl-120/soft_noise.fs.bin");
    REQUIRE(find_uniform(*result.program, "u_amount") != nullptr);
    REQUIRE(find_sampler(*result.program, "s_noise") != nullptr);
}

TEST_CASE("one fragment shader can resolve different material roles with different vertex stages")
{
    const auto project = make_project();
    const auto world = noveltea::resolve_material_shader_program(
        project, *noveltea::parse_material_id("world/water").id, "glsl-120");
    const auto ui = noveltea::resolve_material_shader_program(
        project, *noveltea::parse_material_id("ui/noise_panel").id, "glsl-120");

    REQUIRE(world.ok());
    REQUIRE(ui.ok());
    CHECK(world.program->fragment.path == ui.program->fragment.path);
    CHECK(world.program->vertex.path != ui.program->vertex.path);
    CHECK(ui.program->vertex.shader.value() == "rmlui_decorator_default");
}

TEST_CASE("direct ActiveText shader pairs resolve without material records")
{
    const auto project = make_project();
    const auto result = noveltea::resolve_direct_shader_pair_program(
        project, *noveltea::parse_shader_id("active_text_wave_vs").id,
        *noveltea::parse_shader_id("active_text_wave_fs").id, "glsl-120");

    REQUIRE(result.ok());
    REQUIRE(result.program);
    CHECK(result.program->key.kind == noveltea::ShaderProgramRequestKind::DirectShaderPair);
    CHECK(result.program->key.material_id.empty());
    CHECK(result.program->key.role == noveltea::ShaderRole::ActiveText);
    CHECK(result.program->vertex.path == "shaders/bgfx/glsl-120/active_text_wave.vs.bin");
    CHECK(result.program->fragment.path == "shaders/bgfx/glsl-120/active_text_wave.fs.bin");
    REQUIRE(find_uniform(*result.program, "u_time") != nullptr);
}

TEST_CASE("missing material variants report material context and expected binary paths")
{
    const auto project = make_project();
    const auto result = noveltea::resolve_material_shader_program(
        project, *noveltea::parse_material_id("world/water").id, "essl-100");

    REQUIRE_FALSE(result.ok());
    CHECK(has_code(result, noveltea::ShaderProgramDiagnosticCode::MissingCompiledVariant));
    CHECK(diagnostic_mentions(result, "world/water"));
    CHECK(diagnostic_mentions(result, "engine-2d"));
    CHECK(diagnostic_mentions(result, "essl-100"));
    CHECK(diagnostic_mentions(result, "shaders/bgfx/essl-100/engine_2d_default.vs.bin"));
}

TEST_CASE("missing direct shader-pair variants report ActiveText shader ids")
{
    const auto project = make_project();
    const auto result = noveltea::resolve_direct_shader_pair_program(
        project, *noveltea::parse_shader_id("active_text_wave_vs").id,
        *noveltea::parse_shader_id("active_text_wave_fs").id, "essl-100");

    REQUIRE_FALSE(result.ok());
    CHECK(has_code(result, noveltea::ShaderProgramDiagnosticCode::MissingCompiledVariant));
    CHECK(diagnostic_mentions(result, "active_text_wave_vs"));
    CHECK(diagnostic_mentions(result, "active_text_wave_fs"));
    CHECK(diagnostic_mentions(result, "essl-100"));
    CHECK(diagnostic_mentions(result, "shaders/bgfx/essl-100/active_text_wave_vs.vs.bin"));
}

TEST_CASE("material resolution does not guess vertex stages when role binding is required")
{
    const auto parsed = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "fragment_only":{
          "stages":{"fragment":{"compiled":{"glsl-120":"shaders/bgfx/glsl-120/fragment_only.fs.bin"}}},
          "roles":["engine-2d"]
        }
      },
      "materials":{"bad":{"role":"engine-2d","shader":"fragment_only"}}
    })json");
    REQUIRE(parsed.ok());
    REQUIRE(parsed.project);

    const auto result = noveltea::resolve_material_shader_program(
        *parsed.project, *noveltea::parse_material_id("bad").id, "glsl-120");

    REQUIRE_FALSE(result.ok());
    CHECK(has_code(result, noveltea::ShaderProgramDiagnosticCode::MissingRoleBinding));
    CHECK(diagnostic_mentions(result, "fragment_only"));
}

TEST_CASE("program cache keys distinguish material programs from direct shader pairs")
{
    const auto project = make_project();
    const auto material = noveltea::resolve_material_shader_program(
        project, *noveltea::parse_material_id("world/water").id, "glsl-120");
    const auto direct = noveltea::resolve_direct_shader_pair_program(
        project, *noveltea::parse_shader_id("engine_2d_default").id,
        *noveltea::parse_shader_id("soft_noise").id, "glsl-120");

    REQUIRE(material.ok());
    REQUIRE(direct.ok());
    const std::string material_key = noveltea::shader_program_cache_key(material.program->key);
    const std::string direct_key = noveltea::shader_program_cache_key(direct.program->key);
    CHECK(material_key != direct_key);
    CHECK(material_key.find("material|world/water") != std::string::npos);
    CHECK(direct_key.find("direct_shader_pair|") != std::string::npos);
}
