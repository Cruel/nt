#pragma once

#include "host/layout_composition.hpp"
#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/runtime_clock.hpp"
#include "noveltea/surface.hpp"
#include "ui/rmlui/rmlui_lifecycle.hpp"

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <unordered_set>
#include <vector>

union SDL_Event;
struct SDL_Window;
struct lua_State;

namespace Rml {
class Context;
class RenderInterface;
} // namespace Rml

namespace noveltea {
struct ShaderMaterialProject;

namespace assets {
class AssetManager;
}

namespace ui::rmlui {

class AssetRmlFileInterface;
class BgfxRenderInterface;
class SdlSystemInterface;

class RmlUiHost final {
public:
    using ContextKey = LifecycleContextKey;

    struct ContextRecord {
        ContextKey key;
        std::string name;
        Rml::Context* context = nullptr;
        ResolvedContextMetrics metrics{};
    };

    struct Config {
        const assets::AssetManager* assets = nullptr;
        SDL_Window* window = nullptr;
        lua_State* lua_state = nullptr;
        const ShaderMaterialProject* shader_materials = nullptr;
        PresentationMetrics presentation{};
        bool headless_render = false;
    };

    using VisibleDocumentPredicate = std::function<bool(Rml::Context*)>;
    using LayoutEventDispatch =
        std::function<bool(core::MountedLayoutOwner, const std::function<bool()>&)>;

    RmlUiHost();
    ~RmlUiHost();

    RmlUiHost(const RmlUiHost&) = delete;
    RmlUiHost& operator=(const RmlUiHost&) = delete;

    [[nodiscard]] bool initialize(const Config& config);
    void shutdown();

    [[nodiscard]] Rml::Context* primary_context() const noexcept;
    [[nodiscard]] Rml::Context* context_for(ContextKey key);
    [[nodiscard]] Rml::Context* find_context(ContextKey key) const noexcept;
    [[nodiscard]] const std::vector<ContextRecord>& contexts() const noexcept;
    [[nodiscard]] std::vector<ContextRecord>& contexts() noexcept;
    [[nodiscard]] const ResolvedContextMetrics*
    context_metrics(Rml::Context* context) const noexcept;
    void sort_contexts();

    [[nodiscard]] AssetRmlFileInterface* file_interface() const noexcept;

    [[nodiscard]] bool process_event(const SDL_Event& event,
                                     const PresentationMetrics& presentation,
                                     const VisibleDocumentPredicate& has_visible_document,
                                     const LayoutEventDispatch& dispatch_layout_event);
    void resize(const PresentationMetrics& presentation);

    void begin_frame(const core::RuntimeClockUpdate& clocks);
    void update_contexts();
    void set_world_overlay_framebuffers(std::uint16_t source, std::uint16_t target,
                                        bool transition_active);
    void render_world_overlay_source();
    void render_world_overlay_target();
    void end_frame();
    void reset_backend_state();

    void set_density(float density);
    void set_perf_logging_enabled(bool enabled);
    void set_base_direct_compatibility(bool enabled);
    void set_context_clock(ContextKey key);

    [[nodiscard]] bool wants_pointer_input() const;
    [[nodiscard]] bool wants_keyboard_input() const;
    [[nodiscard]] const PresentationMetrics& presentation() const noexcept;

private:
    struct PlaneRenderer {
        core::PresentationPlane plane = core::PresentationPlane::GameUi;
        bool world_transition_source = false;
        std::unique_ptr<Rml::RenderInterface> owned;
        BgfxRenderInterface* bgfx = nullptr;
    };

    [[nodiscard]] Rml::RenderInterface* renderer_for(ContextKey key);
    [[nodiscard]] bool
    dispatch_transformed_event(const SDL_Event& event, const PresentationTransform& transform,
                               std::optional<Vec2> reference_pointer,
                               const VisibleDocumentPredicate& has_visible_document,
                               const LayoutEventDispatch& dispatch_layout_event);
    void reset_pointer_state();
    void render_contexts(bool world_source_only, bool world_target_only);

    const assets::AssetManager* m_assets = nullptr;
    SDL_Window* m_window = nullptr;
    const ShaderMaterialProject* m_shader_materials = nullptr;
    PresentationMetrics m_presentation{};
    ResolvedContextMetrics m_context_metrics{};
    core::RuntimeClockUpdate m_clocks{};
    std::unique_ptr<AssetRmlFileInterface> m_file_interface;
    std::unique_ptr<SdlSystemInterface> m_system_interface;
    std::vector<ContextRecord> m_contexts;
    std::vector<PlaneRenderer> m_plane_renderers;
    std::unordered_set<Rml::Context*> m_rendered_contexts;
    std::unordered_set<std::uint64_t> m_active_touches;
    Rml::Context* m_primary_context = nullptr;
    bool m_pointer_inside = false;
    bool m_headless_render = false;
    bool m_perf_logging = false;
    bool m_base_direct_compatibility = false;
    bool m_rml_initialized = false;
};

} // namespace ui::rmlui
} // namespace noveltea
