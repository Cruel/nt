#include "ui/rmlui/rmlui_host.hpp"

#include "ui/rmlui/rmlui_input_sdl3.hpp"
#include "ui/rmlui/rmlui_render_interface_bgfx.hpp"

#include <cstdint>

#include <SDL3/SDL.h>
#include <RmlUi/Core/Context.h>
#include <bgfx/bgfx.h>

namespace noveltea::ui::rmlui {

void RmlUiHost::resize(const PresentationMetrics& presentation)
{
    if (!m_contexts.empty()) {
        if (m_pointer_inside) {
            SDL_Event leave{};
            leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
            for (auto& record : m_contexts)
                (void)process_sdl_event(*record.context, m_window, leave);
        }
        for (const std::uint64_t touch_id : m_active_touches) {
            SDL_Event cancel{};
            cancel.type = SDL_EVENT_FINGER_CANCELED;
            cancel.tfinger.fingerID = touch_id;
            for (auto& record : m_contexts)
                (void)process_sdl_event(*record.context, m_window, cancel);
        }
    }
    reset_pointer_state();

    m_surface = sanitize_surface_metrics(presentation.game_surface);
    m_presentation = presentation;
    for (auto& record : m_contexts) {
        record.context->SetDimensions(
            Rml::Vector2i(m_surface.logical_width, m_surface.logical_height));
        record.context->SetDensityIndependentPixelRatio(m_surface.scale_x);
    }
    for (auto& renderer : m_plane_renderers)
        if (renderer.bgfx)
            renderer.bgfx->resize(presentation);
}

void RmlUiHost::begin_frame(const core::RuntimeClockUpdate& clocks)
{
    m_rendered_contexts.clear();
    m_clocks = clocks;
    for (auto& renderer : m_plane_renderers)
        if (renderer.bgfx)
            renderer.bgfx->begin_frame();
}

void RmlUiHost::update_contexts()
{
    for (auto& record : m_contexts) {
        set_context_clock(record.key);
        record.context->Update();
    }
}

void RmlUiHost::set_world_overlay_framebuffers(std::uint16_t source, std::uint16_t target,
                                               bool transition_active)
{
    for (auto& renderer : m_plane_renderers) {
        if (!renderer.bgfx || renderer.plane != core::PresentationPlane::WorldOverlay)
            continue;
        const std::uint16_t handle = renderer.world_transition_source ? source : target;
        const bool local = transition_active && handle != UINT16_MAX;
        bgfx::FrameBufferHandle framebuffer = BGFX_INVALID_HANDLE;
        if (local)
            framebuffer = bgfx::FrameBufferHandle{handle};
        renderer.bgfx->set_output_framebuffer(framebuffer, m_presentation, local);
    }
}

void RmlUiHost::render_contexts(bool world_source_only, bool world_target_only)
{
    for (auto& record : m_contexts) {
        const bool is_world = record.key.plane == core::PresentationPlane::WorldOverlay;
        const bool is_source =
            is_world && record.key.composition_group == kWorldTransitionSourceCompositionGroup;
        if (m_rendered_contexts.contains(record.context))
            continue;
        if (world_source_only && !is_source)
            continue;
        if (world_target_only && (!is_world || is_source))
            continue;
        set_context_clock(record.key);
        record.context->Render();
        m_rendered_contexts.insert(record.context);
    }
}

void RmlUiHost::render_world_overlay_source() { render_contexts(true, false); }

void RmlUiHost::render_world_overlay_target() { render_contexts(false, true); }

void RmlUiHost::end_frame()
{
    render_contexts(false, false);
    for (auto& renderer : m_plane_renderers)
        if (renderer.bgfx)
            renderer.bgfx->end_frame();
}

} // namespace noveltea::ui::rmlui
