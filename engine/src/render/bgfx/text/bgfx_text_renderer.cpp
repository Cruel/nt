#include "noveltea/renderer.hpp"

#include "noveltea/core/rich_text.hpp"
#include "noveltea/render/shader_manifest.hpp"
#include "render/bgfx/bgfx_material_binder.hpp"
#include "render/bgfx/bgfx_renderer_internal.hpp"
#include "render/bgfx/bgfx_shader_loader.hpp"
#include "render/bgfx/bgfx_shader_program_cache.hpp"
#include "text/text_engine.hpp"

#include <SDL3/SDL_log.h>
#include <bgfx/bgfx.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <memory>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace noveltea {
namespace {

struct TextVertex {
    float x, y;
    float u, v;
    float r, g, b, a;
};

struct GlyphCacheKey {
    uint32_t font = 0;
    uint32_t glyph_id = 0;
    uint32_t pixel_size = 0;
    uint32_t synthetic_style = TextFontRegular;

    [[nodiscard]] friend bool operator==(const GlyphCacheKey&, const GlyphCacheKey&) = default;
};

struct GlyphCacheKeyHash {
    std::size_t operator()(const GlyphCacheKey& key) const
    {
        uint64_t value = key.font;
        value = value * 1315423911u + key.glyph_id;
        value = value * 1315423911u + key.pixel_size;
        value = value * 1315423911u + key.synthetic_style;
        return static_cast<std::size_t>(value);
    }
};

struct CachedGlyph {
    uint16_t page = 0;
    float u0 = 0.0f;
    float v0 = 0.0f;
    float u1 = 0.0f;
    float v1 = 0.0f;
    float width = 0.0f;
    float height = 0.0f;
    float bearing_x = 0.0f;
    float bearing_y = 0.0f;
};

struct AtlasPage {
    bgfx::TextureHandle texture = BGFX_INVALID_HANDLE;
};

enum class ActiveTextBindingKind {
    Default,
    Material,
    DirectShaderPair,
};

struct ActiveTextBatchKey {
    ActiveTextBindingKind kind = ActiveTextBindingKind::Default;
    uint16_t page = 0;
    std::string material_id;
    std::string vertex_shader_id;
    std::string fragment_shader_id;

    [[nodiscard]] friend bool operator==(const ActiveTextBatchKey&,
                                         const ActiveTextBatchKey&) = default;
};

struct ActiveTextDrawBatch {
    ActiveTextBatchKey key;
    std::vector<TextVertex> vertices;
    std::vector<uint16_t> indices;
};

Color active_text_glow_color(Color base, float glow)
{
    const float intensity = std::clamp(glow, 0.0f, 1.0f);
    if (intensity <= 0.0f) {
        return base;
    }

    constexpr Color warm_glow = Color::from_rgba8(255, 210, 78);
    const float mix_amount = 0.65f * intensity;
    base.r =
        std::clamp(base.r + (warm_glow.r - base.r) * mix_amount + 0.20f * intensity, 0.0f, 1.0f);
    base.g =
        std::clamp(base.g + (warm_glow.g - base.g) * mix_amount + 0.14f * intensity, 0.0f, 1.0f);
    base.b = std::clamp(base.b + (warm_glow.b - base.b) * mix_amount, 0.0f, 1.0f);
    return base;
}

float effective_alpha(const TextStyle& style)
{
    return std::clamp(style.color.a * style.alpha, 0.0f, 1.0f);
}

bool has_font_style(unsigned int style, unsigned int flag) noexcept { return (style & flag) != 0; }

Vec2 transform_point(Vec2 point, Vec2 origin, const Transform2D& transform)
{
    const float local_x = (point.x - origin.x) * transform.scale.x;
    const float local_y = (point.y - origin.y) * transform.scale.y;
    const float c = std::cos(transform.rotation_radians);
    const float s = std::sin(transform.rotation_radians);
    return {
        origin.x + transform.position.x + local_x * c - local_y * s,
        origin.y + transform.position.y + local_x * s + local_y * c,
    };
}

class BgfxTextRenderer {
public:
    explicit BgfxTextRenderer(const assets::AssetManager& assets)
        : m_assets(assets), m_text(assets), m_packer(1024, 1024, kGlyphPadding)
    {
    }
    bool initialize();
    void shutdown();
    FontHandle load_font(const FontDesc& desc) { return m_text.load_font(desc); }
    FontFamilyHandle register_font_family(const FontFamilyDesc& desc)
    {
        return m_text.register_font_family(desc);
    }
    ResolvedFont resolve_font(std::string_view alias, uint32_t style) const
    {
        return m_text.resolve_font(alias, style);
    }
    void resize(const SurfaceMetrics& surface) { m_surface = sanitize_surface_metrics(surface); }
    void set_standard_inputs(ShaderStandardInputs inputs) { m_standard_inputs = inputs; }
    TextLayout layout_text(const Text& text) const
    {
        return m_text.layout_text(text, effective_scale());
    }
    TextMetrics measure(const Text& text) const
    {
        return m_text.layout_text(text, effective_scale()).metrics;
    }
    TextMetrics measure(FontHandle font, std::string_view value, float size) const;
    void draw_text(const Text& text) { draw_text(m_text.layout_text(text, effective_scale())); }
    void draw_text(const TextLayout& layout);
    void draw_active_text(const ActiveTextLayout& layout, FontHandle font,
                          const ShaderMaterialProject* materials,
                          bgfx_backend::BgfxShaderProgramCache* programs,
                          bgfx_backend::BgfxMaterialBinder* material_binder);

private:
    CachedGlyph* ensure_glyph(const PositionedGlyph& glyph);
    bgfx::TextureHandle ensure_page(uint16_t page);
    float effective_scale() const { return std::max(m_surface.scale_x, m_surface.scale_y); }

