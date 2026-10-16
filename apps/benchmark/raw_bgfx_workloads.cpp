#include "raw_bgfx_workloads.hpp"

#include "benchmark_assets.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace noveltea::benchmark {
namespace {

struct QuadVertex {
    float x, y, u, v, r, g, b, a;
};

void add_quad(std::vector<QuadVertex>& vertices, std::vector<uint16_t>& indices, float x, float y,
              float width, float height, bool flip_v, float r, float g, float b)
{
    const auto first = static_cast<uint16_t>(vertices.size());
    const float top = flip_v ? 1.0f : 0.0f;
    const float bottom = flip_v ? 0.0f : 1.0f;
    vertices.push_back({x, y, 0, top, r, g, b, 1});
    vertices.push_back({x + width, y, 1, top, r, g, b, 1});
    vertices.push_back({x + width, y + height, 1, bottom, r, g, b, 1});
    vertices.push_back({x, y + height, 0, bottom, r, g, b, 1});
    for (uint16_t offset :
         {uint16_t(0), uint16_t(1), uint16_t(2), uint16_t(0), uint16_t(2), uint16_t(3)})
        indices.push_back(static_cast<uint16_t>(first + offset));
}

bgfx::VertexLayout quad_layout()
{
    bgfx::VertexLayout layout;
    layout.begin()
        .add(bgfx::Attrib::Position, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::TexCoord0, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::Color0, 4, bgfx::AttribType::Float)
        .end();
    return layout;
}

} // namespace

RawBgfxWorkloads::~RawBgfxWorkloads() { shutdown(); }

bool RawBgfxWorkloads::initialize(const RawWorkloadReference& work, uint32_t width, uint32_t height,
                                  std::string& reason)
{
    shutdown();
    if (width == 0 || height == 0 || width > 8192 || height > 8192 ||
        !is_extended_raw_scenario(work.id)) {
        reason = "invalid raw workload or framebuffer dimensions";
        return false;
    }
    work_ = work;
    width_ = static_cast<uint16_t>(width);
    height_ = static_cast<uint16_t>(height);
    if (work_.draws_per_frame == 0) {
        initialized_ = true;
        return true;
    }

    const auto vs = load_benchmark_shader(NOVELTEA_BENCHMARK_SHADER_ROOT "/quad.vs.bin");
    if (!bgfx::isValid(vs)) {
        reason = "cannot load raw workload vertex shader";
        return false;
    }
    const auto fs = load_benchmark_shader(NOVELTEA_BENCHMARK_SHADER_ROOT "/quad.fs.bin");
    if (!bgfx::isValid(fs)) {
        bgfx::destroy(vs);
        reason = "cannot load raw workload fragment shader";
        return false;
    }
    program_ = bgfx::createProgram(vs, fs, true);
    if (!bgfx::isValid(program_)) {
        reason = "cannot create raw workload shader program";
        return false;
    }
    sampler_ = bgfx::createUniform("s_texColor", bgfx::UniformType::Sampler);
    if (!bgfx::isValid(sampler_)) {
        reason = "cannot create raw workload sampler";
        shutdown();
        return false;
    }

    const uint32_t edge = work_.texture_size;
    std::vector<uint8_t> pixels(static_cast<size_t>(edge) * edge * 4);
    for (uint32_t y = 0; y < edge; ++y) {
        for (uint32_t x = 0; x < edge; ++x) {
            const size_t p = (static_cast<size_t>(y) * edge + x) * 4;
            const bool light = ((x * 8 / edge) + (y * 8 / edge)) % 2 == 0;
            pixels[p] = light ? 242 : 51;
            pixels[p + 1] = light ? 170 : 135;
            pixels[p + 2] = light ? 88 : 218;
            pixels[p + 3] = 255;
        }
    }
    texture_ =
        bgfx::createTexture2D(static_cast<uint16_t>(edge), static_cast<uint16_t>(edge), false, 1,
                              bgfx::TextureFormat::RGBA8,
                              BGFX_SAMPLER_MIN_POINT | BGFX_SAMPLER_MAG_POINT |
                                  BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP,
                              bgfx::copy(pixels.data(), static_cast<uint32_t>(pixels.size())));
    if (!bgfx::isValid(texture_)) {
        reason = "cannot create raw workload texture";
        shutdown();
        return false;
    }

    const uint32_t quads = work_.quads_per_draw;
    uint32_t columns = 1;
    while (columns * columns < quads)
        ++columns;
    const uint32_t rows = (quads + columns - 1) / columns;
    const float covered_width = 1280.0f * static_cast<float>(work_.coverage);
    const float covered_height = 720.0f * static_cast<float>(work_.coverage);
    const float start_x = (1280.0f - covered_width) * 0.5f;
    const float start_y = (720.0f - covered_height) * 0.5f;
    std::vector<QuadVertex> vertices;
    std::vector<uint16_t> indices;
    vertices.reserve(static_cast<size_t>(quads) * 4);
    indices.reserve(static_cast<size_t>(quads) * 6);
    for (uint32_t i = 0; i < quads; ++i) {
        add_quad(vertices, indices, start_x + covered_width * (i % columns) / columns,
                 start_y + covered_height * (i / columns) / rows, covered_width / columns,
                 covered_height / rows, false, 1, 1, 1);
    }
    const auto layout = quad_layout();
    vertices_ = bgfx::createVertexBuffer(
        bgfx::copy(vertices.data(), static_cast<uint32_t>(vertices.size() * sizeof(QuadVertex))),
        layout);
    indices_ = bgfx::createIndexBuffer(
        bgfx::copy(indices.data(), static_cast<uint32_t>(indices.size() * sizeof(uint16_t))));
    if (!bgfx::isValid(vertices_) || !bgfx::isValid(indices_)) {
        reason = "cannot allocate raw workload geometry";
        shutdown();
        return false;
    }

    if (work_.offscreen) {
        framebuffer_ = bgfx::createFrameBuffer(width_, height_, bgfx::TextureFormat::RGBA8,
                                               BGFX_TEXTURE_RT | BGFX_SAMPLER_MIN_POINT |
                                                   BGFX_SAMPLER_MAG_POINT);
        if (!bgfx::isValid(framebuffer_) || !bgfx::isValid(bgfx::getTexture(framebuffer_))) {
            reason = "cannot allocate raw workload offscreen target";
            shutdown();
            return false;
        }
        std::vector<QuadVertex> composite;
        std::vector<uint16_t> composite_indices;
        add_quad(composite, composite_indices, 0, 0, 1280, 720, bgfx::getCaps()->originBottomLeft,
                 1, 1, 1);
        composite_vertices_ = bgfx::createVertexBuffer(
            bgfx::copy(composite.data(),
                       static_cast<uint32_t>(composite.size() * sizeof(QuadVertex))),
            layout);
        composite_indices_ = bgfx::createIndexBuffer(
            bgfx::copy(composite_indices.data(),
                       static_cast<uint32_t>(composite_indices.size() * sizeof(uint16_t))));
        if (!bgfx::isValid(composite_vertices_) || !bgfx::isValid(composite_indices_)) {
            reason = "cannot allocate raw workload composite geometry";
            shutdown();
            return false;
        }
    }

    std::memset(ortho_, 0, sizeof(ortho_));
    ortho_[0] = 2.0f / 1280.0f;
    ortho_[5] = -2.0f / 720.0f;
    ortho_[10] = 1.0f;
    ortho_[12] = -1.0f;
    ortho_[13] = 1.0f;
    ortho_[15] = 1.0f;
    initialized_ = true;
    return true;
}

