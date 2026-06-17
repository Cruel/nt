#include "ui/rmlui/rmlui_render_interface_bgfx.hpp"

#if defined(NOVELTEA_HAS_RMLUI) && defined(NOVELTEA_HAS_BGFX)

#include "render/bgfx/bgfx_renderer_internal.hpp"
#include "render/bgfx/bgfx_shader_loader.hpp"
#include "ui/rmlui/rmlui_file_interface.hpp"

#include <RmlUi/Core/Types.h>
#include <bimg/decode.h>
#include <bx/allocator.h>
#include <bx/math.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <unordered_map>
#include <vector>

namespace noveltea::ui::rmlui {

namespace {

constexpr uint64_t kRmlTextureFlags = BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP | BGFX_SAMPLER_MIN_POINT | BGFX_SAMPLER_MAG_POINT;
constexpr uint64_t kRmlBlendState = BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A |
    BGFX_STATE_BLEND_FUNC_SEPARATE(BGFX_STATE_BLEND_ONE, BGFX_STATE_BLEND_INV_SRC_ALPHA, BGFX_STATE_BLEND_ONE, BGFX_STATE_BLEND_INV_SRC_ALPHA);

struct RmlVertex {
    float px;
    float py;
    uint32_t rgba;
    float u;
    float v;
};

struct GeometryRecord {
    bgfx::VertexBufferHandle vb = BGFX_INVALID_HANDLE;
    bgfx::IndexBufferHandle ib = BGFX_INVALID_HANDLE;
    uint32_t index_count = 0;
};

struct TextureRecord {
    bgfx::TextureHandle handle = BGFX_INVALID_HANDLE;
    Rml::Vector2i dimensions;
};

uint32_t pack_abgr(Rml::ColourbPremultiplied colour)
{
    return (uint32_t(colour.alpha) << 24u) | (uint32_t(colour.blue) << 16u) |
        (uint32_t(colour.green) << 8u) | uint32_t(colour.red);
}

void premultiply_rgba(std::vector<uint8_t>& rgba)
{
    for (size_t i = 0; i + 3 < rgba.size(); i += 4) {
        const uint32_t alpha = rgba[i + 3];
        rgba[i + 0] = static_cast<uint8_t>((uint32_t(rgba[i + 0]) * alpha + 127u) / 255u);
        rgba[i + 1] = static_cast<uint8_t>((uint32_t(rgba[i + 1]) * alpha + 127u) / 255u);
        rgba[i + 2] = static_cast<uint8_t>((uint32_t(rgba[i + 2]) * alpha + 127u) / 255u);
    }
}

Rml::Rectanglei clamp_scissor(Rml::Rectanglei region, int width, int height)
{
    const int left = std::clamp(region.Left(), 0, std::max(width, 0));
    const int top = std::clamp(region.Top(), 0, std::max(height, 0));
    const int right = std::clamp(region.Right(), 0, std::max(width, 0));
    const int bottom = std::clamp(region.Bottom(), 0, std::max(height, 0));
    if (right <= left || bottom <= top) {
        return Rml::Rectanglei::FromPositionSize({0, 0}, {0, 0});
    }
    return Rml::Rectanglei::FromPositionSize({left, top}, {right - left, bottom - top});
}

} // namespace

void RmlUiPassAllocator::reset()
{
    next = begin;
    exhausted = false;
}

bgfx::ViewId RmlUiPassAllocator::allocate(const char* name, int width, int height)
{
    if (next > end) {
        if (!exhausted) {
            std::fprintf(stderr, "[rmlui] bgfx view range exhausted (%u..%u)\n", begin, end);
        }
        exhausted = true;
        return bgfx_backend::ViewRuntimeUIEnd;
    }
    const bgfx::ViewId view = next++;
    bgfx::setViewName(view, name);
    bgfx::setViewMode(view, bgfx::ViewMode::Sequential);
    bgfx::setViewRect(view, 0, 0, static_cast<uint16_t>(std::max(width, 1)), static_cast<uint16_t>(std::max(height, 1)));
    bgfx::setViewFrameBuffer(view, BGFX_INVALID_HANDLE);
    return view;
}

struct BgfxRenderInterface::Impl {
    explicit Impl(int initial_width, int initial_height, const assets::AssetManager& asset_manager)
        : assets(asset_manager)
    {
        layout.begin()
            .add(bgfx::Attrib::Position, 2, bgfx::AttribType::Float)
            .add(bgfx::Attrib::Color0, 4, bgfx::AttribType::Uint8, true)
            .add(bgfx::Attrib::TexCoord0, 2, bgfx::AttribType::Float)
            .end();

        program = bgfx_backend::BgfxShaderLoader(assets).load_program(bgfx_backend::SystemShader::RmlUi);
        sampler = bgfx::createUniform("s_texColor", bgfx::UniformType::Sampler);
        projection_uniform = bgfx::createUniform("u_projection", bgfx::UniformType::Mat4);
        transform_uniform = bgfx::createUniform("u_transform", bgfx::UniformType::Mat4);
        translate_uniform = bgfx::createUniform("u_translate", bgfx::UniformType::Vec4);

        const uint8_t white[] = {255, 255, 255, 255};
        white_texture = bgfx::createTexture2D(1, 1, false, 1, bgfx::TextureFormat::RGBA8, kRmlTextureFlags, bgfx::copy(white, sizeof(white)));
        resize(initial_width, initial_height);
    }

