#include <catch2/catch_test_macros.hpp>

#include "noveltea/render/material_contract.hpp"
#include "noveltea/render/quad_batch.hpp"
#include "render/bgfx/bgfx_material_binder.hpp"
#include "render/bgfx/bgfx_shader_loader.hpp"
#include "render/bgfx/bgfx_shader_program_cache.hpp"
#include "render/bgfx/bgfx_typed_asset_loader.hpp"

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
                             {0.0f, 0.0f, 1.0f, 1.0f}, {1.0f, 1.0f, 1.0f, 1.0f}, 0.0f,
                             noveltea::GameLayer::Main,
                             noveltea::MaterialTextureSampler::ClampNearest);
    CHECK_FALSE(only_command(batch).material.valid());
    CHECK(only_command(batch).texture_sampler == noveltea::MaterialTextureSampler::ClampNearest);
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

TEST_CASE("renderer system shader registry names both hotspot overlay programs")
{
    using noveltea::bgfx_backend::system_shader_name;
    using noveltea::bgfx_backend::SystemShader;

    CHECK(std::string_view{system_shader_name(SystemShader::PremultipliedQuad)} ==
          "premultiplied_quad");
    CHECK(std::string_view{system_shader_name(SystemShader::HotspotAlpha)} == "hotspot_alpha");
    CHECK(std::string_view{system_shader_name(SystemShader::HotspotCustom)} == "hotspot_custom");
}

TEST_CASE("draw texture sampling overrides filtering while preserving address mode")
{
    using noveltea::MaterialTextureSampler;
    using noveltea::bgfx_backend::resolve_draw_texture_sampler;

    CHECK(resolve_draw_texture_sampler(MaterialTextureSampler::ClampLinear,
                                       MaterialTextureSampler::ClampNearest) ==
          MaterialTextureSampler::ClampNearest);
    CHECK(resolve_draw_texture_sampler(MaterialTextureSampler::RepeatLinear,
                                       MaterialTextureSampler::ClampNearest) ==
          MaterialTextureSampler::RepeatNearest);
    CHECK(resolve_draw_texture_sampler(MaterialTextureSampler::RepeatNearest,
                                       MaterialTextureSampler::ClampLinear) ==
          MaterialTextureSampler::RepeatLinear);
}

TEST_CASE("renderer draw texture resolves the current quad texture or neutral source")
{
    noveltea::QuadCommand textured;
    textured.texture = noveltea::Texture{42};
    textured.texture_sampler = noveltea::MaterialTextureSampler::ClampNearest;

    const auto current =
        noveltea::bgfx_backend::resolve_renderer_draw_texture(&textured, bgfx::TextureHandle{77});
    CHECK(current.texture.idx == 42);
    CHECK(current.sampler == noveltea::MaterialTextureSampler::ClampNearest);

    noveltea::QuadCommand untextured;
    const auto neutral =
        noveltea::bgfx_backend::resolve_renderer_draw_texture(&untextured, bgfx::TextureHandle{77});
    CHECK(neutral.texture.idx == 77);
    CHECK(neutral.sampler == noveltea::MaterialTextureSampler::ClampLinear);
}

TEST_CASE("linear texture uploads build a complete averaged RGBA8 mip chain")
{
    using noveltea::bgfx_backend::build_rgba8_mip_chain;
    const std::array<std::uint8_t, 64> pixels = {
        0, 0,   0, 255, 64, 0,   0, 255, 128, 0,   0, 255, 255, 0,   0, 255,
        0, 64,  0, 255, 64, 64,  0, 255, 128, 64,  0, 255, 255, 64,  0, 255,
        0, 128, 0, 255, 64, 128, 0, 255, 128, 128, 0, 255, 255, 128, 0, 255,
        0, 255, 0, 255, 64, 255, 0, 255, 128, 255, 0, 255, 255, 255, 0, 255,
    };

    const auto chain = build_rgba8_mip_chain(pixels, 4, 4);
    REQUIRE(chain.mip_count == 3);
    REQUIRE(chain.bytes.size() == 64 + 16 + 4);
    CHECK(chain.bytes[64] == 32);
    CHECK(chain.bytes[65] == 32);
    CHECK(chain.bytes[80] == 112);
    CHECK(chain.bytes[81] == 112);
    CHECK(chain.bytes[83] == 255);
}

