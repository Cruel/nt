#include "ui/rmlui/rmlui_host.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "ui/rmlui/rmlui_file_interface.hpp"
#include "ui/rmlui/rmlui_render_interface_bgfx.hpp"
#include "ui/rmlui/rmlui_system_interface_sdl3.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <memory>
#include <string>
#include <utility>

#include <RmlUi/Core.h>
#include <RmlUi/Lua.h>

namespace noveltea::ui::rmlui {
namespace {

constexpr const char* kRuntimeUiFontAsset = "project:/rmlui/LiberationSans.ttf";
constexpr const char* kRuntimeUiSystemFontAsset = "system:/fonts/LiberationSans.ttf";

class HeadlessRenderInterface final : public Rml::RenderInterface {
public:
    Rml::CompiledGeometryHandle CompileGeometry(Rml::Span<const Rml::Vertex>,
                                                Rml::Span<const int>) override
    {
        return ++m_next_geometry;
    }
    void RenderGeometry(Rml::CompiledGeometryHandle, Rml::Vector2f, Rml::TextureHandle) override {}
    void ReleaseGeometry(Rml::CompiledGeometryHandle) override {}
    Rml::TextureHandle LoadTexture(Rml::Vector2i& texture_dimensions, const Rml::String&) override
    {
        texture_dimensions = {0, 0};
        return 0;
    }
    Rml::TextureHandle GenerateTexture(Rml::Span<const Rml::byte>, Rml::Vector2i) override
    {
        return ++m_next_texture;
    }
    void ReleaseTexture(Rml::TextureHandle) override {}
    void EnableScissorRegion(bool) override {}
    void SetScissorRegion(Rml::Rectanglei) override {}

private:
    Rml::CompiledGeometryHandle m_next_geometry = 0;
    Rml::TextureHandle m_next_texture = 0;
};

} // namespace

RmlUiHost::RmlUiHost() = default;
RmlUiHost::~RmlUiHost() { shutdown(); }

bool RmlUiHost::initialize(const Config& config)
{
    if (m_rml_initialized)
        return true;
    if (!config.assets || !config.lua_state)
        return false;

    m_assets = config.assets;
    m_window = config.window;
    m_shader_materials = config.shader_materials;
    m_presentation = config.presentation;
    const ContextKey primary_key{core::PresentationPlane::GameUi, 0,
                                 core::LayoutClockDomain::Gameplay, core::LayoutInputMode::Normal,
                                 core::MountedLayoutOwner::Gameplay};
    auto context_metrics =
        resolve_context_environment(primary_key, m_presentation, m_user_settings);
    if (!context_metrics) {
        std::fprintf(stderr, "[runtime_ui] invalid context metrics: %s\n",
                     context_metrics.error().c_str());
        return false;
    }
    m_default_context_metrics = std::move(*context_metrics.value_if());
    m_headless_render = config.headless_render;
    m_file_interface = std::make_unique<AssetRmlFileInterface>(*m_assets);
    m_system_interface = std::make_unique<SdlSystemInterface>(m_window);
    m_system_interface->set_context_projection(m_presentation, m_default_context_metrics);
    Rml::SetFileInterface(m_file_interface.get());
    Rml::SetSystemInterface(m_system_interface.get());

    if (!Rml::Initialise()) {
        std::fprintf(stderr, "[runtime_ui] RmlUi::Initialise() failed\n");
        shutdown();
        return false;
    }
    m_rml_initialized = true;
    Rml::Lua::Initialise(config.lua_state);

    m_primary_context = context_for(primary_key);
    if (!m_primary_context) {
        std::fprintf(stderr, "[runtime_ui] RmlUi::CreateContext failed\n");
        shutdown();
        return false;
    }

    if (!Rml::LoadFontFace(kRuntimeUiSystemFontAsset, true)) {
        std::fprintf(stderr, "[runtime_ui] failed to load font: %s\n", kRuntimeUiSystemFontAsset);
        if (!Rml::LoadFontFace(kRuntimeUiFontAsset, true)) {
            std::fprintf(stderr, "[runtime_ui] (optional) failed to load font: %s\n",
                         kRuntimeUiFontAsset);
        }
    }

    std::printf("[runtime_ui] RmlUi initialized %s\n",
                format_resolved_context_metrics(m_default_context_metrics).c_str());
    return true;
}

void RmlUiHost::shutdown()
{
    reset_pointer_state();
    for (auto& record : m_contexts) {
        if (record.context)
            record.context->UnloadAllDocuments();
    }
    for (auto& record : m_contexts)
        Rml::RemoveContext(record.name);
    m_contexts.clear();
    m_primary_context = nullptr;
    m_rendered_contexts.clear();
    m_context_render_observer = {};

    if (m_rml_initialized) {
        Rml::Shutdown();
        m_rml_initialized = false;
    }
    m_plane_renderers.clear();
    Rml::SetSystemInterface(nullptr);
    Rml::SetFileInterface(nullptr);
    m_system_interface.reset();
    m_file_interface.reset();
    m_assets = nullptr;
    m_window = nullptr;
    m_shader_materials = nullptr;
}

Rml::Context* RmlUiHost::primary_context() const noexcept { return m_primary_context; }

Rml::RenderInterface* RmlUiHost::renderer_for(ContextKey key, const ResolvedContextMetrics& metrics)
{
    const bool world_transition_source =
        is_world_transition_source_context(key, host::kWorldTransitionSourceCompositionGroup);
    const auto found =
        std::find_if(m_plane_renderers.begin(), m_plane_renderers.end(), [&](const auto& value) {
            return value.plane == key.plane &&
                   value.world_transition_source == world_transition_source;
        });
    if (found != m_plane_renderers.end())
        return found->owned.get();

    PlaneRenderer renderer;
    renderer.plane = key.plane;
    renderer.world_transition_source = world_transition_source;
    if (m_headless_render) {
        renderer.owned = std::make_unique<HeadlessRenderInterface>();
    } else {
        const auto views = world_transition_source ? rmlui_bgfx_world_source_overlay_view_range()
                                                   : rmlui_bgfx_plane_view_range(key.plane);
        auto bgfx = std::make_unique<BgfxRenderInterface>(m_presentation, metrics, *m_assets, views,
                                                          m_shader_materials);
        if (!*bgfx)
            return nullptr;
        bgfx->set_perf_logging_enabled(m_perf_logging);
        bgfx->set_base_direct_compatibility(m_base_direct_compatibility);
        renderer.bgfx = bgfx.get();
        renderer.owned = std::move(bgfx);
    }
    m_plane_renderers.push_back(std::move(renderer));
    return m_plane_renderers.back().owned.get();
}

Rml::Context* RmlUiHost::context_for(ContextKey key)
{
    const auto found = std::find_if(m_contexts.begin(), m_contexts.end(),
                                    [&](const auto& value) { return value.key == key; });
    if (found != m_contexts.end())
        return found->context;

    const std::string name = "runtime-" + std::to_string(static_cast<unsigned>(key.plane)) + "-" +
                             std::to_string(key.composition_group) + "-" +
                             std::to_string(static_cast<unsigned>(key.clock)) + "-" +
                             std::to_string(static_cast<unsigned>(key.input)) + "-" +
                             std::to_string(static_cast<unsigned>(key.owner)) + "-" +
                             std::to_string(static_cast<unsigned>(key.scale_domain)) + "-" +
                             std::to_string(key.compatibility_group);
    auto metrics = resolve_context_environment(key, m_presentation, m_user_settings);
    if (!metrics) {
        std::fprintf(stderr, "[runtime_ui] invalid context environment for %s: %s\n", name.c_str(),
                     metrics.error().c_str());
        return nullptr;
    }
    auto* resolved_metrics = metrics.value_if();
    if (!resolved_metrics)
        return nullptr;
    auto* renderer = renderer_for(key, *resolved_metrics);
    if (!renderer)
        return nullptr;
    auto* created = Rml::CreateContext(
        name,
        Rml::Vector2i(resolved_metrics->layout_size.width, resolved_metrics->layout_size.height),
        renderer);
    if (!created)
        return nullptr;
    apply_context_environment(*created, *resolved_metrics);
    m_contexts.push_back({key, name, created, std::move(*resolved_metrics)});
    sort_contexts();
    return created;
}

Rml::Context* RmlUiHost::find_context(ContextKey key) const noexcept
{
    const auto found = std::find_if(m_contexts.begin(), m_contexts.end(),
                                    [&](const auto& value) { return value.key == key; });
    return found == m_contexts.end() ? nullptr : found->context;
}

const std::vector<RmlUiHost::ContextRecord>& RmlUiHost::contexts() const noexcept
{
    return m_contexts;
}

std::vector<RmlUiHost::ContextRecord>& RmlUiHost::contexts() noexcept { return m_contexts; }

const ResolvedContextMetrics* RmlUiHost::context_metrics(Rml::Context* context) const noexcept
{
    const auto found = std::find_if(m_contexts.begin(), m_contexts.end(),
                                    [&](const auto& value) { return value.context == context; });
    return found == m_contexts.end() ? nullptr : &found->metrics;
}

void RmlUiHost::sort_contexts()
{
    std::stable_sort(m_contexts.begin(), m_contexts.end(), [](const auto& lhs, const auto& rhs) {
        return lifecycle_context_presentation_less(lhs.key, rhs.key);
    });
}

AssetRmlFileInterface* RmlUiHost::file_interface() const noexcept { return m_file_interface.get(); }

core::Result<ResolvedContextMetrics, std::string>
RmlUiHost::resolve_context_environment(ContextKey key, const PresentationMetrics& presentation,
                                       const core::RuntimeUserSettings& settings) const
{
    const float ui_scale = static_cast<float>(settings.ui_scale());
    const float text_scale = static_cast<float>(settings.text_scale());
    if (!std::isfinite(ui_scale) || ui_scale <= 0.0f)
        return core::Result<ResolvedContextMetrics, std::string>::failure(
            "effective runtime UI scale must fit a positive finite float value");
    if (!std::isfinite(text_scale) || text_scale <= 0.0f)
        return core::Result<ResolvedContextMetrics, std::string>::failure(
            "effective runtime text scale must fit a positive finite float value");

    auto resolved =
        resolve_context_metrics(presentation, ui_scale, inherits_ui_scale(key.scale_domain));
    if (!resolved)
        return resolved;
    auto metrics = std::move(*resolved.value_if());
    metrics.text_scale_factor = inherits_text_scale(key.scale_domain) ? text_scale : 1.0f;
    return core::Result<ResolvedContextMetrics, std::string>::success(std::move(metrics));
}

void RmlUiHost::apply_context_environment(Rml::Context& context,
                                          const ResolvedContextMetrics& metrics,
                                          bool force_media_query_refresh)
{
    context.SetDimensions(Rml::Vector2i(metrics.layout_size.width, metrics.layout_size.height));
    if (force_media_query_refresh)
        context.ClearMediaQueryDimensions();
    context.SetMediaQueryDimensions(
        Rml::Vector2i(metrics.media_query_size.width, metrics.media_query_size.height));
    context.SetDensityIndependentPixelRatio(metrics.ui_raster_scale.x);
    context.SetTextScaleFactor(metrics.text_scale_factor);
    context.SetFontRasterScale(metrics.font_raster_scale);
}

void RmlUiHost::set_perf_logging_enabled(bool enabled)
{
    m_perf_logging = enabled;
    for (auto& renderer : m_plane_renderers)
        if (renderer.bgfx)
            renderer.bgfx->set_perf_logging_enabled(enabled);
}

void RmlUiHost::set_base_direct_compatibility(bool enabled)
{
    m_base_direct_compatibility = enabled;
    for (auto& renderer : m_plane_renderers)
        if (renderer.bgfx)
            renderer.bgfx->set_base_direct_compatibility(enabled);
}

void RmlUiHost::set_context_render_observer(ContextRenderObserver observer)
{
    m_context_render_observer = std::move(observer);
}

void RmlUiHost::set_context_clock(ContextKey key)
{
    if (!m_system_interface)
        return;
    m_system_interface->set_elapsed_time(domain_time(m_clocks, key.clock));
    const auto found = std::find_if(m_contexts.begin(), m_contexts.end(),
                                    [&](const auto& value) { return value.key == key; });
    if (found != m_contexts.end())
        m_system_interface->set_context_projection(m_presentation, found->metrics);
}

const PresentationMetrics& RmlUiHost::presentation() const noexcept { return m_presentation; }

} // namespace noveltea::ui::rmlui
