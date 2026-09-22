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
          "interface_fingerprint":"sha256:0e4e262891e0e3895803481b735e0747bb62bc49599e4b8de76586139b2e292a",
          "stages":{
            "vertex":{"compiled":{"glsl-330":{"runtimePath":"project:/shaders/bgfx/glsl-330/engine_2d_default.vs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}}
          },
          "roles":["engine-2d"],
          "role_bindings":{}
        },
        "rmlui_decorator_default":{
          "interface_contract":"noveltea.material-preset:rmlui-decorator:1",
          "interface_fingerprint":"sha256:4d6fa3ddc7c34a2d7ca9fa8102e0881305a1ea684693b47eff6ebebdddaf4a27",
          "stages":{
            "vertex":{"compiled":{"glsl-330":{"runtimePath":"project:/shaders/bgfx/glsl-330/rmlui_decorator_default.vs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}}
          },
          "roles":["rmlui-decorator"],
          "role_bindings":{}
        },
        "soft_noise":{
          "interface_contract":"noveltea.material-preset:engine-2d:1",
          "interface_fingerprint":"sha256:0e4e262891e0e3895803481b735e0747bb62bc49599e4b8de76586139b2e292a",
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
        },
        "active_text_wave_vs":{
          "interface_contract":"noveltea.material-preset:active-text:1",
          "interface_fingerprint":"sha256:c62ec9672871d25d0736f7b093016d8835ea372693b9dab9016ea56d145427e2",
          "stages":{
            "vertex":{"compiled":{"glsl-330":{"runtimePath":"project:/shaders/bgfx/glsl-330/active_text_wave.vs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}}
          },
          "roles":["active-text"],
          "role_bindings":{}
        },
        "active_text_wave_fs":{
          "interface_contract":"noveltea.material-preset:active-text:1",
          "interface_fingerprint":"sha256:c62ec9672871d25d0736f7b093016d8835ea372693b9dab9016ea56d145427e2",
          "stages":{
            "fragment":{"compiled":{"glsl-330":{"runtimePath":"project:/shaders/bgfx/glsl-330/active_text_wave.fs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}}
          },
          "uniforms":{"u_time":{"type":"float","binding":"engine.time"}},
          "roles":["active-text"],
          "role_bindings":{}
        },
        "active-text-program-abc":{
          "interface_contract":"noveltea.material-preset:active-text:1",
          "interface_fingerprint":"sha256:c62ec9672871d25d0736f7b093016d8835ea372693b9dab9016ea56d145427e2",
          "stages":{
            "vertex":{"compiled":{"glsl-330":{"runtimePath":"project:/shaders/derived/glsl-330/program-abc.vs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}},
            "fragment":{"compiled":{"glsl-330":{"runtimePath":"project:/shaders/derived/glsl-330/program-abc.fs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}}
          },
          "uniforms":{"u_time":{"type":"float","binding":"engine.time"}},
          "roles":["active-text"],
          "role_bindings":{}
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

TEST_CASE("direct ActiveText shader pairs resolve without material records")
{
    const auto project = make_project();
    const auto result = noveltea::resolve_direct_shader_pair_program(
        project, *noveltea::parse_shader_id("active_text_wave_vs").id,
        *noveltea::parse_shader_id("active_text_wave_fs").id, "glsl-330");

    REQUIRE(result.ok());
    REQUIRE(result.program);
    CHECK(result.program->key.kind == noveltea::ShaderProgramRequestKind::DirectShaderPair);
    CHECK(result.program->key.material_id.empty());
    CHECK(result.program->key.role == noveltea::ShaderRole::ActiveText);
    CHECK(result.program->vertex.path == "project:/shaders/bgfx/glsl-330/active_text_wave.vs.bin");
    CHECK(result.program->fragment.path ==
          "project:/shaders/bgfx/glsl-330/active_text_wave.fs.bin");
    REQUIRE(find_uniform(*result.program, "u_time") != nullptr);
}

TEST_CASE("derived ActiveText source programs resolve from runtime metadata")
{
    const auto project = make_project();
    const auto result = noveltea::resolve_source_shader_program(
        project, "active-text-program-abc", noveltea::ShaderRole::ActiveText, "glsl-330");

    REQUIRE(result.ok());
    REQUIRE(result.program);
    CHECK(result.program->key.kind == noveltea::ShaderProgramRequestKind::SourceProgram);
    CHECK(result.program->key.program_identity == "active-text-program-abc");
    CHECK(result.program->vertex.path == "project:/shaders/derived/glsl-330/program-abc.vs.bin");
    CHECK(result.program->fragment.path == "project:/shaders/derived/glsl-330/program-abc.fs.bin");
    REQUIRE(find_uniform(*result.program, "u_time") != nullptr);
}

TEST_CASE("source-backed ActiveText programs resolve without authored Shader ids")
{
    const auto program = noveltea::resolve_source_shader_pair_program(
        "program-abc", noveltea::ShaderRole::ActiveText, "glsl-330",
        "project:/shaders/derived/glsl-330/program-abc.vs.bin",
        "project:/shaders/derived/glsl-330/program-abc.fs.bin");

    CHECK(program.key.kind == noveltea::ShaderProgramRequestKind::SourceProgram);
    CHECK(program.key.program_identity == "program-abc");
    CHECK(program.key.role == noveltea::ShaderRole::ActiveText);
    CHECK(program.key.vertex_shader.string().empty());
    CHECK(program.key.fragment_shader.string().empty());
    CHECK(program.vertex.path == "project:/shaders/derived/glsl-330/program-abc.vs.bin");
    CHECK(program.fragment.path == "project:/shaders/derived/glsl-330/program-abc.fs.bin");

    const auto cache_key = noveltea::shader_program_cache_key(program.key);
    CHECK(cache_key.find("source_program|program-abc|active-text|") != std::string::npos);
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

TEST_CASE("missing direct shader-pair variants report ActiveText shader ids")
{
    const auto project = make_project();
    const auto result = noveltea::resolve_direct_shader_pair_program(
        project, *noveltea::parse_shader_id("active_text_wave_vs").id,
        *noveltea::parse_shader_id("active_text_wave_fs").id, "metal");

    REQUIRE_FALSE(result.ok());
    CHECK(has_code(result, noveltea::ShaderProgramDiagnosticCode::MissingCompiledVariant));
    CHECK(diagnostic_mentions(result, "active_text_wave_vs"));
    CHECK(diagnostic_mentions(result, "active_text_wave_fs"));
    CHECK(diagnostic_mentions(result, "metal"));
    CHECK(diagnostic_mentions(result, "shaders/bgfx/metal/active_text_wave_vs.vs.bin"));
}

TEST_CASE("material resolution does not guess vertex stages when role binding is required")
{
    const auto parsed = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "fragment_only":{
          "interface_contract":"noveltea.material-preset:engine-2d:1",
          "interface_fingerprint":"sha256:0e4e262891e0e3895803481b735e0747bb62bc49599e4b8de76586139b2e292a",
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

TEST_CASE("program cache keys distinguish material programs from direct shader pairs")
{
    const auto project = make_project();
    const auto material = noveltea::resolve_material_shader_program(
        project, *noveltea::parse_material_id("world/water").id, "glsl-330");
    const auto direct = noveltea::resolve_direct_shader_pair_program(
        project, *noveltea::parse_shader_id("engine_2d_default").id,
        *noveltea::parse_shader_id("soft_noise").id, "glsl-330");

    REQUIRE(material.ok());
    REQUIRE(direct.ok());
    const std::string material_key = noveltea::shader_program_cache_key(material.program->key);
    const std::string direct_key = noveltea::shader_program_cache_key(direct.program->key);
    CHECK(material_key != direct_key);
    CHECK(material_key.find("material|world/water") != std::string::npos);
    CHECK(direct_key.find("direct_shader_pair|") != std::string::npos);

    auto same_binaries = *material.program;
    same_binaries.key.material_id = "world/ice";
    same_binaries.key.material_shader = noveltea::ShaderId("material_specific_metadata");
    CHECK(noveltea::shader_program_cache_key(material.program->key) !=
          noveltea::shader_program_cache_key(same_binaries.key));
    CHECK(noveltea::shader_program_binary_cache_key(*material.program) ==
          noveltea::shader_program_binary_cache_key(same_binaries));
}