bool RawBgfxWorkloads::submit(std::string& reason)
{
    if (!initialized_) {
        reason = "raw workload not prepared";
        return false;
    }
    if (work_.offscreen)
        bgfx::setViewFrameBuffer(0, framebuffer_);
    else
        bgfx::setViewFrameBuffer(0, BGFX_INVALID_HANDLE);
    bgfx::setViewRect(0, 0, 0, width_, height_);
    bgfx::setViewClear(0, BGFX_CLEAR_COLOR, 0x111924ff);
    bgfx::touch(0);
    if (work_.draws_per_frame == 0)
        return true;
    bgfx::setViewTransform(0, nullptr, ortho_);
    for (uint32_t i = 0; i < work_.draw_calls; ++i) {
        bgfx::setTexture(0, sampler_, texture_);
        bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A);
        bgfx::setVertexBuffer(0, vertices_);
        bgfx::setIndexBuffer(indices_);
        bgfx::submit(0, program_);
    }
    if (work_.offscreen) {
        bgfx::setViewFrameBuffer(2, BGFX_INVALID_HANDLE);
        bgfx::setViewRect(2, 0, 0, width_, height_);
        bgfx::setViewClear(2, BGFX_CLEAR_COLOR, 0x111924ff);
        bgfx::setViewTransform(2, nullptr, ortho_);
        bgfx::touch(2);
        bgfx::setTexture(0, sampler_, bgfx::getTexture(framebuffer_));
        bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A);
        bgfx::setVertexBuffer(0, composite_vertices_);
        bgfx::setIndexBuffer(composite_indices_);
        bgfx::submit(2, program_);
    }
    return true;
}

void RawBgfxWorkloads::shutdown()
{
    if (bgfx::isValid(framebuffer_)) {
        bgfx::setViewFrameBuffer(0, BGFX_INVALID_HANDLE);
        bgfx::setViewClear(2, BGFX_CLEAR_NONE);
        bgfx::destroy(framebuffer_);
    }
    if (bgfx::isValid(composite_indices_))
        bgfx::destroy(composite_indices_);
    if (bgfx::isValid(composite_vertices_))
        bgfx::destroy(composite_vertices_);
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
    framebuffer_ = BGFX_INVALID_HANDLE;
    composite_indices_ = BGFX_INVALID_HANDLE;
    composite_vertices_ = BGFX_INVALID_HANDLE;
    indices_ = BGFX_INVALID_HANDLE;
    vertices_ = BGFX_INVALID_HANDLE;
    texture_ = BGFX_INVALID_HANDLE;
    sampler_ = BGFX_INVALID_HANDLE;
    program_ = BGFX_INVALID_HANDLE;
    initialized_ = false;
}

} // namespace noveltea::benchmark