    const assets::AssetManager& m_assets;
    text::TextEngine m_text;
    SurfaceMetrics m_surface{};
    ShaderStandardInputs m_standard_inputs{};
    text::ShelfAtlasPacker m_packer;
    std::vector<AtlasPage> m_pages;
    std::unordered_map<GlyphCacheKey, CachedGlyph, GlyphCacheKeyHash> m_glyphs;
    bgfx::ProgramHandle m_program = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle m_sampler = BGFX_INVALID_HANDLE;
    std::unordered_set<std::string> m_active_text_diagnostics;
    static constexpr uint16_t kGlyphPadding = 1;
};

bool BgfxTextRenderer::initialize()
{
    if (!m_text.valid()) {
        return false;
    }
    m_program =
        bgfx_backend::BgfxShaderLoader(m_assets).load_program(bgfx_backend::SystemShader::Text);
    if (!bgfx::isValid(m_program)) {
        return false;
    }
    m_sampler = bgfx::createUniform("s_textAtlas", bgfx::UniformType::Sampler);
    return bgfx::isValid(m_sampler);
}

void BgfxTextRenderer::shutdown()
{
    for (auto& page : m_pages) {
        if (bgfx::isValid(page.texture)) {
            bgfx::destroy(page.texture);
        }
    }
    m_pages.clear();
    m_glyphs.clear();
    if (bgfx::isValid(m_sampler)) {
        bgfx::destroy(m_sampler);
    }
    if (bgfx::isValid(m_program)) {
        bgfx::destroy(m_program);
    }
    m_sampler = BGFX_INVALID_HANDLE;
    m_program = BGFX_INVALID_HANDLE;
}

TextMetrics BgfxTextRenderer::measure(FontHandle font, std::string_view value, float size) const
{
    Text text;
    text.font = font;
    text.value = std::string(value);
    text.style.size = size;
    text.wrap = TextWrap::NoWrap;
    return m_text.layout_text(text, effective_scale()).metrics;
}

bgfx::TextureHandle BgfxTextRenderer::ensure_page(uint16_t page_index)
{
    while (m_pages.size() <= page_index) {
        AtlasPage page;
        std::vector<uint8_t> zeroes(static_cast<size_t>(m_packer.width()) * m_packer.height() * 4u,
                                    0);
        page.texture = bgfx::createTexture2D(m_packer.width(), m_packer.height(), false, 1,
                                             bgfx::TextureFormat::RGBA8,
                                             BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP, nullptr);
        if (bgfx::isValid(page.texture)) {
            bgfx::updateTexture2D(page.texture, 0, 0, 0, 0, m_packer.width(), m_packer.height(),
                                  bgfx::copy(zeroes.data(), static_cast<uint32_t>(zeroes.size())));
        }
        m_pages.push_back(page);
    }
    return m_pages[page_index].texture;
}

CachedGlyph* BgfxTextRenderer::ensure_glyph(const PositionedGlyph& glyph)
{
    GlyphCacheKey key;
    key.font = glyph.font.id;
    key.glyph_id = glyph.glyph_id;
    key.pixel_size = text::glyph_cache_pixel_size_key(glyph.raster_pixel_size);
    key.synthetic_style = glyph.synthetic_font_style & (TextFontBold | TextFontItalic);
    auto found = m_glyphs.find(key);
    if (found != m_glyphs.end()) {
        return &found->second;
    }

    auto bitmap = m_text.rasterize_glyph(glyph.font, glyph.glyph_id, glyph.raster_pixel_size,
                                         glyph.synthetic_font_style);
    if (!bitmap) {
        return nullptr;
    }
    const auto rect =
        m_packer.add(static_cast<uint16_t>(bitmap->width), static_cast<uint16_t>(bitmap->height));
    bgfx::TextureHandle texture = ensure_page(rect.page);
    if (!bgfx::isValid(texture)) {
        return nullptr;
    }

    if (bitmap->width > 0 && bitmap->height > 0) {
        const auto upload = text::make_padded_glyph_upload(*bitmap, kGlyphPadding);
        bgfx::updateTexture2D(
            texture, 0, 0, static_cast<uint16_t>(rect.x - upload.glyph_x),
            static_cast<uint16_t>(rect.y - upload.glyph_y), upload.width, upload.height,
            bgfx::copy(upload.rgba.data(), static_cast<uint32_t>(upload.rgba.size())));
    }

    CachedGlyph cached;
    cached.page = rect.page;
    cached.u0 = static_cast<float>(rect.x) / static_cast<float>(m_packer.width());
    cached.v0 = static_cast<float>(rect.y) / static_cast<float>(m_packer.height());
    cached.u1 = static_cast<float>(rect.x + rect.width) / static_cast<float>(m_packer.width());
    cached.v1 = static_cast<float>(rect.y + rect.height) / static_cast<float>(m_packer.height());
    cached.width = static_cast<float>(bitmap->width);
    cached.height = static_cast<float>(bitmap->height);
    cached.bearing_x = static_cast<float>(bitmap->bearing_x);
    cached.bearing_y = static_cast<float>(bitmap->bearing_y);
    auto inserted = m_glyphs.emplace(key, cached);
    return &inserted.first->second;
}

void BgfxTextRenderer::draw_text(const TextLayout& layout)
{
    if (!bgfx::isValid(m_program) || layout.lines.empty()) {
        return;
    }

    std::vector<std::vector<TextVertex>> page_vertices(m_pages.size() + 1);
    std::vector<std::vector<uint16_t>> page_indices(m_pages.size() + 1);
    const Color color = layout.style.color;
    const float alpha = effective_alpha(layout.style);
    const Vec2 origin{layout.bounds.x, layout.bounds.y};

    for (const auto& line : layout.lines) {
        for (const auto& run : line.visual_runs) {
            for (const auto& positioned : run.glyphs) {
                CachedGlyph* glyph = ensure_glyph(positioned);
                const float glyph_scale =
                    positioned.logical_pixel_size > 0.0f
                        ? positioned.raster_pixel_size / positioned.logical_pixel_size
                        : effective_scale();
                const float inv_glyph_scale = 1.0f / std::max(glyph_scale, 0.0001f);
                const float glyph_width = glyph ? glyph->width * inv_glyph_scale : 0.0f;
                const float glyph_height = glyph ? glyph->height * inv_glyph_scale : 0.0f;
                const float glyph_bearing_x = glyph ? glyph->bearing_x * inv_glyph_scale : 0.0f;
                const float glyph_bearing_y = glyph ? glyph->bearing_y * inv_glyph_scale : 0.0f;
                if (!glyph || glyph_width <= 0.0f || glyph_height <= 0.0f) {
                    continue;
                }
                if (page_vertices.size() <= glyph->page) {
                    page_vertices.resize(static_cast<size_t>(glyph->page) + 1u);
                    page_indices.resize(static_cast<size_t>(glyph->page) + 1u);
                }
                auto& vertices = page_vertices[glyph->page];
                auto& indices = page_indices[glyph->page];
                if (vertices.size() > std::numeric_limits<uint16_t>::max() - 4u) {
                    continue;
                }

                const float x0 = positioned.position.x + positioned.offset.x + glyph_bearing_x;
                const float y0 = positioned.position.y + positioned.offset.y - glyph_bearing_y;
                const float x1 = x0 + glyph_width;
                const float y1 = y0 + glyph_height;
                const uint16_t base = static_cast<uint16_t>(vertices.size());
                const Vec2 p0 = transform_point({x0, y0}, origin, layout.transform);
                const Vec2 p1 = transform_point({x1, y0}, origin, layout.transform);
                const Vec2 p2 = transform_point({x1, y1}, origin, layout.transform);
                const Vec2 p3 = transform_point({x0, y1}, origin, layout.transform);
                vertices.push_back(
                    {p0.x, p0.y, glyph->u0, glyph->v0, color.r, color.g, color.b, alpha});
                vertices.push_back(
                    {p1.x, p1.y, glyph->u1, glyph->v0, color.r, color.g, color.b, alpha});
                vertices.push_back(
                    {p2.x, p2.y, glyph->u1, glyph->v1, color.r, color.g, color.b, alpha});
                vertices.push_back(
                    {p3.x, p3.y, glyph->u0, glyph->v1, color.r, color.g, color.b, alpha});
                indices.insert(indices.end(),
                               {base, static_cast<uint16_t>(base + 1),
                                static_cast<uint16_t>(base + 2), base,
                                static_cast<uint16_t>(base + 2), static_cast<uint16_t>(base + 3)});
            }
        }
    }
    bgfx::VertexLayout vertex_layout;
    vertex_layout.begin()
        .add(bgfx::Attrib::Position, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::TexCoord0, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::Color0, 4, bgfx::AttribType::Float)
        .end();

    const Rect physical_bounds = logical_to_framebuffer(layout.bounds, m_surface);
    const uint16_t scissor =
        (layout.bounds.width > 0.0f && layout.bounds.height > 0.0f)
            ? bgfx::setScissor(
                  static_cast<uint16_t>(std::max(0.0f, std::floor(physical_bounds.x))),
                  static_cast<uint16_t>(std::max(0.0f, std::floor(physical_bounds.y))),
                  static_cast<uint16_t>(std::max(0.0f, std::ceil(physical_bounds.width))),
                  static_cast<uint16_t>(std::max(0.0f, std::ceil(physical_bounds.height))))
            : UINT16_MAX;

    for (size_t page_index = 0; page_index < page_vertices.size(); ++page_index) {
        const auto& vertices = page_vertices[page_index];
        const auto& indices = page_indices[page_index];
        if (vertices.empty() || indices.empty() || page_index >= m_pages.size() ||
            !bgfx::isValid(m_pages[page_index].texture)) {
            continue;
        }
        bgfx::TransientVertexBuffer tvb;
        bgfx::TransientIndexBuffer tib;
        if (!bgfx::allocTransientBuffers(&tvb, vertex_layout,
                                         static_cast<uint32_t>(vertices.size()), &tib,
                                         static_cast<uint32_t>(indices.size()))) {
            continue;
        }
        std::memcpy(tvb.data, vertices.data(), vertices.size() * sizeof(TextVertex));
        std::memcpy(tib.data, indices.data(), indices.size() * sizeof(uint16_t));
        if (scissor != UINT16_MAX) {
            bgfx::setScissor(scissor);
        }
        const float identity[16] = {
            1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f,
            0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f,
        };
        bgfx::setTransform(identity);
        bgfx::setTexture(0, m_sampler, m_pages[page_index].texture);
        bgfx::setVertexBuffer(0, &tvb);
        bgfx::setIndexBuffer(&tib);
        bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A | BGFX_STATE_BLEND_ALPHA);
        bgfx::submit(bgfx_backend::ViewTextLab, m_program);
    }
}