    ~Impl()
    {
        for (auto& [_, geometry] : geometries) {
            destroy_geometry(geometry);
        }
        for (auto& [_, texture] : textures) {
            if (bgfx::isValid(texture.handle)) bgfx::destroy(texture.handle);
        }
        if (bgfx::isValid(white_texture)) bgfx::destroy(white_texture);
        if (bgfx::isValid(program)) bgfx::destroy(program);
        if (bgfx::isValid(sampler)) bgfx::destroy(sampler);
        if (bgfx::isValid(projection_uniform)) bgfx::destroy(projection_uniform);
        if (bgfx::isValid(transform_uniform)) bgfx::destroy(transform_uniform);
        if (bgfx::isValid(translate_uniform)) bgfx::destroy(translate_uniform);
    }

    void resize(int new_width, int new_height)
    {
        width = std::max(new_width, 1);
        height = std::max(new_height, 1);
        bx::mtxOrtho(projection, 0.0f, float(width), float(height), 0.0f, -10000.0f, 10000.0f, 0.0f, bgfx::getCaps()->homogeneousDepth);
    }

    static void destroy_geometry(GeometryRecord& geometry)
    {
        if (bgfx::isValid(geometry.vb)) bgfx::destroy(geometry.vb);
        if (bgfx::isValid(geometry.ib)) bgfx::destroy(geometry.ib);
        geometry = {};
    }

    Rml::TextureHandle create_texture_from_rgba(std::vector<uint8_t> rgba, int tex_width, int tex_height, bool already_premultiplied)
    {
        if (tex_width <= 0 || tex_height <= 0 || tex_width > UINT16_MAX || tex_height > UINT16_MAX) {
            return 0;
        }
        const bgfx::Caps* caps = bgfx::getCaps();
        if (caps && (uint32_t(tex_width) > caps->limits.maxTextureSize || uint32_t(tex_height) > caps->limits.maxTextureSize)) {
            std::fprintf(stderr, "[rmlui] texture too large: %dx%d max=%u\n", tex_width, tex_height, caps->limits.maxTextureSize);
            return 0;
        }
        const size_t expected_size = size_t(tex_width) * size_t(tex_height) * 4u;
        if (rgba.size() != expected_size || expected_size > std::numeric_limits<uint32_t>::max()) {
            return 0;
        }
        if (!already_premultiplied) {
            premultiply_rgba(rgba);
        }
        bgfx::TextureHandle texture = bgfx::createTexture2D(uint16_t(tex_width), uint16_t(tex_height), false, 1, bgfx::TextureFormat::RGBA8,
            kRmlTextureFlags, bgfx::copy(rgba.data(), uint32_t(rgba.size())));
        if (!bgfx::isValid(texture)) {
            return 0;
        }
        const Rml::TextureHandle handle = ++texture_counter;
        textures.emplace(handle, TextureRecord{texture, {tex_width, tex_height}});
        return handle;
    }

