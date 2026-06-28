#pragma once

#include "noveltea/render/quad_batch.hpp"
#include "noveltea/render/shader.hpp"
#include "noveltea/preview_bridge.hpp"
#include "noveltea/active_text_layout.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/text/font.hpp"
#include "noveltea/text/text.hpp"
#include "noveltea/text/text_lab.hpp"
#include "noveltea/text/text_layout.hpp"
#include "noveltea/surface.hpp"

#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea {

struct ShaderMaterialProject;

namespace bgfx_backend {
class BgfxMaterialBinder;
class BgfxShaderProgramCache;
} // namespace bgfx_backend

struct RendererConfig {
    void* native_display = nullptr;
    void* native_window = nullptr;
    SurfaceMetrics surface{};
    bool vsync = true;
    const char* title = "NovelTea";
    const assets::AssetManager* assets = nullptr;
};

class Renderer {
public:
    Renderer();
    ~Renderer();

    Renderer(const Renderer&) = delete;
    Renderer& operator=(const Renderer&) = delete;

    bool initialize(const RendererConfig& config);
    void begin_frame();
    void end_frame();
    void resize(const SurfaceMetrics& surface);
    void shutdown();
    void request_screenshot(const std::string& path);

    void draw_demo_2d(float time_seconds);
    void draw_demo_text(float time_seconds);
    void draw_preview_triangle(preview_bridge::NormalizedPosition position);
    void draw_2d(const QuadBatch& batch);
    void set_shader_material_project(const ShaderMaterialProject* project);
    void set_shader_standard_inputs(const ShaderStandardInputs& inputs);
    FontHandle load_font(const FontDesc& desc);
    TextLayout layout_text(const Text& text) const;
    TextMetrics measure_text(const Text& text) const;
    void draw_text(const Text& text);
    void draw_text(const TextLayout& layout);
    void draw_text(const TextRun& run);
    void draw_active_text(const ActiveTextLayout& layout);
    TextMetrics measure_text(FontHandle font, std::string_view text, float size) const;

    const char* renderer_name() const;
    const char* texture_status() const { return m_texture_status.c_str(); }
    bool is_initialized() const { return m_initialized; }
    const SurfaceMetrics& surface() const { return m_surface; }
    int logical_width() const { return m_surface.logical_width; }
    int logical_height() const { return m_surface.logical_height; }
    int framebuffer_width() const { return m_surface.framebuffer_width; }
    int framebuffer_height() const { return m_surface.framebuffer_height; }
    float scale_x() const { return m_surface.scale_x; }
    float scale_y() const { return m_surface.scale_y; }
    [[deprecated("Use logical_width()")]] int width() const { return logical_width(); }
    [[deprecated("Use logical_height()")]] int height() const { return logical_height(); }

    // Scissor/clip stack (logical coordinates; converted to framebuffer pixels internally).
    void push_scissor(int16_t x, int16_t y, uint16_t w, uint16_t h);
    void pop_scissor();

    // Draw developer overlay text (rendered in-viewport, not stdout).
    void debug_printf(uint16_t x, uint16_t y, uint8_t color, const char* fmt, ...);

private:
    void create_triangle();
    void destroy_triangle();
    void create_2d();
    void destroy_2d();
    void create_text();
    void destroy_text();
    void resize_text();
    void submit_quad(const QuadCommand& command);
    void submit_default_quad(const QuadCommand& command);
    [[nodiscard]] bool submit_material_quad(const QuadCommand& command);
    uint16_t load_ppm_texture(std::string_view logical_path);

    struct ScissorRect {
        int16_t x = 0, y = 0;
        uint16_t w = 0, h = 0;
        bool active = false;
    };
    ScissorRect current_scissor() const;

    const assets::AssetManager* m_assets = nullptr;
    const ShaderMaterialProject* m_shader_materials = nullptr;
    ShaderStandardInputs m_shader_standard_inputs{};
    bool m_initialized = false;
    bool m_vsync = true;
    SurfaceMetrics m_surface{};

    // Scissor stack (logical coords, pushed at logical coords, converted on pop).
    std::vector<ScissorRect> m_scissor_stack;

    // Backend resource handles (stored as uint16_t indices; UINT16_MAX = invalid).
    uint16_t m_triangle_vb = UINT16_MAX;
    uint16_t m_triangle_ib = UINT16_MAX;
    uint16_t m_triangle_program = UINT16_MAX;
    uint16_t m_quad_program = UINT16_MAX;
    uint16_t m_checker_texture = UINT16_MAX;
    uint16_t m_disk_texture = UINT16_MAX;
    uint16_t m_sampler = UINT16_MAX;
    uint16_t m_use_texture_uniform = UINT16_MAX;
    uint32_t m_default_text_font = 0;
    void* m_text_renderer = nullptr;
    std::unique_ptr<bgfx_backend::BgfxShaderProgramCache> m_shader_program_cache;
    std::unique_ptr<bgfx_backend::BgfxMaterialBinder> m_material_binder;
    std::string m_texture_status = "procedural checker";
    std::string m_pending_screenshot;
};

} // namespace noveltea
