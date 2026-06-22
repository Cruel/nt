#pragma once

#include "ui/rmlui/bgfx_renderer/rmlui_bgfx_target_cache.hpp"
#include "ui/rmlui/bgfx_renderer/rmlui_bgfx_types.hpp"

#include <RmlUi/Core/Types.h>

#include <vector>

namespace rmlui_bgfx {

class BgfxLayerSystem {
public:
    explicit BgfxLayerSystem(BgfxTargetCache& target_cache);

    void begin_frame();
    void clear_stack_to_base();
    void push_layer(Rml::LayerHandle handle);
    bool pop_layer();
    LayerRecord& prepare_virtual_child(Rml::LayerHandle handle, Rml::LayerHandle parent,
                                       const RenderBounds& provisional_bounds,
                                       ScissorState push_scissor, bool push_transform_valid);

    [[nodiscard]] Rml::LayerHandle active_layer() const { return m_active_layer; }
    [[nodiscard]] Rml::LayerHandle& active_layer_ref() { return m_active_layer; }
    [[nodiscard]] const Rml::LayerHandle& active_layer_ref() const { return m_active_layer; }

    [[nodiscard]] std::vector<Rml::LayerHandle>& stack() { return m_layer_stack; }
    [[nodiscard]] const std::vector<Rml::LayerHandle>& stack() const { return m_layer_stack; }

    [[nodiscard]] LayerRecord* layer_for_handle(Rml::LayerHandle handle);
    [[nodiscard]] const LayerRecord* layer_for_handle(Rml::LayerHandle handle) const;
    [[nodiscard]] LayerRecord* materialized_layer_for_handle(Rml::LayerHandle handle,
                                                             bool direct_base_requested);
    [[nodiscard]] const LayerRecord*
    materialized_layer_for_handle(Rml::LayerHandle handle, bool direct_base_requested) const;
    [[nodiscard]] LayerRecord* current_layer();
    [[nodiscard]] const LayerRecord* current_layer() const;
    [[nodiscard]] bool active_layer_is_recording() const;

private:
    BgfxTargetCache* m_target_cache = nullptr;
    std::vector<Rml::LayerHandle> m_layer_stack;
    Rml::LayerHandle m_active_layer = 0;
};

} // namespace rmlui_bgfx
