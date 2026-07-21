#pragma once

#include "noveltea/render/quad_batch.hpp"
#include "noveltea/render/rasterization_policy.hpp"
#include "noveltea/render/shader.hpp"
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
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea {

struct ShaderMaterialProject;

enum class WorldCompositionPass : std::uint8_t {
    Ordinary,
    Source,
    Target,
    GameUiUnderlay,
};

namespace bgfx_backend {
class BgfxMaterialBinder;
class BgfxShaderProgramCache;
class BgfxTypedAssetLoader;
} // namespace bgfx_backend

struct RendererConfig {
    void* native_display = nullptr;
    void* native_window = nullptr;
    PresentationMetrics presentation{};
    std::uint32_t bar_color_rgba = 0x000000ff;
    bool vsync = true;
    const char* title = "NovelTea";
    const assets::AssetManager* assets = nullptr;
};

struct RendererScreenshotCapture {
    std::uint64_t request_id = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::string png_bytes;
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
    void resize(const PresentationMetrics& presentation);
    void shutdown();
    void request_screenshot(const std::string& path);
    [[nodiscard]] bool request_screenshot_capture(std::uint64_t request_id);
    [[nodiscard]] std::optional<RendererScreenshotCapture> take_screenshot_capture();

    void draw_2d(const QuadBatch& batch);
    void draw_world_2d(const QuadBatch& batch, WorldCompositionPass pass, float opacity = 1.0f);
    void composite_ordinary_world_surface();
    [[nodiscard]] bool prepare_world_transition_surfaces();
    void composite_world_surface(WorldCompositionPass pass, float opacity = 1.0f);
    [[nodiscard]] std::uint16_t world_transition_framebuffer(WorldCompositionPass pass) const;
    void draw_fullscreen_color(Color color);
    void set_shader_material_project(const ShaderMaterialProject* project);
    void set_shader_standard_inputs(const ShaderStandardInputs& inputs);
    void set_bar_color(std::uint32_t bar_color_rgba) { m_bar_color_rgba = bar_color_rgba; }
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
    const PresentationMetrics& presentation() const { return m_presentation; }
    const ReferenceFrameMetrics& reference_frame() const { return m_presentation.reference; }
    const WorldRasterMetrics& world_raster() const { return m_presentation.world_raster; }
    const UiRasterMetrics& ui_raster() const { return m_presentation.ui_raster; }
    int reference_width() const { return reference_frame().size.width; }
    int reference_height() const { return reference_frame().size.height; }
    int ui_raster_width() const { return ui_raster().size.width; }
    int ui_raster_height() const { return ui_raster().size.height; }
    float reference_to_ui_raster_scale_x() const
    {
        return static_cast<float>(ui_raster_width()) / reference_width();
    }
    float reference_to_ui_raster_scale_y() const
    {
        return static_cast<float>(ui_raster_height()) / reference_height();
    }

    // Scissor/clip stack (logical coordinates; converted to framebuffer pixels internally).
    void push_scissor(int16_t x, int16_t y, uint16_t w, uint16_t h);
    void pop_scissor();

    // Draw developer overlay text (rendered in-viewport, not stdout).
    void debug_printf(uint16_t x, uint16_t y, uint8_t color, const char* fmt, ...);

private:
    void create_2d();
    void destroy_2d();
    [[nodiscard]] bool prepare_ordinary_world_surface();
    void configure_ordinary_world_surface();
    void destroy_ordinary_world_surface();
    void destroy_world_transition_surfaces();
    void create_text();
    void destroy_text();
    void resize_text();
    void submit_quad(const QuadCommand& command);
    void submit_quad(const QuadCommand& command, std::uint16_t view, float opacity);
    void submit_default_quad(const QuadCommand& command);
    void submit_default_quad(const QuadCommand& command, std::uint16_t view);
    [[nodiscard]] bool submit_material_quad(const QuadCommand& command);
    [[nodiscard]] bool submit_material_quad(const QuadCommand& command, std::uint16_t view);

    struct ScissorRect {
        int16_t x = 0, y = 0;
        uint16_t w = 0, h = 0;
        bool active = false;
    };
    ScissorRect current_scissor() const;
    RasterScissor current_ui_raster_scissor() const;

    const assets::AssetManager* m_assets = nullptr;
    const ShaderMaterialProject* m_shader_materials = nullptr;
    ShaderStandardInputs m_shader_standard_inputs{};
    bool m_initialized = false;
    bool m_vsync = true;
    PresentationMetrics m_presentation{};
    std::uint32_t m_bar_color_rgba = 0x000000ff;

    // Scissor stack (logical coords, pushed at logical coords, converted on pop).
    std::vector<ScissorRect> m_scissor_stack;

    // Backend resource handles (stored as uint16_t indices; UINT16_MAX = invalid).
    uint16_t m_quad_program = UINT16_MAX;
    uint16_t m_checker_texture = UINT16_MAX;
    uint16_t m_sampler = UINT16_MAX;
    uint16_t m_use_texture_uniform = UINT16_MAX;
    uint16_t m_world_color_texture = UINT16_MAX;
    uint16_t m_world_color_framebuffer = UINT16_MAX;
    uint16_t m_world_color_width = 0;
    uint16_t m_world_color_height = 0;
    WorldRasterPolicy m_world_color_policy = WorldRasterPolicy::Capped;
    uint16_t m_world_source_texture = UINT16_MAX;
    uint16_t m_world_source_framebuffer = UINT16_MAX;
    uint16_t m_world_target_texture = UINT16_MAX;
    uint16_t m_world_target_framebuffer = UINT16_MAX;
    uint16_t m_world_surface_width = 0;
    uint16_t m_world_surface_height = 0;
    uint32_t m_default_text_font = 0;
    void* m_text_renderer = nullptr;
    std::unique_ptr<bgfx_backend::BgfxShaderProgramCache> m_shader_program_cache;
    std::unique_ptr<bgfx_backend::BgfxTypedAssetLoader> m_typed_asset_loader;
    std::unique_ptr<bgfx_backend::BgfxMaterialBinder> m_material_binder;
    std::string m_texture_status = "procedural checker";
    std::string m_pending_screenshot;
    std::optional<std::uint64_t> m_pending_screenshot_capture;
    std::optional<std::uint64_t> m_outstanding_screenshot_capture;
};

} // namespace noveltea