TEST_CASE("linear mip generation includes odd trailing texels")
{
    using noveltea::bgfx_backend::build_rgba8_mip_chain;
    const std::array<std::uint8_t, 12> pixels = {
        0, 0, 0, 255, 90, 0, 0, 255, 180, 0, 0, 255,
    };

    const auto chain = build_rgba8_mip_chain(pixels, 3, 1);
    REQUIRE(chain.mip_count == 2);
    REQUIRE(chain.bytes.size() == 16);
    CHECK(chain.bytes[12] == 90);
    CHECK(chain.bytes[15] == 255);
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

TEST_CASE("built-in ActiveText Material uses the canonical glyph-atlas contract")
{
    const auto project = noveltea::make_builtin_active_text_material_project();
    REQUIRE(project.materials.size() == 1);
    REQUIRE(project.shaders.size() == 1);

    const auto& material = project.materials.front();
    const auto& shader = project.shaders.front();
    const auto* preset = noveltea::material_preset_contract("active-text");
    REQUIRE(preset != nullptr);

    CHECK(material.id.string() == noveltea::builtin_active_text_material_id);
    CHECK(material.role == noveltea::ShaderRole::ActiveText);
    CHECK(material.shader == shader.id);
    CHECK(shader.interface_contract == preset->contract_identity);
    CHECK(shader.interface_fingerprint == preset->contract_fingerprint);
    REQUIRE(shader.samplers.size() == 1);
    CHECK(shader.samplers.front().name == "s_textAtlas");
    CHECK(shader.samplers.front().stage == 0);
    CHECK_FALSE(shader.samplers.front().binding.has_value());
}

TEST_CASE("ActiveText pipeline state is contract-owned premultiplied alpha")
{
    const auto state =
        noveltea::bgfx_backend::material_pipeline_state(noveltea::ShaderRole::ActiveText);
    REQUIRE(state.has_value());
    CHECK(*state == (BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A |
                     BGFX_STATE_BLEND_FUNC(BGFX_STATE_BLEND_ONE, BGFX_STATE_BLEND_INV_SRC_ALPHA)));
}

TEST_CASE("postprocess pipeline state is contract-owned replacement over premultiplied output")
{
    const auto state =
        noveltea::bgfx_backend::material_pipeline_state(noveltea::ShaderRole::Postprocess);
    REQUIRE(state.has_value());
    CHECK(*state == (BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A));
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

TEST_CASE("material binder packs canonical RmlUi standard inputs")
{
    using noveltea::ShaderInputSemantic;
    using noveltea::ShaderStandardInputs;
    using noveltea::bgfx_backend::pack_shader_standard_input;

    ShaderStandardInputs inputs;
    inputs.reference_to_world_raster_scale = {0.75f, 0.8f};
    inputs.context_logical_to_raster_scale = {2.5f, 2.4f};
    inputs.rmlui_media_query_resolution = 2.5f;
    inputs.viewport_pixel_dimensions = {3840.0f, 2160.0f};

    const auto world =
        pack_shader_standard_input(ShaderInputSemantic::EngineReferenceToWorldRasterScale, inputs);
    CHECK(world == std::array<float, 4>{0.75f, 0.8f, 0.0f, 0.0f});

    const auto ui =
        pack_shader_standard_input(ShaderInputSemantic::EngineContextLogicalToRasterScale, inputs);
    CHECK(ui == std::array<float, 4>{2.5f, 2.4f, 0.0f, 0.0f});

    const auto media =
        pack_shader_standard_input(ShaderInputSemantic::RmlUiMediaQueryResolution, inputs);
    CHECK(media == std::array<float, 4>{2.5f, 0.0f, 0.0f, 0.0f});

    const auto viewport =
        pack_shader_standard_input(ShaderInputSemantic::EngineViewportPixelDimensions, inputs);
    CHECK(viewport == std::array<float, 4>{3840.0f, 2160.0f, 0.0f, 0.0f});
    CHECK(world != ui);
}

TEST_CASE("material binder packs hotspot overlay standard inputs")
{
    // The hotspot draw context is packed through the same standard-input path as other roles.
    using noveltea::ShaderInputSemantic;
    using noveltea::ShaderStandardInputs;
    using noveltea::bgfx_backend::pack_shader_standard_input;

    ShaderStandardInputs inputs;
    inputs.hotspot_bounds = {0.1f, 0.2f, 0.3f, 0.4f};
    inputs.hotspot_hovered = true;
    inputs.hotspot_pressed = true;
    inputs.hotspot_image_dimensions = {1920.0f, 1080.0f};
    inputs.hotspot_mask_dimensions = {640.0f, 360.0f};

    CHECK(pack_shader_standard_input(ShaderInputSemantic::EngineHotspotBounds, inputs) ==
          inputs.hotspot_bounds);
    CHECK(pack_shader_standard_input(ShaderInputSemantic::EngineHotspotHovered, inputs) ==
          std::array<float, 4>{1.0f, 0.0f, 0.0f, 0.0f});
    CHECK(pack_shader_standard_input(ShaderInputSemantic::EngineHotspotPressed, inputs) ==
          std::array<float, 4>{1.0f, 0.0f, 0.0f, 0.0f});
    CHECK(pack_shader_standard_input(ShaderInputSemantic::EngineHotspotImageDimensions, inputs) ==
          std::array<float, 4>{1920.0f, 1080.0f, 0.0f, 0.0f});
    CHECK(pack_shader_standard_input(ShaderInputSemantic::EngineHotspotMaskDimensions, inputs) ==
          std::array<float, 4>{640.0f, 360.0f, 0.0f, 0.0f});
}