    void submit(const GeometryRecord& geometry, Rml::Vector2f translation, Rml::TextureHandle texture)
    {
        if (!bgfx::isValid(program) || geometry.index_count == 0 || pass_allocator.exhausted) {
            return;
        }
        const bgfx::ViewId view = pass_allocator.allocate("RmlUi.Geometry", width, height);
        bgfx::setVertexBuffer(0, geometry.vb);
        bgfx::setIndexBuffer(geometry.ib, 0, geometry.index_count);
        bgfx::setUniform(projection_uniform, projection);
        bgfx::setUniform(transform_uniform, transform_valid ? transform : identity);
        const float translate[4] = {translation.x, translation.y, 0.0f, 0.0f};
        bgfx::setUniform(translate_uniform, translate);
        bgfx::TextureHandle bgfx_texture = white_texture;
        if (auto it = textures.find(texture); it != textures.end()) {
            bgfx_texture = it->second.handle;
        }
        bgfx::setTexture(0, sampler, bgfx_texture);
        if (scissor_enabled) {
            const Rml::Rectanglei scissor = clamp_scissor(scissor_region, width, height);
            if (scissor.Width() <= 0 || scissor.Height() <= 0) {
                return;
            }
            bgfx::setScissor(uint16_t(scissor.Left()), uint16_t(scissor.Top()), uint16_t(scissor.Width()), uint16_t(scissor.Height()));
        }
        bgfx::setState(kRmlBlendState);
        bgfx::submit(view, program);
    }

