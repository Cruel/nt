#include "raw_bgfx_geometry.hpp"
#include "benchmark_assets.hpp"

#include <bgfx/bgfx.h>

#include <cmath>
#include <cstring>
#include <fstream>
#include <iterator>
#include <vector>

namespace noveltea::benchmark {
namespace {

struct QuadVertex {
    float x, y, u, v, r, g, b, a;
};

bgfx::ShaderHandle shader(const char* filename)
{
    std::ifstream file(benchmark_asset_path(filename), std::ios::binary);
    if (!file)
        return BGFX_INVALID_HANDLE;
    const std::vector<char> bytes((std::istreambuf_iterator<char>(file)),
                                  std::istreambuf_iterator<char>());
    if (bytes.empty())
        return BGFX_INVALID_HANDLE;
    return bgfx::createShader(bgfx::copy(bytes.data(), static_cast<uint32_t>(bytes.size())));
}

uint32_t rgba(ReferenceColor color)
{
    return (uint32_t(color.r) << 24) | (uint32_t(color.g) << 16) | (uint32_t(color.b) << 8) |
           uint32_t(color.a);
}

} // namespace

RawBgfxGeometry::~RawBgfxGeometry() { shutdown(); }

bool RawBgfxGeometry::initialize(const ReferenceScene& scene, int framebuffer_width,
                                 int framebuffer_height, std::string& reason)
{
    shutdown();
    if (framebuffer_width < 1 || framebuffer_height < 1 || framebuffer_width > 65535 ||
        framebuffer_height > 65535 || scene.width == 0 || scene.height == 0 ||
        scene.rects.empty() || scene.rects.size() > kMaxReferenceRects ||
        scene.texture.width != 1 || scene.texture.height != 1) {
        reason = "invalid reference scene or framebuffer dimensions";
        return false;
    }
    const auto vertex_shader = shader(NOVELTEA_BENCHMARK_SHADER_ROOT "/quad.vs.bin");
    if (!bgfx::isValid(vertex_shader)) {
        reason = "cannot load raw geometry vertex shader";
        return false;
    }
    const auto fragment_shader = shader(NOVELTEA_BENCHMARK_SHADER_ROOT "/quad.fs.bin");
    if (!bgfx::isValid(fragment_shader)) {
        bgfx::destroy(vertex_shader);
        reason = "cannot load raw geometry fragment shader";
        return false;
    }
    program_ = bgfx::createProgram(vertex_shader, fragment_shader, true);
    if (!bgfx::isValid(program_)) {
        reason = "cannot create raw geometry shader program";
        return false;
    }
    sampler_ = bgfx::createUniform("s_texColor", bgfx::UniformType::Sampler);
    if (!bgfx::isValid(sampler_)) {
        reason = "cannot create raw geometry sampler";
        shutdown();
        return false;
    }
    const ReferenceColor color = scene.texture.color;
    const uint8_t pixel[] = {color.r, color.g, color.b, color.a};
    texture_ = bgfx::createTexture2D(1, 1, false, 1, bgfx::TextureFormat::RGBA8,
                                     scene.texture.linear_filter
                                         ? BGFX_SAMPLER_NONE
                                         : BGFX_SAMPLER_MIN_POINT | BGFX_SAMPLER_MAG_POINT,
                                     bgfx::copy(pixel, sizeof(pixel)));
    if (!bgfx::isValid(texture_)) {
        reason = "cannot create raw geometry texture";
        shutdown();
        return false;
    }
    std::vector<QuadVertex> vertices;
    std::vector<uint16_t> indices;
    vertices.reserve(scene.rects.size() * 4);
    indices.reserve(scene.rects.size() * 6);
    for (const auto& rect : scene.rects) {
        if (!std::isfinite(rect.x) || !std::isfinite(rect.y) || !std::isfinite(rect.width) ||
            !std::isfinite(rect.height) || rect.width <= 0 || rect.height <= 0) {
            reason = "invalid reference rectangle";
            shutdown();
            return false;
        }
        const float r = rect.color.r / 255.0f;
        const float g = rect.color.g / 255.0f;
        const float b = rect.color.b / 255.0f;
        const float a = rect.color.a / 255.0f;
        const auto first = static_cast<uint16_t>(vertices.size());
        vertices.push_back({rect.x, rect.y, 0, 0, r, g, b, a});
        vertices.push_back({rect.x + rect.width, rect.y, 1, 0, r, g, b, a});
        vertices.push_back({rect.x + rect.width, rect.y + rect.height, 1, 1, r, g, b, a});
        vertices.push_back({rect.x, rect.y + rect.height, 0, 1, r, g, b, a});
        for (const uint16_t offset :
             {uint16_t(0), uint16_t(1), uint16_t(2), uint16_t(0), uint16_t(2), uint16_t(3)})
            indices.push_back(static_cast<uint16_t>(first + offset));
    }
    bgfx::VertexLayout layout;
    layout.begin()
        .add(bgfx::Attrib::Position, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::TexCoord0, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::Color0, 4, bgfx::AttribType::Float)
        .end();
    vertices_ = bgfx::createVertexBuffer(
        bgfx::copy(vertices.data(), static_cast<uint32_t>(vertices.size() * sizeof(QuadVertex))),
        layout);
    indices_ = bgfx::createIndexBuffer(
        bgfx::copy(indices.data(), static_cast<uint32_t>(indices.size() * sizeof(uint16_t))));
    if (!bgfx::isValid(vertices_) || !bgfx::isValid(indices_)) {
        reason = "cannot allocate raw geometry buffers";
        shutdown();
        return false;
    }

    clear_rgba_ = rgba(scene.clear_color);
    framebuffer_width_ = framebuffer_width;
    framebuffer_height_ = framebuffer_height;
    std::memset(ortho_, 0, sizeof(ortho_));
    ortho_[0] = 2.0f / static_cast<float>(scene.width);
    ortho_[5] = -2.0f / static_cast<float>(scene.height);
    ortho_[10] = 1.0f;
    ortho_[12] = -1.0f;
    ortho_[13] = 1.0f;
    ortho_[15] = 1.0f;
    return true;
}

bool RawBgfxGeometry::submit(std::string& reason)
{
    if (!initialized() || !bgfx::isValid(vertices_) || !bgfx::isValid(indices_) ||
        !bgfx::isValid(texture_)) {
        reason = "raw geometry not prepared";
        return false;
    }
    bgfx::setViewRect(0, 0, 0, static_cast<uint16_t>(framebuffer_width_),
                      static_cast<uint16_t>(framebuffer_height_));
    bgfx::setViewClear(0, BGFX_CLEAR_COLOR, clear_rgba_);
    bgfx::setViewTransform(0, nullptr, ortho_);
    bgfx::touch(0);
    bgfx::setTexture(0, sampler_, texture_);
    bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A);
    bgfx::setVertexBuffer(0, vertices_);
    bgfx::setIndexBuffer(indices_);
    bgfx::submit(0, program_);
    return true;
}

void RawBgfxGeometry::shutdown()
{
    if (bgfx::isValid(indices_))
        bgfx::destroy(indices_);
    if (bgfx::isValid(vertices_))
        bgfx::destroy(vertices_);
    if (bgfx::isValid(texture_))
        bgfx::destroy(texture_);
    if (bgfx::isValid(sampler_))
        bgfx::destroy(sampler_);
    if (bgfx::isValid(program_))
        bgfx::destroy(program_);
    indices_ = BGFX_INVALID_HANDLE;
    vertices_ = BGFX_INVALID_HANDLE;
    texture_ = BGFX_INVALID_HANDLE;
    sampler_ = BGFX_INVALID_HANDLE;
    program_ = BGFX_INVALID_HANDLE;
}

} // namespace noveltea::benchmark
