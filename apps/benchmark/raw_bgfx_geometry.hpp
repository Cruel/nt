#pragma once

#include "reference_scene.hpp"

#include <bgfx/bgfx.h>

#include <string>

namespace noveltea::benchmark {

// Benchmark-only bgfx adapter. Does not depend on NovelTea Engine/Renderer.
class RawBgfxGeometry {
public:
    ~RawBgfxGeometry();
    RawBgfxGeometry() = default;
    RawBgfxGeometry(const RawBgfxGeometry&) = delete;
    RawBgfxGeometry& operator=(const RawBgfxGeometry&) = delete;

    bool initialize(const ReferenceScene& scene, int framebuffer_width, int framebuffer_height,
                    std::string& reason);
    bool submit(std::string& reason);
    void shutdown();
    [[nodiscard]] bool initialized() const { return bgfx::isValid(program_); }

private:
    bgfx::ProgramHandle program_ = BGFX_INVALID_HANDLE;
    bgfx::VertexBufferHandle vertices_ = BGFX_INVALID_HANDLE;
    bgfx::IndexBufferHandle indices_ = BGFX_INVALID_HANDLE;
    bgfx::TextureHandle texture_ = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle sampler_ = BGFX_INVALID_HANDLE;
    int framebuffer_width_ = 0;
    int framebuffer_height_ = 0;
    float ortho_[16]{};
    uint32_t clear_rgba_ = 0;
};

} // namespace noveltea::benchmark
