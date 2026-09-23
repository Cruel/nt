#include <catch2/catch_test_macros.hpp>

#include "noveltea/render/shader_manifest.hpp"
#include "noveltea/render/material_codec.hpp"

#include <string>
#include <string_view>

namespace {

noveltea::ShaderMaterialProject make_project()
{
    const auto parsed = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "engine_2d_default":{
          "interface_contract":"noveltea.material-preset:engine-2d:1",
          "interface_fingerprint":"sha256:49111ad3e9c928953f510a57100419f761118d42f65bafe1786d56a858ae74b9",
          "stages":{
            "vertex":{"compiled":{"glsl-330":{"runtimePath":"project:/shaders/bgfx/glsl-330/engine_2d_default.vs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}}
          },
          "roles":["engine-2d"],
          "role_bindings":{}
        },
        "rmlui_decorator_default":{
          "interface_contract":"noveltea.material-preset:rmlui-decorator:1",
          "interface_fingerprint":"sha256:13861c8862bc8406cc2a3575a6a81e504c8f85943b9fcb5f9b4de8bf075245f8",
          "stages":{
            "vertex":{"compiled":{"glsl-330":{"runtimePath":"project:/shaders/bgfx/glsl-330/rmlui_decorator_default.vs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}}
          },
          "roles":["rmlui-decorator"],
          "role_bindings":{}
        },
        "soft_noise":{
          "interface_contract":"noveltea.material-preset:engine-2d:1",
          "interface_fingerprint":"sha256:49111ad3e9c928953f510a57100419f761118d42f65bafe1786d56a858ae74b9",
          "stages":{
            "fragment":{"compiled":{"glsl-330":{"runtimePath":"project:/shaders/bgfx/glsl-330/soft_noise.fs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}}
          },
          "uniforms":{"u_amount":{"type":"float","default":0.25}},
          "samplers":{"s_noise":{"type":"texture2d","stage":3,"binding":null}},
          "roles":["engine-2d","rmlui-decorator"],
          "role_bindings":{
            "engine-2d":{"vertex":"engine_2d_default","fragment":"soft_noise"},
            "rmlui-decorator":{"vertex":"rmlui_decorator_default","fragment":"soft_noise"}
          }
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

    const auto result = noveltea::resolve_material_shader_program(project, material_id, "glsl-330");

    REQUIRE(result.ok());
    REQUIRE(result.program);
    CHECK(result.program->key.kind == noveltea::ShaderProgramRequestKind::Material);
    CHECK(result.program->key.material_id == "world/water");
    CHECK(result.program->key.role == noveltea::ShaderRole::Engine2D);
    CHECK(result.program->vertex.shader.value() == "engine_2d_default");
    CHECK(result.program->fragment.shader.value() == "soft_noise");
    CHECK(result.program->vertex.path == "project:/shaders/bgfx/glsl-330/engine_2d_default.vs.bin");
    CHECK(result.program->fragment.path == "project:/shaders/bgfx/glsl-330/soft_noise.fs.bin");
    REQUIRE(find_uniform(*result.program, "u_amount") != nullptr);
    REQUIRE(find_sampler(*result.program, "s_noise") != nullptr);
}

TEST_CASE("one fragment shader can resolve different material roles with different vertex stages")
{
    const auto project = make_project();
    const auto world = noveltea::resolve_material_shader_program(
        project, *noveltea::parse_material_id("world/water").id, "glsl-330");
    const auto ui = noveltea::resolve_material_shader_program(
        project, *noveltea::parse_material_id("ui/noise_panel").id, "glsl-330");

    REQUIRE(world.ok());
    REQUIRE(ui.ok());
    CHECK(world.program->fragment.path == ui.program->fragment.path);
    CHECK(world.program->vertex.path != ui.program->vertex.path);
    CHECK(ui.program->vertex.shader.value() == "rmlui_decorator_default");
}

TEST_CASE("missing material variants report material context and expected binary paths")
{
    const auto project = make_project();
    const auto result = noveltea::resolve_material_shader_program(
        project, *noveltea::parse_material_id("world/water").id, "metal");

    REQUIRE_FALSE(result.ok());
    CHECK(has_code(result, noveltea::ShaderProgramDiagnosticCode::MissingCompiledVariant));
    CHECK(diagnostic_mentions(result, "world/water"));
    CHECK(diagnostic_mentions(result, "engine-2d"));
    CHECK(diagnostic_mentions(result, "metal"));
    CHECK(diagnostic_mentions(result, "shaders/bgfx/metal/engine_2d_default.vs.bin"));
}

TEST_CASE("material resolution does not guess vertex stages when role binding is required")
{
    const auto parsed = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "fragment_only":{
          "interface_contract":"noveltea.material-preset:engine-2d:1",
          "interface_fingerprint":"sha256:49111ad3e9c928953f510a57100419f761118d42f65bafe1786d56a858ae74b9",
          "stages":{"fragment":{"compiled":{"glsl-330":{"runtimePath":"project:/shaders/bgfx/glsl-330/fragment_only.fs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}}},
          "roles":["engine-2d"],
          "role_bindings":{}
        }
      },
      "materials":{"bad":{"role":"engine-2d","shader":"fragment_only"}}
    })json");
    REQUIRE(parsed.ok());
    REQUIRE(parsed.project);

    const auto result = noveltea::resolve_material_shader_program(
        *parsed.project, *noveltea::parse_material_id("bad").id, "glsl-330");

    REQUIRE_FALSE(result.ok());
    CHECK(has_code(result, noveltea::ShaderProgramDiagnosticCode::MissingRoleBinding));
    CHECK(diagnostic_mentions(result, "fragment_only"));
}

TEST_CASE("program cache keys keep Material metadata distinct while sharing binary cache entries")
{
    const auto project = make_project();
    const auto material = noveltea::resolve_material_shader_program(
        project, *noveltea::parse_material_id("world/water").id, "glsl-330");

    REQUIRE(material.ok());
    const std::string material_key = noveltea::shader_program_cache_key(material.program->key);
    CHECK(material_key.find("material|world/water") != std::string::npos);

    auto same_binaries = *material.program;
    same_binaries.key.material_id = "world/ice";
    same_binaries.key.material_shader = noveltea::ShaderId("material_specific_metadata");
    CHECK(noveltea::shader_program_cache_key(material.program->key) !=
          noveltea::shader_program_cache_key(same_binaries.key));
    CHECK(noveltea::shader_program_binary_cache_key(*material.program) ==
          noveltea::shader_program_binary_cache_key(same_binaries));
}
