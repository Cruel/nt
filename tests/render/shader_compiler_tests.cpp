#include <catch2/catch_test_macros.hpp>

#include "noveltea/render/shader_compiler.hpp"
#include "noveltea/render/material_codec.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <string>

namespace {

std::filesystem::path unique_temp_dir(std::string_view name)
{
    auto path = std::filesystem::temp_directory_path() /
                ("noveltea-shader-compiler-" + std::string(name) + "-" +
                 std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(path);
    return path;
}

void write_text(const std::filesystem::path& path, std::string_view text)
{
    std::filesystem::create_directories(path.parent_path());
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    REQUIRE(file);
    file.write(text.data(), static_cast<std::streamsize>(text.size()));
    REQUIRE(file.good());
}

noveltea::ShaderCompileOptions make_options(const std::filesystem::path& temp)
{
    noveltea::ShaderCompileOptions options;
    options.project_root = temp / "project";
    options.output_root = temp / "generated";
    options.cache_root = temp / "cache";
    options.variants = noveltea::shader_compile_variants_from_names({"glsl-120", "essl-100"});
    return options;
}

noveltea::ShaderMaterialProject make_source_project(const std::filesystem::path& project_root)
{
    write_text(project_root / "shaders" / "sample.vs.sc",
               "$input a_position\n#include <bgfx_shader.sh>\n"
               "void main() { gl_Position = vec4(a_position, 0.0, 1.0); }\n");
    write_text(project_root / "shaders" / "sample.fs.sc",
               "#include <bgfx_shader.sh>\nvoid main() { gl_FragColor = vec4(1.0); }\n");

    const auto parsed = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v2",
      "shaders":{
        "sample_effect":{
          "stages":{
            "vertex":{"source":"project:/shaders/sample.vs.sc"},
            "fragment":{"source":"project:/shaders/sample.fs.sc"}
          },
          "uniforms":{"u_amount":{"type":"float","default":1.0}},
          "roles":["engine-2d"],
          "role_bindings":{}
        }
      },
      "materials":{"sample":{"role":"engine-2d","shader":"sample_effect"}}
    })json");
    REQUIRE(parsed.ok());
    REQUIRE(parsed.project);
    return *parsed.project;
}

const noveltea::ShaderDefinition* find_shader(const noveltea::ShaderMaterialProject& project,
                                              std::string_view id)
{
    for (const auto& shader : project.shaders) {
        if (shader.id.value() == id)
            return &shader;
    }
    return nullptr;
}

const noveltea::ShaderStageDefinition* find_stage(const noveltea::ShaderDefinition& shader,
                                                  noveltea::ShaderStage stage)
{
    for (const auto& definition : shader.stages) {
        if (definition.stage == stage)
            return &definition;
    }
    return nullptr;
}

bool has_compiled_ref(const noveltea::ShaderStageDefinition& stage, std::string_view variant,
                      std::string_view path)
{
    for (const auto& compiled : stage.compiled) {
        if (compiled.variant == variant && compiled.path == path)
            return true;
    }
    return false;
}

bool diagnostic_mentions(const noveltea::ShaderCompileResult& result, std::string_view text)
{
    for (const auto& diagnostic : result.diagnostics) {
        if (diagnostic.message.find(text) != std::string::npos ||
            diagnostic.command_line.find(text) != std::string::npos ||
            diagnostic.source_path.string().find(text) != std::string::npos ||
            diagnostic.output_path.string().find(text) != std::string::npos) {
            return true;
        }
    }
    return false;
}

} // namespace

TEST_CASE("shader compiler maps supported NovelTea shader variants")
{
    const auto gl = noveltea::shader_compile_variant_from_name("glsl-120");
    REQUIRE(gl);
    CHECK(gl->platform == "linux");
    CHECK(gl->profile == "120");

    const auto web = noveltea::shader_compile_variant_from_name("essl-100");
    REQUIRE(web);
    CHECK(web->platform == "asm.js");
    CHECK(web->profile == "100_es");

    const auto android = noveltea::shader_compile_variant_from_name("essl-300");
    REQUIRE(android);
    CHECK(android->platform == "android");
    CHECK(android->profile == "300_es");

    CHECK_FALSE(noveltea::shader_compile_variant_from_name("spirv"));
}

