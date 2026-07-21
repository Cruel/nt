#include <catch2/catch_test_macros.hpp>

#include "noveltea/render/quad_batch.hpp"
#include "render/bgfx/bgfx_material_binder.hpp"
#include "render/bgfx/bgfx_shader_program_cache.hpp"

namespace {

const noveltea::QuadCommand& only_command(const noveltea::QuadBatch& batch)
{
    REQUIRE(batch.commands().size() == 1);
    return batch.commands().front();
}

noveltea::ShaderMaterialProject make_role_test_project()
{
    noveltea::ShaderDefinition shader;
    shader.id = noveltea::ShaderId("test_shader");
    shader.roles.push_back(noveltea::ShaderRole::Engine2D);

    noveltea::MaterialDefinition material;
    material.id = noveltea::MaterialId("world/water");
    material.role = noveltea::ShaderRole::Engine2D;
    material.shader = shader.id;

    noveltea::ShaderMaterialProject project;
    project.shaders.push_back(std::move(shader));
    project.materials.push_back(std::move(material));
    return project;
}

bool has_program_diagnostic(const std::vector<noveltea::ShaderProgramDiagnostic>& diagnostics,
                            noveltea::ShaderProgramDiagnosticCode code)
{
    for (const auto& diagnostic : diagnostics) {
        if (diagnostic.code == code)
            return true;
    }
    return false;
}

} // namespace

TEST_CASE("quad batch default commands do not carry material ids")
{
    noveltea::QuadBatch batch;
    batch.draw_colored_quad({1.0f, 2.0f, 3.0f, 4.0f}, {0.1f, 0.2f, 0.3f, 0.4f});
    CHECK_FALSE(only_command(batch).material.valid());

    batch.clear();
    batch.draw_textured_quad({1.0f, 2.0f, 3.0f, 4.0f}, noveltea::Texture{7},
                             {0.0f, 0.0f, 1.0f, 1.0f}, {1.0f, 1.0f, 1.0f, 1.0f});
    CHECK_FALSE(only_command(batch).material.valid());
}

TEST_CASE("quad batch material commands preserve material ids and draw texture metadata")
{
    noveltea::QuadBatch batch;
    batch.draw_material_quad({10.0f, 20.0f, 30.0f, 40.0f}, noveltea::MaterialId("world/water"),
                             {0.2f, 0.4f, 0.6f, 1.0f});
    CHECK(only_command(batch).material.value() == "world/water");
    CHECK_FALSE(only_command(batch).texture.valid());

    batch.clear();
    batch.draw_material_textured_quad({10.0f, 20.0f, 30.0f, 40.0f},
                                      noveltea::MaterialId("world/water"), noveltea::Texture{42},
                                      {0.0f, 0.0f, 0.5f, 0.5f}, {1.0f, 1.0f, 1.0f, 1.0f});
    CHECK(only_command(batch).material.value() == "world/water");
    CHECK(only_command(batch).texture.handle == 42);
    CHECK(only_command(batch).uv.width == 0.5f);
}

TEST_CASE("material binder maps sampler policy to bgfx flags")
{
    using noveltea::MaterialTextureSampler;
    using noveltea::bgfx_backend::bgfx_sampler_flags;

    CHECK((bgfx_sampler_flags(MaterialTextureSampler::ClampNearest) & BGFX_SAMPLER_U_CLAMP) != 0);
    CHECK((bgfx_sampler_flags(MaterialTextureSampler::ClampNearest) & BGFX_SAMPLER_MIN_POINT) != 0);
    CHECK((bgfx_sampler_flags(MaterialTextureSampler::ClampLinear) & BGFX_SAMPLER_U_CLAMP) != 0);
    CHECK((bgfx_sampler_flags(MaterialTextureSampler::ClampLinear) & BGFX_SAMPLER_MIN_POINT) == 0);
    CHECK((bgfx_sampler_flags(MaterialTextureSampler::RepeatNearest) & BGFX_SAMPLER_U_CLAMP) == 0);
    CHECK((bgfx_sampler_flags(MaterialTextureSampler::RepeatNearest) & BGFX_SAMPLER_MIN_POINT) !=
          0);
    CHECK(bgfx_sampler_flags(MaterialTextureSampler::RepeatLinear) == 0);
}

