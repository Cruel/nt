#include "noveltea/renderer.hpp"

#include "render/bgfx/bgfx_renderer_internal.hpp"
#include "render/bgfx/bgfx_shader_loader.hpp"
#include "text/text_engine.hpp"

#include <SDL3/SDL_log.h>
#include <bgfx/bgfx.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <unordered_map>
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

    [[nodiscard]] friend bool operator==(const GlyphCacheKey&, const GlyphCacheKey&) = default;
};

struct GlyphCacheKeyHash {
    std::size_t operator()(const GlyphCacheKey& key) const
    {
        uint64_t value = key.font;
        value = value * 1315423911u + key.glyph_id;
        value = value * 1315423911u + key.pixel_size;
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

float effective_alpha(const TextStyle& style)
{
    return std::clamp(style.color.a * style.alpha, 0.0f, 1.0f);
}

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
    explicit BgfxTextRenderer(const assets::AssetManager& assets) : m_assets(assets), m_text(assets), m_packer(1024, 1024, kGlyphPadding) {}
    bool initialize();
    void shutdown();
    FontHandle load_font(const FontDesc& desc) { return m_text.load_font(desc); }
    TextLayout layout_text(const Text& text) const { return m_text.layout_text(text); }
    TextMetrics measure(const Text& text) const { return m_text.measure_text(text); }
    TextMetrics measure(FontHandle font, std::string_view value, float size) const { return m_text.measure_text(font, value, size); }
    void draw_text(const Text& text) { draw_text(m_text.layout_text(text)); }
    void draw_text(const TextLayout& layout);

private:
    CachedGlyph* ensure_glyph(const PositionedGlyph& glyph);
    bgfx::TextureHandle ensure_page(uint16_t page);

    const assets::AssetManager& m_assets;
    text::TextEngine m_text;
    text::ShelfAtlasPacker m_packer;
    std::vector<AtlasPage> m_pages;
    std::unordered_map<GlyphCacheKey, CachedGlyph, GlyphCacheKeyHash> m_glyphs;
    bgfx::ProgramHandle m_program = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle m_sampler = BGFX_INVALID_HANDLE;
    static constexpr uint16_t kGlyphPadding = 1;
};

bool BgfxTextRenderer::initialize()
{
    if (!m_text.valid()) {
        return false;
    }
    m_program = bgfx_backend::BgfxShaderLoader(m_assets).load_program(bgfx_backend::SystemShader::Text);
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

bgfx::TextureHandle BgfxTextRenderer::ensure_page(uint16_t page_index)
{
    while (m_pages.size() <= page_index) {
        AtlasPage page;
        std::vector<uint8_t> zeroes(static_cast<size_t>(m_packer.width()) * m_packer.height() * 4u, 0);
        page.texture = bgfx::createTexture2D(
            m_packer.width(),
            m_packer.height(),
            false,
            1,
            bgfx::TextureFormat::RGBA8,
            BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP,
            nullptr);
        if (bgfx::isValid(page.texture)) {
            bgfx::updateTexture2D(
                page.texture,
                0,
                0,
                0,
                0,
                m_packer.width(),
                m_packer.height(),
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
    key.pixel_size = text::glyph_cache_pixel_size_key(glyph.pixel_size);
    auto found = m_glyphs.find(key);
    if (found != m_glyphs.end()) {
        return &found->second;
    }

    auto bitmap = m_text.rasterize_glyph(glyph.font, glyph.glyph_id, glyph.pixel_size);
    if (!bitmap) {
        return nullptr;
    }
    const auto rect = m_packer.add(static_cast<uint16_t>(bitmap->width), static_cast<uint16_t>(bitmap->height));
    bgfx::TextureHandle texture = ensure_page(rect.page);
    if (!bgfx::isValid(texture)) {
        return nullptr;
    }

    if (bitmap->width > 0 && bitmap->height > 0) {
        const auto upload = text::make_padded_glyph_upload(*bitmap, kGlyphPadding);
        bgfx::updateTexture2D(
            texture,
            0,
            0,
            static_cast<uint16_t>(rect.x - upload.glyph_x),
            static_cast<uint16_t>(rect.y - upload.glyph_y),
            upload.width,
            upload.height,
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
                if (!glyph || glyph->width <= 0.0f || glyph->height <= 0.0f) {
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

                const float x0 = positioned.position.x + positioned.offset.x + glyph->bearing_x;
                const float y0 = positioned.position.y + positioned.offset.y - glyph->bearing_y;
                const float x1 = x0 + glyph->width;
                const float y1 = y0 + glyph->height;
                const uint16_t base = static_cast<uint16_t>(vertices.size());
                const Vec2 p0 = transform_point({x0, y0}, origin, layout.transform);
                const Vec2 p1 = transform_point({x1, y0}, origin, layout.transform);
                const Vec2 p2 = transform_point({x1, y1}, origin, layout.transform);
                const Vec2 p3 = transform_point({x0, y1}, origin, layout.transform);
                vertices.push_back({p0.x, p0.y, glyph->u0, glyph->v0, color.r, color.g, color.b, alpha});
                vertices.push_back({p1.x, p1.y, glyph->u1, glyph->v0, color.r, color.g, color.b, alpha});
                vertices.push_back({p2.x, p2.y, glyph->u1, glyph->v1, color.r, color.g, color.b, alpha});
                vertices.push_back({p3.x, p3.y, glyph->u0, glyph->v1, color.r, color.g, color.b, alpha});
                indices.insert(indices.end(), {base, static_cast<uint16_t>(base + 1), static_cast<uint16_t>(base + 2), base, static_cast<uint16_t>(base + 2), static_cast<uint16_t>(base + 3)});
            }
        }
    }
    bgfx::VertexLayout vertex_layout;
    vertex_layout.begin()
        .add(bgfx::Attrib::Position, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::TexCoord0, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::Color0, 4, bgfx::AttribType::Float)
        .end();

    const uint16_t scissor = (layout.bounds.width > 0.0f && layout.bounds.height > 0.0f)
        ? bgfx::setScissor(
            static_cast<uint16_t>(std::max(0.0f, layout.bounds.x)),
            static_cast<uint16_t>(std::max(0.0f, layout.bounds.y)),
            static_cast<uint16_t>(std::max(0.0f, layout.bounds.width)),
            static_cast<uint16_t>(std::max(0.0f, layout.bounds.height)))
        : UINT16_MAX;

    for (size_t page_index = 0; page_index < page_vertices.size(); ++page_index) {
        const auto& vertices = page_vertices[page_index];
        const auto& indices = page_indices[page_index];
        if (vertices.empty() || indices.empty() || page_index >= m_pages.size() || !bgfx::isValid(m_pages[page_index].texture)) {
            continue;
        }
        bgfx::TransientVertexBuffer tvb;
        bgfx::TransientIndexBuffer tib;
        if (!bgfx::allocTransientBuffers(&tvb, vertex_layout, static_cast<uint32_t>(vertices.size()), &tib, static_cast<uint32_t>(indices.size()))) {
            continue;
        }
        std::memcpy(tvb.data, vertices.data(), vertices.size() * sizeof(TextVertex));
        std::memcpy(tib.data, indices.data(), indices.size() * sizeof(uint16_t));
        if (scissor != UINT16_MAX) {
            bgfx::setScissor(scissor);
        }
        const float identity[16] = {
            1.0f, 0.0f, 0.0f, 0.0f,
            0.0f, 1.0f, 0.0f, 0.0f,
            0.0f, 0.0f, 1.0f, 0.0f,
            0.0f, 0.0f, 0.0f, 1.0f,
        };
        bgfx::setTransform(identity);
        bgfx::setTexture(0, m_sampler, m_pages[page_index].texture);
        bgfx::setVertexBuffer(0, &tvb);
        bgfx::setIndexBuffer(&tib);
        bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A | BGFX_STATE_BLEND_ALPHA);
        bgfx::submit(bgfx_backend::ViewTextLab, m_program);
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
    if (!text->initialize()) {
        delete text;
        m_text_renderer = nullptr;
        std::fprintf(stderr, "[text] failed to initialize bgfx text renderer\n");
        return;
    }
    m_text_renderer = text;

    FontDesc desc;
    desc.asset_path = "project:/rmlui/LiberationSans.ttf";
    m_default_text_font = text->load_font(desc).id;
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

void Renderer::draw_text(const TextRun& run)
{
    draw_text(to_text(run));
}

TextMetrics Renderer::measure_text(FontHandle font, std::string_view text_value, float size) const
{
    auto* text = static_cast<const BgfxTextRenderer*>(m_text_renderer);
    return text ? text->measure(font, text_value, size) : TextMetrics{};
}

void Renderer::draw_demo_text(float time_seconds)
{
    if (!m_initialized || m_default_text_font == 0) {
        return;
    }
    const FontHandle font{m_default_text_font};

    auto draw = [&](std::string value, Rect bounds, float size, Color color, TextAlign align = TextAlign::Start, TextDirection direction = TextDirection::Auto, Transform2D transform = {}) {
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

    draw("Grayscale text at 18 px", {64.0f, 40.0f, 360.0f, 30.0f}, 18.0f, Color::from_rgba8(245, 242, 232));
    draw("Grayscale text at 24 px", {64.0f, 78.0f, 360.0f, 36.0f}, 24.0f, Color::from_rgba8(245, 242, 232));
    draw("Grayscale text at 36 px", {64.0f, 126.0f, 420.0f, 52.0f}, 36.0f, Color::from_rgba8(255, 196, 87));
    draw("Wrapped English text uses a boxed Text primitive and keeps shaping/layout separate from RmlUi.", {64.0f, 200.0f, 360.0f, 92.0f}, 22.0f, Color::from_rgba8(212, 230, 255));
    draw("Combining marks: cafe\xCC\x81, A\xCC\x8A, n\xCC\x83", {64.0f, 320.0f, 520.0f, 42.0f}, 24.0f, Color::from_rgba8(176, 224, 188));
    draw("Bidi CPU tests pass; bundled demo font has no Hebrew glyphs", {64.0f, 374.0f, 720.0f, 48.0f}, 24.0f, Color::from_rgba8(250, 214, 160));
    draw("Centered boxed text", {500.0f, 64.0f, 300.0f, 44.0f}, 24.0f, Color::from_rgba8(160, 214, 250), TextAlign::Center);
    draw("End aligned", {500.0f, 118.0f, 300.0f, 44.0f}, 24.0f, Color::from_rgba8(160, 214, 250), TextAlign::End);
    draw("This height-constrained paragraph intentionally overflows after a couple of lines so clipping and overflow reporting can be exercised by the layout.", {500.0f, 186.0f, 320.0f, 58.0f}, 20.0f, Color::from_rgba8(235, 170, 170));

    Transform2D transform;
    transform.scale = {1.0f + 0.2f * std::sin(time_seconds * 2.0f), 1.0f + 0.2f * std::sin(time_seconds * 2.0f)};
    transform.rotation_radians = 0.08f;
    draw("Transformed Text", {500.0f, 330.0f, 360.0f, 60.0f}, 30.0f, Color::from_rgba8(190, 170, 245), TextAlign::Start, TextDirection::Auto, transform);
}

} // namespace noveltea
