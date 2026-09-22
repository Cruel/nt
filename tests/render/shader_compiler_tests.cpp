#include <catch2/catch_test_macros.hpp>

#include "noveltea/render/shader_compiler.hpp"
#include "noveltea/render/material_codec.hpp"
#include "noveltea/render/material_contract.hpp"

#include <algorithm>
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
    options.engine_shader_root = temp / "engine-shaders";
    options.output_root = temp / "generated";
    options.cache_root = temp / "cache";
    options.variants = noveltea::shader_compile_variants_from_names({"glsl-330", "essl-300"});
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
      "schema":"noveltea.shader-materials",
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
    const auto gl = noveltea::shader_compile_variant_from_name("glsl-330");
    REQUIRE(gl);
    CHECK(gl->platform == "linux");
    CHECK(gl->profile == "330");

    const auto essl = noveltea::shader_compile_variant_from_name("essl-300");
    REQUIRE(essl);
    CHECK(essl->platform == "android");
    CHECK(essl->profile == "300_es");

    const auto metal = noveltea::shader_compile_variant_from_name("metal");
    REQUIRE(metal);
    CHECK(metal->platform == "osx");
    CHECK(metal->profile == "metal");

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
    CHECK(has_compiled_ref(*vertex, "glsl-330",
                           "project:/shaders/bgfx/glsl-330/sample_effect.vs.bin"));
    CHECK(has_compiled_ref(*fragment, "essl-300",
                           "project:/shaders/bgfx/essl-300/sample_effect.fs.bin"));

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
      "schema":"noveltea.shader-materials",
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
                                  "shaders/bgfx/glsl-330/inline_effect.fs.bin"));

    std::filesystem::remove_all(temp);
}

TEST_CASE("shader compiler failure diagnostics include command context and compiler output")
{
    const auto temp = unique_temp_dir("failure");
    auto options = make_options(temp);
    options.variants = noveltea::shader_compile_variants_from_names({"glsl-330"});
    const auto project = make_source_project(options.project_root);
    write_text(options.project_root / "shaders" / "sample.fs.sc",
               "this is not valid shader code\n");

    const noveltea::ShaderCompilerService compiler;
    const auto result = compiler.compile_shader_project(project, options);

    REQUIRE_FALSE(result.success());
    REQUIRE_FALSE(result.diagnostics.empty());
    CHECK(result.diagnostics.front().code == noveltea::ShaderCompileDiagnosticCode::CompilerFailed);
    CHECK(diagnostic_mentions(result, "sample_effect"));
    CHECK(diagnostic_mentions(result, "glsl-330"));
    CHECK(diagnostic_mentions(result, "sample.fs.sc"));
    CHECK(diagnostic_mentions(result, "--platform"));

    std::filesystem::remove_all(temp);
}

