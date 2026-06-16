#include <catch2/catch_test_macros.hpp>

#include "render/bgfx/bgfx_shader_loader.hpp"

using noveltea::bgfx_backend::shader_variant_for_renderer;

TEST_CASE("bgfx shader variant resolver only advertises built variants")
{
    CHECK(std::string(shader_variant_for_renderer(bgfx::RendererType::OpenGL, false)) == "glsl-120");
    CHECK(std::string(shader_variant_for_renderer(bgfx::RendererType::OpenGLES, true)) == "essl-100");
    CHECK(std::string(shader_variant_for_renderer(bgfx::RendererType::OpenGLES, false)) == "essl-300");
    CHECK(std::string(shader_variant_for_renderer(bgfx::RendererType::Metal, false)).empty());
    CHECK(std::string(shader_variant_for_renderer(bgfx::RendererType::Direct3D11, false)).empty());
    CHECK(std::string(shader_variant_for_renderer(bgfx::RendererType::Vulkan, false)).empty());
}
