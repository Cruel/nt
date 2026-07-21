#include "ui/rmlui/rmlui_host.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "ui/rmlui/rmlui_file_interface.hpp"
#include "ui/rmlui/rmlui_render_interface_bgfx.hpp"
#include "ui/rmlui/rmlui_system_interface_sdl3.hpp"

#include <algorithm>
#include <cstdio>
#include <memory>
#include <string>

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
    m_surface = sanitize_surface_metrics(config.surface);
    m_presentation = config.presentation;
    m_headless_render = config.headless_render;
    m_file_interface = std::make_unique<AssetRmlFileInterface>(*m_assets);
    m_system_interface = std::make_unique<SdlSystemInterface>(m_window);
    Rml::SetFileInterface(m_file_interface.get());
    Rml::SetSystemInterface(m_system_interface.get());

    if (!Rml::Initialise()) {
        std::fprintf(stderr, "[runtime_ui] RmlUi::Initialise() failed\n");
        shutdown();
        return false;
    }
    m_rml_initialized = true;
    Rml::Lua::Initialise(config.lua_state);

    m_primary_context = context_for(
        ContextKey{core::PresentationPlane::GameUi, 0, core::LayoutClockDomain::Gameplay,
                   core::LayoutInputMode::Normal, core::MountedLayoutOwner::Gameplay});
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

    std::printf("[runtime_ui] RmlUi initialized logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f\n",
                m_surface.logical_width, m_surface.logical_height, m_surface.framebuffer_width,
                m_surface.framebuffer_height, m_surface.scale_x, m_surface.scale_y);
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

Rml::RenderInterface* RmlUiHost::renderer_for(ContextKey key)
{
    const bool world_transition_source =
        key.plane == core::PresentationPlane::WorldOverlay &&
        key.composition_group == host::kWorldTransitionSourceCompositionGroup;
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
        auto bgfx = std::make_unique<BgfxRenderInterface>(m_presentation, *m_assets, views,
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
                             std::to_string(static_cast<unsigned>(key.owner));
    auto* renderer = renderer_for(key);
    if (!renderer)
        return nullptr;
    auto* created = Rml::CreateContext(
        name, Rml::Vector2i(m_surface.logical_width, m_surface.logical_height), renderer);
    if (!created)
        return nullptr;
    created->SetDensityIndependentPixelRatio(m_surface.scale_x);
    m_contexts.push_back({key, name, created});
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

void RmlUiHost::sort_contexts()
{
    std::sort(m_contexts.begin(), m_contexts.end(),
              [](const auto& lhs, const auto& rhs) { return lhs.key < rhs.key; });
}

AssetRmlFileInterface* RmlUiHost::file_interface() const noexcept { return m_file_interface.get(); }

void RmlUiHost::set_density(float density)
{
    for (auto& record : m_contexts)
        record.context->SetDensityIndependentPixelRatio(density);
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

void RmlUiHost::set_context_clock(ContextKey key)
{
    if (m_system_interface)
        m_system_interface->set_elapsed_time(domain_time(m_clocks, key.clock));
}

const PresentationMetrics& RmlUiHost::presentation() const noexcept { return m_presentation; }

} // namespace noveltea::ui::rmlui
