#pragma once

#include "noveltea/ui_render_configuration.hpp"

#include <RmlUi/Core/RenderInterface.h>

#include <string>
#include <unordered_set>

namespace noveltea::benchmark {

// Benchmark-only proxy. It observes RmlUi's actual backend callbacks during
// preparation, then disables observation before strict frame sampling.
// Forward every callback to the real renderer; no simulated effect path exists.
class RmlUiEffectProbe final : public Rml::RenderInterface {
public:
    explicit RmlUiEffectProbe(Rml::RenderInterface& delegate) : delegate_(delegate) {}

    void capture(bool enabled)
    {
        enabled_ = enabled;
        if (enabled) {
            activity_ = {};
            depth_ = 0;
            gradient_shaders_.clear();
            shadow_filters_.clear();
        }
    }
    [[nodiscard]] UiEffectActivity activity() const { return activity_; }

    Rml::CompiledGeometryHandle CompileGeometry(Rml::Span<const Rml::Vertex> vertices,
                                                Rml::Span<const int> indices) override
    {
        return delegate_.CompileGeometry(vertices, indices);
    }
    void RenderGeometry(Rml::CompiledGeometryHandle geometry, Rml::Vector2f translation,
                        Rml::TextureHandle texture) override
    {
        delegate_.RenderGeometry(geometry, translation, texture);
    }
    void ReleaseGeometry(Rml::CompiledGeometryHandle geometry) override
    {
        delegate_.ReleaseGeometry(geometry);
    }
    Rml::TextureHandle LoadTexture(Rml::Vector2i& dimensions, const Rml::String& source) override
    {
        return delegate_.LoadTexture(dimensions, source);
    }
    Rml::TextureHandle GenerateTexture(Rml::Span<const Rml::byte> bytes,
                                       Rml::Vector2i dimensions) override
    {
        return delegate_.GenerateTexture(bytes, dimensions);
    }
    void ReleaseTexture(Rml::TextureHandle texture) override { delegate_.ReleaseTexture(texture); }
    void EnableScissorRegion(bool enabled) override
    {
        if (enabled_ && enabled)
            ++activity_.clipping_calls;
        delegate_.EnableScissorRegion(enabled);
    }
    void SetScissorRegion(Rml::Rectanglei region) override { delegate_.SetScissorRegion(region); }
    void SetTransform(const Rml::Matrix4f* matrix) override
    {
        if (enabled_ && matrix)
            ++activity_.transforms;
        delegate_.SetTransform(matrix);
    }
    void EnableClipMask(bool enabled) override { delegate_.EnableClipMask(enabled); }
    void RenderToClipMask(Rml::ClipMaskOperation operation, Rml::CompiledGeometryHandle geometry,
                          Rml::Vector2f translation) override
    {
        if (enabled_)
            ++activity_.clipping_calls;
        delegate_.RenderToClipMask(operation, geometry, translation);
    }
    Rml::LayerHandle PushLayer() override
    {
        if (enabled_) {
            ++activity_.layer_pushes;
            ++depth_;
            if (depth_ > activity_.max_layer_depth)
                activity_.max_layer_depth = depth_;
        }
        return delegate_.PushLayer();
    }
    void CompositeLayers(Rml::LayerHandle source, Rml::LayerHandle destination,
                         Rml::BlendMode blend_mode,
                         Rml::Span<const Rml::CompiledFilterHandle> filters) override
    {
        if (enabled_) {
            for (const auto filter : filters) {
                if (shadow_filters_.contains(filter)) {
                    ++activity_.filtered_composites;
                    break;
                }
            }
        }
        delegate_.CompositeLayers(source, destination, blend_mode, filters);
    }
    void PopLayer() override
    {
        if (enabled_ && depth_ > 0)
            --depth_;
        delegate_.PopLayer();
    }
    Rml::TextureHandle SaveLayerAsTexture() override { return delegate_.SaveLayerAsTexture(); }
    Rml::CompiledFilterHandle SaveLayerAsMaskImage() override
    {
        const auto handle = delegate_.SaveLayerAsMaskImage();
        if (enabled_ && handle != 0)
            ++activity_.mask_saves;
        return handle;
    }
    Rml::CompiledFilterHandle CompileFilter(const Rml::String& name,
                                            const Rml::Dictionary& parameters) override
    {
        const auto handle = delegate_.CompileFilter(name, parameters);
        if (enabled_ && handle != 0 && name == "drop-shadow")
            shadow_filters_.insert(handle);
        return handle;
    }
    void ReleaseFilter(Rml::CompiledFilterHandle handle) override
    {
        shadow_filters_.erase(handle);
        delegate_.ReleaseFilter(handle);
    }
    Rml::CompiledShaderHandle CompileShader(const Rml::String& name,
                                            const Rml::Dictionary& parameters) override
    {
        const auto handle = delegate_.CompileShader(name, parameters);
        if (enabled_ && name == "linear-gradient")
            gradient_shaders_.insert(handle);
        return handle;
    }
    void RenderShader(Rml::CompiledShaderHandle shader, Rml::CompiledGeometryHandle geometry,
                      Rml::Vector2f translation, Rml::TextureHandle texture) override
    {
        if (enabled_ && gradient_shaders_.contains(shader))
            ++activity_.gradient_draws;
        delegate_.RenderShader(shader, geometry, translation, texture);
    }
    void ReleaseShader(Rml::CompiledShaderHandle shader) override
    {
        gradient_shaders_.erase(shader);
        delegate_.ReleaseShader(shader);
    }

private:
    Rml::RenderInterface& delegate_;
    bool enabled_ = false;
    uint32_t depth_ = 0;
    UiEffectActivity activity_;
    std::unordered_set<Rml::CompiledShaderHandle> gradient_shaders_;
    std::unordered_set<Rml::CompiledFilterHandle> shadow_filters_;
};

} // namespace noveltea::benchmark
