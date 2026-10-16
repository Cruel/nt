#pragma once

#include "reference_workloads.hpp"

#include <bgfx/bgfx.h>

#include <string>

namespace noveltea::benchmark {

// GPU resources for Stage 2 direct bgfx references. No Engine or UI dependencies.
class RawBgfxWorkloads {
public:
    RawBgfxWorkloads() = default;
    ~RawBgfxWorkloads();
    RawBgfxWorkloads(const RawBgfxWorkloads&) = delete;
    RawBgfxWorkloads& operator=(const RawBgfxWorkloads&) = delete;

    bool initialize(const RawWorkloadReference& work, uint32_t width, uint32_t height,
                    std::string& reason);
    bool submit(std::string& reason);
    void shutdown();
    [[nodiscard]] bool initialized() const { return initialized_; }

private:
    bool initialized_ = false;
    RawWorkloadReference work_;
    uint16_t width_ = 0;
    uint16_t height_ = 0;
    float ortho_[16]{};
    bgfx::ProgramHandle program_ = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle sampler_ = BGFX_INVALID_HANDLE;
    bgfx::VertexBufferHandle vertices_ = BGFX_INVALID_HANDLE;
    bgfx::IndexBufferHandle indices_ = BGFX_INVALID_HANDLE;
    bgfx::VertexBufferHandle composite_vertices_ = BGFX_INVALID_HANDLE;
    bgfx::IndexBufferHandle composite_indices_ = BGFX_INVALID_HANDLE;
    bgfx::TextureHandle texture_ = BGFX_INVALID_HANDLE;
    bgfx::FrameBufferHandle framebuffer_ = BGFX_INVALID_HANDLE;
};

} // namespace noveltea::benchmark
