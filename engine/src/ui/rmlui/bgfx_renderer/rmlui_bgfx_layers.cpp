#include "ui/rmlui/bgfx_renderer/rmlui_bgfx_layers.hpp"

namespace rmlui_bgfx {

BgfxLayerSystem::BgfxLayerSystem(BgfxTargetCache& target_cache) : m_target_cache(&target_cache) {}

void BgfxLayerSystem::begin_frame()
{
    m_layer_stack.clear();
    m_layer_stack.push_back(0);
    m_active_layer = 0;
}

void BgfxLayerSystem::clear_stack_to_base()
{
    m_layer_stack.clear();
    m_active_layer = 0;
}

void BgfxLayerSystem::push_layer(Rml::LayerHandle handle)
{
    m_layer_stack.push_back(handle);
    m_active_layer = handle;
}

bool BgfxLayerSystem::pop_layer()
{
    if (m_layer_stack.size() <= 1) {
        return false;
    }
    m_layer_stack.pop_back();
    m_active_layer = m_layer_stack.back();
    return true;
}

LayerRecord& BgfxLayerSystem::prepare_virtual_child(Rml::LayerHandle handle,
                                                    Rml::LayerHandle parent,
                                                    const RenderBounds& provisional_bounds,
                                                    ScissorState push_scissor,
                                                    bool push_transform_valid)
{
    LayerRecord& previous = m_target_cache->prepare_virtual_layer_slot(uint32_t(handle));
    LayerRecord preserved_resources;
    preserved_resources.framebuffer = previous.framebuffer;
    preserved_resources.color = previous.color;
    preserved_resources.depth_stencil = previous.depth_stencil;
    preserved_resources.texture_width = previous.texture_width;
    preserved_resources.texture_height = previous.texture_height;
    previous.framebuffer = BGFX_INVALID_HANDLE;
    previous.color = BGFX_INVALID_HANDLE;
    previous.depth_stencil = BGFX_INVALID_HANDLE;
    previous.texture_width = 0;
    previous.texture_height = 0;

    LayerRecord child;
    child.framebuffer = preserved_resources.framebuffer;
    child.color = preserved_resources.color;
    child.depth_stencil = preserved_resources.depth_stencil;
    child.texture_width = preserved_resources.texture_width;
    child.texture_height = preserved_resources.texture_height;
    child.kind = LayerKind::VirtualChild;
    child.parent_layer = parent;
    child.bounds = provisional_bounds;
    child.push_scissor = push_scissor;
    child.push_transform_valid = push_transform_valid;
    child.recording = true;
    child.materialized = false;
    child.clear_pending = true;

    if (const LayerRecord* parent_layer = layer_for_handle(parent)) {
        child.clip_mask_enabled = parent_layer->clip_mask_enabled;
        child.stencil_ref = parent_layer->stencil_ref;
        child.conservative_mask_bounds = parent_layer->conservative_mask_bounds;
        child.clip_commands = parent_layer->clip_commands;
        child.inherited_clip_command_count = child.clip_commands.size();
    }

    previous = std::move(child);
    return previous;
}

LayerRecord* BgfxLayerSystem::layer_for_handle(Rml::LayerHandle handle)
{
    if (!m_target_cache) {
        return nullptr;
    }
    return m_target_cache->layer(uint32_t(handle));
}

const LayerRecord* BgfxLayerSystem::layer_for_handle(Rml::LayerHandle handle) const
{
    if (!m_target_cache) {
        return nullptr;
    }
    return m_target_cache->layer(uint32_t(handle));
}

LayerRecord* BgfxLayerSystem::materialized_layer_for_handle(Rml::LayerHandle handle,
                                                            bool direct_base_requested)
{
    LayerRecord* layer = layer_for_handle(handle);
    if (!layer) {
        return nullptr;
    }
    if (size_t(handle) == 0 && direct_base_requested) {
        return layer;
    }
    if (!bgfx::isValid(layer->framebuffer)) {
        return nullptr;
    }
    return layer;
}

const LayerRecord* BgfxLayerSystem::materialized_layer_for_handle(Rml::LayerHandle handle,
                                                                  bool direct_base_requested) const
{
    const LayerRecord* layer = layer_for_handle(handle);
    if (!layer) {
        return nullptr;
    }
    if (size_t(handle) == 0 && direct_base_requested) {
        return layer;
    }
    if (!bgfx::isValid(layer->framebuffer)) {
        return nullptr;
    }
    return layer;
}

LayerRecord* BgfxLayerSystem::current_layer() { return layer_for_handle(m_active_layer); }

const LayerRecord* BgfxLayerSystem::current_layer() const
{
    return layer_for_handle(m_active_layer);
}

bool BgfxLayerSystem::active_layer_is_recording() const
{
    const LayerRecord* layer = layer_for_handle(m_active_layer);
    if (!layer) {
        return false;
    }
    return layer->kind == LayerKind::VirtualChild && layer->recording && !layer->materialized;
}

} // namespace rmlui_bgfx
