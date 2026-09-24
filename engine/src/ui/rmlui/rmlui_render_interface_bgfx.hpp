#pragma once

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/runtime_clock.hpp"
#include "noveltea/core/runtime_presentation_contracts.hpp"
#include "noveltea/render/material.hpp"
#include "noveltea/surface.hpp"
#include <rmlui_bgfx/config.hpp>
#include <rmlui_bgfx/render_interface.hpp>

#include <RmlUi/Core/RenderInterface.h>

#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace noveltea {
struct ShaderMaterialProject;
}

namespace noveltea::ui::rmlui {

[[nodiscard]] std::optional<rmlui_bgfx::SurfaceMetrics>
to_rmlui_bgfx_surface(const PresentationMetrics& presentation,
                      const ResolvedContextMetrics& context);
[[nodiscard]] Rml::Vector2f
snap_rmlui_submission_translation(Rml::Vector2f translation,
                                  const ResolvedContextMetrics& context) noexcept;
[[nodiscard]] rmlui_bgfx::ViewRange rmlui_bgfx_runtime_view_range();
[[nodiscard]] rmlui_bgfx::ViewRange rmlui_bgfx_plane_view_range(core::PresentationPlane plane);
[[nodiscard]] rmlui_bgfx::ViewRange rmlui_bgfx_world_source_overlay_view_range();

struct RmlUiResolvedMaterialTexture {
    std::string source;
    MaterialTextureSampler filtering = MaterialTextureSampler::ClampLinear;
    bool operator==(const RmlUiResolvedMaterialTexture&) const = default;
};

[[nodiscard]] std::optional<RmlUiResolvedMaterialTexture>
resolve_rmlui_material_texture(const MaterialTextureAssignment* assignment,
                               const core::PresentationMaterialTextureBinding* occurrence);

class RmlUiMaterialOccurrenceEpochs final {
public:
    [[nodiscard]] double elapsed(std::string_view scope,
                                 const core::PresentationMaterialParameter& parameter,
                                 double now_seconds);
    void retain(std::string_view scope, std::optional<core::LayoutMountOccurrenceId> occurrence,
                std::span<const core::PresentationMaterialParameter> parameters);

private:
    struct Entry {
        core::PresentationOwner owner;
        core::MaterialOccurrence occurrence;
        core::MaterialId material;
        std::string parameter;
        core::MaterialClockPolicy clock = core::MaterialClockPolicy::Gameplay;
        double epoch_seconds = 0.0;
    };

    struct ScopeState {
        std::optional<core::LayoutMountOccurrenceId> occurrence;
        std::vector<Entry> entries;
    };

    std::unordered_map<std::string, ScopeState> m_epochs;
};

class BgfxRenderInterface final : public Rml::RenderInterface {
public:
    BgfxRenderInterface(const PresentationMetrics& presentation,
                        const ResolvedContextMetrics& context, const assets::AssetManager& assets,
                        const ShaderMaterialProject* shader_materials = nullptr);
    BgfxRenderInterface(const PresentationMetrics& presentation,
                        const ResolvedContextMetrics& context, const assets::AssetManager& assets,
                        rmlui_bgfx::ViewRange views,
                        const ShaderMaterialProject* shader_materials = nullptr);
    ~BgfxRenderInterface() override;

    explicit operator bool() const;

    void resize(const PresentationMetrics& presentation, const ResolvedContextMetrics& context);
    void configure_context(const PresentationMetrics& presentation,
                           const ResolvedContextMetrics& context);
    void begin_frame(bool continue_view_range = false);
    void end_frame();
    void set_perf_logging_enabled(bool enabled);
    void set_base_direct_compatibility(bool enabled);
    void set_raster_snapping(bool geometry_enabled, bool text_enabled);
    void set_output_framebuffer(bgfx::FrameBufferHandle framebuffer,
                                const PresentationMetrics& presentation, bool local_viewport);
    void set_material_parameters(
        std::string_view occurrence_scope,
        std::optional<core::LayoutMountOccurrenceId> occurrence,
        std::span<const core::PresentationMaterialParameter> parameters,
        std::span<const core::PresentationMaterialTextureBinding> textures,
        const core::RuntimeClockUpdate& clocks, double camera_zoom);

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
    [[nodiscard]] Rml::Vector2f submission_translation(Rml::Vector2f translation,
                                                       Rml::TextureHandle texture) const noexcept;

    struct Adapter;
    std::unique_ptr<Adapter> m_adapter;
    std::unique_ptr<rmlui_bgfx::RenderInterface> m_core;
    ResolvedContextMetrics m_context_metrics{};
    rmlui_bgfx::FramebufferViewport m_viewport{};
    std::unordered_set<Rml::TextureHandle> m_generated_textures;
    bool m_geometry_raster_snapping = true;
    bool m_text_raster_snapping = true;
};

} // namespace noveltea::ui::rmlui