TEST_CASE("material binder validates requested shader role before bgfx program loading")
{
    noveltea::assets::AssetManager assets;
    noveltea::bgfx_backend::BgfxShaderProgramCache programs(assets);
    noveltea::bgfx_backend::BgfxMaterialBinder binder(assets, programs, BGFX_INVALID_HANDLE);
    std::vector<noveltea::ShaderProgramDiagnostic> diagnostics;

    const auto result = binder.bind_material(
        make_role_test_project(), noveltea::MaterialId("world/water"),
        noveltea::bgfx_backend::BgfxMaterialBindInputs{.role = noveltea::ShaderRole::ActiveText},
        &diagnostics);

    CHECK_FALSE(result.ok);
    CHECK(has_program_diagnostic(diagnostics,
                                 noveltea::ShaderProgramDiagnosticCode::IncompatibleShaderRole));
}

TEST_CASE("material binder reports unknown materials without bgfx program loading")
{
    noveltea::assets::AssetManager assets;
    noveltea::bgfx_backend::BgfxShaderProgramCache programs(assets);
    noveltea::bgfx_backend::BgfxMaterialBinder binder(assets, programs, BGFX_INVALID_HANDLE);
    std::vector<noveltea::ShaderProgramDiagnostic> diagnostics;

    const auto result = binder.bind_material(
        make_role_test_project(), noveltea::MaterialId("missing"),
        noveltea::bgfx_backend::BgfxMaterialBindInputs{.role = noveltea::ShaderRole::ActiveText},
        &diagnostics);

    CHECK_FALSE(result.ok);
    CHECK(has_program_diagnostic(diagnostics,
                                 noveltea::ShaderProgramDiagnosticCode::UnknownMaterial));
}

TEST_CASE("material binder packs schema uniform values into vec4 bgfx uniforms")
{
    using noveltea::ShaderColor;
    using noveltea::ShaderUniformValue;
    using noveltea::bgfx_backend::pack_material_uniform;

    auto scalar = pack_material_uniform(ShaderUniformValue{0.75f});
    REQUIRE(scalar.supported);
    CHECK(scalar.value[0] == 0.75f);
    CHECK(scalar.value[1] == 0.0f);

    auto vec3 = pack_material_uniform(ShaderUniformValue{std::array<float, 3>{1.0f, 2.0f, 3.0f}});
    REQUIRE(vec3.supported);
    CHECK(vec3.value[0] == 1.0f);
    CHECK(vec3.value[1] == 2.0f);
    CHECK(vec3.value[2] == 3.0f);
    CHECK(vec3.value[3] == 0.0f);

    auto color = pack_material_uniform(ShaderUniformValue{ShaderColor{0.1f, 0.2f, 0.3f, 0.4f}});
    REQUIRE(color.supported);
    CHECK(color.value[0] == 0.1f);
    CHECK(color.value[3] == 0.4f);

    auto boolean = pack_material_uniform(ShaderUniformValue{true});
    REQUIRE(boolean.supported);
    CHECK(boolean.value[0] == 1.0f);

    auto empty = pack_material_uniform(ShaderUniformValue{});
    CHECK_FALSE(empty.supported);
}

TEST_CASE("material binder keeps world UI media and viewport standard inputs distinct")
{
    using noveltea::ShaderInputSemantic;
    using noveltea::ShaderStandardInputs;
    using noveltea::bgfx_backend::pack_shader_standard_input;

    ShaderStandardInputs inputs;
    inputs.reference_to_world_raster_scale = {0.75f, 0.8f};
    inputs.context_logical_to_ui_raster_scale = {2.5f, 2.4f};
    inputs.ui_media_query_resolution = 2.5f;
    inputs.viewport_pixel_dimensions = {3840.0f, 2160.0f};

    const auto world =
        pack_shader_standard_input(ShaderInputSemantic::EngineReferenceToWorldRasterScale, inputs);
    CHECK(world == std::array<float, 4>{0.75f, 0.8f, 0.0f, 0.0f});

    const auto ui = pack_shader_standard_input(
        ShaderInputSemantic::EngineContextLogicalToUiRasterScale, inputs);
    CHECK(ui == std::array<float, 4>{2.5f, 2.4f, 0.0f, 0.0f});

    const auto rmlui_ui =
        pack_shader_standard_input(ShaderInputSemantic::RmlUiContextLogicalToUiRasterScale, inputs);
    CHECK(rmlui_ui == ui);

    const auto media =
        pack_shader_standard_input(ShaderInputSemantic::EngineUiMediaQueryResolution, inputs);
    CHECK(media == std::array<float, 4>{2.5f, 0.0f, 0.0f, 0.0f});

    const auto viewport =
        pack_shader_standard_input(ShaderInputSemantic::EngineViewportPixelDimensions, inputs);
    CHECK(viewport == std::array<float, 4>{3840.0f, 2160.0f, 0.0f, 0.0f});
    CHECK(world != ui);
}