void BgfxTextRenderer::draw_active_text(const ActiveTextLayout& layout, FontHandle font,
                                        const ShaderMaterialProject* materials,
                                        bgfx_backend::BgfxShaderProgramCache* programs,
                                        bgfx_backend::BgfxMaterialBinder* material_binder)
{
    if (!bgfx::isValid(m_program) || layout.glyphs.empty()) {
        return;
    }

    std::vector<ActiveTextDrawBatch> batches;

    const auto binding_key_for = [&](const ActiveTextGlyphVisual& glyph, uint16_t page) {
        ActiveTextBatchKey key;
        key.page = page;
        if (!glyph.material_id.empty()) {
            key.kind = ActiveTextBindingKind::Material;
            key.material_id = glyph.material_id;
            return key;
        }
        if (!glyph.vertex_shader_id.empty() || !glyph.fragment_shader_id.empty()) {
            key.kind = ActiveTextBindingKind::DirectShaderPair;
            key.vertex_shader_id = glyph.vertex_shader_id;
            key.fragment_shader_id = glyph.fragment_shader_id;
        }
        return key;
    };

    const auto batch_for = [&](const ActiveTextGlyphVisual& visual,
                               uint16_t page) -> ActiveTextDrawBatch& {
        const ActiveTextBatchKey key = binding_key_for(visual, page);
        if (!batches.empty() && batches.back().key == key) {
            return batches.back();
        }
        ActiveTextDrawBatch batch;
        batch.key = key;
        batches.push_back(std::move(batch));
        return batches.back();
    };

    const auto diagnose_shader_metadata = [&](const ActiveTextGlyphVisual& glyph) {
        if (!glyph.material_id.empty() && materials) {
            const auto parsed = parse_material_id(glyph.material_id);
            if (parsed.ok()) {
                const auto* material = find_material(*materials, *parsed.id);
                if (!material || material->role != ShaderRole::ActiveText) {
                    const std::string key = "mat:" + glyph.material_id;
                    if (m_active_text_diagnostics.insert(key).second) {
                        std::fprintf(stderr,
                                     "[active_text] material '%s' role 'active-text' fell back to "
                                     "default text rendering: %s\n",
                                     glyph.material_id.c_str(),
                                     material ? "material role is not active-text"
                                              : "unknown material id");
                    }
                } else {
                    const auto result = resolve_material_shader_program(
                        *materials, *parsed.id, programs ? programs->active_variant() : "");
                    if (!result.ok()) {
                        const std::string key = "mat:" + glyph.material_id;
                        if (m_active_text_diagnostics.insert(key).second) {
                            for (const auto& diagnostic : result.diagnostics) {
                                std::fprintf(stderr,
                                             "[active_text] material '%s' role 'active-text' fell "
                                             "back to default text rendering: %s\n",
                                             glyph.material_id.c_str(), diagnostic.message.c_str());
                            }
                        }
                    }
                }
            } else {
                const std::string key = "mat:" + glyph.material_id;
                if (m_active_text_diagnostics.insert(key).second) {
                    std::fprintf(stderr,
                                 "[active_text] material '%s' role 'active-text' fell back to "
                                 "default text rendering: invalid material id\n",
                                 glyph.material_id.c_str());
                }
            }
        }
        if ((!glyph.vertex_shader_id.empty() || !glyph.fragment_shader_id.empty()) && materials) {
            const auto result = resolve_direct_shader_pair_program(
                *materials, ShaderId(glyph.vertex_shader_id), ShaderId(glyph.fragment_shader_id),
                programs ? programs->active_variant() : "");
            if (!result.ok()) {
                const std::string key =
                    "shader:" + glyph.vertex_shader_id + "|" + glyph.fragment_shader_id;
                if (m_active_text_diagnostics.insert(key).second) {
                    for (const auto& diagnostic : result.diagnostics) {
                        std::fprintf(stderr,
                                     "[active_text] direct shader pair vertex='%s' fragment='%s' "
                                     "fell back to default text rendering: %s\n",
                                     glyph.vertex_shader_id.c_str(),
                                     glyph.fragment_shader_id.c_str(), diagnostic.message.c_str());
                    }
                }
            }
        }
    };

    const auto append_positioned_glyph = [&](const ActiveTextGlyphVisual& visual,
                                             const PositionedGlyph& positioned) {
        CachedGlyph* glyph = ensure_glyph(positioned);
        const float glyph_scale = positioned.logical_pixel_size > 0.0f
                                      ? positioned.raster_pixel_size / positioned.logical_pixel_size
                                      : effective_scale();
        const float inv_glyph_scale = 1.0f / std::max(glyph_scale, 0.0001f);
        const float visual_scale = std::max(visual.scale, 0.0001f);
        const float base_width = glyph ? glyph->width * inv_glyph_scale : 0.0f;
        const float base_height = glyph ? glyph->height * inv_glyph_scale : 0.0f;
        const float glyph_width = base_width * visual_scale;
        const float glyph_height = base_height * visual_scale;
        const float glyph_bearing_x = glyph ? glyph->bearing_x * inv_glyph_scale : 0.0f;
        const float glyph_bearing_y = glyph ? glyph->bearing_y * inv_glyph_scale : 0.0f;
        if (!glyph || glyph_width <= 0.0f || glyph_height <= 0.0f) {
            return;
        }
        auto& batch = batch_for(visual, glyph->page);
        auto& vertices = batch.vertices;
        auto& indices = batch.indices;
        if (vertices.size() > std::numeric_limits<uint16_t>::max() - 4u) {
            return;
        }

        const float base_x0 =
            positioned.position.x + positioned.offset.x + glyph_bearing_x + visual.offset.x;
        const float base_y0 =
            positioned.position.y + positioned.offset.y - glyph_bearing_y + visual.offset.y;
        const float pivot_x = base_x0 + base_width * 0.5f;
        const float pivot_y = base_y0 + base_height * 0.5f;
        const float x0 = pivot_x + (base_x0 - pivot_x) * visual_scale;
        const float y0 = pivot_y + (base_y0 - pivot_y) * visual_scale;
        const float x1 = x0 + glyph_width;
        const float y1 = y0 + glyph_height;
        const Color color = active_text_glow_color(
            visual.diff ? Color::from_rgba8(255, 214, 92) : visual.color, visual.glow);
        const float alpha = std::clamp(visual.alpha * color.a, 0.0f, 1.0f);
        const bool synthetic_bold = has_font_style(visual.font_style, core::FontBold);
        const bool synthetic_italic = has_font_style(visual.font_style, core::FontItalic);
        const float italic_shear = synthetic_italic ? std::max(glyph_height * 0.18f, 1.0f) : 0.0f;
        const float bold_offset =
            synthetic_bold ? std::max(0.75f, visual.font_size * 0.035f) : 0.0f;
        const int passes = synthetic_bold ? 2 : 1;
        for (int pass = 0; pass < passes; ++pass) {
            const float pass_offset = static_cast<float>(pass) * bold_offset;
            if (vertices.size() > std::numeric_limits<uint16_t>::max() - 4u) {
                return;
            }
            const uint16_t base = static_cast<uint16_t>(vertices.size());
            vertices.push_back({x0 + italic_shear + pass_offset, y0, glyph->u0, glyph->v0, color.r,
                                color.g, color.b, alpha});
            vertices.push_back({x1 + italic_shear + pass_offset, y0, glyph->u1, glyph->v0, color.r,
                                color.g, color.b, alpha});
            vertices.push_back(
                {x1 + pass_offset, y1, glyph->u1, glyph->v1, color.r, color.g, color.b, alpha});
            vertices.push_back(
                {x0 + pass_offset, y1, glyph->u0, glyph->v1, color.r, color.g, color.b, alpha});
            indices.insert(indices.end(),
                           {base, static_cast<uint16_t>(base + 1), static_cast<uint16_t>(base + 2),
                            base, static_cast<uint16_t>(base + 2),
                            static_cast<uint16_t>(base + 3)});
        }
    };

    const auto append_decoration = [&](const ActiveTextGlyphVisual& visual, std::string_view value,
                                       Rect bounds) {
        if (bounds.width <= 0.0f || bounds.height <= 0.0f) {
            return;
        }
        Text text;
        text.value = std::string(value);
        text.font = font;
        text.bounds = bounds;
        text.style.size = std::max(visual.font_size > 0 ? static_cast<float>(visual.font_size)
                                                        : layout.metrics.line_height,
                                   1.0f);
        text.style.color = visual.diff ? Color::from_rgba8(255, 214, 92) : visual.color;
        text.style.alpha = visual.alpha;
        text.wrap = TextWrap::NoWrap;
        auto shaped = m_text.layout_text(text, effective_scale());
        for (const auto& line : shaped.lines) {
            for (const auto& run : line.visual_runs) {
                for (const auto& positioned : run.glyphs) {
                    append_positioned_glyph(visual, positioned);
                }
            }
        }
    };

    const auto append_decorations = [&](const ActiveTextGlyphVisual& visual,
                                        const PositionedGlyph& positioned) {
        if (!has_font_style(visual.font_style, core::FontUnderlined) &&
            !has_font_style(visual.font_style, core::FontStrikeThrough)) {
            return;
        }
        const float advance_width = std::max(positioned.advance.x * std::max(visual.scale, 0.0001f),
                                             std::max(visual.font_size * 0.25f, 1.0f));
        if (has_font_style(visual.font_style, core::FontUnderlined)) {
            append_decoration(visual, "_",
                              {positioned.position.x + visual.offset.x,
                               positioned.position.y + visual.offset.y, advance_width,
                               std::max(static_cast<float>(visual.font_size), 1.0f)});
        }
        if (has_font_style(visual.font_style, core::FontStrikeThrough)) {
            append_decoration(visual, "-",
                              {positioned.position.x + visual.offset.x,
                               positioned.position.y + visual.offset.y -
                                   std::max(static_cast<float>(visual.font_size) * 0.35f, 1.0f),
                               advance_width,
                               std::max(static_cast<float>(visual.font_size), 1.0f)});
        }
    };

    for (const auto& glyph : layout.glyphs) {
        diagnose_shader_metadata(glyph);
        if (glyph.has_shaped_glyph) {
            append_positioned_glyph(glyph, glyph.shaped_glyph);
            append_decorations(glyph, glyph.shaped_glyph);
            continue;
        }

        Text text;
        text.value = glyph.text;
        text.font = font;
        text.bounds = glyph.bounds;
        text.style.size = std::max(glyph.bounds.height / 1.2f, 1.0f);
        text.style.color = glyph.diff ? Color::from_rgba8(255, 214, 92) : glyph.color;
        text.style.alpha = glyph.alpha;
        text.wrap = TextWrap::NoWrap;
        auto shaped = m_text.layout_text(text, effective_scale());
        for (const auto& line : shaped.lines) {
            for (const auto& run : line.visual_runs) {
                for (const auto& positioned : run.glyphs) {
                    append_positioned_glyph(glyph, positioned);
                    append_decorations(glyph, positioned);
                }
            }
        }
    }

    if (layout.prompt.visible && layout.prompt.alpha > 0.0f) {
        ActiveTextGlyphVisual prompt_visual;
        prompt_visual.text = layout.prompt.page_break ? "v" : ">";
        prompt_visual.bounds = layout.prompt.bounds;
        prompt_visual.color = Color::from_rgba8(255, 228, 128);
        prompt_visual.alpha = std::clamp(layout.prompt.alpha, 0.0f, 1.0f);
        prompt_visual.font_size = static_cast<unsigned int>(
            std::max(std::round(std::max(layout.prompt.bounds.height, 1.0f)), 1.0f));

        Text text;
        text.value = prompt_visual.text;
        text.font = font;
        text.bounds = prompt_visual.bounds;
        text.style.size = std::max(layout.prompt.bounds.height, 1.0f);
        text.style.color = prompt_visual.color;
        text.style.alpha = prompt_visual.alpha;
        text.wrap = TextWrap::NoWrap;
        auto shaped = m_text.layout_text(text, effective_scale());
        for (const auto& line : shaped.lines) {
            for (const auto& run : line.visual_runs) {
                for (const auto& positioned : run.glyphs) {
                    append_positioned_glyph(prompt_visual, positioned);
                }
            }
        }
    }

    bgfx::VertexLayout vertex_layout;
    vertex_layout.begin()
        .add(bgfx::Attrib::Position, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::TexCoord0, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::Color0, 4, bgfx::AttribType::Float)
        .end();

    const Rect physical_bounds = logical_to_framebuffer(layout.bounds, m_surface);
    const uint16_t scissor =
        (layout.bounds.width > 0.0f && layout.bounds.height > 0.0f)
            ? bgfx::setScissor(
                  static_cast<uint16_t>(std::max(0.0f, std::floor(physical_bounds.x))),
                  static_cast<uint16_t>(std::max(0.0f, std::floor(physical_bounds.y))),
                  static_cast<uint16_t>(std::max(0.0f, std::ceil(physical_bounds.width))),
                  static_cast<uint16_t>(std::max(0.0f, std::ceil(physical_bounds.height))))
            : UINT16_MAX;

    const auto log_diagnostics = [&](const std::string& key_prefix,
                                     const std::vector<ShaderProgramDiagnostic>& diagnostics) {
        for (const auto& diagnostic : diagnostics) {
            const std::string key =
                key_prefix + ":" + diagnostic.context + ":" + diagnostic.message;
            if (m_active_text_diagnostics.insert(key).second) {
                std::fprintf(
                    stderr,
                    "[active_text] custom shader path fell back to default text rendering: "
                    "%s: %s\n",
                    diagnostic.context.c_str(), diagnostic.message.c_str());
            }
        }
    };

    const auto resolve_batch_program = [&](const ActiveTextDrawBatch& batch,
                                           bgfx::TextureHandle atlas) {
        if (batch.key.kind == ActiveTextBindingKind::Material && materials && material_binder) {
            const auto parsed = parse_material_id(batch.key.material_id);
            if (parsed.ok()) {
                std::vector<ShaderProgramDiagnostic> diagnostics;
                const auto bound = material_binder->bind_material(
                    *materials, *parsed.id,
                    bgfx_backend::BgfxMaterialBindInputs{.role = ShaderRole::ActiveText,
                                                         .quad_command = nullptr,
                                                         .glyph_atlas = atlas,
                                                         .standard_inputs = m_standard_inputs,
                                                         .first_texture_stage = 0},
                    &diagnostics);
                log_diagnostics("mat:" + batch.key.material_id, diagnostics);
                if (bound.ok && bgfx::isValid(bound.program)) {
                    return bound.program;
                }
            }
        }

        if (batch.key.kind == ActiveTextBindingKind::DirectShaderPair && materials && programs) {
            std::vector<ShaderProgramDiagnostic> diagnostics;
            const auto resolved = resolve_direct_shader_pair_program(
                *materials, ShaderId(batch.key.vertex_shader_id),
                ShaderId(batch.key.fragment_shader_id), programs->active_variant());
            if (resolved.program) {
                const auto program = programs->load_program(*resolved.program, &diagnostics);
                log_diagnostics("shader:" + batch.key.vertex_shader_id + "|" +
                                    batch.key.fragment_shader_id,
                                diagnostics);
                if (bgfx::isValid(program)) {
                    if (material_binder) {
                        material_binder->bind_standard_uniforms(*resolved.program,
                                                                m_standard_inputs);
                    }
                    bgfx::setTexture(0, m_sampler, atlas,
                                     BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP);
                    return program;
                }
            } else {
                log_diagnostics("shader:" + batch.key.vertex_shader_id + "|" +
                                    batch.key.fragment_shader_id,
                                resolved.diagnostics);
            }
        }

        bgfx::setTexture(0, m_sampler, atlas);
        return m_program;
    };

    for (const auto& batch : batches) {
        const auto& vertices = batch.vertices;
        const auto& indices = batch.indices;
        const size_t page_index = batch.key.page;
        if (vertices.empty() || indices.empty() || page_index >= m_pages.size() ||
            !bgfx::isValid(m_pages[page_index].texture)) {
            continue;
        }
        bgfx::TransientVertexBuffer tvb;
        bgfx::TransientIndexBuffer tib;
        if (!bgfx::allocTransientBuffers(&tvb, vertex_layout,
                                         static_cast<uint32_t>(vertices.size()), &tib,
                                         static_cast<uint32_t>(indices.size()))) {
            continue;
        }
        std::memcpy(tvb.data, vertices.data(), vertices.size() * sizeof(TextVertex));
        std::memcpy(tib.data, indices.data(), indices.size() * sizeof(uint16_t));
        if (scissor != UINT16_MAX) {
            bgfx::setScissor(scissor);
        }
        const float identity[16] = {
            1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f,
            0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f,
        };
        bgfx::setTransform(identity);
        const bgfx::TextureHandle atlas = m_pages[page_index].texture;
        const bgfx::ProgramHandle program = resolve_batch_program(batch, atlas);
        bgfx::setVertexBuffer(0, &tvb);
        bgfx::setIndexBuffer(&tib);
        bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A | BGFX_STATE_BLEND_ALPHA);
        bgfx::submit(bgfx_backend::ViewActiveText, program);
    }
}

} // namespace

