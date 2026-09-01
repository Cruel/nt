noveltea_verb_menu = noveltea_verb_menu or {}

function noveltea_verb_menu.position(event, element, document)
    local mount = Game.mount_context ~= nil and Game.mount_context("runtime_verb_menu") or nil
    if document == nil or mount == nil then
        return false
    end

    local hint = mount:position_hint()
    if hint == nil then
        return false
    end

    local panel = document:GetElementById("nt_verb_menu")
    if panel == nil then
        return false
    end
    local position = Layout.clamp_to_viewport(panel, hint.x, hint.y, 8)
    panel.style.left = position.x .. "px"
    panel.style.top = position.y .. "px"
    return true
end