    const assets::AssetManager& assets;
    bgfx::VertexLayout layout;
    bgfx::ProgramHandle program = BGFX_INVALID_HANDLE;
    bgfx::TextureHandle white_texture = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle sampler = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle projection_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle transform_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle translate_uniform = BGFX_INVALID_HANDLE;
    std::unordered_map<Rml::CompiledGeometryHandle, GeometryRecord> geometries;
    std::unordered_map<Rml::TextureHandle, TextureRecord> textures;
    Rml::CompiledGeometryHandle geometry_counter = 0;
    Rml::TextureHandle texture_counter = 0;
    RmlUiPassAllocator pass_allocator{bgfx_backend::ViewRuntimeUIBegin, bgfx_backend::ViewRuntimeUIEnd};
    int width = 1;
    int height = 1;
    float projection[16] {};
    float identity[16] {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    float transform[16] {};
    bool transform_valid = false;
    bool scissor_enabled = false;
    Rml::Rectanglei scissor_region = Rml::Rectanglei::FromPositionSize({0, 0}, {0, 0});
};

BgfxRenderInterface::BgfxRenderInterface(int width, int height, const assets::AssetManager& assets)
    : m_impl(std::make_unique<Impl>(width, height, assets))
{
}

BgfxRenderInterface::~BgfxRenderInterface() = default;

BgfxRenderInterface::operator bool() const
{
    return m_impl && bgfx::isValid(m_impl->program);
}

void BgfxRenderInterface::resize(int width, int height) { m_impl->resize(width, height); }

void BgfxRenderInterface::begin_frame()
{
    m_impl->pass_allocator.reset();
    m_impl->transform_valid = false;
    m_impl->scissor_enabled = false;
    m_impl->scissor_region = Rml::Rectanglei::FromPositionSize({0, 0}, {m_impl->width, m_impl->height});
    const bgfx::ViewId view = m_impl->pass_allocator.allocate("RmlUi.Begin", m_impl->width, m_impl->height);
    bgfx::setViewClear(view, BGFX_CLEAR_NONE);
    bgfx::touch(view);
}

void BgfxRenderInterface::end_frame()
{
    const bgfx::ViewId view = m_impl->pass_allocator.allocate("RmlUi.End", m_impl->width, m_impl->height);
    bgfx::touch(view);
}

Rml::CompiledGeometryHandle BgfxRenderInterface::CompileGeometry(Rml::Span<const Rml::Vertex> vertices, Rml::Span<const int> indices)
{
    if (vertices.empty() || indices.empty() || vertices.size() > std::numeric_limits<uint32_t>::max() ||
        indices.size() > std::numeric_limits<uint32_t>::max()) {
        return 0;
    }
    std::vector<RmlVertex> converted;
    converted.reserve(vertices.size());
    for (const Rml::Vertex& vertex : vertices) {
        converted.push_back({vertex.position.x, vertex.position.y, pack_abgr(vertex.colour), vertex.tex_coord.x, vertex.tex_coord.y});
    }
    std::vector<uint32_t> converted_indices;
    converted_indices.reserve(indices.size());
    for (int index : indices) {
        if (index < 0 || size_t(index) >= vertices.size()) {
            return 0;
        }
        converted_indices.push_back(uint32_t(index));
    }
    auto vb = bgfx::createVertexBuffer(bgfx::copy(converted.data(), uint32_t(converted.size() * sizeof(RmlVertex))), m_impl->layout);
    auto ib = bgfx::createIndexBuffer(bgfx::copy(converted_indices.data(), uint32_t(converted_indices.size() * sizeof(uint32_t))), BGFX_BUFFER_INDEX32);
    if (!bgfx::isValid(vb) || !bgfx::isValid(ib)) {
        if (bgfx::isValid(vb)) bgfx::destroy(vb);
        if (bgfx::isValid(ib)) bgfx::destroy(ib);
        return 0;
    }
    const Rml::CompiledGeometryHandle handle = ++m_impl->geometry_counter;
    m_impl->geometries.emplace(handle, GeometryRecord{vb, ib, uint32_t(converted_indices.size())});
    return handle;
}

void BgfxRenderInterface::RenderGeometry(Rml::CompiledGeometryHandle geometry, Rml::Vector2f translation, Rml::TextureHandle texture)
{
    if (auto it = m_impl->geometries.find(geometry); it != m_impl->geometries.end()) {
        m_impl->submit(it->second, translation, texture);
    }
}

void BgfxRenderInterface::ReleaseGeometry(Rml::CompiledGeometryHandle geometry)
{
    if (auto it = m_impl->geometries.find(geometry); it != m_impl->geometries.end()) {
        Impl::destroy_geometry(it->second);
        m_impl->geometries.erase(it);
    }
}

Rml::TextureHandle BgfxRenderInterface::LoadTexture(Rml::Vector2i& texture_dimensions, const Rml::String& source)
{
    texture_dimensions = {};
    const std::string logical = resolve_asset_path(m_impl->assets, source.c_str());
    auto bytes = m_impl->assets.read_binary(logical);
    if (!bytes || bytes.value->bytes.empty()) {
        std::fprintf(stderr, "[rmlui] texture read failed: %s (%s)\n", logical.c_str(), bytes.error.c_str());
        return 0;
    }
    bx::DefaultAllocator allocator;
    bimg::ImageContainer* image = bimg::imageParse(&allocator, bytes.value->bytes.data(), uint32_t(bytes.value->bytes.size()), bimg::TextureFormat::RGBA8);
    if (!image || image->m_width <= 0 || image->m_height <= 0 || !image->m_data) {
        if (image) bimg::imageFree(image);
        std::fprintf(stderr, "[rmlui] image decode failed: %s\n", logical.c_str());
        return 0;
    }
    std::vector<uint8_t> rgba(static_cast<const uint8_t*>(image->m_data), static_cast<const uint8_t*>(image->m_data) + image->m_size);
    const int width = int(image->m_width);
    const int height = int(image->m_height);
    bimg::imageFree(image);
    Rml::TextureHandle handle = m_impl->create_texture_from_rgba(std::move(rgba), width, height, false);
    if (handle != 0) {
        texture_dimensions = {width, height};
    }
    return handle;
}

Rml::TextureHandle BgfxRenderInterface::GenerateTexture(Rml::Span<const Rml::byte> source, Rml::Vector2i source_dimensions)
{
    if (source.empty()) {
        return 0;
    }
    std::vector<uint8_t> rgba(source.begin(), source.end());
    return m_impl->create_texture_from_rgba(std::move(rgba), source_dimensions.x, source_dimensions.y, true);
}

void BgfxRenderInterface::ReleaseTexture(Rml::TextureHandle texture)
{
    if (auto it = m_impl->textures.find(texture); it != m_impl->textures.end()) {
        if (bgfx::isValid(it->second.handle)) bgfx::destroy(it->second.handle);
        m_impl->textures.erase(it);
    }
}

void BgfxRenderInterface::EnableScissorRegion(bool enable) { m_impl->scissor_enabled = enable; }
void BgfxRenderInterface::SetScissorRegion(Rml::Rectanglei region) { m_impl->scissor_region = clamp_scissor(region, m_impl->width, m_impl->height); }

void BgfxRenderInterface::SetTransform(const Rml::Matrix4f* transform)
{
    if (transform) {
        m_impl->transform_valid = true;
        std::memcpy(m_impl->transform, transform->data(), sizeof(m_impl->transform));
    } else {
        m_impl->transform_valid = false;
    }
}

void BgfxRenderInterface::EnableClipMask(bool enable)
{
    std::fprintf(stderr, "[rmlui] advanced clip mask %s is not implemented in this bgfx backend yet\n", enable ? "enable" : "disable");
}

void BgfxRenderInterface::RenderToClipMask(Rml::ClipMaskOperation, Rml::CompiledGeometryHandle, Rml::Vector2f)
{
    std::fprintf(stderr, "[rmlui] RenderToClipMask is not implemented in this bgfx backend yet\n");
}

Rml::LayerHandle BgfxRenderInterface::PushLayer()
{
    std::fprintf(stderr, "[rmlui] PushLayer is not implemented in this bgfx backend yet\n");
    return 0;
}

void BgfxRenderInterface::CompositeLayers(Rml::LayerHandle, Rml::LayerHandle, Rml::BlendMode, Rml::Span<const Rml::CompiledFilterHandle>)
{
    std::fprintf(stderr, "[rmlui] CompositeLayers is not implemented in this bgfx backend yet\n");
}

void BgfxRenderInterface::PopLayer()
{
    std::fprintf(stderr, "[rmlui] PopLayer is not implemented in this bgfx backend yet\n");
}

Rml::TextureHandle BgfxRenderInterface::SaveLayerAsTexture()
{
    std::fprintf(stderr, "[rmlui] SaveLayerAsTexture is not implemented in this bgfx backend yet\n");
    return 0;
}

Rml::CompiledFilterHandle BgfxRenderInterface::SaveLayerAsMaskImage()
{
    std::fprintf(stderr, "[rmlui] SaveLayerAsMaskImage is not implemented in this bgfx backend yet\n");
    return 0;
}

Rml::CompiledFilterHandle BgfxRenderInterface::CompileFilter(const Rml::String& name, const Rml::Dictionary&)
{
    std::fprintf(stderr, "[rmlui] filter '%s' is not implemented in this bgfx backend yet\n", name.c_str());
    return 0;
}

void BgfxRenderInterface::ReleaseFilter(Rml::CompiledFilterHandle) {}

Rml::CompiledShaderHandle BgfxRenderInterface::CompileShader(const Rml::String& name, const Rml::Dictionary&)
{
    std::fprintf(stderr, "[rmlui] shader '%s' is not implemented in this bgfx backend yet\n", name.c_str());
    return 0;
}

void BgfxRenderInterface::RenderShader(Rml::CompiledShaderHandle, Rml::CompiledGeometryHandle, Rml::Vector2f, Rml::TextureHandle)
{
    std::fprintf(stderr, "[rmlui] RenderShader is not implemented in this bgfx backend yet\n");
}

void BgfxRenderInterface::ReleaseShader(Rml::CompiledShaderHandle) {}

} // namespace noveltea::ui::rmlui

#endif
