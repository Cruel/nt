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

void make_executable(const std::filesystem::path& path)
{
    std::filesystem::permissions(path,
                                 std::filesystem::perms::owner_exec |
                                     std::filesystem::perms::owner_read |
                                     std::filesystem::perms::owner_write,
                                 std::filesystem::perm_options::add);
}

std::filesystem::path write_fake_shaderc(const std::filesystem::path& dir)
{
    const auto script = dir / "fake-shaderc.sh";
    write_text(script, R"sh(#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        -o)
            shift
            out="$1"
            ;;
    esac
    shift
done
if [ -z "$out" ]; then
    echo "missing output" >&2
    exit 9
fi
mkdir -p "$(dirname "$out")"
printf 'fake compiled shader\n' > "$out"
exit 0
)sh");
    make_executable(script);
    return script;
}

std::filesystem::path write_failing_shaderc(const std::filesystem::path& dir)
{
    const auto script = dir / "failing-shaderc.sh";
    write_text(script, R"sh(#!/bin/sh
echo "fake shaderc failure" >&2
exit 7
)sh");
    make_executable(script);
    return script;
}

noveltea::ShaderCompileOptions make_options(const std::filesystem::path& temp)
{
    const auto bgfx_include = temp / "bgfx-include";
    write_text(bgfx_include / "bgfx_shader.sh", "// fake bgfx include\n");

    noveltea::ShaderCompileOptions options;
    options.shaderc = write_fake_shaderc(temp);
    options.bgfx_shader_include_dir = bgfx_include;
    options.project_root = temp / "project";
    options.output_root = temp / "generated";
    options.cache_root = temp / "cache";
    options.variants = noveltea::shader_compile_variants_from_names({"glsl-120", "essl-100"});
    return options;
}

noveltea::ShaderMaterialProject make_source_project(const std::filesystem::path& project_root)
{
    write_text(project_root / "shaders" / "sample.vs.sc", "// vertex\n");
    write_text(project_root / "shaders" / "sample.fs.sc", "// fragment\n");

    const auto parsed = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "sample_effect":{
          "stages":{
            "vertex":{"source":"project:/shaders/sample.vs.sc"},
            "fragment":{"source":"project:/shaders/sample.fs.sc"}
          },
          "uniforms":{"u_amount":{"type":"float","default":1.0}},
          "roles":["engine-2d"]
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
        CHECK(output.runtime_path.find("shaders/bgfx/") == 0);
    }

    const auto* shader = find_shader(result.project, "sample_effect");
    REQUIRE(shader != nullptr);
    const auto* vertex = find_stage(*shader, noveltea::ShaderStage::Vertex);
    const auto* fragment = find_stage(*shader, noveltea::ShaderStage::Fragment);
    REQUIRE(vertex != nullptr);
    REQUIRE(fragment != nullptr);
    CHECK(has_compiled_ref(*vertex, "glsl-120", "shaders/bgfx/glsl-120/sample_effect.vs.bin"));
    CHECK(has_compiled_ref(*fragment, "essl-100", "shaders/bgfx/essl-100/sample_effect.fs.bin"));

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
    for (const auto& output : second.outputs)
        CHECK(output.cache_hit);

    std::filesystem::remove_all(temp);
}

TEST_CASE("shader compiler compiles source_text through generated temporary source files")
{
    const auto temp = unique_temp_dir("source-text");
    const auto options = make_options(temp);
    const auto parsed = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "inline_effect":{
          "stages":{"fragment":{"source_text":"// inline fragment\n"}},
          "roles":["engine-2d"]
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
    options.shaderc = write_failing_shaderc(temp);
    options.variants = noveltea::shader_compile_variants_from_names({"glsl-120"});
    const auto project = make_source_project(options.project_root);

    const noveltea::ShaderCompilerService compiler;
    const auto result = compiler.compile_shader_project(project, options);

    REQUIRE_FALSE(result.success());
    REQUIRE_FALSE(result.diagnostics.empty());
    CHECK(result.diagnostics.front().code == noveltea::ShaderCompileDiagnosticCode::CompilerFailed);
    CHECK(diagnostic_mentions(result, "sample_effect"));
    CHECK(diagnostic_mentions(result, "glsl-120"));
    CHECK(diagnostic_mentions(result, "fake shaderc failure"));
    CHECK(diagnostic_mentions(result, "--platform"));

    std::filesystem::remove_all(temp);
}

TEST_CASE("shader compiler reports missing source and missing tool diagnostics")
{
    const auto temp = unique_temp_dir("missing");
    auto options = make_options(temp);
    options.shaderc = temp / "missing-shaderc";
    const auto parsed = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "missing_source":{"stages":{"fragment":{"source":"project:/shaders/missing.fs.sc"}},"roles":["engine-2d"]}
      },
      "materials":{}
    })json");
    REQUIRE(parsed.ok());
    REQUIRE(parsed.project);

    const noveltea::ShaderCompilerService compiler;
    const auto result = compiler.compile_shader_project(*parsed.project, options);

    REQUIRE_FALSE(result.success());
    REQUIRE_FALSE(result.diagnostics.empty());
    CHECK(result.diagnostics.front().code == noveltea::ShaderCompileDiagnosticCode::MissingShaderc);

    options.shaderc = write_fake_shaderc(temp);
    const auto source_result = compiler.compile_shader_project(*parsed.project, options);
    REQUIRE_FALSE(source_result.success());
    CHECK(diagnostic_mentions(source_result, "missing.fs.sc"));

    std::filesystem::remove_all(temp);
}
