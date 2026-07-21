#include "ui/rmlui/rmlui_host.hpp"

#include "ui/rmlui/rmlui_input_sdl3.hpp"
#include "ui/rmlui/rmlui_render_interface_bgfx.hpp"
#include "ui/rmlui/rmlui_system_interface_sdl3.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>

#include <SDL3/SDL.h>
#include <RmlUi/Core/Core.h>
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
    auto reconfigured = reconfigure_user_settings(m_user_settings);
    if (!reconfigured) {
        for (const auto& diagnostic : reconfigured.error()) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[runtime_ui] resize rejected: %s",
                         diagnostic.message.c_str());
        }
    }
}

core::Result<void, core::Diagnostics>
RmlUiHost::reconfigure_user_settings(const core::RuntimeUserSettings& settings)
{
    const float ui_scale = static_cast<float>(settings.ui_scale());
    const float text_scale = static_cast<float>(settings.text_scale());
    if (!std::isfinite(ui_scale) || ui_scale <= 0.0f || !std::isfinite(text_scale) ||
        text_scale <= 0.0f) {
        return core::Result<void, core::Diagnostics>::failure({{
            .code = "runtime_ui.user_settings_float_range",
            .message =
                "Effective runtime UI and text scales must fit positive finite float values.",
        }});
    }

    auto context_metrics = resolve_context_metrics(m_presentation, ui_scale, true);
    if (!context_metrics) {
        return core::Result<void, core::Diagnostics>::failure({{
            .code = "runtime_ui.context_metrics_invalid",
            .message = context_metrics.error(),
        }});
    }

    const float previous_font_raster_scale = m_context_metrics.font_raster_scale;
    m_user_settings = settings;
    m_context_metrics = std::move(*context_metrics.value_if());
    for (auto& record : m_contexts) {
        record.metrics = m_context_metrics;
        record.context->SetDimensions(
            Rml::Vector2i(record.metrics.layout_size.width, record.metrics.layout_size.height));
        record.context->SetMediaQueryDimensions(Rml::Vector2i(
            record.metrics.media_query_size.width, record.metrics.media_query_size.height));
        record.context->SetDensityIndependentPixelRatio(record.metrics.ui_raster_scale.x);
        record.context->SetTextScaleFactor(text_scale);
        record.context->SetFontRasterScale(record.metrics.font_raster_scale);
    }
    if (!m_contexts.empty() && previous_font_raster_scale != m_context_metrics.font_raster_scale)
        Rml::ReleaseFontRasterResources();
    if (m_system_interface)
        m_system_interface->set_context_projection(m_presentation, m_context_metrics);
    for (auto& renderer : m_plane_renderers)
        if (renderer.bgfx)
            renderer.bgfx->resize(m_presentation, m_context_metrics);
    return core::Result<void, core::Diagnostics>::success();
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

void RmlUiHost::render_contexts(bool world_source_only, bool world_target_only,
                                bool include_debug_plane)
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
        if (!include_debug_plane && record.key.plane == core::PresentationPlane::Debug)
            continue;
        set_context_clock(record.key);
        const auto renderer = std::find_if(m_plane_renderers.begin(), m_plane_renderers.end(),
                                           [&](const PlaneRenderer& value) {
                                               return value.plane == record.key.plane &&
                                                      value.world_transition_source == is_source;
                                           });
        if (renderer != m_plane_renderers.end() && renderer->bgfx)
            renderer->bgfx->configure_context(m_presentation, record.metrics);
        record.context->Render();
        m_rendered_contexts.insert(record.context);
    }
}

void RmlUiHost::render_world_overlay_source() { render_contexts(true, false, true); }

void RmlUiHost::render_world_overlay_target() { render_contexts(false, true, true); }

void RmlUiHost::end_frame(bool include_debug_plane)
{
    render_contexts(false, false, include_debug_plane);
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
