#pragma once

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/surface.hpp"
#include <rmlui_bgfx/config.hpp>
#include <rmlui_bgfx/render_interface.hpp>

#include <RmlUi/Core/RenderInterface.h>

#include <memory>
#include <optional>

namespace noveltea {
struct ShaderMaterialProject;
}

namespace noveltea::ui::rmlui {

[[nodiscard]] std::optional<rmlui_bgfx::SurfaceMetrics>
to_rmlui_bgfx_surface(const PresentationMetrics& presentation);
[[nodiscard]] rmlui_bgfx::ViewRange rmlui_bgfx_runtime_view_range();
[[nodiscard]] rmlui_bgfx::ViewRange rmlui_bgfx_plane_view_range(core::PresentationPlane plane);
[[nodiscard]] rmlui_bgfx::ViewRange rmlui_bgfx_world_source_overlay_view_range();

class BgfxRenderInterface final : public Rml::RenderInterface {
public:
    BgfxRenderInterface(const PresentationMetrics& presentation, const assets::AssetManager& assets,
                        const ShaderMaterialProject* shader_materials = nullptr);
    BgfxRenderInterface(const PresentationMetrics& presentation, const assets::AssetManager& assets,
                        rmlui_bgfx::ViewRange views,
                        const ShaderMaterialProject* shader_materials = nullptr);
    ~BgfxRenderInterface() override;

    explicit operator bool() const;

    void resize(const PresentationMetrics& presentation);
    void begin_frame();
    void end_frame();
    void set_perf_logging_enabled(bool enabled);
    void set_base_direct_compatibility(bool enabled);
    void set_output_framebuffer(bgfx::FrameBufferHandle framebuffer,
                                const PresentationMetrics& presentation, bool local_viewport);

    Rml::CompiledGeometryHandle CompileGeometry(Rml::Span<const Rml::Vertex> vertices,
                                                Rml::Span<const int> indices) override;
    void RenderGeometry(Rml::CompiledGeometryHandle geometry, Rml::Vector2f translation,
                        Rml::TextureHandle texture) override;
    void ReleaseGeometry(Rml::CompiledGeometryHandle geometry) override;

    Rml::TextureHandle LoadTexture(Rml::Vector2i& texture_dimensions,
                                   const Rml::String& source) override;
    Rml::TextureHandle GenerateTexture(Rml::Span<const Rml::byte> source,
                                       Rml::Vector2i source_dimensions) override;
    void ReleaseTexture(Rml::TextureHandle texture) override;

    void EnableScissorRegion(bool enable) override;
    void SetScissorRegion(Rml::Rectanglei region) override;
    void SetTransform(const Rml::Matrix4f* transform) override;

    void EnableClipMask(bool enable) override;
    void RenderToClipMask(Rml::ClipMaskOperation operation, Rml::CompiledGeometryHandle geometry,
                          Rml::Vector2f translation) override;
    Rml::LayerHandle PushLayer() override;
    void CompositeLayers(Rml::LayerHandle source, Rml::LayerHandle destination,
                         Rml::BlendMode blend_mode,
                         Rml::Span<const Rml::CompiledFilterHandle> filters) override;
    void PopLayer() override;
    Rml::TextureHandle SaveLayerAsTexture() override;
    Rml::CompiledFilterHandle SaveLayerAsMaskImage() override;
    Rml::CompiledFilterHandle CompileFilter(const Rml::String& name,
                                            const Rml::Dictionary& parameters) override;
    void ReleaseFilter(Rml::CompiledFilterHandle filter) override;
    Rml::CompiledShaderHandle CompileShader(const Rml::String& name,
                                            const Rml::Dictionary& parameters) override;
    void RenderShader(Rml::CompiledShaderHandle shader, Rml::CompiledGeometryHandle geometry,
                      Rml::Vector2f translation, Rml::TextureHandle texture) override;
    void ReleaseShader(Rml::CompiledShaderHandle shader) override;

private:
    struct Adapter;
    std::unique_ptr<Adapter> m_adapter;
    std::unique_ptr<rmlui_bgfx::RenderInterface> m_core;
};

} // namespace noveltea::ui::rmlui
