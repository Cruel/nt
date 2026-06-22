#include "ui/rmlui/rmlui_render_interface_bgfx.hpp"

#include "render/bgfx/bgfx_renderer_internal.hpp"
#include "render/bgfx/bgfx_shader_loader.hpp"
#include "ui/rmlui/rmlui_file_interface.hpp"

#include <bimg/decode.h>
#include <bx/allocator.h>

#include <cstdio>
#include <string>

namespace noveltea::ui::rmlui {

namespace {

[[nodiscard]] bgfx_backend::SystemShader to_noveltea_shader(rmlui_bgfx::SystemProgram program)
{
    switch (program) {
    case rmlui_bgfx::SystemProgram::RmlUi:
        return bgfx_backend::SystemShader::RmlUi;
    case rmlui_bgfx::SystemProgram::Composite:
        return bgfx_backend::SystemShader::RmlUiComposite;
    case rmlui_bgfx::SystemProgram::Copy:
        return bgfx_backend::SystemShader::RmlUiCopy;
    case rmlui_bgfx::SystemProgram::Opacity:
        return bgfx_backend::SystemShader::RmlUiOpacity;
    case rmlui_bgfx::SystemProgram::ColorMatrix:
        return bgfx_backend::SystemShader::RmlUiColorMatrix;
    case rmlui_bgfx::SystemProgram::MaskMultiply:
        return bgfx_backend::SystemShader::RmlUiMaskMultiply;
    case rmlui_bgfx::SystemProgram::Blur:
        return bgfx_backend::SystemShader::RmlUiBlur;
    case rmlui_bgfx::SystemProgram::DropShadow:
        return bgfx_backend::SystemShader::RmlUiDropShadow;
    case rmlui_bgfx::SystemProgram::Gradient:
        return bgfx_backend::SystemShader::RmlUiGradient;
    }
    return bgfx_backend::SystemShader::RmlUi;
}

} // namespace

struct BgfxRenderInterface::Adapter final : rmlui_bgfx::ShaderProvider,
                                            rmlui_bgfx::TextureLoader,
                                            rmlui_bgfx::Diagnostics,
                                            rmlui_bgfx::PerfLogger {
    explicit Adapter(const assets::AssetManager& asset_manager) : assets(asset_manager) {}

    bgfx::ProgramHandle load_program(rmlui_bgfx::SystemProgram program) override
    {
        return bgfx_backend::BgfxShaderLoader(assets).load_program(to_noveltea_shader(program));
    }

    bool load_rgba8(const char* source, rmlui_bgfx::LoadedTexture& out,
                    std::string* error_message) override
    {
        out = {};
        const std::string logical = resolve_asset_path(assets, source ? source : "");
        auto bytes = assets.read_binary(logical);
        if (!bytes || bytes.value->bytes.empty()) {
            if (error_message) {
                *error_message = logical;
                if (!bytes.error.empty()) {
                    *error_message += ": ";
                    *error_message += bytes.error;
                }
            }
            return false;
        }

        bx::DefaultAllocator allocator;
        bimg::ImageContainer* image =
            bimg::imageParse(&allocator, bytes.value->bytes.data(),
                             uint32_t(bytes.value->bytes.size()), bimg::TextureFormat::RGBA8);
        if (!image || image->m_width <= 0 || image->m_height <= 0 || !image->m_data ||
            image->m_format != bimg::TextureFormat::RGBA8 || image->m_numLayers != 1 ||
            image->m_depth != 1 || image->m_numMips != 1 ||
            image->m_size != image->m_width * image->m_height * 4u) {
            if (image)
                bimg::imageFree(image);
            if (error_message) {
                *error_message = logical;
                *error_message += ": image decode failed";
            }
            return false;
        }

        out.width = int(image->m_width);
        out.height = int(image->m_height);
        out.rgba8.assign(static_cast<const std::uint8_t*>(image->m_data),
                         static_cast<const std::uint8_t*>(image->m_data) + image->m_size);
        bimg::imageFree(image);
        return true;
    }

    void warning(std::string_view message) override
    {
        std::fprintf(stderr, "[rmlui] %.*s\n", int(message.size()), message.data());
    }

    void error(std::string_view message) override
    {
        std::fprintf(stderr, "[rmlui] %.*s\n", int(message.size()), message.data());
    }

    void log_perf_line(std::string_view message) override
    {
        std::fprintf(stderr, "%.*s\n", int(message.size()), message.data());
    }

    const assets::AssetManager& assets;
};

rmlui_bgfx::SurfaceMetrics to_rmlui_bgfx_surface(const SurfaceMetrics& surface)
{
    return rmlui_bgfx::SurfaceMetrics{surface.logical_width,     surface.logical_height,
                                      surface.framebuffer_width, surface.framebuffer_height,
                                      surface.scale_x,           surface.scale_y};
}

rmlui_bgfx::ViewRange rmlui_bgfx_runtime_view_range()
{
    return rmlui_bgfx::ViewRange{bgfx_backend::ViewRuntimeUIBegin, bgfx_backend::ViewRuntimeUIEnd};
}

BgfxRenderInterface::BgfxRenderInterface(const SurfaceMetrics& surface,
                                         const assets::AssetManager& assets)
    : m_adapter(std::make_unique<Adapter>(assets))
{
    rmlui_bgfx::RendererConfig config;
    config.surface = to_rmlui_bgfx_surface(surface);
    config.views = rmlui_bgfx_runtime_view_range();
    config.shaders = m_adapter.get();
    config.textures = m_adapter.get();
    config.diagnostics = m_adapter.get();
    config.perf_logger = m_adapter.get();
    m_core = std::make_unique<rmlui_bgfx::RenderInterface>(config);
}

BgfxRenderInterface::~BgfxRenderInterface() = default;

BgfxRenderInterface::operator bool() const { return m_core && static_cast<bool>(*m_core); }

void BgfxRenderInterface::resize(const SurfaceMetrics& surface)
{
    m_core->resize(to_rmlui_bgfx_surface(surface));
}

void BgfxRenderInterface::begin_frame() { m_core->begin_frame(); }
void BgfxRenderInterface::end_frame() { m_core->end_frame(); }
void BgfxRenderInterface::set_perf_logging_enabled(bool enabled)
{
    m_core->set_perf_logging_enabled(enabled);
}
void BgfxRenderInterface::set_base_direct_compatibility(bool enabled)
{
    m_core->set_base_direct_compatibility(enabled);
}

Rml::CompiledGeometryHandle
BgfxRenderInterface::CompileGeometry(Rml::Span<const Rml::Vertex> vertices,
                                     Rml::Span<const int> indices)
{
    return m_core->CompileGeometry(vertices, indices);
}

void BgfxRenderInterface::RenderGeometry(Rml::CompiledGeometryHandle geometry,
                                         Rml::Vector2f translation, Rml::TextureHandle texture)
{
    m_core->RenderGeometry(geometry, translation, texture);
}

void BgfxRenderInterface::ReleaseGeometry(Rml::CompiledGeometryHandle geometry)
{
    m_core->ReleaseGeometry(geometry);
}

Rml::TextureHandle BgfxRenderInterface::LoadTexture(Rml::Vector2i& texture_dimensions,
                                                    const Rml::String& source)
{
    return m_core->LoadTexture(texture_dimensions, source);
}

Rml::TextureHandle BgfxRenderInterface::GenerateTexture(Rml::Span<const Rml::byte> source,
                                                        Rml::Vector2i source_dimensions)
{
    return m_core->GenerateTexture(source, source_dimensions);
}

void BgfxRenderInterface::ReleaseTexture(Rml::TextureHandle texture)
{
    m_core->ReleaseTexture(texture);
}

void BgfxRenderInterface::EnableScissorRegion(bool enable) { m_core->EnableScissorRegion(enable); }
void BgfxRenderInterface::SetScissorRegion(Rml::Rectanglei region)
{
    m_core->SetScissorRegion(region);
}
void BgfxRenderInterface::SetTransform(const Rml::Matrix4f* transform)
{
    m_core->SetTransform(transform);
}

void BgfxRenderInterface::EnableClipMask(bool enable) { m_core->EnableClipMask(enable); }
void BgfxRenderInterface::RenderToClipMask(Rml::ClipMaskOperation operation,
                                           Rml::CompiledGeometryHandle geometry,
                                           Rml::Vector2f translation)
{
    m_core->RenderToClipMask(operation, geometry, translation);
}

Rml::LayerHandle BgfxRenderInterface::PushLayer() { return m_core->PushLayer(); }

void BgfxRenderInterface::CompositeLayers(Rml::LayerHandle source, Rml::LayerHandle destination,
                                          Rml::BlendMode blend_mode,
                                          Rml::Span<const Rml::CompiledFilterHandle> filters)
{
    m_core->CompositeLayers(source, destination, blend_mode, filters);
}

void BgfxRenderInterface::PopLayer() { m_core->PopLayer(); }
Rml::TextureHandle BgfxRenderInterface::SaveLayerAsTexture()
{
    return m_core->SaveLayerAsTexture();
}
Rml::CompiledFilterHandle BgfxRenderInterface::SaveLayerAsMaskImage()
{
    return m_core->SaveLayerAsMaskImage();
}
Rml::CompiledFilterHandle BgfxRenderInterface::CompileFilter(const Rml::String& name,
                                                             const Rml::Dictionary& parameters)
{
    return m_core->CompileFilter(name, parameters);
}
void BgfxRenderInterface::ReleaseFilter(Rml::CompiledFilterHandle filter)
{
    m_core->ReleaseFilter(filter);
}
Rml::CompiledShaderHandle BgfxRenderInterface::CompileShader(const Rml::String& name,
                                                             const Rml::Dictionary& parameters)
{
    return m_core->CompileShader(name, parameters);
}
void BgfxRenderInterface::RenderShader(Rml::CompiledShaderHandle shader,
                                       Rml::CompiledGeometryHandle geometry,
                                       Rml::Vector2f translation, Rml::TextureHandle texture)
{
    m_core->RenderShader(shader, geometry, translation, texture);
}
void BgfxRenderInterface::ReleaseShader(Rml::CompiledShaderHandle shader)
{
    m_core->ReleaseShader(shader);
}

} // namespace noveltea::ui::rmlui
