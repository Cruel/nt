#include "noveltea/renderer.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "render/bgfx/bgfx_renderer_internal.hpp"
#include "render/bgfx/bgfx_shader_loader.hpp"

#include <bgfx/bgfx.h>
#include <SDL3/SDL_log.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <string_view>
#include <unordered_map>
#include <vector>

#define STB_TRUETYPE_IMPLEMENTATION
#include "third_party/stb_truetype.h"

namespace noveltea {
namespace {

struct TextVertex {
    float x, y;
    float u, v;
    float r, g, b, a;
};

struct Glyph {
    float advance = 0.0f;
    float xoff = 0.0f;
    float yoff = 0.0f;
    float width = 0.0f;
    float height = 0.0f;
    float u0 = 0.0f;
    float v0 = 0.0f;
    float u1 = 0.0f;
    float v1 = 0.0f;
};

struct FontResource {
    bgfx::TextureHandle texture = BGFX_INVALID_HANDLE;
    std::vector<uint8_t> ttf_data;
    stbtt_fontinfo info{};
    Glyph glyphs[96]{};
    float base_pixel_size = 96.0f;
    int sdf_padding = 12;
    uint8_t sdf_onedge_value = 180;
    float sdf_pixel_dist_scale = 24.0f;
    float sdf_min_softness = 0.012f;
    float ascent = 0.0f;
    float descent = 0.0f;
    float line_gap = 0.0f;
    float line_height = 0.0f;
    uint16_t atlas_width = 0;
    uint16_t atlas_height = 0;
};

class BgfxTextRenderer {
public:
    explicit BgfxTextRenderer(const assets::AssetManager& assets) : m_assets(assets) {}
    bool initialize();
    void shutdown();
    FontHandle load_font(const FontDesc& desc);
    void draw_text(const TextRun& run);
    TextMetrics measure(FontHandle font, std::string_view text, float size) const;

private:
    const FontResource* find(FontHandle handle) const;
    FontResource* find(FontHandle handle);