TEST_CASE("shader compiler reports missing source diagnostics without an external tool path")
{
    const auto temp = unique_temp_dir("missing");
    auto options = make_options(temp);
    const auto parsed = noveltea::parse_shader_material_project_json(R"json({
      "schema":"noveltea.shader-materials",
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

TEST_CASE(
    "source program compiler uses explicit varying inputs and fingerprints transitive includes")
{
    const auto temp = unique_temp_dir("source-program");
    auto options = make_options(temp);
    options.variants =
        noveltea::shader_compile_variants_from_names({"glsl-330", "essl-300", "metal"});
    write_text(options.project_root / "shaders" / "varying.def.sc",
               "vec2 a_position : POSITION;\nvec2 v_uv : TEXCOORD0;\n");
    write_text(options.project_root / "shaders" / "shared.sc",
               "#define NT_TINT vec4(1.0, 0.0, 0.0, 1.0)\n");
    write_text(options.project_root / "shaders" / "main.vs.sc",
               "$input a_position\n$output v_uv\n#include <bgfx_shader.sh>\n"
               "void main() { v_uv = a_position; gl_Position = vec4(a_position, 0.0, 1.0); }\n");
    write_text(options.project_root / "shaders" / "main.fs.sc",
               "$input v_uv\n#include <bgfx_shader.sh>\n#include \"shared.sc\"\n"
               "// #include \"../outside.sc\"\n"
               "void main() { gl_FragColor = NT_TINT; }\n");

    const noveltea::ShaderSourceProgramRequest request{
        .vertex_source = "project:/shaders/main.vs.sc",
        .fragment_source = "project:/shaders/main.fs.sc",
        .varying_definition = "project:/shaders/varying.def.sc",
        .interface_contract = "engine-2d:v1",
        .interface_fingerprint =
            "sha256:0000000000000000000000000000000000000000000000000000000000000001",
    };
    const noveltea::ShaderCompilerService compiler;
    const auto first = compiler.compile_source_program(request, options);
    REQUIRE(first.success());
    REQUIRE(first.outputs.size() == 6);
    CHECK(std::any_of(first.outputs.begin(), first.outputs.end(),
                      [](const auto& output) { return output.variant == "glsl-330"; }));
    CHECK(std::any_of(first.outputs.begin(), first.outputs.end(),
                      [](const auto& output) { return output.variant == "essl-300"; }));
    CHECK(std::any_of(first.outputs.begin(), first.outputs.end(),
                      [](const auto& output) { return output.variant == "metal"; }));
    CHECK_FALSE(first.program_identity.empty());
    CHECK_FALSE(
        std::filesystem::exists(options.project_root / "shaders" / "main" / "varying.def.sc"));

    const auto fragment =
        std::find_if(first.outputs.begin(), first.outputs.end(), [](const auto& output) {
            return output.stage == noveltea::ShaderStage::Fragment && output.variant == "glsl-330";
        });
    REQUIRE(fragment != first.outputs.end());
    CHECK(std::find(fragment->dependencies.begin(), fragment->dependencies.end(),
                    "project:/shaders/shared.sc") != fragment->dependencies.end());
    REQUIRE(fragment->dependency_revisions.size() == fragment->dependencies.size());
    for (std::size_t index = 0; index < fragment->dependency_revisions.size(); ++index) {
        CHECK(fragment->dependency_revisions[index].identity == fragment->dependencies[index]);
        CHECK(fragment->dependency_revisions[index].content_hash.starts_with("sha256:"));
        CHECK(fragment->dependency_revisions[index].content_hash.size() == 71);
    }
    const auto first_key = fragment->cache_key;
    const auto first_identity = first.program_identity;

    write_text(options.project_root / "shaders" / "shared.sc",
               "#define NT_TINT vec4(0.0, 1.0, 0.0, 1.0)\n");
    const auto second = compiler.compile_source_program(request, options);
    REQUIRE(second.success());
    CHECK(second.program_identity != first_identity);
    const auto second_fragment =
        std::find_if(second.outputs.begin(), second.outputs.end(), [](const auto& output) {
            return output.stage == noveltea::ShaderStage::Fragment && output.variant == "glsl-330";
        });
    REQUIRE(second_fragment != second.outputs.end());
    CHECK(second_fragment->cache_key != first_key);

    auto changed_contract = request;
    changed_contract.interface_contract = "engine-2d:v2";
    const auto third = compiler.compile_source_program(changed_contract, options);
    REQUIRE(third.success());
    CHECK(third.program_identity != second.program_identity);

    auto changed_fingerprint = request;
    changed_fingerprint.interface_fingerprint =
        "sha256:0000000000000000000000000000000000000000000000000000000000000002";
    const auto fourth = compiler.compile_source_program(changed_fingerprint, options);
    REQUIRE(fourth.success());
    CHECK(fourth.program_identity != second.program_identity);

    std::filesystem::remove_all(temp);
}

TEST_CASE("shipped Material preset programs pass canonical contract certification")
{
    const auto temp = unique_temp_dir("builtin-material-contracts");
    auto options = make_options(temp);
    options.engine_shader_root = std::filesystem::path(NOVELTEA_SOURCE_DIR) / "engine/shaders/bgfx";
    options.variants =
        noveltea::shader_compile_variants_from_names({"glsl-330", "essl-300", "metal"});
    const noveltea::ShaderCompilerService compiler;

    for (const auto& preset : noveltea::material_preset_contracts()) {
        INFO("preset=" << preset.id);
        const noveltea::ShaderSourceProgramRequest request{
            .vertex_source = std::string(preset.vertex_source),
            .fragment_source = std::string(preset.fragment_source),
            .varying_definition = std::string(preset.varying_definition),
            .interface_contract = std::string(preset.contract_identity),
            .interface_fingerprint = std::string(preset.contract_fingerprint),
        };
        const auto result = compiler.compile_source_program(request, options);
        for (const auto& diagnostic : result.diagnostics)
            INFO(diagnostic.message);
        CHECK(result.success());
    }

    std::filesystem::remove_all(temp);
}

TEST_CASE("Material source programs certify renderer ABI and reflected sampler stages")
{
    const auto temp = unique_temp_dir("material-contract");
    auto options = make_options(temp);
    options.variants = noveltea::shader_compile_variants_from_names({"glsl-330"});
    write_text(options.engine_shader_root / "varying.def.sc", "vec2 a_position : POSITION;\n"
                                                              "vec2 a_texcoord0 : TEXCOORD0;\n"
                                                              "vec4 a_color0 : COLOR0;\n"
                                                              "vec2 v_texcoord0 : TEXCOORD0;\n"
                                                              "vec4 v_color0 : COLOR0;\n");
    write_text(options.engine_shader_root / "vs_quad.sc",
               "$input a_position, a_texcoord0, a_color0\n"
               "$output v_texcoord0, v_color0\n"
               "#include <bgfx_shader.sh>\n"
               "void main() { v_texcoord0 = a_texcoord0; v_color0 = a_color0; "
               "gl_Position = mul(u_modelViewProj, vec4(a_position, 0.0, 1.0)); }\n");
    write_text(options.project_root / "shaders" / "effect.fs.sc",
               "$input v_texcoord0, v_color0\n"
               "#include <bgfx_shader.sh>\n"
               "uniform vec4 u_amount;\n"
               "SAMPLER2D(s_texColor, 0);\n"
               "void main() { gl_FragColor = texture2D(s_texColor, v_texcoord0) * "
               "v_color0 * u_amount; }\n");

    const auto* preset = noveltea::material_preset_contract("engine-2d");
    REQUIRE(preset != nullptr);
    const noveltea::ShaderSourceProgramRequest request{
        .vertex_source = "engine:/vs_quad.sc",
        .fragment_source = "project:/shaders/effect.fs.sc",
        .varying_definition = "engine:/varying.def.sc",
        .interface_contract = std::string(preset->contract_identity),
        .interface_fingerprint = std::string(preset->contract_fingerprint),
    };
    const noveltea::ShaderCompilerService compiler;
    const auto result = compiler.compile_source_program(request, options);
    REQUIRE(result.success());
    const auto fragment =
        std::find_if(result.outputs.begin(), result.outputs.end(), [](const auto& output) {
            return output.stage == noveltea::ShaderStage::Fragment;
        });
    REQUIRE(fragment != result.outputs.end());
    const auto sampler =
        std::find_if(fragment->reflected_inputs.begin(), fragment->reflected_inputs.end(),
                     [](const auto& input) { return input.name == "s_texColor"; });
    REQUIRE(sampler != fragment->reflected_inputs.end());
    CHECK(sampler->register_index == 0);
    CHECK(sampler->register_count == 1);

    write_text(options.project_root / "shaders" / "effect.fs.sc",
               "$input v_texcoord0, v_color0\n"
               "#include <bgfx_shader.sh>\n"
               "uniform mat4 u_authorMatrix;\n"
               "SAMPLER2D(s_texColor, 0);\n"
               "void main() { gl_FragColor = u_authorMatrix[0] + "
               "texture2D(s_texColor, v_texcoord0) * v_color0; }\n");
    const auto matrix = compiler.compile_source_program(request, options);
    CHECK_FALSE(matrix.success());
    CHECK(std::any_of(matrix.diagnostics.begin(), matrix.diagnostics.end(), [](const auto& item) {
        return item.code == noveltea::ShaderCompileDiagnosticCode::ContractViolation &&
               item.message.find("physical vec4") != std::string::npos;
    }));

    write_text(options.project_root / "shaders" / "effect.fs.sc",
               "$input v_texcoord0, v_color0\n"
               "#include <bgfx_shader.sh>\n"
               "uniform vec4 u_authorArray[2];\n"
               "SAMPLER2D(s_texColor, 0);\n"
               "void main() { gl_FragColor = u_authorArray[0] + "
               "texture2D(s_texColor, v_texcoord0) * v_color0; }\n");
    const auto array = compiler.compile_source_program(request, options);
    CHECK_FALSE(array.success());
    CHECK(std::any_of(array.diagnostics.begin(), array.diagnostics.end(), [](const auto& item) {
        return item.code == noveltea::ShaderCompileDiagnosticCode::ContractViolation &&
               item.message.find("array size 1") != std::string::npos;
    }));

    write_text(options.project_root / "shaders" / "effect.fs.sc",
               "$input v_texcoord0, v_color0\n"
               "#include <bgfx_shader.sh>\n"
               "SAMPLER2D(s_texColor, 1);\n"
               "void main() { gl_FragColor = texture2D(s_texColor, v_texcoord0) * v_color0; }\n");
    auto invalid_stage = request;
    const auto rejected = compiler.compile_source_program(invalid_stage, options);
    CHECK_FALSE(rejected.success());
    CHECK(
        std::any_of(rejected.diagnostics.begin(), rejected.diagnostics.end(), [](const auto& item) {
            return item.code == noveltea::ShaderCompileDiagnosticCode::ContractViolation &&
                   item.message.find("reserved stage 0") != std::string::npos;
        }));

    auto stale_contract = request;
    stale_contract.interface_fingerprint =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const auto stale = compiler.compile_source_program(stale_contract, options);
    CHECK_FALSE(stale.success());
    CHECK(std::any_of(stale.diagnostics.begin(), stale.diagnostics.end(), [](const auto& item) {
        return item.code == noveltea::ShaderCompileDiagnosticCode::ContractViolation &&
               item.message.find("fingerprint") != std::string::npos;
    }));

    std::filesystem::remove_all(temp);
}

TEST_CASE("Material additional varyings extend but cannot collide with the renderer contract")
{
    const auto temp = unique_temp_dir("material-varying-extension");
    auto options = make_options(temp);
    options.variants = noveltea::shader_compile_variants_from_names({"glsl-330"});
    write_text(options.engine_shader_root / "varying.def.sc", "vec2 a_position : POSITION;\n"
                                                              "vec2 a_texcoord0 : TEXCOORD0;\n"
                                                              "vec4 a_color0 : COLOR0;\n"
                                                              "vec2 v_texcoord0 : TEXCOORD0;\n"
                                                              "vec4 v_color0 : COLOR0;\n");
    write_text(options.project_root / "shaders" / "extra.def.sc", "vec2 v_extra : TEXCOORD1;\n");
    write_text(options.project_root / "shaders" / "effect.vs.sc",
               "$input a_position, a_texcoord0, a_color0\n"
               "$output v_texcoord0, v_color0, v_extra\n"
               "#include <bgfx_shader.sh>\n"
               "void main() { v_texcoord0 = a_texcoord0; v_color0 = a_color0; "
               "v_extra = a_texcoord0; gl_Position = mul(u_modelViewProj, "
               "vec4(a_position, 0.0, 1.0)); }\n");
    write_text(options.project_root / "shaders" / "effect.fs.sc",
               "$input v_texcoord0, v_color0, v_extra\n"
               "#include <bgfx_shader.sh>\nSAMPLER2D(s_texColor, 0);\n"
               "void main() { gl_FragColor = texture2D(s_texColor, v_extra) * v_color0; }\n");
    const auto* preset = noveltea::material_preset_contract("engine-2d");
    REQUIRE(preset != nullptr);
    noveltea::ShaderSourceProgramRequest request{
        .vertex_source = "project:/shaders/effect.vs.sc",
        .fragment_source = "project:/shaders/effect.fs.sc",
        .varying_definition = "project:/shaders/extra.def.sc",
        .interface_contract = std::string(preset->contract_identity),
        .interface_fingerprint = std::string(preset->contract_fingerprint),
    };
    const noveltea::ShaderCompilerService compiler;
    const auto valid = compiler.compile_source_program(request, options);
    REQUIRE(valid.success());
    CHECK(std::any_of(
        valid.outputs.front().dependencies.begin(), valid.outputs.front().dependencies.end(),
        [](const auto& dependency) { return dependency == "engine:/varying.def.sc"; }));
    CHECK(std::any_of(
        valid.outputs.front().dependencies.begin(), valid.outputs.front().dependencies.end(),
        [](const auto& dependency) { return dependency == "project:/shaders/extra.def.sc"; }));

    write_text(options.project_root / "shaders" / "extra.def.sc", "vec2 v_extra : TEXCOORD0;\n");
    const auto collision = compiler.compile_source_program(request, options);
    CHECK_FALSE(collision.success());
    CHECK(std::any_of(
        collision.diagnostics.begin(), collision.diagnostics.end(), [](const auto& item) {
            return item.code == noveltea::ShaderCompileDiagnosticCode::ContractViolation &&
                   item.message.find("collides") != std::string::npos;
        }));

    std::filesystem::remove_all(temp);
}

TEST_CASE("source program reflection normalizes Metal sampler bindings to logical inputs")
{
    const auto temp = unique_temp_dir("metal-sampler-reflection");
    auto options = make_options(temp);
    options.variants = noveltea::shader_compile_variants_from_names({"essl-300", "metal"});
    write_text(options.engine_shader_root / "varying.def.sc",
               "vec2 a_position : POSITION;\nvec2 v_uv : TEXCOORD0;\n");
    write_text(options.engine_shader_root / "default.vs.sc",
               "$input a_position\n$output v_uv\n#include <bgfx_shader.sh>\n"
               "void main() { v_uv = a_position; gl_Position = vec4(a_position, 0.0, 1.0); }\n");
    write_text(options.project_root / "shaders" / "custom.fs.sc",
               "$input v_uv\n#include <bgfx_shader.sh>\nuniform vec4 u_tint;\n"
               "SAMPLER2D(s_tex, 0);\n"
               "void main() { gl_FragColor = u_tint + texture2D(s_tex, v_uv); }\n");

    const noveltea::ShaderSourceProgramRequest request{
        .vertex_source = "engine:/default.vs.sc",
        .fragment_source = "project:/shaders/custom.fs.sc",
        .varying_definition = "engine:/varying.def.sc",
        .interface_contract = "preview:test",
    };
    const noveltea::ShaderCompilerService compiler;
    const auto result = compiler.compile_source_program(request, options);
    REQUIRE(result.success());

    const auto metal_fragment =
        std::find_if(result.outputs.begin(), result.outputs.end(), [](const auto& output) {
            return output.stage == noveltea::ShaderStage::Fragment && output.variant == "metal";
        });
    REQUIRE(metal_fragment != result.outputs.end());
    CHECK(std::none_of(metal_fragment->reflected_inputs.begin(),
                       metal_fragment->reflected_inputs.end(), [](const auto& input) {
                           return input.name == "s_texSampler" || input.name == "s_texTexture";
                       }));
    const auto sampler = std::find_if(metal_fragment->reflected_inputs.begin(),
                                      metal_fragment->reflected_inputs.end(),
                                      [](const auto& input) { return input.name == "s_tex"; });
    REQUIRE(sampler != metal_fragment->reflected_inputs.end());
    CHECK(sampler->kind == noveltea::ShaderReflectedInputKind::SampledImage);
    CHECK(sampler->array_size == 1);

    std::filesystem::remove_all(temp);
}

TEST_CASE("source program compiler rejects project include escapes")
{
    const auto temp = unique_temp_dir("include-escape");
    auto options = make_options(temp);
    options.variants = noveltea::shader_compile_variants_from_names({"glsl-330"});
    write_text(options.project_root / "shaders" / "varying.def.sc", "vec2 v_uv : TEXCOORD0;\n");
    write_text(options.project_root / "outside.sc", "#define ESCAPED 1\n");
    write_text(options.project_root / "shaders" / "main.fs.sc",
               "#include <bgfx_shader.sh>\n#include \"../outside.sc\"\n"
               "void main() { gl_FragColor = vec4(1.0); }\n");

    const noveltea::ShaderSourceProgramRequest request{
        .fragment_source = "project:/shaders/main.fs.sc",
        .varying_definition = "project:/shaders/varying.def.sc",
    };
    const noveltea::ShaderCompilerService compiler;
    const auto result = compiler.compile_source_program(request, options);
    REQUIRE_FALSE(result.success());
    CHECK(std::any_of(
        result.diagnostics.begin(), result.diagnostics.end(), [](const auto& diagnostic) {
            return diagnostic.code == noveltea::ShaderCompileDiagnosticCode::UnsafeIncludePath;
        }));

    std::filesystem::remove_all(temp);
}

TEST_CASE(
    "source program compiler supports engine stages and exposes reflection and browser payload")
{
    const auto temp = unique_temp_dir("engine-stage");
    auto options = make_options(temp);
    options.variants = noveltea::shader_compile_variants_from_names({"essl-300"});
    write_text(options.engine_shader_root / "varying.def.sc",
               "vec2 a_position : POSITION;\nvec2 v_uv : TEXCOORD0;\n");
    write_text(options.engine_shader_root / "default.vs.sc",
               "$input a_position\n$output v_uv\n#include <bgfx_shader.sh>\n"
               "void main() { v_uv = a_position; gl_Position = vec4(a_position, 0.0, 1.0); }\n");
    write_text(options.engine_shader_root / "preview-common.sc",
               "#define NT_PREVIEW_BIAS vec4(0.0)\n");
    write_text(
        options.project_root / "shaders" / "custom.fs.sc",
        "$input v_uv\n#include <bgfx_shader.sh>\n# include \"preview-common.sc\"\n"
        "uniform vec4 u_tint;\nSAMPLER2D(s_tex, 0);\n"
        "void main() { gl_FragColor = u_tint + texture2D(s_tex, v_uv) + NT_PREVIEW_BIAS; }\n");

    const noveltea::ShaderSourceProgramRequest request{
        .vertex_source = "engine:/default.vs.sc",
        .fragment_source = "project:/shaders/custom.fs.sc",
        .varying_definition = "engine:/varying.def.sc",
        .interface_contract = "preview:test",
    };
    const noveltea::ShaderCompilerService compiler;
    const auto result = compiler.compile_source_program(request, options);
    REQUIRE(result.success());
    REQUIRE(result.outputs.size() == 2);
    const auto fragment =
        std::find_if(result.outputs.begin(), result.outputs.end(), [](const auto& output) {
            return output.stage == noveltea::ShaderStage::Fragment;
        });
    REQUIRE(fragment != result.outputs.end());
    REQUIRE(fragment->browser_payload);
    CHECK(fragment->browser_payload->find("void main") != std::string::npos);
    CHECK(std::find(fragment->dependencies.begin(), fragment->dependencies.end(),
                    "engine:/preview-common.sc") != fragment->dependencies.end());
    CHECK(std::any_of(fragment->reflected_inputs.begin(), fragment->reflected_inputs.end(),
                      [](const auto& input) {
                          return input.name == "u_tint" &&
                                 input.kind == noveltea::ShaderReflectedInputKind::Uniform;
                      }));
    CHECK(std::any_of(fragment->reflected_inputs.begin(), fragment->reflected_inputs.end(),
                      [](const auto& input) {
                          return input.name == "s_tex" &&
                                 input.kind == noveltea::ShaderReflectedInputKind::SampledImage;
                      }));

    const auto repeated = compiler.compile_source_program(request, options);
    REQUIRE(repeated.success());
    CHECK(repeated.program_identity == result.program_identity);
    CHECK(std::all_of(repeated.outputs.begin(), repeated.outputs.end(),
                      [](const auto& output) { return output.cache_hit; }));

    std::filesystem::remove_all(temp);
}