void Renderer::create_text()
{
    if (!m_assets) {
        std::fprintf(stderr, "[text] no AssetManager for text renderer\n");
        return;
    }
    auto* text = new BgfxTextRenderer(*m_assets);
    text->resize(m_surface);
    if (!text->initialize()) {
        delete text;
        m_text_renderer = nullptr;
        std::fprintf(stderr, "[text] failed to initialize bgfx text renderer\n");
        return;
    }
    m_text_renderer = text;

    FontDesc desc;
    desc.asset_path = std::string(kSystemFontProjectAsset);
    FontFamilyDesc family;
    family.alias = std::string(kSystemFontAlias);
    family.regular = desc;
    family.synthetic_styles = true;
    if (!text->register_font_family(family)) {
        desc.asset_path = std::string(kSystemFontAsset);
        family.regular = desc;
        text->register_font_family(family);
    }
    m_default_text_font = text->resolve_font(kSystemFontAlias, TextFontRegular).face.id;
    SDL_Log("[text] bgfx grayscale text renderer initialized");
}

void Renderer::destroy_text()
{
    auto* text = static_cast<BgfxTextRenderer*>(m_text_renderer);
    if (text) {
        text->shutdown();
        delete text;
    }
    m_text_renderer = nullptr;
    m_default_text_font = 0;
}

