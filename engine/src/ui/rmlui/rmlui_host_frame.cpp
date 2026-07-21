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
            for (auto& record : m_contexts) {
                set_context_clock(record.key);
                (void)process_sdl_event(*record.context, m_window, leave);
            }
        }
        for (const std::uint64_t touch_id : m_active_touches) {
            SDL_Event cancel{};
            cancel.type = SDL_EVENT_FINGER_CANCELED;
            cancel.tfinger.fingerID = touch_id;
            for (auto& record : m_contexts) {
                set_context_clock(record.key);
                (void)process_sdl_event(*record.context, m_window, cancel);
            }
        }
    }
    reset_pointer_state();

    m_presentation = presentation;
    auto context_metrics = resolve_context_metrics(m_presentation, 1.0f, true);
    if (!context_metrics) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[runtime_ui] resize rejected: %s",
                     context_metrics.error().c_str());
        return;
    }
    m_context_metrics = std::move(*context_metrics.value_if());
    for (auto& record : m_contexts) {
        record.metrics = m_context_metrics;
        record.context->SetDimensions(
            Rml::Vector2i(record.metrics.layout_size.width, record.metrics.layout_size.height));
        record.context->SetMediaQueryDimensions(Rml::Vector2i(
            record.metrics.media_query_size.width, record.metrics.media_query_size.height));
        record.context->SetDensityIndependentPixelRatio(record.metrics.ui_raster_scale.x);
        record.context->SetTextScaleFactor(1.0f);
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

void RmlUiHost::set_postprocess_framebuffers(std::uint16_t world, std::uint16_t full_game)
{
    m_world_postprocess_framebuffer = world;
    m_full_game_postprocess_framebuffer = full_game;
    for (auto& renderer : m_plane_renderers) {
        if (!renderer.bgfx)
            continue;
        std::uint16_t handle = UINT16_MAX;
        if (renderer.plane == core::PresentationPlane::WorldOverlay) {
            handle = world != UINT16_MAX ? world : full_game;
        } else if (renderer.plane != core::PresentationPlane::Debug) {
            handle = full_game;
        }
        const bool local = handle != UINT16_MAX;
        bgfx::FrameBufferHandle framebuffer = BGFX_INVALID_HANDLE;
        if (local)
            framebuffer = bgfx::FrameBufferHandle{handle};
        renderer.bgfx->set_output_framebuffer(framebuffer, m_presentation, local);
    }
}

void RmlUiHost::set_world_overlay_framebuffers(std::uint16_t source, std::uint16_t target,
                                               bool transition_active)
{
    m_world_transition_active = transition_active;
    m_world_transition_source_enabled = transition_active && source != UINT16_MAX;
    m_world_transition_target_enabled = transition_active && target != UINT16_MAX;
    for (auto& renderer : m_plane_renderers) {
        if (!renderer.bgfx || renderer.plane != core::PresentationPlane::WorldOverlay)
            continue;
        std::uint16_t handle = renderer.world_transition_source ? source : target;
        if (!transition_active)
            handle = m_world_postprocess_framebuffer != UINT16_MAX
                         ? m_world_postprocess_framebuffer
                         : m_full_game_postprocess_framebuffer;
        const bool local = handle != UINT16_MAX;
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
        const bool is_source = is_world && record.key.composition_group ==
                                               host::kWorldTransitionSourceCompositionGroup;
        if (m_rendered_contexts.contains(record.context))
            continue;
        if (m_world_transition_active && is_world) {
            const bool enabled =
                is_source ? m_world_transition_source_enabled : m_world_transition_target_enabled;
            if (!enabled)
                continue;
        }
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

void RmlUiHost::reset_backend_state()
{
    reset_pointer_state();
    m_rendered_contexts.clear();
    m_world_transition_active = false;
    m_world_transition_source_enabled = false;
    m_world_transition_target_enabled = false;
    m_world_postprocess_framebuffer = UINT16_MAX;
    m_full_game_postprocess_framebuffer = UINT16_MAX;
}

} // namespace noveltea::ui::rmlui
