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
              float width, float height, bool flip_v, float r, float g, float b, float a = 1.0f)
{
    const auto first = static_cast<uint16_t>(vertices.size());
    const float top = flip_v ? 1.0f : 0.0f;
    const float bottom = flip_v ? 0.0f : 1.0f;
    vertices.push_back({x, y, 0, top, r, g, b, a});
    vertices.push_back({x + width, y, 1, top, r, g, b, a});
    vertices.push_back({x + width, y + height, 1, bottom, r, g, b, a});
    vertices.push_back({x, y + height, 0, bottom, r, g, b, a});
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
        uint64_t flags = BGFX_TEXTURE_RT | BGFX_SAMPLER_MIN_POINT | BGFX_SAMPLER_MAG_POINT |
                         BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP;
        if (work_.msaa_samples == 2)
            flags |= BGFX_TEXTURE_RT_MSAA_X2;
        if (work_.msaa_samples == 4)
            flags |= BGFX_TEXTURE_RT_MSAA_X4;
        const uint16_t target_width =
            work_.composition ? static_cast<uint16_t>(work_.target_width) : width_;
        const uint16_t target_height =
            work_.composition ? static_cast<uint16_t>(work_.target_height) : height_;
        if (!bgfx::isTextureValid(0, false, 1, bgfx::TextureFormat::RGBA8, flags)) {
            reason = "requested offscreen color/MSAA format is unsupported by this bgfx device";
            shutdown();
            return false;
        }
        framebuffer_ =
            bgfx::createFrameBuffer(target_width, target_height, bgfx::TextureFormat::RGBA8, flags);
        if (!bgfx::isValid(framebuffer_) || !bgfx::isValid(bgfx::getTexture(framebuffer_))) {
            reason = "cannot allocate raw workload offscreen target";
            shutdown();
            return false;
        }
        if (work_.composition) {
            for (uint32_t i = 1; i < work_.target_count; ++i) {
                intermediate_[i - 1] = bgfx::createFrameBuffer(
                    target_width, target_height, bgfx::TextureFormat::RGBA8,
                    BGFX_TEXTURE_RT | BGFX_SAMPLER_MIN_POINT | BGFX_SAMPLER_MAG_POINT |
                        BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP);
                if (!bgfx::isValid(intermediate_[i - 1]) ||
                    !bgfx::isValid(bgfx::getTexture(intermediate_[i - 1]))) {
                    reason = "cannot allocate raw workload intermediate composite target";
                    shutdown();
                    return false;
                }
            }
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
    if (work_.transparent_overlay) {
        std::vector<QuadVertex> overlay;
        std::vector<uint16_t> overlay_indices;
        add_quad(overlay, overlay_indices, 160, 100, 960, 520, false, 0.3f, 0.9f, 1.0f, 0.45f);
        overlay_vertices_ = bgfx::createVertexBuffer(
            bgfx::copy(overlay.data(), static_cast<uint32_t>(overlay.size() * sizeof(QuadVertex))),
            layout);
        overlay_indices_ = bgfx::createIndexBuffer(
            bgfx::copy(overlay_indices.data(),
                       static_cast<uint32_t>(overlay_indices.size() * sizeof(uint16_t))));
        if (!bgfx::isValid(overlay_vertices_) || !bgfx::isValid(overlay_indices_)) {
            reason = "cannot allocate transparent overlay geometry";
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
    bgfx::setViewRect(
        0, 0, 0,
        work_.composition && work_.offscreen ? static_cast<uint16_t>(work_.target_width) : width_,
        work_.composition && work_.offscreen ? static_cast<uint16_t>(work_.target_height)
                                             : height_);
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
        const uint32_t passes = work_.composition ? work_.composite_passes : 1;
        for (uint32_t i = 0; i < passes; ++i) {
            const bool final = i + 1 == passes;
            const bgfx::ViewId view = static_cast<bgfx::ViewId>(2 + i);
            const bgfx::FrameBufferHandle source =
                i == 0 ? framebuffer_ : intermediate_[(i - 1) % intermediate_.size()];
            const bgfx::FrameBufferHandle destination =
                final ? bgfx::FrameBufferHandle{bgfx::kInvalidHandle}
                      : intermediate_[i % intermediate_.size()];
            bgfx::setViewFrameBuffer(view, destination);
            bgfx::setViewRect(view, 0, 0,
                              final ? width_ : static_cast<uint16_t>(work_.target_width),
                              final ? height_ : static_cast<uint16_t>(work_.target_height));
            bgfx::setViewClear(view, final ? BGFX_CLEAR_COLOR : BGFX_CLEAR_NONE, 0x111924ff);
            bgfx::setViewTransform(view, nullptr, ortho_);
            bgfx::setTexture(0, sampler_, bgfx::getTexture(source));
            bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A);
            bgfx::setVertexBuffer(0, composite_vertices_);
            bgfx::setIndexBuffer(composite_indices_);
            bgfx::submit(view, program_);
        }
    }
    if (work_.transparent_overlay) {
        constexpr bgfx::ViewId kOverlayView = 6;
        bgfx::setViewFrameBuffer(kOverlayView, BGFX_INVALID_HANDLE);
        bgfx::setViewRect(kOverlayView, 0, 0, width_, height_);
        bgfx::setViewClear(kOverlayView, BGFX_CLEAR_NONE);
        bgfx::setViewTransform(kOverlayView, nullptr, ortho_);
        bgfx::setTexture(0, sampler_, texture_);
        bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A | BGFX_STATE_BLEND_ALPHA);
        bgfx::setVertexBuffer(0, overlay_vertices_);
        bgfx::setIndexBuffer(overlay_indices_);
        bgfx::submit(kOverlayView, program_);
    }
    return true;
}

void RawBgfxWorkloads::shutdown()
{
    if (initialized_ || bgfx::isValid(framebuffer_) || bgfx::isValid(program_)) {
        bgfx::setViewFrameBuffer(0, BGFX_INVALID_HANDLE);
        for (bgfx::ViewId view = 2; view <= 6; ++view) {
            bgfx::setViewFrameBuffer(view, BGFX_INVALID_HANDLE);
            bgfx::setViewClear(view, BGFX_CLEAR_NONE);
        }
    }
    if (bgfx::isValid(framebuffer_))
        bgfx::destroy(framebuffer_);
    for (auto& target : intermediate_) {
        if (bgfx::isValid(target))
            bgfx::destroy(target);
        target = BGFX_INVALID_HANDLE;
    }
    if (bgfx::isValid(overlay_indices_))
        bgfx::destroy(overlay_indices_);
    if (bgfx::isValid(overlay_vertices_))
        bgfx::destroy(overlay_vertices_);
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
    overlay_indices_ = BGFX_INVALID_HANDLE;
    overlay_vertices_ = BGFX_INVALID_HANDLE;
    indices_ = BGFX_INVALID_HANDLE;
    vertices_ = BGFX_INVALID_HANDLE;
    texture_ = BGFX_INVALID_HANDLE;
    sampler_ = BGFX_INVALID_HANDLE;
    program_ = BGFX_INVALID_HANDLE;
    initialized_ = false;
}

} // namespace noveltea::benchmark
