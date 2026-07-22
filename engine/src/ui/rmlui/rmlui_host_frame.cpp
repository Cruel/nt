#include "ui/rmlui/rmlui_host.hpp"

#include "ui/rmlui/rmlui_input_sdl3.hpp"
#include "ui/rmlui/rmlui_render_interface_bgfx.hpp"
#include "ui/rmlui/rmlui_system_interface_sdl3.hpp"

#include <algorithm>
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

    auto reconfigured = reconfigure_context_environment(presentation, m_user_settings, true);
    if (!reconfigured) {
        for (const auto& diagnostic : reconfigured.error()) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[runtime_ui] resize rejected: %s",
                         diagnostic.message.c_str());
        }
    }
}

core::Result<void, core::Diagnostics>
RmlUiHost::reconfigure_environment(const PresentationMetrics& presentation,
                                   const core::RuntimeUserSettings& settings)
{
    return reconfigure_context_environment(presentation, settings, true);
}

core::Result<void, core::Diagnostics>
RmlUiHost::reconfigure_user_settings(const core::RuntimeUserSettings& settings)
{
    return reconfigure_context_environment(m_presentation, settings, false);
}

core::Result<void, core::Diagnostics>
RmlUiHost::reconfigure_context_environment(const PresentationMetrics& presentation,
                                           const core::RuntimeUserSettings& settings,
                                           bool force_media_query_refresh)
{
    const ContextKey default_key{core::PresentationPlane::GameUi, 0,
                                 core::LayoutClockDomain::Gameplay, core::LayoutInputMode::Normal,
                                 core::MountedLayoutOwner::Gameplay};
    auto default_metrics = resolve_context_environment(default_key, presentation, settings);
    if (!default_metrics) {
        return core::Result<void, core::Diagnostics>::failure({{
            .code = "runtime_ui.context_metrics_invalid",
            .message = default_metrics.error(),
        }});
    }

    std::vector<ResolvedContextMetrics> staged_metrics;
    staged_metrics.reserve(m_contexts.size());
    bool release_font_raster_resources = false;
    for (const auto& record : m_contexts) {
        auto resolved = resolve_context_environment(record.key, presentation, settings);
        if (!resolved) {
            return core::Result<void, core::Diagnostics>::failure({{
                .code = "runtime_ui.context_metrics_invalid",
                .message = record.name + ": " + resolved.error(),
            }});
        }
        auto* resolved_metrics = resolved.value_if();
        if (!resolved_metrics) {
            return core::Result<void, core::Diagnostics>::failure({{
                .code = "runtime_ui.context_metrics_invalid",
                .message = record.name + ": resolved metrics are unavailable",
            }});
        }
        release_font_raster_resources =
            release_font_raster_resources ||
            record.metrics.font_raster_scale != resolved_metrics->font_raster_scale;
        staged_metrics.push_back(std::move(*resolved_metrics));
    }

    m_presentation = presentation;
    m_user_settings = settings;
    m_default_context_metrics = std::move(*default_metrics.value_if());

    for (std::size_t index = 0; index < m_contexts.size(); ++index)
        m_contexts[index].metrics = std::move(staged_metrics[index]);
    for (auto& record : m_contexts)
        apply_context_environment(*record.context, record.metrics, force_media_query_refresh);

    const ResolvedContextMetrics* projection_metrics = &m_default_context_metrics;
    const auto primary =
        std::find_if(m_contexts.begin(), m_contexts.end(),
                     [&](const auto& record) { return record.context == m_primary_context; });
    if (primary != m_contexts.end())
        projection_metrics = &primary->metrics;
    if (m_system_interface)
        m_system_interface->set_context_projection(m_presentation, *projection_metrics);

    for (auto& renderer : m_plane_renderers) {
        if (!renderer.bgfx)
            continue;
        const auto context =
            std::find_if(m_contexts.begin(), m_contexts.end(), [&](const auto& record) {
                return record.key.plane == renderer.plane &&
                       is_world_transition_source_context(
                           record.key, host::kWorldTransitionSourceCompositionGroup) ==
                           renderer.world_transition_source;
            });
        renderer.bgfx->resize(m_presentation, context == m_contexts.end()
                                                  ? m_default_context_metrics
                                                  : context->metrics);
    }

    if (m_rml_initialized && release_font_raster_resources)
        Rml::ReleaseFontRasterResources();
    return core::Result<void, core::Diagnostics>::success();
}

void RmlUiHost::begin_frame(const core::RuntimeClockUpdate& clocks)
{
    m_rendered_contexts.clear();
    m_clocks = clocks;
    for (auto& renderer : m_plane_renderers)
        renderer.view_range_started = false;
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
        const bool is_source = is_world_transition_source_context(
            record.key, host::kWorldTransitionSourceCompositionGroup);
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
        if (renderer != m_plane_renderers.end() && renderer->bgfx) {
            renderer->bgfx->configure_context(m_presentation, record.metrics);
            renderer->bgfx->begin_frame(renderer->view_range_started);
            renderer->view_range_started = true;
        }
        if (m_context_render_observer)
            m_context_render_observer(record.key, record.metrics);
        record.context->Render();
        if (renderer != m_plane_renderers.end() && renderer->bgfx)
            renderer->bgfx->end_frame();
        m_rendered_contexts.insert(record.context);
    }
}

void RmlUiHost::render_world_overlay_source() { render_contexts(true, false, true); }

void RmlUiHost::render_world_overlay_target() { render_contexts(false, true, true); }

void RmlUiHost::end_frame(bool include_debug_plane)
{
    render_contexts(false, false, include_debug_plane);
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