    std::unordered_map<uint32_t, FontResource> m_fonts;
    uint32_t m_next_id = 1;
    bgfx::ProgramHandle m_program = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle m_sampler = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle m_sdf = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle m_outline = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle m_shadow_color = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle m_shadow = BGFX_INVALID_HANDLE;
    const assets::AssetManager& m_assets;
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

bool BgfxTextRenderer::initialize()
{
    m_program = bgfx_backend::BgfxShaderLoader(m_assets).load_program(bgfx_backend::SystemShader::Text);
    if (!bgfx::isValid(m_program)) {
        return false;
    }

    m_sampler = bgfx::createUniform("s_textAtlas", bgfx::UniformType::Sampler);
    m_sdf = bgfx::createUniform("u_textSdf", bgfx::UniformType::Vec4);
    m_outline = bgfx::createUniform("u_textOutlineColor", bgfx::UniformType::Vec4);
    m_shadow_color = bgfx::createUniform("u_textShadowColor", bgfx::UniformType::Vec4);
    m_shadow = bgfx::createUniform("u_textShadow", bgfx::UniformType::Vec4);
    return bgfx::isValid(m_program);
}

void BgfxTextRenderer::shutdown()
{
    for (auto& [id, font] : m_fonts) {
        (void)id;
        if (bgfx::isValid(font.texture)) {
            bgfx::destroy(font.texture);
        }
    }
    m_fonts.clear();
    if (bgfx::isValid(m_shadow)) bgfx::destroy(m_shadow);
    if (bgfx::isValid(m_shadow_color)) bgfx::destroy(m_shadow_color);
    if (bgfx::isValid(m_outline)) bgfx::destroy(m_outline);
    if (bgfx::isValid(m_sdf)) bgfx::destroy(m_sdf);
    if (bgfx::isValid(m_sampler)) bgfx::destroy(m_sampler);
    if (bgfx::isValid(m_program)) bgfx::destroy(m_program);
    m_shadow = BGFX_INVALID_HANDLE;
    m_shadow_color = BGFX_INVALID_HANDLE;
    m_outline = BGFX_INVALID_HANDLE;
    m_sdf = BGFX_INVALID_HANDLE;
    m_sampler = BGFX_INVALID_HANDLE;
    m_program = BGFX_INVALID_HANDLE;
}

FontHandle BgfxTextRenderer::load_font(const FontDesc& desc)
{
    FontResource font;
    const std::string requested_path = desc.asset_path.generic_string();
    const std::string logical_path = requested_path.find(":/") == std::string::npos
        ? "project:/" + requested_path
        : requested_path;
    auto bytes = m_assets.read_binary(logical_path);
    if (bytes) {
        font.ttf_data = std::move(bytes.value->bytes);
    }
    if (font.ttf_data.empty() || !stbtt_InitFont(&font.info, font.ttf_data.data(), 0)) {
        std::fprintf(stderr, "[text] failed to load font: %s (%s)\n", logical_path.c_str(), bytes.error.c_str());
        return {};
    }

    font.base_pixel_size = std::max(desc.base_pixel_size, 1.0f);
    font.atlas_width = std::max<uint16_t>(desc.atlas_width, 64);
    font.atlas_height = std::max<uint16_t>(desc.atlas_height, 64);
    font.sdf_padding = std::max(desc.sdf_padding, 1);
    font.sdf_onedge_value = desc.sdf_onedge_value;
    font.sdf_pixel_dist_scale = std::max(desc.sdf_pixel_dist_scale, 1.0f);
    font.sdf_min_softness = std::max(desc.sdf_min_softness, 0.0005f);
    const float scale = stbtt_ScaleForPixelHeight(&font.info, font.base_pixel_size);
    int ascent = 0;
    int descent = 0;
    int line_gap = 0;
    stbtt_GetFontVMetrics(&font.info, &ascent, &descent, &line_gap);
    font.ascent = static_cast<float>(ascent) * scale;
    font.descent = static_cast<float>(descent) * scale;
    font.line_gap = static_cast<float>(line_gap) * scale;
    font.line_height = font.ascent - font.descent + font.line_gap;

    std::vector<uint8_t> atlas(static_cast<size_t>(font.atlas_width) * font.atlas_height * 4, 0);
    int pen_x = 1;
    int pen_y = 1;
    int row_h = 0;

    for (int cp = 32; cp <= 127; ++cp) {
        int glyph_w = 0;
        int glyph_h = 0;
        int xoff = 0;
        int yoff = 0;
        unsigned char* sdf = stbtt_GetCodepointSDF(
            &font.info,
            scale,
            cp,
            font.sdf_padding,
            font.sdf_onedge_value,
            font.sdf_pixel_dist_scale,
            &glyph_w,
            &glyph_h,
            &xoff,
            &yoff);
        if (!sdf) {
            continue;
        }
        if (pen_x + glyph_w + 1 >= font.atlas_width) {
            pen_x = 1;
            pen_y += row_h + 1;
            row_h = 0;
        }
        if (pen_y + glyph_h + 1 >= font.atlas_height) {
            stbtt_FreeSDF(sdf, nullptr);
            std::fprintf(stderr, "[text] font atlas full: %s\n", logical_path.c_str());
            return {};
        }

        for (int y = 0; y < glyph_h; ++y) {
            for (int x = 0; x < glyph_w; ++x) {
                const size_t dst = (static_cast<size_t>(pen_y + y) * font.atlas_width + static_cast<size_t>(pen_x + x)) * 4;
                atlas[dst + 0] = 255;
                atlas[dst + 1] = 255;
                atlas[dst + 2] = 255;
                atlas[dst + 3] = sdf[y * glyph_w + x];
            }
        }

        int advance = 0;
        int lsb = 0;
        stbtt_GetCodepointHMetrics(&font.info, cp, &advance, &lsb);
        Glyph& glyph = font.glyphs[cp - 32];
        glyph.advance = static_cast<float>(advance) * scale;
        glyph.xoff = static_cast<float>(xoff);
        glyph.yoff = static_cast<float>(yoff);
        glyph.width = static_cast<float>(glyph_w);
        glyph.height = static_cast<float>(glyph_h);
        glyph.u0 = static_cast<float>(pen_x) / font.atlas_width;
        glyph.v0 = static_cast<float>(pen_y) / font.atlas_height;
        glyph.u1 = static_cast<float>(pen_x + glyph_w) / font.atlas_width;
        glyph.v1 = static_cast<float>(pen_y + glyph_h) / font.atlas_height;

        pen_x += glyph_w + 1;
        row_h = std::max(row_h, glyph_h);
        stbtt_FreeSDF(sdf, nullptr);
    }

    font.texture = bgfx::createTexture2D(
        font.atlas_width,
        font.atlas_height,
        false,
        1,
        bgfx::TextureFormat::RGBA8,
        BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP,
        bgfx::copy(atlas.data(), static_cast<uint32_t>(atlas.size())));
    if (!bgfx::isValid(font.texture)) {
        return {};
    }

    const uint32_t id = m_next_id++;
    m_fonts.emplace(id, std::move(font));
    return FontHandle{id};
}

const FontResource* BgfxTextRenderer::find(FontHandle handle) const
{
    auto it = m_fonts.find(handle.id);
    return it == m_fonts.end() ? nullptr : &it->second;
}

FontResource* BgfxTextRenderer::find(FontHandle handle)
{
    auto it = m_fonts.find(handle.id);
    return it == m_fonts.end() ? nullptr : &it->second;
}

TextMetrics BgfxTextRenderer::measure(FontHandle handle, std::string_view text, float size) const
{
    const FontResource* font = find(handle);
    if (!font) return {};

    const float scale = size / font->base_pixel_size;
    float line_width = 0.0f;
    float max_width = 0.0f;
    uint32_t lines = 1;
    for (unsigned char ch : text) {
        if (ch == '\n') {
            max_width = std::max(max_width, line_width);
            line_width = 0.0f;
            ++lines;
            continue;
        }
        if (ch < 32 || ch > 127) {
            ch = '?';
        }
        line_width += font->glyphs[ch - 32].advance * scale;
    }
    max_width = std::max(max_width, line_width);
    return {max_width, font->line_height * scale * static_cast<float>(lines), font->line_height * scale, lines};
}

void BgfxTextRenderer::draw_text(const TextRun& run)
{
    const FontResource* font = find(run.font);
    if (!font || !bgfx::isValid(m_program) || run.text.empty()) {
        return;
    }

    const float scale = run.style.size / font->base_pixel_size;
    const float inv_w = 1.0f / static_cast<float>(font->atlas_width);
    const float inv_h = 1.0f / static_cast<float>(font->atlas_height);
    float x = run.position.x;
    float y = run.position.y + font->ascent * scale;
    std::vector<TextVertex> vertices;
    std::vector<uint16_t> indices;
    vertices.reserve(run.text.size() * 4);
    indices.reserve(run.text.size() * 6);

    for (unsigned char ch : run.text) {
        if (ch == '\n') {
            x = run.position.x;
            y += font->line_height * scale;
            continue;
        }
        if (ch < 32 || ch > 127) {
            ch = '?';
        }
        const Glyph& glyph = font->glyphs[ch - 32];
        if (glyph.width <= 0.0f || glyph.height <= 0.0f) {
            x += glyph.advance * scale;
            continue;
        }

        const float x0 = x + glyph.xoff * scale;
        const float y0 = y + glyph.yoff * scale;
        const float x1 = x0 + glyph.width * scale;
        const float y1 = y0 + glyph.height * scale;
        const uint16_t base = static_cast<uint16_t>(vertices.size());
        const Color color = run.style.color;
        const float alpha = effective_alpha(run.style);
        const Vec2 p0 = transform_point({x0, y0}, run.position, run.transform);
        const Vec2 p1 = transform_point({x1, y0}, run.position, run.transform);
        const Vec2 p2 = transform_point({x1, y1}, run.position, run.transform);
        const Vec2 p3 = transform_point({x0, y1}, run.position, run.transform);
        vertices.push_back({p0.x, p0.y, glyph.u0, glyph.v0, color.r, color.g, color.b, alpha});
        vertices.push_back({p1.x, p1.y, glyph.u1, glyph.v0, color.r, color.g, color.b, alpha});
        vertices.push_back({p2.x, p2.y, glyph.u1, glyph.v1, color.r, color.g, color.b, alpha});
        vertices.push_back({p3.x, p3.y, glyph.u0, glyph.v1, color.r, color.g, color.b, alpha});
        indices.insert(indices.end(), {base, static_cast<uint16_t>(base + 1), static_cast<uint16_t>(base + 2), base, static_cast<uint16_t>(base + 2), static_cast<uint16_t>(base + 3)});
        x += glyph.advance * scale;
    }

    if (vertices.empty()) {
        return;
    }

    bgfx::VertexLayout layout;
    layout.begin()
        .add(bgfx::Attrib::Position, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::TexCoord0, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::Color0, 4, bgfx::AttribType::Float)
        .end();
    bgfx::TransientVertexBuffer tvb;
    bgfx::TransientIndexBuffer tib;
    if (!bgfx::allocTransientBuffers(&tvb, layout, static_cast<uint32_t>(vertices.size()), &tib, static_cast<uint32_t>(indices.size()))) {
        return;
    }
    std::memcpy(tvb.data, vertices.data(), vertices.size() * sizeof(TextVertex));
    std::memcpy(tib.data, indices.data(), indices.size() * sizeof(uint16_t));

    const float sdf[] = {
        static_cast<float>(font->sdf_onedge_value) / 255.0f,
        font->sdf_min_softness,
        std::clamp(run.style.outline_width / std::max(run.style.size, 1.0f), 0.0f, 0.35f),
        0.0f,
    };
    const float outline[] = {run.style.outline_color.r, run.style.outline_color.g, run.style.outline_color.b, run.style.outline_color.a};
    const float shadow_color[] = {run.style.drop_shadow_color.r, run.style.drop_shadow_color.g, run.style.drop_shadow_color.b, run.style.drop_shadow_color.a};
    const float shadow[] = {run.style.drop_shadow_offset.x * inv_w, run.style.drop_shadow_offset.y * inv_h, run.style.drop_shadow_softener / std::max(run.style.size, 1.0f), 0.0f};
    bgfx::setUniform(m_sdf, sdf);
    bgfx::setUniform(m_outline, outline);
    bgfx::setUniform(m_shadow_color, shadow_color);
    bgfx::setUniform(m_shadow, shadow);
    bgfx::setTexture(0, m_sampler, font->texture);
    bgfx::setVertexBuffer(0, &tvb);
    bgfx::setIndexBuffer(&tib);
    bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A | BGFX_STATE_BLEND_ALPHA);
    bgfx::submit(bgfx_backend::ViewTextLab, m_program);
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
    desc.base_pixel_size = 96.0f;
    desc.sdf = true;
    desc.atlas_width = 1024;
    desc.atlas_height = 1024;
    desc.sdf_padding = 12;
    desc.sdf_onedge_value = 180;
    desc.sdf_pixel_dist_scale = 24.0f;
    desc.sdf_min_softness = 0.012f;
    m_default_text_font = text->load_font(desc).id;
    SDL_Log("[text] bgfx SDF text renderer initialized");
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

void Renderer::draw_text(const TextRun& run)
{
    auto* text = static_cast<BgfxTextRenderer*>(m_text_renderer);
    if (text) {
        text->draw_text(run);
    }
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
    (void)time_seconds;
    const FontHandle font{m_default_text_font};
    draw_text(TextRun{
        "Plain SDF quality sample 18 px",
        font,
        {64.0f, 46.0f},
        TextStyle{18.0f, Color::from_rgba8(245, 242, 232), 1.0f},
    });
    draw_text(TextRun{
        "Plain SDF quality sample 24 px",
        font,
        {64.0f, 84.0f},
        TextStyle{24.0f, Color::from_rgba8(245, 242, 232), 1.0f},
    });
    draw_text(TextRun{
        "Plain SDF quality sample 32 px",
        font,
        {64.0f, 132.0f},
        TextStyle{32.0f, Color::from_rgba8(245, 242, 232), 1.0f},
    });
    draw_text(TextRun{
        "Plain SDF quality sample 48 px",
        font,
        {64.0f, 194.0f},
        TextStyle{48.0f, Color::from_rgba8(245, 242, 232), 1.0f},
    });
    draw_text(TextRun{
        "Plain SDF quality 72 px",
        font,
        {64.0f, 284.0f},
        TextStyle{72.0f, Color::from_rgba8(245, 242, 232), 1.0f},
    });
    draw_text(TextRun{
        "scaled and rotated SDF sample",
        font,
        {600.0f, 128.0f},
        TextStyle{32.0f, Color::from_rgba8(136, 206, 250), 1.0f},
        Transform2D{{0.0f, 0.0f}, {1.35f, 1.35f}, 0.13f},
    });
    draw_text(TextRun{
        "outline/drop shadow sample",
        font,
        {64.0f, 390.0f},
        TextStyle{34.0f, Color::from_rgba8(255, 196, 87), 1.0f, Color::from_rgba8(20, 24, 31), 2.0f, Color::from_rgba8(0, 0, 0, 150), {3.0f, 3.0f}, 1.5f},
    });
}

} // namespace noveltea
