#include <catch2/catch_test_macros.hpp>

#include "render/bgfx/bgfx_shader_loader.hpp"

using noveltea::bgfx_backend::shader_variant_for_renderer;

TEST_CASE("runtime shader resolver maps each supported renderer backend")
{
    CHECK(std::string(shader_variant_for_renderer(bgfx::RendererType::OpenGL)) == "glsl-330");
    CHECK(std::string(shader_variant_for_renderer(bgfx::RendererType::OpenGLES)) == "essl-300");
    CHECK(std::string(shader_variant_for_renderer(bgfx::RendererType::Metal)) == "metal");
    CHECK(std::string(shader_variant_for_renderer(bgfx::RendererType::Direct3D11)).empty());
    CHECK(std::string(shader_variant_for_renderer(bgfx::RendererType::Vulkan)).empty());
}