void Renderer::resize_text()
{
    auto* text = static_cast<BgfxTextRenderer*>(m_text_renderer);
    if (text) {
        text->resize(m_surface);
    }
}

FontHandle Renderer::load_font(const FontDesc& desc)
{
    auto* text = static_cast<BgfxTextRenderer*>(m_text_renderer);
    return text ? text->load_font(desc) : FontHandle{};
}

TextLayout Renderer::layout_text(const Text& value) const
{
    auto* text = static_cast<const BgfxTextRenderer*>(m_text_renderer);
    return text ? text->layout_text(value) : TextLayout{};
}

TextMetrics Renderer::measure_text(const Text& value) const
{
    auto* text = static_cast<const BgfxTextRenderer*>(m_text_renderer);
    return text ? text->measure(value) : TextMetrics{};
}

void Renderer::draw_text(const Text& value)
{
    auto* text = static_cast<BgfxTextRenderer*>(m_text_renderer);
    if (text) {
        text->draw_text(value);
    }
}

void Renderer::draw_text(const TextLayout& layout)
{
    auto* text = static_cast<BgfxTextRenderer*>(m_text_renderer);
    if (text) {
        text->draw_text(layout);
    }
}

void Renderer::draw_text(const TextRun& run) { draw_text(to_text(run)); }