TEST_CASE("shader compiler compiles project shader sources and updates compiled refs")
{
    const auto temp = unique_temp_dir("compile");
    const auto options = make_options(temp);
    const auto project = make_source_project(options.project_root);

    const noveltea::ShaderCompilerService compiler;
    const auto result = compiler.compile_shader_project(project, options);

    REQUIRE(result.success());
    REQUIRE(result.outputs.size() == 4);
    for (const auto& output : result.outputs) {
        CHECK_FALSE(output.cache_hit);
        CHECK(std::filesystem::exists(output.output_path));
        CHECK(output.runtime_path.find("project:/shaders/bgfx/") == 0);
        CHECK(output.output_path.lexically_relative(options.output_root)
                  .generic_string()
                  .find("shaders/bgfx/") == 0);
        CHECK(output.byte_hash.starts_with("sha256:"));
        CHECK(output.byte_hash.size() == 71);
        CHECK(output.byte_size > 0);
        CHECK(output.cache_key != output.byte_hash);
    }

    const auto* shader = find_shader(result.project, "sample_effect");
    REQUIRE(shader != nullptr);
    const auto* vertex = find_stage(*shader, noveltea::ShaderStage::Vertex);
    const auto* fragment = find_stage(*shader, noveltea::ShaderStage::Fragment);
    REQUIRE(vertex != nullptr);
    REQUIRE(fragment != nullptr);
    CHECK(has_compiled_ref(*vertex, "glsl-120",
                           "project:/shaders/bgfx/glsl-120/sample_effect.vs.bin"));
    CHECK(has_compiled_ref(*fragment, "essl-100",
                           "project:/shaders/bgfx/essl-100/sample_effect.fs.bin"));

    std::filesystem::remove_all(temp);
}

TEST_CASE("shader compiler reports cache hits on unchanged second run")
{
    const auto temp = unique_temp_dir("cache");
    const auto options = make_options(temp);
    const auto project = make_source_project(options.project_root);

    const noveltea::ShaderCompilerService compiler;
    const auto first = compiler.compile_shader_project(project, options);
    REQUIRE(first.success());
    REQUIRE_FALSE(first.outputs.empty());

    const auto second = compiler.compile_shader_project(project, options);
    REQUIRE(second.success());
    REQUIRE(second.outputs.size() == first.outputs.size());
    for (std::size_t index = 0; index < second.outputs.size(); ++index) {
        const auto& output = second.outputs[index];
        CHECK(output.cache_hit);
        CHECK(output.byte_hash == first.outputs[index].byte_hash);
        CHECK(output.byte_size == first.outputs[index].byte_size);
        CHECK(output.cache_key == first.outputs[index].cache_key);
    }

    std::filesystem::remove_all(temp);
}

TEST_CASE("shader compiler compiles source_text through generated temporary source files")
{
    const auto temp = unique_temp_dir("source-text");
    const auto options = make_options(temp);
    const auto parsed = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v2",
      "shaders":{
        "inline_effect":{
          "stages":{"fragment":{"source_text":"#include <bgfx_shader.sh>\nvoid main() { gl_FragColor = vec4(1.0); }\n"}},
          "roles":["engine-2d"],
          "role_bindings":{}
        }
      },
      "materials":{}
    })json");
    REQUIRE(parsed.ok());
    REQUIRE(parsed.project);

    const noveltea::ShaderCompilerService compiler;
    const auto result = compiler.compile_shader_project(*parsed.project, options);

    REQUIRE(result.success());
    REQUIRE(result.outputs.size() == 2);
    CHECK(result.outputs.front().source_path.string().find("source-text") != std::string::npos);
    CHECK(std::filesystem::exists(options.output_root /
                                  "shaders/bgfx/glsl-120/inline_effect.fs.bin"));

    std::filesystem::remove_all(temp);
}

TEST_CASE("shader compiler failure diagnostics include command context and compiler output")
{
    const auto temp = unique_temp_dir("failure");
    auto options = make_options(temp);
    options.variants = noveltea::shader_compile_variants_from_names({"glsl-120"});
    const auto project = make_source_project(options.project_root);
    write_text(options.project_root / "shaders" / "sample.fs.sc",
               "this is not valid shader code\n");

    const noveltea::ShaderCompilerService compiler;
    const auto result = compiler.compile_shader_project(project, options);

    REQUIRE_FALSE(result.success());
    REQUIRE_FALSE(result.diagnostics.empty());
    CHECK(result.diagnostics.front().code == noveltea::ShaderCompileDiagnosticCode::CompilerFailed);
    CHECK(diagnostic_mentions(result, "sample_effect"));
    CHECK(diagnostic_mentions(result, "glsl-120"));
    CHECK(diagnostic_mentions(result, "sample.fs.sc"));
    CHECK(diagnostic_mentions(result, "--platform"));

    std::filesystem::remove_all(temp);
}

TEST_CASE("shader compiler reports missing source diagnostics without an external tool path")
{
    const auto temp = unique_temp_dir("missing");
    auto options = make_options(temp);
    const auto parsed = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v2",
      "shaders":{
        "missing_source":{"stages":{"fragment":{"source":"project:/shaders/missing.fs.sc"}},"roles":["engine-2d"],"role_bindings":{}}
      },
      "materials":{}
    })json");
    REQUIRE(parsed.ok());
    REQUIRE(parsed.project);

    const noveltea::ShaderCompilerService compiler;
    const auto result = compiler.compile_shader_project(*parsed.project, options);

    REQUIRE_FALSE(result.success());
    REQUIRE_FALSE(result.diagnostics.empty());
    CHECK(diagnostic_mentions(result, "missing.fs.sc"));

    std::filesystem::remove_all(temp);
}