TextMetrics Renderer::measure_text(FontHandle font, std::string_view text_value, float size) const
{
    auto* text = static_cast<const BgfxTextRenderer*>(m_text_renderer);
    return text ? text->measure(font, text_value, size) : TextMetrics{};
}

void Renderer::draw_active_text(const ActiveTextLayout& layout)
{
    auto* text = static_cast<BgfxTextRenderer*>(m_text_renderer);
    if (text) {
        auto inputs = m_shader_standard_inputs;
        inputs.paint_dimensions = {layout.bounds.width, layout.bounds.height};
        text->set_standard_inputs(inputs);
        text->draw_active_text(layout, FontHandle{m_default_text_font}, m_shader_materials,
                               m_shader_program_cache.get(), m_material_binder.get());
    }
}

void Renderer::draw_demo_text(float time_seconds)
{
    if (!m_initialized || m_default_text_font == 0) {
        return;
    }
    const FontHandle font{m_default_text_font};
    const float title_box_height =
        clamp_logical(static_cast<float>(m_surface.logical_height) * 0.15f, 72.0f, 150.0f);
    const float title_size = clamp_logical(title_box_height * 0.55f, 28.0f, 72.0f);

    auto draw = [&](std::string value, Rect bounds, float size, Color color,
                    TextAlign align = TextAlign::Start,
                    TextDirection direction = TextDirection::Auto, Transform2D transform = {}) {
        Text text;
        text.value = std::move(value);
        text.font = font;
        text.bounds = bounds;
        text.style = TextStyle{size, color, 1.0f};
        text.align = align;
        text.direction = direction;
        text.language = "en";
        text.transform = transform;
        draw_text(text);
    };

    draw("Proportional title/header", {64.0f, 24.0f, 620.0f, title_box_height}, title_size,
         Color::from_rgba8(255, 196, 87));
    draw("Grayscale text at 18 logical px", {64.0f, 126.0f, 420.0f, 30.0f}, 18.0f,
         Color::from_rgba8(245, 242, 232));
    draw("Grayscale text at 24 logical px", {64.0f, 164.0f, 420.0f, 36.0f}, 24.0f,
         Color::from_rgba8(245, 242, 232));
    draw("Grayscale text at 36 logical px", {64.0f, 212.0f, 500.0f, 52.0f}, 36.0f,
         Color::from_rgba8(255, 196, 87));
    draw("Wrapped English text uses a boxed Text primitive and keeps shaping/layout separate from "
         "RmlUi.",
         {64.0f, 200.0f, 360.0f, 92.0f}, 22.0f, Color::from_rgba8(212, 230, 255));
    draw("Combining marks: cafe\xCC\x81, A\xCC\x8A, n\xCC\x83", {64.0f, 320.0f, 520.0f, 42.0f},
         24.0f, Color::from_rgba8(176, 224, 188));
    draw("Bidi CPU tests pass; bundled demo font has no Hebrew glyphs",
         {64.0f, 374.0f, 720.0f, 48.0f}, 24.0f, Color::from_rgba8(250, 214, 160));
    draw("Centered boxed text", {500.0f, 64.0f, 300.0f, 44.0f}, 24.0f,
         Color::from_rgba8(160, 214, 250), TextAlign::Center);
    draw("End aligned", {500.0f, 118.0f, 300.0f, 44.0f}, 24.0f, Color::from_rgba8(160, 214, 250),
         TextAlign::End);
    draw("This height-constrained paragraph intentionally overflows after a couple of lines so "
         "clipping and overflow "
         "reporting can be exercised by the layout.",
         {500.0f, 186.0f, 320.0f, 58.0f}, 20.0f, Color::from_rgba8(235, 170, 170));

    Transform2D transform;
    transform.scale = {1.0f + 0.2f * std::sin(time_seconds * 2.0f),
                       1.0f + 0.2f * std::sin(time_seconds * 2.0f)};
    transform.rotation_radians = 0.08f;
    draw("Transformed Text", {500.0f, 330.0f, 360.0f, 60.0f}, 30.0f,
         Color::from_rgba8(190, 170, 245), TextAlign::Start, TextDirection::Auto, transform);
}

} // namespace noveltea
